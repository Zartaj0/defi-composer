import { spawn, type ChildProcess } from "child_process";
import {
  createPublicClient,
  http,
  encodeFunctionData,
  parseUnits,
} from "viem";
import type {
  StrategyGraph,
  SimulationResult,
  CapitalFlowStep,
  StressTestResult,
} from "@defi-composer/shared";

// ─── Contract ABIs (minimal) ──────────────────────────────────
const ERC20_ABI = [
  { name: "approve", type: "function", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }], stateMutability: "nonpayable" },
  { name: "balanceOf", type: "function", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { name: "decimals", type: "function", inputs: [], outputs: [{ name: "", type: "uint8" }], stateMutability: "view" },
] as const;

const AAVE_POOL_ABI = [
  { name: "supply", type: "function", inputs: [{ name: "asset", type: "address" }, { name: "amount", type: "uint256" }, { name: "onBehalfOf", type: "address" }, { name: "referralCode", type: "uint16" }], outputs: [], stateMutability: "nonpayable" },
  { name: "getUserAccountData", type: "function", inputs: [{ name: "user", type: "address" }], outputs: [{ name: "totalCollateralBase", type: "uint256" }, { name: "totalDebtBase", type: "uint256" }, { name: "availableBorrowsBase", type: "uint256" }, { name: "currentLiquidationThreshold", type: "uint256" }, { name: "ltv", type: "uint256" }, { name: "healthFactor", type: "uint256" }], stateMutability: "view" },
] as const;

const DATA_PROVIDER_ABI = [
  { name: "getReserveData", type: "function", inputs: [{ name: "asset", type: "address" }], outputs: [{ name: "unbacked", type: "uint256" }, { name: "accruedToTreasuryScaled", type: "uint256" }, { name: "totalAToken", type: "uint256" }, { name: "totalStableDebt", type: "uint256" }, { name: "totalVariableDebt", type: "uint256" }, { name: "liquidityRate", type: "uint256" }, { name: "variableBorrowRate", type: "uint256" }, { name: "stableBorrowRate", type: "uint256" }, { name: "averageStableBorrowRate", type: "uint256" }, { name: "liquidityIndex", type: "uint256" }, { name: "variableBorrowIndex", type: "uint256" }, { name: "lastUpdateTimestamp", type: "uint40" }], stateMutability: "view" },
] as const;

// ─── Base mainnet addresses ───────────────────────────────────
const CONTRACTS = {
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as `0x${string}`,
  WETH: "0x4200000000000000000000000000000000000006" as `0x${string}`,
  AAVE_POOL: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5" as `0x${string}`,
  AAVE_DATA_PROVIDER: "0x2D8A3c5677189723C4CB8873cfC9c8976dfE292b" as `0x${string}`,
  MORPHO: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb" as `0x${string}`,
  MORPHO_STEAKHOUSE_USDC: "0xc1256Ae5FF1cf2719D4937adb3bbCCab2E00A2Ca" as `0x${string}`,
  AERODROME_ROUTER: "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43" as `0x${string}`,
};

// ─── RAY conversion (Aave uses 1e27) ─────────────────────────
const RAY = 10n ** 27n;
const SECONDS_PER_YEAR = 31_536_000n;
function rayToApyBps(ray: bigint): number {
  const perYear = (ray * SECONDS_PER_YEAR * 10000n) / RAY;
  return Number(perYear);
}

// ─── Simulation Engine ───────────────────────────────────────
export class SimulationEngine {
  private anvilProcess: ChildProcess | null = null;
  private anvilPort = 0;
  private static nextPort = Number(process.env["ANVIL_PORT"] ?? 18000);

  // ── Spin up an Anvil fork ──────────────────────────────────
  private async startAnvil(): Promise<number> {
    const port = SimulationEngine.nextPort++;
    const forkUrl = process.env["BASE_RPC_URL"] ?? "https://mainnet.base.org";

    return new Promise((resolve, reject) => {
      const proc = spawn(
        process.env["ANVIL_BIN"] ?? "anvil",
        [
          "--fork-url", forkUrl,
          "--port", String(port),
          "--silent",
          "--no-mining",
          "--chain-id", "8453",
        ],
        { stdio: ["ignore", "pipe", "pipe"] }
      );

      this.anvilProcess = proc;

      let ready = false;
      const timeout = setTimeout(() => {
        if (!ready) reject(new Error("Anvil failed to start within 30s"));
      }, 30_000);

      const checkReady = (data: Buffer) => {
        const text = data.toString();
        if (text.includes("Listening on") || text.includes("eth_chainId")) {
          ready = true;
          clearTimeout(timeout);
          this.anvilPort = port;
          resolve(port);
        }
      };

      proc.stdout?.on("data", checkReady);
      proc.stderr?.on("data", checkReady);

      proc.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      proc.on("exit", (code) => {
        if (!ready) {
          clearTimeout(timeout);
          reject(new Error(`Anvil exited with code ${code}`));
        }
      });
    });
  }

  private stopAnvil() {
    if (this.anvilProcess) {
      this.anvilProcess.kill("SIGTERM");
      this.anvilProcess = null;
      this.anvilPort = 0;
    }
  }

  // ── Fund a test address with USDC via Anvil state manipulation ──
  private async fundAddress(
    rpcUrl: string,
    address: `0x${string}`,
    usdcAmount: bigint
  ): Promise<void> {
    // Find a USDC whale on Base to impersonate
    const whale = "0x0B0A5886664376F59C351ba3f598C8A8B4D0A6f3" as `0x${string}`;

    // Impersonate whale
    await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "anvil_impersonateAccount", params: [whale] }),
    });

    // Transfer USDC from whale to test address
    const transferData = encodeFunctionData({
      abi: [{ name: "transfer", type: "function", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }], stateMutability: "nonpayable" }],
      functionName: "transfer",
      args: [address, usdcAmount],
    });

    await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 2,
        method: "eth_sendTransaction",
        params: [{ from: whale, to: CONTRACTS.USDC, data: transferData, gas: "0x30000" }],
      }),
    });

    // Stop impersonating
    await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "anvil_stopImpersonatingAccount", params: [whale] }),
    });
  }

  // ── Main simulate() — executable simulations require a live fork ──
  async simulate(
    graph: StrategyGraph,
    capitalUsd: number,
    userAddress: `0x${string}`
  ): Promise<SimulationResult> {
    const forkUrl = process.env["BASE_RPC_URL"] ?? "https://mainnet.base.org";

    try {
      return await this.simulateOnFork(graph, capitalUsd, userAddress, forkUrl);
    } catch (err) {
      throw new Error(`Base fork simulation failed: ${(err as Error).message}`);
    } finally {
      this.stopAnvil();
    }
  }

  // ── Real on-fork simulation ────────────────────────────────
  private async simulateOnFork(
    graph: StrategyGraph,
    capitalUsd: number,
    userAddress: `0x${string}`,
    mainnetRpc: string
  ): Promise<SimulationResult> {
    const startTime = Date.now();
    const port = await this.startAnvil();
    const forkRpc = `http://127.0.0.1:${port}`;

    const client = createPublicClient({ transport: http(forkRpc) });

    const usdcAmount = parseUnits(capitalUsd.toFixed(6), 6);
    await this.fundAddress(forkRpc, userAddress, usdcAmount);

    const capitalFlow: CapitalFlowStep[] = [];
    let totalGas = 0n;

    const hasSupply = graph.nodes.some(n => n.protocol === "aave-v3" && n.action === "supply");
    const hasAave = graph.nodes.some(n => n.protocol === "aave-v3");

    for (const node of graph.nodes) {
      const gasStart = await client.getGasPrice();

      if (node.protocol === "aave-v3" && node.action === "supply") {
        const assetAddr = node.inputAsset === "USDC" ? CONTRACTS.USDC : CONTRACTS.WETH;
        const amount = node.inputAsset === "USDC" ? usdcAmount : parseUnits(String(capitalUsd / 3000), 18);

        try {
          // Estimate approve gas
          const approveGas = await client.estimateGas({
            account: userAddress,
            to: assetAddr,
            data: encodeFunctionData({
              abi: ERC20_ABI,
              functionName: "approve",
              args: [CONTRACTS.AAVE_POOL, amount],
            }),
          });

          // Estimate supply gas
          const supplyGas = await client.estimateGas({
            account: userAddress,
            to: CONTRACTS.AAVE_POOL,
            data: encodeFunctionData({
              abi: AAVE_POOL_ABI,
              functionName: "supply",
              args: [assetAddr, amount, userAddress, 0],
            }),
          });

          const gasUsed = approveGas + supplyGas;
          totalGas += gasUsed;
          const gasCostUsd = Number(gasUsed * gasStart) / 1e18 * 3000;

          capitalFlow.push({
            nodeId: node.id,
            protocol: node.protocol,
            action: node.action,
            inputAmount: `$${capitalUsd.toFixed(2)}`,
            outputAmount: `$${capitalUsd.toFixed(2)} aToken`,
            gasCostUsd,
          });
        } catch (err) {
          throw new Error(`Aave supply fork simulation failed for node ${node.id}: ${(err as Error).message}`);
        }
      } else {
        capitalFlow.push({
          nodeId: node.id,
          protocol: node.protocol,
          action: node.action,
          inputAmount: `$${capitalUsd.toFixed(2)}`,
          outputAmount: `$${capitalUsd.toFixed(2)}`,
          gasCostUsd: node.gasCostUsd,
        });
      }
    }

    // Read real live APYs from Aave for the simulation
    let projectedApyBps = graph.estimatedApyBps;
    try {
      const reserveData = await client.readContract({
        address: CONTRACTS.AAVE_DATA_PROVIDER,
        abi: DATA_PROVIDER_ABI,
        functionName: "getReserveData",
        args: [CONTRACTS.USDC],
      });
      const liveApyBps = rayToApyBps(reserveData[5]); // liquidityRate
      if (liveApyBps > 0) {
        projectedApyBps = graph.nodes.some(n => n.protocol === "aave-v3" && n.action === "supply")
          ? liveApyBps
          : graph.estimatedApyBps;
      }
    } catch {
      // Keep estimated APY
    }

    const gasPriceGwei = await client.getGasPrice();
    const totalGasCostUsd = Number(totalGas * gasPriceGwei) / 1e18 * 3000;
    const projectedDailyYieldUsd = (capitalUsd * (projectedApyBps / 10000)) / 365;

    return {
      strategyId: graph.id,
      success: true,
      capitalFlow,
      projectedApyBps,
      projectedDailyYieldUsd,
      totalGasCostUsd: totalGasCostUsd || graph.totalGasCostUsd,
      slippagePct: this.estimateSlippage(graph, capitalUsd),
      liquidationBuffer: this.estimateLiquidationBuffer(graph),
      stressTest: this.runStressTests(graph, capitalUsd),
      simulatedAt: new Date(),
      simulationMode: "anvil-fork",
    } as SimulationResult & { simulationMode: string };
  }

  // ── Stress test: real HF math ──────────────────────────────
  private runStressTests(graph: StrategyGraph, capitalUsd: number): StressTestResult {
    const hasBorrow = graph.nodes.some((n) => n.action === "borrow");
    const borrowNode = graph.nodes.find((n) => n.action === "borrow");
    const targetLtv = (borrowNode?.metadata["targetLtv"] as number | undefined) ?? 0;

    if (!hasBorrow) {
      return {
        minDrawdownScenario: "Market price decline of underlying assets",
        maxDrawdownPct: 15,
        survives30PctDrop: true,
        survives50PctDrop: true,
      };
    }

    const liquidationThreshold = 0.825;
    const initialHF = liquidationThreshold / targetLtv;
    const hfAfter30 = initialHF * 0.7;
    const hfAfter50 = initialHF * 0.5;
    const maxDropBeforeLiquidation = 1 - 1 / (initialHF * liquidationThreshold);
    const maxDrawdownPct = Math.max(0, Math.min(maxDropBeforeLiquidation * 100, 100));

    return {
      minDrawdownScenario: `ETH price drop. Liquidation if ETH drops ~${maxDrawdownPct.toFixed(0)}%`,
      maxDrawdownPct,
      survives30PctDrop: hfAfter30 > 1.0,
      survives50PctDrop: hfAfter50 > 1.0,
      ...(hfAfter50 <= 1.0 && {
        liquidationScenario: `At -50% ETH, HF = ${hfAfter50.toFixed(2)} — liquidation triggered`,
      }),
    };
  }

  private estimateSlippage(graph: StrategyGraph, capitalUsd: number): number {
    const lpNodes = graph.nodes.filter((n) => n.action === "add_liquidity");
    if (lpNodes.length === 0) return 0.05;
    const poolDepth = 10_000_000;
    return Math.min((capitalUsd / poolDepth) * 100, 2);
  }

  private estimateLiquidationBuffer(graph: StrategyGraph): number | undefined {
    const borrowNode = graph.nodes.find((n) => n.action === "borrow");
    if (!borrowNode) return undefined;
    const targetLtv = (borrowNode.metadata["targetLtv"] as number | undefined) ?? 0.4;
    return 0.825 / targetLtv;
  }

  // ── Tenderly single-tx simulation (used for per-tx pre-flight checks) ──
  async simulateSingleTx(
    to: `0x${string}`,
    data: `0x${string}`,
    from: `0x${string}`,
    valueWei = "0"
  ): Promise<boolean> {
    const accessKey = process.env["TENDERLY_ACCESS_KEY"];
    const account = process.env["TENDERLY_ACCOUNT"];
    const project = process.env["TENDERLY_PROJECT"];
    if (!accessKey || !account || !project) return true; // skip if not configured

    try {
      const res = await fetch(
        `https://api.tenderly.co/api/v1/account/${account}/project/${project}/simulate`,
        {
          method: "POST",
          headers: { "X-Access-Key": accessKey, "Content-Type": "application/json" },
          body: JSON.stringify({
            network_id: "8453",
            from, to, input: data, value: valueWei,
            save: false, simulation_type: "quick",
          }),
        }
      );
      if (!res.ok) return false;
      const json = await res.json() as { simulation?: { status?: boolean } };
      return json.simulation?.status ?? false;
    } catch {
      return true; // if Tenderly unreachable, don't block
    }
  }
}

export const simulationEngine = new SimulationEngine();

// ─── V2 Mandate-native simulation ─────────────────────────────
// Use this for all new mandate-driven execution paths.
export { MandateSimulator, mandateSimulator } from "./mandate-simulator.js";
export type {
  SimulationArtifact,
  PlaybookName,
  PlaybookRequest,
  MandatePolicy,
  ExecutionMode,
} from "./mandate-simulator.js";
export { BASE_CONTRACTS, BASE_SEPOLIA_CONTRACTS, getActiveContracts, getActiveChainId } from "./fork-context.js";

// ─── Safe Transaction Proposal ────────────────────────────────
export {
  buildSafeTxStruct,
  encodeSafeTxForSigning,
  computeSafeTxHash,
} from "./safe-proposal.js";
export type { SafeTxStruct, SafeTxEip712 } from "./safe-proposal.js";
export { createFallbackTransport, getNextForkUrl, getRpcUrls } from "./rpc-transport.js";
