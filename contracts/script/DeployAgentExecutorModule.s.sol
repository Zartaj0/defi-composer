// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/AgentExecutorModule.sol";

/**
 * @notice Deploy AgentExecutorModule to Base Sepolia.
 *
 * Required env vars:
 *   EXECUTOR_PRIVATE_KEY  — deployer and initial executor EOA (without 0x is fine)
 *   SAFE_ADDRESS          — Safe that will own the module
 *   EXECUTOR_ADDRESS      — EOA allowed to call execute() (usually same as deployer)
 *
 * Usage:
 *   forge script contracts/script/DeployAgentExecutorModule.s.sol \
 *     --rpc-url https://sepolia.base.org \
 *     --broadcast \
 *     --verify
 */
contract DeployAgentExecutorModule is Script {
    function run() external {
        string memory rawKey = vm.envString("EXECUTOR_PRIVATE_KEY");
        // Normalise: accept keys with or without 0x prefix
        bytes memory keyBytes = bytes(rawKey);
        uint256 deployerKey;
        if (keyBytes.length == 64) {
            // No 0x prefix — prepend it for vm.parseUint
            deployerKey = vm.parseUint(string(abi.encodePacked("0x", rawKey)));
        } else {
            deployerKey = vm.parseUint(rawKey);
        }

        address safe     = vm.envAddress("SAFE_ADDRESS");
        address exec     = vm.envAddress("EXECUTOR_ADDRESS");

        console.log("Deploying AgentExecutorModule...");
        console.log("  SAFE:     ", safe);
        console.log("  EXECUTOR: ", exec);

        vm.startBroadcast(deployerKey);
        AgentExecutorModule module = new AgentExecutorModule(safe, exec);
        vm.stopBroadcast();

        console.log("Deployed at:", address(module));
        console.log("");
        console.log("Next step: install on Safe via Safe UI");
        console.log("  Call: Safe.enableModule(", address(module), ")");
    }
}
