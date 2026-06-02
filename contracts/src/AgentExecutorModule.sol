// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ============================================================
// AgentExecutorModule
//
// A Gnosis Safe module that enables autonomous execution of
// fork-simulated transactions by a trusted executor EOA,
// without requiring multisig confirmation for every execution.
//
// Flow:
//   1. Simulation engine proves calldata on an Anvil fork.
//   2. Safe owners review the SimulationArtifact and approve
//      its hash via a single multisig transaction:
//        module.approveCalldata(approvalHash, validUntilBlock)
//   3. Within the validity window, executor EOA calls:
//        module.execute(to, value, data, operation, simulationId)
//   4. Module verifies hash, consumes approval (one-use),
//      then calls Safe.execTransactionFromModule.
//
// Security properties:
//   - Only Safe multisig can approve or change executor.
//   - Each approval is one-use (deleted after execution).
//   - Approvals expire at a block number set by the Safe.
//   - Executor cannot execute anything not pre-approved.
// ============================================================

interface ISafe {
    function execTransactionFromModule(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation
    ) external returns (bool success);
}

contract AgentExecutorModule {
    // ── Immutables ─────────────────────────────────────────────
    address public immutable SAFE;

    // ── State ──────────────────────────────────────────────────
    address public executor;

    /// @dev approvalHash => valid-until block number (0 = not approved)
    mapping(bytes32 => uint256) public approvals;

    // ── Events ─────────────────────────────────────────────────
    event CalldataApproved(bytes32 indexed approvalHash, uint256 validUntilBlock);
    event CalldataRevoked(bytes32 indexed approvalHash);
    event CalldataExecuted(bytes32 indexed approvalHash, bytes32 indexed simulationId);
    event ExecutorUpdated(address indexed previousExecutor, address indexed newExecutor);

    // ── Errors ─────────────────────────────────────────────────
    error NotSafe();
    error NotExecutor();
    error HashNotApproved(bytes32 approvalHash);
    error ApprovalExpired(bytes32 approvalHash, uint256 expiredAtBlock, uint256 currentBlock);
    error ModuleExecutionFailed();
    error InvalidApprovalWindow();

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
        require(_safe     != address(0), "safe=0");
        require(_executor != address(0), "executor=0");
        SAFE     = _safe;
        executor = _executor;
    }

    // ── Safe-governed functions ────────────────────────────────

    /**
     * @notice Pre-approve a fork-proven calldata hash for one autonomous
     *         execution. Must be called via Safe multisig.
     * @param approvalHash    keccak256(abi.encode(to, value, data, operation))
     * @param validUntilBlock Approval expires after this block (must be > current)
     */
    function approveCalldata(bytes32 approvalHash, uint256 validUntilBlock) external onlySafe {
        if (validUntilBlock <= block.number) revert InvalidApprovalWindow();
        approvals[approvalHash] = validUntilBlock;
        emit CalldataApproved(approvalHash, validUntilBlock);
    }

    /**
     * @notice Revoke a previously approved hash before it is executed.
     *         Must be called via Safe multisig.
     */
    function revokeCalldata(bytes32 approvalHash) external onlySafe {
        delete approvals[approvalHash];
        emit CalldataRevoked(approvalHash);
    }

    /**
     * @notice Replace the trusted executor EOA.
     *         Must be called via Safe multisig.
     */
    function setExecutor(address newExecutor) external onlySafe {
        require(newExecutor != address(0), "executor=0");
        emit ExecutorUpdated(executor, newExecutor);
        executor = newExecutor;
    }

    // ── Executor functions ─────────────────────────────────────

    /**
     * @notice Execute a pre-approved Safe transaction autonomously.
     *
     * @param to           Target address (or MultiSendCallOnly for batches)
     * @param value        ETH value forwarded to target
     * @param data         Calldata (raw call or multiSend(bytes) for batches)
     * @param operation    0 = CALL, 1 = DELEGATECALL (use 1 for MultiSend batches)
     * @param simulationId Off-chain SimulationArtifact.id — logged for audit trail
     */
    function execute(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        bytes32 simulationId
    ) external onlyExecutor {
        bytes32 approvalHash = keccak256(abi.encode(to, value, data, operation));

        uint256 validUntil = approvals[approvalHash];
        if (validUntil == 0) revert HashNotApproved(approvalHash);
        if (block.number > validUntil) revert ApprovalExpired(approvalHash, validUntil, block.number);

        // Consume approval — one-use only
        delete approvals[approvalHash];

        emit CalldataExecuted(approvalHash, simulationId);

        bool success = ISafe(SAFE).execTransactionFromModule(to, value, data, operation);
        if (!success) revert ModuleExecutionFailed();
    }

    // ── View helpers ───────────────────────────────────────────

    /**
     * @notice Compute the approval hash for a given transaction.
     *         Off-chain callers use this to derive the hash to approve.
     */
    function computeApprovalHash(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation
    ) external pure returns (bytes32) {
        return keccak256(abi.encode(to, value, data, operation));
    }

    /**
     * @notice Check whether an approval is currently valid.
     */
    function isApprovalValid(bytes32 approvalHash) external view returns (bool) {
        uint256 validUntil = approvals[approvalHash];
        return validUntil != 0 && block.number <= validUntil;
    }
}
