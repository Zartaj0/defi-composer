// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/PolicyEnforcedModule.sol";

/**
 * @notice Deploy PolicyEnforcedModule to Base Sepolia.
 *
 * Required env vars (set in .env):
 *   EXECUTOR_PRIVATE_KEY  — deployer + initial executor EOA
 *   SAFE_ADDRESS          — Safe that will own the module
 *   EXECUTOR_ADDRESS      — EOA allowed to call execute() (same as deployer)
 *
 * Usage:
 *   forge script contracts/script/DeployPolicyEnforcedModule.s.sol \
 *     --rpc-url $BASE_RPC_URL_SEPOLIA \
 *     --broadcast
 *
 * After deploy, submit a Safe tx to:
 *   1. safe.enableModule(moduleAddress)
 *   2. module.setPolicy(maxSingleActionUsdc, dailyLimitUsdc, reserveFloorUsdc)
 *   3. module.addApprovedTarget(aavePool)
 *   4. module.addApprovedTarget(multiSendCallOnly)
 */
contract DeployPolicyEnforcedModule is Script {
    function run() external {
        address safe = vm.envAddress("SAFE_ADDRESS");
        address exec = vm.envAddress("EXECUTOR_ADDRESS");

        console.log("Deploying PolicyEnforcedModule...");
        console.log("  SAFE:     ", safe);
        console.log("  EXECUTOR: ", exec);

        vm.startBroadcast();
        PolicyEnforcedModule module = new PolicyEnforcedModule(safe, exec);
        vm.stopBroadcast();

        console.log("");
        console.log("Deployed PolicyEnforcedModule at:", address(module));
        console.log("");
        console.log("=== NEXT: Submit these Safe transactions ===");
        console.log("");
        console.log("1) Enable module on Safe:");
        console.log("   safe.enableModule(", address(module), ")");
        console.log("");
        console.log("2) Set policy (adjust amounts as needed):");
        console.log("   module.setPolicy(");
        console.log("     maxSingleActionUsdc: 100_000_000,  // $100 USDC");
        console.log("     dailyLimitUsdc:      500_000_000,  // $500/day");
        console.log("     reserveFloorUsdc:     50_000_000   // $50 floor");
        console.log("   )");
        console.log("");
        console.log("3) Approve Aave V3 pool on Base Sepolia:");
        console.log("   module.addApprovedTarget(0x07eA79F68B2B3df564D0A34F8e19D9B1e339814b)");
        console.log("");
        console.log("4) Approve MultiSendCallOnly (for batched txs):");
        console.log("   module.addApprovedTarget(0x9641d764fc13c8B624c04430C7356C1C7C8102e2)");
    }
}
