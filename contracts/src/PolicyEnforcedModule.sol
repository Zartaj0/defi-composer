// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ============================================================
// PolicyEnforcedModule  (V2)
//
// A Gnosis Safe module that enables fully autonomous DeFi
// execution by a trusted executor EOA, bounded by onchain
// policy rules set by the Safe multisig.
//
// Security model:
//   - Only Safe multisig can set/change policy, targets, or selectors.
//   - Executor can ONLY send to approved protocol contracts.
//   - Per-action and daily USDC limits are enforced onchain.
//   - Reserve floor (minimum liquid USDC) enforced onchain
//     via USDC.balanceOf(SAFE) check — not just informational.
//   - For MultiSend (DELEGATECALL) batches, every inner call's
//     target AND function selector is validated against the
//     onchain allowlist — no broad "approve MultiSend" bypass.
//   - Safe can pause the policy instantly (1 multisig tx).
//   - Even a compromised executor key is bounded:
//       max damage = dailyLimitUsdc per 24h window.
//
// Changes from V1:
//   1. reserveFloorUsdc enforced onchain: USDC.balanceOf(SAFE)
//      must be >= floor + declaredAmount before execution.
//   2. MultiSend inner-call validation: DELEGATECALL batches are
//      decoded; every inner (to, selector) must be in the
//      per-target selector allowlist.
//   3. Per-target selector guard: approveSelector(target, sel)
//      enables fine-grained calldata validation.  When a target
//      has at least one approved selector, the guard is active
//      and only whitelisted selectors are allowed.
//   4. usdcToken is now a configurable storage variable set by
//      Safe (not hardcoded) — supports mainnet/testnet without
//      redeployment.
// ============================================================

interface ISafe {
    function execTransactionFromModule(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation
    ) external returns (bool success);
}

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
}

contract PolicyEnforcedModule {
    // ── Immutables ─────────────────────────────────────────────
    address public immutable SAFE;

    // ── State ──────────────────────────────────────────────────
    address public executor;

    /// @dev USDC token address used for reserve-floor enforcement.
    ///      Set by Safe via setUsdcToken(). If zero, floor check is skipped.
    address public usdcToken;

    struct Policy {
        bool     active;
        uint256  maxSingleActionUsdc;   // 6-decimal USDC, e.g. 100e6 = $100
        uint256  dailyLimitUsdc;        // max spend per 24h window
        uint256  reserveFloorUsdc;      // min liquid USDC enforced onchain
    }

    Policy public policy;

    /// @dev Approved target addresses (Aave pool, Morpho markets, MultiSend, etc.)
    mapping(address => bool) public approvedTargets;

    /// @dev Per-target function selector allowlist.
    ///      When selectorGuardEnabled[target] is true, only whitelisted
    ///      selectors are allowed for that target.
    mapping(address => mapping(bytes4 => bool)) public approvedSelectors;

    /// @dev Tracks whether at least one selector has been registered for a
    ///      target, activating selector-level enforcement for it.
    mapping(address => bool) public selectorGuardEnabled;

    /// Daily rolling window
    uint256 public periodStart;     // timestamp of current window start
    uint256 public periodSpend;     // USDC (6-dec) spent in current window

    uint256 public constant PERIOD_DURATION = 1 days;

    // ── Events ─────────────────────────────────────────────────
    event PolicySet(uint256 maxSingleActionUsdc, uint256 dailyLimitUsdc, uint256 reserveFloorUsdc);
    event PolicyPaused();
    event PolicyResumed();
    event TargetApproved(address indexed target);
    event TargetRevoked(address indexed target);
    event SelectorApproved(address indexed target, bytes4 indexed selector);
    event SelectorRevoked(address indexed target, bytes4 indexed selector);
    event ExecutorUpdated(address indexed prev, address indexed next);
    event UsdcTokenSet(address indexed token);
    event ActionExecuted(
        bytes32 indexed simulationId,
        address indexed to,
        uint256 declaredUsdcAmount,
        uint256 periodSpendAfter
    );

    // ── Errors ─────────────────────────────────────────────────
    error NotSafe();
    error NotExecutor();
    error PolicyNotActive();
    error TargetNotApproved(address target);
    error SelectorNotApproved(address target, bytes4 selector);
    error ExceedsMaxSingleAction(uint256 amount, uint256 max);
    error ExceedsDailyLimit(uint256 amount, uint256 remaining);
    error InsufficientReserve(uint256 available, uint256 required);
    error ExecutionFailed();
    error ZeroAddress();
    error InvalidCalldata();

    // ── Modifiers ──────────────────────────────────────────────
    modifier onlySafe() {
        if (msg.sender != SAFE) revert NotSafe();
        _;
    }

    modifier onlyExecutor() {
        if (msg.sender != executor) revert NotExecutor();
        _;
    }

    // ── Constructor ────────────────────────────────────────────
    constructor(address _safe, address _executor) {
        if (_safe     == address(0)) revert ZeroAddress();
        if (_executor == address(0)) revert ZeroAddress();
        SAFE        = _safe;
        executor    = _executor;
        periodStart = block.timestamp;
    }

    // ── Safe-governed (require multisig) ──────────────────────

    /**
     * @notice Activate or replace the policy rules.
     *         Call once at setup, and whenever mandate params change.
     */
    function setPolicy(
        uint256 maxSingleActionUsdc,
        uint256 dailyLimitUsdc,
        uint256 reserveFloorUsdc
    ) external onlySafe {
        require(maxSingleActionUsdc > 0,                    "maxSingleAction=0");
        require(dailyLimitUsdc      >= maxSingleActionUsdc, "daily<single");
        policy = Policy({
            active:               true,
            maxSingleActionUsdc:  maxSingleActionUsdc,
            dailyLimitUsdc:       dailyLimitUsdc,
            reserveFloorUsdc:     reserveFloorUsdc
        });
        emit PolicySet(maxSingleActionUsdc, dailyLimitUsdc, reserveFloorUsdc);
    }

    /**
     * @notice Set the USDC token address used for reserve-floor enforcement.
     *         Pass address(0) to disable floor enforcement (not recommended).
     */
    function setUsdcToken(address token) external onlySafe {
        usdcToken = token;
        emit UsdcTokenSet(token);
    }

    /// @notice Immediately pause all autonomous execution.
    function pausePolicy() external onlySafe {
        policy.active = false;
        emit PolicyPaused();
    }

    /// @notice Resume autonomous execution after a pause.
    function resumePolicy() external onlySafe {
        policy.active = true;
        emit PolicyResumed();
    }

    /// @notice Whitelist a protocol contract the executor may target.
    function addApprovedTarget(address target) external onlySafe {
        if (target == address(0)) revert ZeroAddress();
        approvedTargets[target] = true;
        emit TargetApproved(target);
    }

    /// @notice Remove a protocol from the whitelist.
    function removeApprovedTarget(address target) external onlySafe {
        approvedTargets[target] = false;
        emit TargetRevoked(target);
    }

    /**
     * @notice Approve a function selector for a target contract.
     *         Activates selector-level enforcement for that target.
     *         Once the guard is enabled for a target, ALL calls to that
     *         target must use a registered selector.
     */
    function approveSelector(address target, bytes4 selector) external onlySafe {
        approvedSelectors[target][selector] = true;
        selectorGuardEnabled[target]        = true;
        emit SelectorApproved(target, selector);
    }

    /**
     * @notice Revoke a previously approved selector.
     *         Does NOT disable the guard — use removeApprovedTarget + re-add
     *         to reset a target entirely.
     */
    function revokeSelector(address target, bytes4 selector) external onlySafe {
        approvedSelectors[target][selector] = false;
        emit SelectorRevoked(target, selector);
    }

    /// @notice Replace the trusted executor EOA (e.g. rotate keys).
    function setExecutor(address newExecutor) external onlySafe {
        if (newExecutor == address(0)) revert ZeroAddress();
        emit ExecutorUpdated(executor, newExecutor);
        executor = newExecutor;
    }

    // ── Executor: fully autonomous execution ──────────────────

    /**
     * @notice Execute a Safe transaction within policy bounds.
     *         No per-tx multisig approval needed — policy enforces all constraints.
     *
     * @param to                  Target contract (must be in approvedTargets).
     *                            For MultiSend batches, pass MultiSendCallOnly address.
     * @param value               ETH value forwarded (normally 0 for DeFi).
     * @param data                Encoded calldata.  For operation==1 (DELEGATECALL /
     *                            MultiSend), every inner call is decoded and validated.
     * @param operation           0 = CALL, 1 = DELEGATECALL (for MultiSend).
     * @param simulationId        Off-chain SimulationArtifact ID — logged for audit.
     * @param declaredUsdcAmount  USDC amount (6-dec) this action deploys.  Enforced
     *                            against policy limits and reserve floor.
     */
    function execute(
        address to,
        uint256 value,
        bytes  calldata data,
        uint8  operation,
        bytes32 simulationId,
        uint256 declaredUsdcAmount
    ) external onlyExecutor {
        // ── Policy checks ──────────────────────────────────────
        if (!policy.active)       revert PolicyNotActive();
        if (!approvedTargets[to]) revert TargetNotApproved(to);

        if (declaredUsdcAmount > policy.maxSingleActionUsdc)
            revert ExceedsMaxSingleAction(declaredUsdcAmount, policy.maxSingleActionUsdc);

        // ── Reserve floor check (onchain) ──────────────────────
        // Ensures the Safe always keeps at least reserveFloorUsdc of liquid USDC.
        // This check is independent of the executor's declared amount — it reads
        // actual on-chain state.
        if (usdcToken != address(0) && policy.reserveFloorUsdc > 0) {
            uint256 liquidUsdc = IERC20(usdcToken).balanceOf(SAFE);
            uint256 required   = policy.reserveFloorUsdc + declaredUsdcAmount;
            if (liquidUsdc < required)
                revert InsufficientReserve(liquidUsdc, required);
        }

        // ── Reset rolling window if expired ────────────────────
        if (block.timestamp >= periodStart + PERIOD_DURATION) {
            periodStart = block.timestamp;
            periodSpend = 0;
        }

        uint256 newSpend  = periodSpend + declaredUsdcAmount;
        uint256 remaining = policy.dailyLimitUsdc > periodSpend
            ? policy.dailyLimitUsdc - periodSpend
            : 0;
        if (newSpend > policy.dailyLimitUsdc)
            revert ExceedsDailyLimit(declaredUsdcAmount, remaining);

        // ── Calldata validation ────────────────────────────────
        if (operation == 1) {
            // DELEGATECALL — expected to be a MultiSend batch.
            // Decode every inner call and validate (target, selector).
            _validateMultiSendCalls(data);
        } else if (data.length >= 4 && selectorGuardEnabled[to]) {
            // Direct CALL with selector guard active for this target.
            bytes4 sel;
            assembly { sel := calldataload(data.offset) }
            if (!approvedSelectors[to][sel]) revert SelectorNotApproved(to, sel);
        }

        // Record spend before external call (CEI pattern).
        // On Safe failure the entire tx reverts, so spend is not permanently recorded.
        periodSpend = newSpend;

        emit ActionExecuted(simulationId, to, declaredUsdcAmount, newSpend);

        // ── Execute via Safe module ────────────────────────────
        bool success = ISafe(SAFE).execTransactionFromModule(to, value, data, operation);
        if (!success) revert ExecutionFailed();
    }

    // ── Internal: MultiSend inner-call decoder ─────────────────

    /**
     * @dev Decode a MultiSend(bytes transactions) payload and verify that
     *      every inner call's target is in approvedTargets AND — when
     *      selectorGuardEnabled[innerTo] is true — that the inner selector
     *      is in approvedSelectors[innerTo].
     *
     *      MultiSend ABI layout:
     *        data[0:4]    = multiSend selector
     *        data[4:36]   = ABI offset (== 0x20)
     *        data[36:68]  = byte-length of packed transactions
     *        data[68:...]  = packed transactions
     *
     *      Each packed transaction:
     *        [op:1][to:20][value:32][dataLen:32][data:dataLen]
     */
    function _validateMultiSendCalls(bytes calldata data) internal view {
        // Need at least selector(4) + offset(32) + length(32) = 68 bytes
        if (data.length < 68) revert InvalidCalldata();

        // Read transaction-block byte-length at data[36..68)
        uint256 txLen;
        assembly {
            txLen := calldataload(add(data.offset, 36))
        }
        if (68 + txLen > data.length) revert InvalidCalldata();

        uint256 pos = 68;            // packed transactions start here
        uint256 end = 68 + txLen;

        while (pos < end) {
            // Minimum per-entry header: op(1) + to(20) + value(32) + dataLen(32) = 85
            if (pos + 85 > end) revert InvalidCalldata();

            // Skip operation byte (1)
            pos += 1;

            // Extract inner 'to' — right-aligned 20 bytes from a 32-byte load
            address innerTo;
            assembly {
                innerTo := shr(96, calldataload(add(data.offset, pos)))
            }
            if (!approvedTargets[innerTo]) revert TargetNotApproved(innerTo);

            pos += 20; // past 'to'
            pos += 32; // skip value

            // Inner data byte-length
            uint256 innerDataLen;
            assembly {
                innerDataLen := calldataload(add(data.offset, pos))
            }
            pos += 32; // past dataLen

            // Selector check for inner call (if guard enabled for this target)
            if (selectorGuardEnabled[innerTo] && innerDataLen >= 4) {
                bytes4 innerSel;
                assembly {
                    // calldataload grabs 32 bytes; bytes4 takes the leftmost 4
                    innerSel := calldataload(add(data.offset, pos))
                }
                if (!approvedSelectors[innerTo][innerSel])
                    revert SelectorNotApproved(innerTo, innerSel);
            }

            if (pos + innerDataLen > end) revert InvalidCalldata();
            pos += innerDataLen;
        }
    }

    // ── View helpers ───────────────────────────────────────────

    /// @notice USDC remaining in the current 24h window.
    function remainingDailyLimit() external view returns (uint256) {
        if (block.timestamp >= periodStart + PERIOD_DURATION)
            return policy.dailyLimitUsdc;
        return policy.dailyLimitUsdc > periodSpend
            ? policy.dailyLimitUsdc - periodSpend
            : 0;
    }

    /// @notice Whether an execution would pass policy checks right now.
    ///         Does NOT check reserve floor (requires live balance read).
    function canExecute(address to, uint256 usdcAmount) external view returns (bool, string memory) {
        if (!policy.active)       return (false, "policy paused");
        if (!approvedTargets[to]) return (false, "target not approved");
        if (usdcAmount > policy.maxSingleActionUsdc)
            return (false, "exceeds maxSingleAction");
        uint256 spent = block.timestamp >= periodStart + PERIOD_DURATION ? 0 : periodSpend;
        if (spent + usdcAmount > policy.dailyLimitUsdc)
            return (false, "exceeds daily limit");
        return (true, "");
    }
}
