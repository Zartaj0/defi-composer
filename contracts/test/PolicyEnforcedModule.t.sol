// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/PolicyEnforcedModule.sol";

/// @dev Minimal Safe stub — tracks module-initiated calls
contract MockSafe {
    address public lastTo;
    bytes   public lastData;
    bool    public shouldFail;

    function execTransactionFromModule(
        address to,
        uint256,
        bytes calldata data,
        uint8
    ) external returns (bool) {
        if (shouldFail) return false;
        lastTo   = to;
        lastData = data;
        return true;
    }

    function setFail(bool _fail) external { shouldFail = _fail; }
}

/// @dev Minimal USDC stub for reserve-floor tests
contract MockUSDC {
    mapping(address => uint256) public balanceOf;

    function setBalance(address account, uint256 amount) external {
        balanceOf[account] = amount;
    }
}

/// @dev Helper: build a MultiSend packed transaction entry
function packMultiSendCall(
    address to,
    bytes memory data,
    uint256 value
) pure returns (bytes memory) {
    return abi.encodePacked(
        uint8(0),     // operation: CALL
        to,           // 20 bytes
        value,        // 32 bytes
        data.length,  // 32 bytes (dataLen)
        data          // N bytes
    );
}

/// @dev Build a full multiSend(bytes) calldata from packed entries
function encodeMultiSend(bytes[] memory entries) pure returns (bytes memory) {
    bytes memory packed;
    for (uint256 i = 0; i < entries.length; i++) {
        packed = abi.encodePacked(packed, entries[i]);
    }
    // multiSend(bytes transactions) — selector 0x8d80ff0a
    return abi.encodeWithSelector(bytes4(0x8d80ff0a), packed);
}

contract PolicyEnforcedModuleTest is Test {
    PolicyEnforcedModule module;
    MockSafe             safe;
    MockUSDC             usdc;

    address executor     = address(0xE0EC);
    address aavePool     = address(0xAA1E);
    address morphoMarket = address(0xBEEF);
    address attacker     = address(0xBAD);
    address multiSend    = address(0x1234);

    // Policy params (6-decimal USDC)
    uint256 constant MAX_SINGLE   = 500e6;    // $500
    uint256 constant DAILY_LIMIT  = 2000e6;  // $2,000
    uint256 constant RESERVE_FLOOR = 100e6;  // $100

    // Common selectors
    bytes4 constant SEL_SUPPLY   = bytes4(keccak256("supply(address,uint256,address,uint16)"));
    bytes4 constant SEL_WITHDRAW = bytes4(keccak256("withdraw(address,uint256,address)"));
    bytes4 constant SEL_APPROVE  = bytes4(keccak256("approve(address,uint256)"));

    function setUp() public {
        safe = new MockSafe();
        usdc = new MockUSDC();
        module = new PolicyEnforcedModule(address(safe), executor);

        // Set policy as Safe
        vm.prank(address(safe));
        module.setPolicy(MAX_SINGLE, DAILY_LIMIT, RESERVE_FLOOR);

        // Set USDC token
        vm.prank(address(safe));
        module.setUsdcToken(address(usdc));

        // Approve targets as Safe
        vm.startPrank(address(safe));
        module.addApprovedTarget(aavePool);
        module.addApprovedTarget(morphoMarket);
        module.addApprovedTarget(multiSend);
        vm.stopPrank();

        // Give Safe enough USDC for reserve floor + first action by default
        usdc.setBalance(address(safe), 1000e6); // $1,000 liquid
    }

    // ── Construction ──────────────────────────────────────────

    function test_constructor_setsImmutables() public view {
        assertEq(module.SAFE(),     address(safe));
        assertEq(module.executor(), executor);
    }

    function test_constructor_revertZeroSafe() public {
        vm.expectRevert(PolicyEnforcedModule.ZeroAddress.selector);
        new PolicyEnforcedModule(address(0), executor);
    }

    function test_constructor_revertZeroExecutor() public {
        vm.expectRevert(PolicyEnforcedModule.ZeroAddress.selector);
        new PolicyEnforcedModule(address(safe), address(0));
    }

    // ── Policy management (onlySafe) ──────────────────────────

    function test_setPolicy_storesValues() public view {
        (bool active, uint256 maxSingle, uint256 daily, uint256 floor) = module.policy();
        assertTrue(active);
        assertEq(maxSingle, MAX_SINGLE);
        assertEq(daily,     DAILY_LIMIT);
        assertEq(floor,     RESERVE_FLOOR);
    }

    function test_setPolicy_revertNotSafe() public {
        vm.prank(attacker);
        vm.expectRevert(PolicyEnforcedModule.NotSafe.selector);
        module.setPolicy(MAX_SINGLE, DAILY_LIMIT, RESERVE_FLOOR);
    }

    function test_setPolicy_revertDailyLessThanSingle() public {
        vm.prank(address(safe));
        vm.expectRevert(bytes("daily<single"));
        module.setPolicy(500e6, 400e6, 0);
    }

    function test_pauseAndResume() public {
        vm.prank(address(safe));
        module.pausePolicy();
        (bool active,,,) = module.policy();
        assertFalse(active);

        vm.prank(address(safe));
        module.resumePolicy();
        (active,,,) = module.policy();
        assertTrue(active);
    }

    function test_pause_revertNotSafe() public {
        vm.prank(attacker);
        vm.expectRevert(PolicyEnforcedModule.NotSafe.selector);
        module.pausePolicy();
    }

    function test_approveTarget() public {
        address newTarget = address(0x1111111111111111111111111111111111111111);
        vm.prank(address(safe));
        module.addApprovedTarget(newTarget);
        assertTrue(module.approvedTargets(newTarget));
    }

    function test_revokeTarget() public {
        vm.prank(address(safe));
        module.removeApprovedTarget(aavePool);
        assertFalse(module.approvedTargets(aavePool));
    }

    function test_setExecutor() public {
        address newExec = address(0x2222222222222222222222222222222222222222);
        vm.prank(address(safe));
        module.setExecutor(newExec);
        assertEq(module.executor(), newExec);
    }

    // ── setUsdcToken ──────────────────────────────────────────

    function test_setUsdcToken_storesAddress() public view {
        assertEq(module.usdcToken(), address(usdc));
    }

    function test_setUsdcToken_revertNotSafe() public {
        vm.prank(attacker);
        vm.expectRevert(PolicyEnforcedModule.NotSafe.selector);
        module.setUsdcToken(address(usdc));
    }

    function test_setUsdcToken_zeroDisablesFloorCheck() public {
        // Set zero to disable floor check
        vm.prank(address(safe));
        module.setUsdcToken(address(0));

        // Set Safe balance to zero — would fail if floor check ran
        usdc.setBalance(address(safe), 0);

        vm.prank(executor);
        module.execute(aavePool, 0, hex"", 0, bytes32(0), 100e6);
        // Passes because floor check is skipped when usdcToken == address(0)
    }

    // ── Execute: happy path ───────────────────────────────────

    function test_execute_happyPath() public {
        bytes memory data = abi.encodeWithSignature(
            "supply(address,uint256,address,uint16)",
            address(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913), 100e6, address(safe), 0
        );
        bytes32 simId = keccak256("sim-1");

        vm.prank(executor);
        module.execute(aavePool, 0, data, 0, simId, 100e6);

        assertEq(safe.lastTo(), aavePool);
        assertEq(module.periodSpend(), 100e6);
    }

    function test_execute_updatesSpend() public {
        vm.prank(executor);
        module.execute(aavePool, 0, hex"", 0, bytes32(0), 200e6);
        assertEq(module.periodSpend(), 200e6);

        vm.prank(executor);
        module.execute(morphoMarket, 0, hex"", 0, bytes32(0), 300e6);
        assertEq(module.periodSpend(), 500e6);
    }

    // ── Execute: access control ───────────────────────────────

    function test_execute_revertNotExecutor() public {
        vm.prank(attacker);
        vm.expectRevert(PolicyEnforcedModule.NotExecutor.selector);
        module.execute(aavePool, 0, hex"", 0, bytes32(0), 100e6);
    }

    // ── Execute: policy checks ────────────────────────────────

    function test_execute_revertPolicyPaused() public {
        vm.prank(address(safe));
        module.pausePolicy();

        vm.prank(executor);
        vm.expectRevert(PolicyEnforcedModule.PolicyNotActive.selector);
        module.execute(aavePool, 0, hex"", 0, bytes32(0), 100e6);
    }

    function test_execute_revertTargetNotApproved() public {
        vm.prank(executor);
        vm.expectRevert(
            abi.encodeWithSelector(PolicyEnforcedModule.TargetNotApproved.selector, attacker)
        );
        module.execute(attacker, 0, hex"", 0, bytes32(0), 100e6);
    }

    function test_execute_revertExceedsMaxSingle() public {
        vm.prank(executor);
        vm.expectRevert(
            abi.encodeWithSelector(
                PolicyEnforcedModule.ExceedsMaxSingleAction.selector,
                501e6, MAX_SINGLE
            )
        );
        module.execute(aavePool, 0, hex"", 0, bytes32(0), 501e6);
    }

    function test_execute_exactlyMaxSinglePasses() public {
        vm.prank(executor);
        module.execute(aavePool, 0, hex"", 0, bytes32(0), MAX_SINGLE);
        assertEq(module.periodSpend(), MAX_SINGLE);
    }

    function test_execute_revertExceedsDailyLimit() public {
        vm.prank(executor);
        module.execute(aavePool, 0, hex"", 0, bytes32(0), MAX_SINGLE); // $500

        vm.prank(executor);
        module.execute(aavePool, 0, hex"", 0, bytes32(0), MAX_SINGLE); // $1000

        vm.prank(executor);
        module.execute(aavePool, 0, hex"", 0, bytes32(0), MAX_SINGLE); // $1500

        vm.prank(executor);
        module.execute(aavePool, 0, hex"", 0, bytes32(0), MAX_SINGLE); // $2000 — exact limit

        // Next $1 should fail
        vm.prank(executor);
        vm.expectRevert(
            abi.encodeWithSelector(
                PolicyEnforcedModule.ExceedsDailyLimit.selector,
                1e6, 0
            )
        );
        module.execute(aavePool, 0, hex"", 0, bytes32(0), 1e6);
    }

    function test_execute_dailyLimitResetsAfter24h() public {
        vm.startPrank(executor);
        module.execute(aavePool, 0, hex"", 0, bytes32(0), MAX_SINGLE);
        module.execute(aavePool, 0, hex"", 0, bytes32(0), MAX_SINGLE);
        module.execute(aavePool, 0, hex"", 0, bytes32(0), MAX_SINGLE);
        module.execute(aavePool, 0, hex"", 0, bytes32(0), MAX_SINGLE);
        vm.stopPrank();

        assertEq(module.periodSpend(), DAILY_LIMIT);

        vm.warp(block.timestamp + 1 days + 1);

        vm.prank(executor);
        module.execute(aavePool, 0, hex"", 0, bytes32(0), MAX_SINGLE);
        assertEq(module.periodSpend(), MAX_SINGLE);
    }

    function test_execute_revertSafeFails() public {
        safe.setFail(true);
        vm.prank(executor);
        vm.expectRevert(PolicyEnforcedModule.ExecutionFailed.selector);
        module.execute(aavePool, 0, hex"", 0, bytes32(0), 100e6);
    }

    // On Safe failure the whole tx reverts — periodSpend is not consumed.
    function test_execute_spendNotRecordedOnSafeFailure() public {
        safe.setFail(true);
        vm.prank(executor);
        vm.expectRevert(PolicyEnforcedModule.ExecutionFailed.selector);
        module.execute(aavePool, 0, hex"", 0, bytes32(0), 100e6);
        assertEq(module.periodSpend(), 0);
    }

    // ── Reserve floor enforcement ─────────────────────────────

    function test_reserveFloor_passesBelowLimit() public {
        // Safe has $1000, reserve $100, spending $100 → $800 remaining ≥ $100 floor ✓
        usdc.setBalance(address(safe), 1000e6);
        vm.prank(executor);
        module.execute(aavePool, 0, hex"", 0, bytes32(0), 100e6);
        assertEq(module.periodSpend(), 100e6);
    }

    function test_reserveFloor_exactlyAtLimit() public {
        // Safe has exactly floor + amount: floor=$100 + amount=$100 → balance=$200 required
        usdc.setBalance(address(safe), 200e6);
        vm.prank(executor);
        module.execute(aavePool, 0, hex"", 0, bytes32(0), 100e6);
        assertEq(module.periodSpend(), 100e6);
    }

    function test_reserveFloor_revertsBelowRequired() public {
        // Safe has $150; floor=$100, spending $100 → need $200 but only $150 available
        usdc.setBalance(address(safe), 150e6);
        vm.prank(executor);
        vm.expectRevert(
            abi.encodeWithSelector(
                PolicyEnforcedModule.InsufficientReserve.selector,
                150e6, 200e6   // available, required
            )
        );
        module.execute(aavePool, 0, hex"", 0, bytes32(0), 100e6);
    }

    function test_reserveFloor_skippedWhenUsdcTokenZero() public {
        vm.prank(address(safe));
        module.setUsdcToken(address(0));

        usdc.setBalance(address(safe), 0); // no USDC — would fail if check ran
        vm.prank(executor);
        module.execute(aavePool, 0, hex"", 0, bytes32(0), 50e6);
    }

    function test_reserveFloor_skippedWhenFloorZero() public {
        // Deploy a fresh module with floor=0
        PolicyEnforcedModule m2 = new PolicyEnforcedModule(address(safe), executor);
        vm.startPrank(address(safe));
        m2.setPolicy(MAX_SINGLE, DAILY_LIMIT, 0);
        m2.setUsdcToken(address(usdc));
        m2.addApprovedTarget(aavePool);
        vm.stopPrank();

        usdc.setBalance(address(safe), 0); // no USDC
        vm.prank(executor);
        m2.execute(aavePool, 0, hex"", 0, bytes32(0), 50e6);
    }

    // ── Selector guard ────────────────────────────────────────

    function test_selectorGuard_inactiveByDefault() public {
        // No selectors approved for aavePool → guard off → any calldata passes
        bytes memory data = abi.encodeWithSignature("randomFunction()");
        vm.prank(executor);
        module.execute(aavePool, 0, data, 0, bytes32(0), 50e6);
    }

    function test_selectorGuard_activatesOnFirstApprove() public {
        vm.prank(address(safe));
        module.approveSelector(aavePool, SEL_SUPPLY);

        assertTrue(module.selectorGuardEnabled(aavePool));
        assertTrue(module.approvedSelectors(aavePool, SEL_SUPPLY));
    }

    function test_selectorGuard_allowsApprovedSelector() public {
        vm.prank(address(safe));
        module.approveSelector(aavePool, SEL_SUPPLY);

        bytes memory data = abi.encodeWithSelector(SEL_SUPPLY, address(0), 100e6, address(safe), 0);
        vm.prank(executor);
        module.execute(aavePool, 0, data, 0, bytes32(0), 100e6);
    }

    function test_selectorGuard_rejectsUnapprovedSelector() public {
        vm.prank(address(safe));
        module.approveSelector(aavePool, SEL_SUPPLY); // only supply approved, not withdraw

        bytes memory data = abi.encodeWithSelector(SEL_WITHDRAW, address(0), 100e6, address(safe));
        vm.prank(executor);
        vm.expectRevert(
            abi.encodeWithSelector(
                PolicyEnforcedModule.SelectorNotApproved.selector,
                aavePool, SEL_WITHDRAW
            )
        );
        module.execute(aavePool, 0, data, 0, bytes32(0), 100e6);
    }

    function test_selectorGuard_skipsCheckForEmptyData() public {
        vm.prank(address(safe));
        module.approveSelector(aavePool, SEL_SUPPLY);

        // data.length < 4 → no selector → check skipped
        vm.prank(executor);
        module.execute(aavePool, 0, hex"", 0, bytes32(0), 50e6);
    }

    function test_selectorGuard_revokeWorks() public {
        vm.startPrank(address(safe));
        module.approveSelector(aavePool, SEL_SUPPLY);
        module.revokeSelector(aavePool, SEL_SUPPLY);
        vm.stopPrank();

        assertFalse(module.approvedSelectors(aavePool, SEL_SUPPLY));
        // Guard is still enabled — revoke doesn't flip selectorGuardEnabled
        assertTrue(module.selectorGuardEnabled(aavePool));

        // Calling with the revoked selector now fails
        bytes memory data = abi.encodeWithSelector(SEL_SUPPLY, address(0), 100e6, address(safe), 0);
        vm.prank(executor);
        vm.expectRevert(
            abi.encodeWithSelector(
                PolicyEnforcedModule.SelectorNotApproved.selector,
                aavePool, SEL_SUPPLY
            )
        );
        module.execute(aavePool, 0, data, 0, bytes32(0), 100e6);
    }

    function test_selectorGuard_revertNotSafe() public {
        vm.prank(attacker);
        vm.expectRevert(PolicyEnforcedModule.NotSafe.selector);
        module.approveSelector(aavePool, SEL_SUPPLY);
    }

    // ── MultiSend inner-call validation ───────────────────────

    function test_multiSend_happyPath_noSelectorGuard() public {
        // Both inner targets approved, no selector guard → passes
        bytes[] memory entries = new bytes[](2);
        entries[0] = packMultiSendCall(address(usdc), abi.encodeWithSelector(SEL_APPROVE, aavePool, 100e6), 0);
        entries[1] = packMultiSendCall(aavePool,      abi.encodeWithSelector(SEL_SUPPLY,  address(usdc), 100e6, address(safe), uint16(0)), 0);

        // Add usdc as approved target for this test
        vm.prank(address(safe));
        module.addApprovedTarget(address(usdc));

        bytes memory data = encodeMultiSend(entries);
        vm.prank(executor);
        module.execute(multiSend, 0, data, 1, bytes32(0), 100e6);
    }

    function test_multiSend_happyPath_withSelectorGuard() public {
        // Add USDC target and approve selectors
        vm.startPrank(address(safe));
        module.addApprovedTarget(address(usdc));
        module.approveSelector(address(usdc), SEL_APPROVE);
        module.approveSelector(aavePool,      SEL_SUPPLY);
        vm.stopPrank();

        bytes[] memory entries = new bytes[](2);
        entries[0] = packMultiSendCall(address(usdc), abi.encodeWithSelector(SEL_APPROVE, aavePool, 100e6), 0);
        entries[1] = packMultiSendCall(aavePool,      abi.encodeWithSelector(SEL_SUPPLY,  address(usdc), 100e6, address(safe), uint16(0)), 0);

        bytes memory data = encodeMultiSend(entries);
        vm.prank(executor);
        module.execute(multiSend, 0, data, 1, bytes32(0), 100e6);
        assertEq(module.periodSpend(), 100e6);
    }

    function test_multiSend_revertInnerTargetNotApproved() public {
        // Second inner call goes to an unapproved target
        bytes[] memory entries = new bytes[](2);
        entries[0] = packMultiSendCall(aavePool,  abi.encodeWithSelector(SEL_SUPPLY, address(usdc), 100e6, address(safe), uint16(0)), 0);
        entries[1] = packMultiSendCall(attacker,  hex"", 0);  // NOT approved

        bytes memory data = encodeMultiSend(entries);
        vm.prank(executor);
        vm.expectRevert(
            abi.encodeWithSelector(PolicyEnforcedModule.TargetNotApproved.selector, attacker)
        );
        module.execute(multiSend, 0, data, 1, bytes32(0), 100e6);
    }

    function test_multiSend_revertInnerSelectorNotApproved() public {
        // Approve target but activate selector guard with only supply; withdraw is rejected
        vm.startPrank(address(safe));
        module.approveSelector(aavePool, SEL_SUPPLY);
        vm.stopPrank();

        bytes[] memory entries = new bytes[](1);
        entries[0] = packMultiSendCall(aavePool, abi.encodeWithSelector(SEL_WITHDRAW, address(usdc), 100e6, address(safe)), 0);

        bytes memory data = encodeMultiSend(entries);
        vm.prank(executor);
        vm.expectRevert(
            abi.encodeWithSelector(
                PolicyEnforcedModule.SelectorNotApproved.selector,
                aavePool, SEL_WITHDRAW
            )
        );
        module.execute(multiSend, 0, data, 1, bytes32(0), 100e6);
    }

    function test_multiSend_revertTooShort() public {
        // data shorter than 68-byte minimum
        bytes memory data = hex"deadbeef";
        vm.prank(executor);
        vm.expectRevert(PolicyEnforcedModule.InvalidCalldata.selector);
        module.execute(multiSend, 0, data, 1, bytes32(0), 100e6);
    }

    // ── View helpers ──────────────────────────────────────────

    function test_remainingDailyLimit_full() public view {
        assertEq(module.remainingDailyLimit(), DAILY_LIMIT);
    }

    function test_remainingDailyLimit_afterSpend() public {
        vm.prank(executor);
        module.execute(aavePool, 0, hex"", 0, bytes32(0), 300e6);
        assertEq(module.remainingDailyLimit(), DAILY_LIMIT - 300e6);
    }

    function test_remainingDailyLimit_afterWindowReset() public {
        vm.prank(executor);
        module.execute(aavePool, 0, hex"", 0, bytes32(0), 500e6);

        vm.warp(block.timestamp + 1 days + 1);
        assertEq(module.remainingDailyLimit(), DAILY_LIMIT);
    }

    function test_canExecute_returnsTrue() public view {
        (bool ok, string memory reason) = module.canExecute(aavePool, 100e6);
        assertTrue(ok);
        assertEq(reason, "");
    }

    function test_canExecute_paused() public {
        vm.prank(address(safe));
        module.pausePolicy();
        (bool ok, string memory reason) = module.canExecute(aavePool, 100e6);
        assertFalse(ok);
        assertEq(reason, "policy paused");
    }

    function test_canExecute_badTarget() public view {
        (bool ok, string memory reason) = module.canExecute(attacker, 100e6);
        assertFalse(ok);
        assertEq(reason, "target not approved");
    }

    function test_canExecute_exceedsSingle() public view {
        (bool ok, string memory reason) = module.canExecute(aavePool, MAX_SINGLE + 1);
        assertFalse(ok);
        assertEq(reason, "exceeds maxSingleAction");
    }

    function test_canExecute_exceedsDaily() public {
        vm.startPrank(executor);
        module.execute(aavePool, 0, hex"", 0, bytes32(0), MAX_SINGLE);
        module.execute(aavePool, 0, hex"", 0, bytes32(0), MAX_SINGLE);
        module.execute(aavePool, 0, hex"", 0, bytes32(0), MAX_SINGLE);
        module.execute(aavePool, 0, hex"", 0, bytes32(0), MAX_SINGLE);
        vm.stopPrank();

        (bool ok, string memory reason) = module.canExecute(aavePool, 1e6);
        assertFalse(ok);
        assertEq(reason, "exceeds daily limit");
    }

    // ── Fuzz ─────────────────────────────────────────────────

    function testFuzz_execute_neverExceedsDaily(uint256 amount, uint8 reps) public {
        amount = bound(amount, 1e6, MAX_SINGLE);   // $1 minimum
        reps   = uint8(bound(reps, 1, 10));        // max 10 runs per fuzz case

        uint256 spent = 0;
        for (uint8 i = 0; i < reps; i++) {
            if (spent + amount > DAILY_LIMIT) {
                vm.prank(executor);
                vm.expectRevert();
                module.execute(aavePool, 0, hex"", 0, bytes32(0), amount);
                break;
            }
            vm.prank(executor);
            module.execute(aavePool, 0, hex"", 0, bytes32(0), amount);
            spent += amount;
        }

        assertEq(module.periodSpend(), spent);
        assertLe(module.periodSpend(), DAILY_LIMIT);
    }

    function testFuzz_reserveFloor_neverDipsBelow(uint256 balance, uint256 amount) public {
        uint256 floor  = RESERVE_FLOOR; // 100e6
        amount = bound(amount, 1e6, MAX_SINGLE);
        balance = bound(balance, 0, 2000e6);

        usdc.setBalance(address(safe), balance);

        vm.prank(executor);
        if (balance < floor + amount) {
            vm.expectRevert(
                abi.encodeWithSelector(
                    PolicyEnforcedModule.InsufficientReserve.selector,
                    balance, floor + amount
                )
            );
            module.execute(aavePool, 0, hex"", 0, bytes32(0), amount);
        } else {
            module.execute(aavePool, 0, hex"", 0, bytes32(0), amount);
        }
    }
}
