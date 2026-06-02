// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/AgentExecutorModule.sol";

// ── Minimal Safe mock ─────────────────────────────────────────
// Tracks calls to execTransactionFromModule and controls return value.
contract MockSafe {
    bool public returnSuccess = true;
    uint256 public callCount;
    address public lastTo;
    bytes  public lastData;
    uint8  public lastOperation;

    function execTransactionFromModule(
        address to,
        uint256,
        bytes calldata data,
        uint8 operation
    ) external returns (bool) {
        callCount++;
        lastTo        = to;
        lastData      = data;
        lastOperation = operation;
        return returnSuccess;
    }

    function setReturnSuccess(bool v) external { returnSuccess = v; }
}

// ─────────────────────────────────────────────────────────────

contract AgentExecutorModuleTest is Test {
    AgentExecutorModule public module;
    MockSafe            public safe;

    address public executor  = makeAddr("executor");
    address public stranger  = makeAddr("stranger");

    // Dummy tx fields reused across tests
    address constant TARGET    = address(0xABCD);
    uint256 constant VALUE     = 0;
    bytes   constant DATA      = hex"deadbeef";
    uint8   constant OPERATION = 0;
    bytes32 constant SIM_ID    = bytes32("sim_abc123");

    function setUp() public {
        safe   = new MockSafe();
        module = new AgentExecutorModule(address(safe), executor);
    }

    // ── Helper ────────────────────────────────────────────────

    function _approvalHash() internal pure returns (bytes32) {
        return keccak256(abi.encode(TARGET, VALUE, DATA, OPERATION));
    }

    function _approveNow(uint256 windowBlocks) internal {
        vm.prank(address(safe));
        module.approveCalldata(_approvalHash(), block.number + windowBlocks);
    }

    // ─────────────────────────────────────────────────────────
    // Test 1: Non-Safe address cannot approve calldata
    // ─────────────────────────────────────────────────────────
    function test_approveCalldata_revertsForNonSafe() public {
        bytes32 h = _approvalHash();
        vm.prank(stranger);
        vm.expectRevert(AgentExecutorModule.NotSafe.selector);
        module.approveCalldata(h, block.number + 100);
    }

    // ─────────────────────────────────────────────────────────
    // Test 2: Safe can approve and hash is stored correctly
    // ─────────────────────────────────────────────────────────
    function test_approveCalldata_storesHash() public {
        bytes32 h = _approvalHash();
        uint256 validUntil = block.number + 300;

        vm.prank(address(safe));
        vm.expectEmit(true, false, false, true);
        emit AgentExecutorModule.CalldataApproved(h, validUntil);
        module.approveCalldata(h, validUntil);

        assertEq(module.approvals(h), validUntil);
        assertTrue(module.isApprovalValid(h));
    }

    // ─────────────────────────────────────────────────────────
    // Test 3: Executor successfully runs an approved tx
    // ─────────────────────────────────────────────────────────
    function test_execute_success() public {
        _approveNow(300);

        vm.prank(executor);
        vm.expectEmit(true, true, false, false);
        emit AgentExecutorModule.CalldataExecuted(_approvalHash(), SIM_ID);
        module.execute(TARGET, VALUE, DATA, OPERATION, SIM_ID);

        // Safe received the call
        assertEq(safe.callCount(),     1);
        assertEq(safe.lastTo(),        TARGET);
        assertEq(safe.lastOperation(), OPERATION);

        // Approval consumed — cannot reuse
        assertEq(module.approvals(_approvalHash()), 0);
    }

    // ─────────────────────────────────────────────────────────
    // Test 4: Executor cannot run a hash that was never approved
    // ─────────────────────────────────────────────────────────
    function test_execute_revertsIfHashNotApproved() public {
        // No approveCalldata call — approval mapping is empty
        vm.prank(executor);
        vm.expectRevert(
            abi.encodeWithSelector(AgentExecutorModule.HashNotApproved.selector, _approvalHash())
        );
        module.execute(TARGET, VALUE, DATA, OPERATION, SIM_ID);
    }

    // ─────────────────────────────────────────────────────────
    // Test 5: Expired approval cannot be executed
    // ─────────────────────────────────────────────────────────
    function test_execute_revertsIfExpired() public {
        // Approve with a 10-block window, then roll past it
        _approveNow(10);
        vm.roll(block.number + 11);

        vm.prank(executor);
        bytes32 h = _approvalHash();
        vm.expectRevert(
            abi.encodeWithSelector(
                AgentExecutorModule.ApprovalExpired.selector,
                h,
                block.number - 1,  // validUntil was (roll_start + 10)
                block.number
            )
        );
        module.execute(TARGET, VALUE, DATA, OPERATION, SIM_ID);
    }

    // ─────────────────────────────────────────────────────────
    // Test 6: Approval is one-use — second execute reverts
    // ─────────────────────────────────────────────────────────
    function test_execute_isOneUse() public {
        _approveNow(300);

        // First execution succeeds
        vm.prank(executor);
        module.execute(TARGET, VALUE, DATA, OPERATION, SIM_ID);
        assertEq(safe.callCount(), 1);

        // Second execution with the same calldata reverts
        vm.prank(executor);
        vm.expectRevert(
            abi.encodeWithSelector(AgentExecutorModule.HashNotApproved.selector, _approvalHash())
        );
        module.execute(TARGET, VALUE, DATA, OPERATION, SIM_ID);
        assertEq(safe.callCount(), 1); // Safe not called again
    }
}
