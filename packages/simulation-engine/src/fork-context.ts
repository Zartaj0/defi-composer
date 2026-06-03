// ============================================================
// ForkContext
// Manages a single Anvil fork session:
//   - starts Anvil against BASE_RPC_URL
//   - captures fork block number
//   - generates deterministic test wallets
//   - funds wallets with fork ETH and USDC/WETH
//   - tears down cleanly
//
// Never touches mainnet keys.  All wallets are ephemeral.
// ============================================================

import { spawn, type ChildProcess } from "child_process";
import { getNextForkUrl } from "./rpc-transport.js";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
  keccak256,
  toBytes,
  encodeAbiParameters,
  toHex,
  pad,
  type PublicClient,
  type WalletClient,
  type Account,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

// ─── Base mainnet addresses (available on Base fork) ──────────
export const BASE_CONTRACTS = {
  USDC:           "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as `0x${string}`,
  WETH:           "0x4200000000000000000000000000000000000006" as `0x${string}`,
  AAVE_POOL:      "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5" as `0x${string}`,
  AAVE_DATA_PROV: "0x2D8A3c5677189723C4CB8873cfC9c8976dfE292b" as `0x${string}`,
  MORPHO:         "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb" as `0x${string}`,
  MORPHO_STEAKHOUSE_USDC: "0xc1256Ae5FF1cf2719D4937adb3bbCCab2E00A2Ca" as `0x${string}`,
  UNISWAP_V3_ROUTER:      "0x2626664c2603336E57B271c5C0b26F421741e481" as `0x${string}`,
  UNISWAP_V3_QUOTER:      "0x3d4e44Eb1374240cE5F1b136041212501E4a0139" as `0x${string}`,
  // Safe factory and singleton (deployed at deterministic addresses on all chains)
  SAFE_PROXY_FACTORY: "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67" as `0x${string}`,
  SAFE_SINGLETON:     "0x41675C099F32341bf84BFc5382aF534df5C7461a" as `0x${string}`,
  SAFE_COMPAT_FALLBACK: "0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99" as `0x${string}`,
} as const;

// ─── Ethereum mainnet addresses (used by contract.dev stagenet, chainId 52638) ──
// contract.dev is a fork of Ethereum mainnet — same addresses as mainnet.
export const ETH_MAINNET_CONTRACTS = {
  USDC:           "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as `0x${string}`,
  WETH:           "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" as `0x${string}`,
  AAVE_POOL:      "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2" as `0x${string}`,
  AAVE_DATA_PROV: "0x7B4EB56E7CD4b454BA8ff71E4518426369a138a3" as `0x${string}`,
  MORPHO:         "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb" as `0x${string}`,
  MORPHO_STEAKHOUSE_USDC: "0xBEEF01735c132Ada46AA9aA4c54623cAA92A64CB" as `0x${string}`,
  UNISWAP_V3_ROUTER:      "0xE592427A0AEce92De3Edee1F18E0157C05861564" as `0x${string}`,
  UNISWAP_V3_QUOTER:      "0x61fFE014bA17989E743c5F6cB21bF9697530B21e" as `0x${string}`,
  // Safe deterministic addresses are the same on all chains
  SAFE_PROXY_FACTORY: "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67" as `0x${string}`,
  SAFE_SINGLETON:     "0x41675C099F32341bf84BFc5382aF534df5C7461a" as `0x${string}`,
  SAFE_COMPAT_FALLBACK: "0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99" as `0x${string}`,
} as const;

// ─── Base Sepolia testnet addresses ───────────────────────────
// Aave V3 Base Sepolia: https://docs.aave.com/developers/deployed-contracts/v3-testnet-addresses
// Safe contracts share deterministic addresses across chains.
export const BASE_SEPOLIA_CONTRACTS = {
  USDC:           "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f" as `0x${string}`,
  WETH:           "0x4200000000000000000000000000000000000006" as `0x${string}`,  // same OP-stack canonical
  AAVE_POOL:      "0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27" as `0x${string}`,
  AAVE_DATA_PROV: "0x0000000000000000000000000000000000000000" as `0x${string}`,  // not needed for simulation
  MORPHO:         "0x0000000000000000000000000000000000000000" as `0x${string}`,  // not deployed on Sepolia
  MORPHO_STEAKHOUSE_USDC: "0x0000000000000000000000000000000000000000" as `0x${string}`,
  // Uniswap V3 is deployed on Sepolia but has no WETH/USDC pool liquidity.
  // Set to zero to trigger graceful "not configured" failure in the playbook.
  UNISWAP_V3_ROUTER:      "0x0000000000000000000000000000000000000000" as `0x${string}`,
  UNISWAP_V3_QUOTER:      "0x0000000000000000000000000000000000000000" as `0x${string}`,
  SAFE_PROXY_FACTORY: "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67" as `0x${string}`,
  SAFE_SINGLETON:     "0x41675C099F32341bf84BFc5382aF534df5C7461a" as `0x${string}`,
  SAFE_COMPAT_FALLBACK: "0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99" as `0x${string}`,
} as const;

export type ChainContracts = typeof BASE_CONTRACTS;

/** Returns contracts for the active chain (CHAIN_ID env, default 8453). */
export function getActiveContracts(): ChainContracts {
  const id = getActiveChainId();
  if (id === 84532) return BASE_SEPOLIA_CONTRACTS;
  if (id === 52638) return ETH_MAINNET_CONTRACTS;  // contract.dev stagenet (Ethereum mainnet fork)
  return BASE_CONTRACTS;
}

/** Returns the active chain ID (CHAIN_ID env, default 8453). */
export function getActiveChainId(): number {
  return parseInt(process.env["CHAIN_ID"] ?? "8453", 10);
}

// Token balance storage slots (verified on respective networks)
// USDC mainnet (FiatToken V2.2): balances mapping at slot 9
// USDC Sepolia (Aave MintableERC20 / OZ ERC20): balances mapping at slot 0
// WETH (canonical OP-stack WETH at 0x4200...0006): balances at slot 3
// WETH (Ethereum mainnet WETH9 at 0xC02a...): balances at slot 3
const TOKEN_BALANCE_SLOTS: Record<string, number> = {
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": 9,  // USDC Base mainnet (FiatToken V2.2)
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": 9,  // USDC Ethereum mainnet (FiatToken V2.2, same slot)
  "0xba50cd2a20f6da35d788639e581bca8d0b5d4d5f": 0,  // USDC Base Sepolia (OZ ERC20)
  "0x4200000000000000000000000000000000000006": 3,  // WETH (all OP-stack chains)
  "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2": 3,  // WETH9 Ethereum mainnet
};

export const ERC20_BALANCE_ABI = [
  {
    name: "balanceOf",
    type: "function" as const,
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view" as const,
  },
] as const;

// ─── Port allocator ───────────────────────────────────────────
let nextPort = Number(process.env["ANVIL_BASE_PORT"] ?? 18100);
function allocatePort(): number {
  return nextPort++;
}

// ─── Deterministic test private key ──────────────────────────
// Not random — same key every fork session so tests are reproducible.
// This key has no mainnet funds and is safe to log.
const FORK_TEST_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as `0x${string}`;

export interface ForkWallet {
  privateKey: `0x${string}`;
  account: Account;
  address: `0x${string}`;
}

export interface ForkSession {
  port: number;
  rpcUrl: string;
  chainId: number;
  forkBlockNumber: bigint;
  validUntilBlock: bigint;
  wallet: ForkWallet;
  publicClient: PublicClient;
  walletClient: WalletClient;
  stop: () => void;
}

export async function startFork(opts: {
  fundUsdcAmount?: bigint;  // USDC (6 decimals)
  fundWethAmount?: bigint;  // WETH (18 decimals)
  validForBlocks?: number;  // default 300 (~10 min on Base)
}): Promise<ForkSession> {
  // Pick fork URL. If running many simulations back-to-back, round-robin spreads
  // rate limits across KEY_1 and KEY_2 — but each fork session is committed to
  // one URL for its lifetime (Anvil can't switch RPC mid-fork).
  const forkUrl = getNextForkUrl();
  const validForBlocks = opts.validForBlocks ?? 300;

  // FORK_RPC_URL: skip Anvil entirely and connect to an already-running fork node.
  // Useful when Anvil cannot spawn (sandboxed envs, macOS proxy detection crash).
  // The node at FORK_RPC_URL must support anvil_setBalance, anvil_setStorageAt,
  // and be a fork of Base (chainId 8453). Hardhat node or a remote Tenderly fork work.
  const externalForkRpc = process.env["FORK_RPC_URL"];
  if (externalForkRpc) {
    return connectToExternalFork(externalForkRpc, opts, validForBlocks);
  }

  const port = allocatePort();
  const rpcUrl = `http://127.0.0.1:${port}`;

  const proc = await spawnAnvil(forkUrl, port);
  const activeChainId = getActiveChainId();
  const contracts = getActiveContracts();

  // No chain param — avoids Op-stack transaction type conflicts with fork RPC
  const publicClient = createPublicClient({
    transport: http(rpcUrl),
  });

  const forkBlockNumber = await publicClient.getBlockNumber();
  const validUntilBlock = forkBlockNumber + BigInt(validForBlocks);

  // Set up test wallet
  const account = privateKeyToAccount(FORK_TEST_PRIVATE_KEY);
  const walletClient = createWalletClient({
    account,
    transport: http(rpcUrl),
  });

  // Fund with fork ETH (needed for gas)
  await setForkBalance(rpcUrl, account.address, parseUnits("10", 18));

  // Fund USDC via direct storage slot write (slot from TOKEN_BALANCE_SLOTS map)
  if (opts.fundUsdcAmount && opts.fundUsdcAmount > 0n) {
    const usdcSlot = TOKEN_BALANCE_SLOTS[contracts.USDC.toLowerCase()] ?? 9;
    await setTokenBalanceViaStorage(rpcUrl, contracts.USDC, account.address, opts.fundUsdcAmount, usdcSlot);
  }

  // Fund WETH via storage slot 3 (canonical OP-stack WETH at 0x4200...0006)
  if (opts.fundWethAmount && opts.fundWethAmount > 0n) {
    const wethSlot = TOKEN_BALANCE_SLOTS[contracts.WETH.toLowerCase()] ?? 3;
    await setTokenBalanceViaStorage(rpcUrl, contracts.WETH, account.address, opts.fundWethAmount, wethSlot);
  }

  const wallet: ForkWallet = {
    privateKey: FORK_TEST_PRIVATE_KEY,
    account,
    address: account.address,
  };

  return {
    port,
    rpcUrl,
    chainId: activeChainId,
    forkBlockNumber,
    validUntilBlock,
    wallet,
    publicClient,
    walletClient,
    stop: () => {
      proc.kill("SIGTERM");
    },
  };
}

// ─── Read ERC-20 balance ──────────────────────────────────────
export async function getTokenBalance(
  publicClient: PublicClient,
  token: `0x${string}`,
  address: `0x${string}`
): Promise<bigint> {
  return publicClient.readContract({
    address: token,
    abi: ERC20_BALANCE_ABI,
    functionName: "balanceOf",
    args: [address],
  });
}

// ─── Snapshot balances for artifact ──────────────────────────
export async function snapshotBalances(
  publicClient: PublicClient,
  address: `0x${string}`
): Promise<{ eth: string; usdc: string; weth: string }> {
  const contracts = getActiveContracts();
  const [eth, usdc, weth] = await Promise.all([
    publicClient.getBalance({ address }),
    getTokenBalance(publicClient, contracts.USDC, address),
    getTokenBalance(publicClient, contracts.WETH, address),
  ]);
  return {
    eth: eth.toString(),
    usdc: usdc.toString(),
    weth: weth.toString(),
  };
}

// ─── Hash calldata batch for artifact integrity ───────────────
export function hashCalldata(calldata: Array<{ to: string; data: string; value?: string }>): string {
  const serialized = JSON.stringify(calldata.map(c => ({ to: c.to.toLowerCase(), data: c.data, value: c.value ?? "0x0" })));
  return keccak256(toBytes(serialized));
}

// ─── External fork connection (FORK_RPC_URL bypass) ──────────
// Used when Anvil cannot spawn locally (sandboxed envs, macOS SCDynamicStore crash).
// The external node must support anvil_* cheat codes.
async function connectToExternalFork(
  rpcUrl: string,
  opts: { fundUsdcAmount?: bigint; fundWethAmount?: bigint },
  validForBlocks: number
): Promise<ForkSession> {
  const publicClient = createPublicClient({ transport: http(rpcUrl) });
  const forkBlockNumber = await publicClient.getBlockNumber();
  const validUntilBlock = forkBlockNumber + BigInt(validForBlocks);
  const activeChainId = getActiveChainId();
  const contracts = getActiveContracts();

  const account = privateKeyToAccount(FORK_TEST_PRIVATE_KEY);
  const walletClient = createWalletClient({ account, transport: http(rpcUrl) });

  await setForkBalance(rpcUrl, account.address, parseUnits("10", 18));
  if (opts.fundUsdcAmount && opts.fundUsdcAmount > 0n) {
    const usdcSlot = TOKEN_BALANCE_SLOTS[contracts.USDC.toLowerCase()] ?? 9;
    await setTokenBalanceViaStorage(rpcUrl, contracts.USDC, account.address, opts.fundUsdcAmount, usdcSlot);
  }
  if (opts.fundWethAmount && opts.fundWethAmount > 0n) {
    const wethSlot = TOKEN_BALANCE_SLOTS[contracts.WETH.toLowerCase()] ?? 3;
    await setTokenBalanceViaStorage(rpcUrl, contracts.WETH, account.address, opts.fundWethAmount, wethSlot);
  }

  console.log(`[Fork] Connected to external fork at ${rpcUrl} (chain=${activeChainId} block=${forkBlockNumber})`);

  return {
    port: 0,
    rpcUrl,
    chainId: activeChainId,
    forkBlockNumber,
    validUntilBlock,
    wallet: { privateKey: FORK_TEST_PRIVATE_KEY, account, address: account.address },
    publicClient,
    walletClient,
    stop: () => { /* external fork — caller manages lifecycle */ },
  };
}

// ─── Internals ────────────────────────────────────────────────
async function spawnAnvil(forkUrl: string, port: number): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      process.env["ANVIL_BIN"] ?? "anvil",
      [
        "--fork-url", forkUrl,
        "--port", String(port),
        // Do NOT use --silent — it suppresses "Listening on" which we need for readiness
        "--chain-id", String(getActiveChainId()),
        // Default: auto-mines each tx instantly (interval=0), which is what we want
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );

    let ready = false;
    const timeout = setTimeout(() => {
      if (!ready) {
        proc.kill();
        reject(new Error(`Anvil failed to start on port ${port} within 30s`));
      }
    }, 30_000);

    const onData = (data: Buffer) => {
      if (!ready && data.toString().includes("Listening on")) {
        ready = true;
        clearTimeout(timeout);
        resolve(proc);
      }
    };

    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);
    proc.on("error", (err) => { clearTimeout(timeout); reject(err); });
    proc.on("exit", (code) => {
      if (!ready) { clearTimeout(timeout); reject(new Error(`Anvil exited ${code}`)); }
    });
  });
}

async function rpcCall(rpcUrl: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = await res.json() as { result?: unknown; error?: { message: string } };
  if (json.error) throw new Error(`RPC ${method} failed: ${json.error.message}`);
  return json.result;
}

async function setForkBalance(rpcUrl: string, address: `0x${string}`, weiAmount: bigint): Promise<void> {
  await rpcCall(rpcUrl, "anvil_setBalance", [address, `0x${weiAmount.toString(16)}`]);
}

// Set ERC-20 token balance directly via storage slot manipulation.
// More reliable than whale impersonation — works regardless of who holds tokens.
//
// Storage key = keccak256(abi.encode(address, uint256(slot)))
// USDC (FiatToken V2.2 on Base): balances at slot 9
// WETH (canonical WETH on Base): balances at slot 3
async function setTokenBalanceViaStorage(
  rpcUrl: string,
  token: `0x${string}`,
  account: `0x${string}`,
  amount: bigint,
  balancesSlot: number
): Promise<void> {
  // Compute the storage key: keccak256(abi.encode(account, slot))
  const storageKey = keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }],
      [account, BigInt(balancesSlot)]
    )
  );

  // Encode amount as 32-byte hex
  const storageValue = pad(toHex(amount), { size: 32 });

  await rpcCall(rpcUrl, "anvil_setStorageAt", [token, storageKey, storageValue]);
}
