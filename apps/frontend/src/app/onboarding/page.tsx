"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAccount, useSignTypedData } from "wagmi";

type OrgType = "dao" | "startup" | "individual";
type RiskProfile = "conservative" | "moderate" | "aggressive";

interface OnboardingState {
  step: number;
  orgName: string;
  orgType: OrgType;
  safeAddress: string;
  treasuryWalletAddress: string;
  riskProfile: RiskProfile;
  maxDrawdownPct: number;
  allowLeverage: boolean;
  allowLiquidationRisk: boolean;
  allowGovernanceTokenRewards: boolean;
  minLiquidityReservePct: number;
  maxAllocationPerProtocolPct: number;
  maxSinglePositionPct: number;
  approvedProtocols: string[];
}

const PROTOCOLS = ["aave-v3", "morpho-blue", "uniswap-v3"] as const;

const API_BASE = process.env["NEXT_PUBLIC_API_URL"] ?? "http://localhost:3001";

export default function OnboardingPage() {
  const router = useRouter();
  const { address } = useAccount();
  const [state, setState] = useState<OnboardingState>({
    step: 1,
    orgName: "",
    orgType: "startup",
    safeAddress: "",
    treasuryWalletAddress: "",
    riskProfile: "conservative",
    maxDrawdownPct: 5,
    allowLeverage: false,
    allowLiquidationRisk: false,
    allowGovernanceTokenRewards: false,
    minLiquidityReservePct: 30,
    maxAllocationPerProtocolPct: 35,
    maxSinglePositionPct: 25,
    approvedProtocols: [...PROTOCOLS],
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { signTypedDataAsync } = useSignTypedData();

  const update = (patch: Partial<OnboardingState>) =>
    setState((s) => ({ ...s, ...patch }));

  function applyRiskProfile(profile: RiskProfile) {
    const presets = {
      conservative: {
        maxDrawdownPct: 5,
        minLiquidityReservePct: 30,
        maxAllocationPerProtocolPct: 35,
        maxSinglePositionPct: 25,
        allowLeverage: false,
        allowLiquidationRisk: false,
        allowGovernanceTokenRewards: false,
      },
      moderate: {
        maxDrawdownPct: 12,
        minLiquidityReservePct: 20,
        maxAllocationPerProtocolPct: 45,
        maxSinglePositionPct: 35,
        allowLeverage: false,
        allowLiquidationRisk: false,
        allowGovernanceTokenRewards: false,
      },
      aggressive: {
        maxDrawdownPct: 25,
        minLiquidityReservePct: 10,
        maxAllocationPerProtocolPct: 60,
        maxSinglePositionPct: 45,
        allowLeverage: false,
        allowLiquidationRisk: false,
        allowGovernanceTokenRewards: false,
      },
    } as const;

    update({
      riskProfile: profile,
      ...presets[profile],
    });
  }

  async function handleFinish() {
    setLoading(true);
    setError(null);
    try {
      // Step 1: Parse intent to create org (side effect)
      const creatorAddress =
        address ?? "0x0000000000000000000000000000000000000001";
      const walletAddress =
        state.treasuryWalletAddress || state.safeAddress || creatorAddress;

      const intentRes = await fetch(`${API_BASE}/api/v1/intent/parse`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rawInput: `Onboard ${state.orgName} as a ${state.orgType} treasury with ${state.riskProfile} risk profile`,
          capitalUsd: 100_000,
          walletAddress,
          orgName: state.orgName,
          orgType: state.orgType,
        }),
      });
      if (!intentRes.ok) throw new Error("Failed to create organization");
      const intentJson = await intentRes.json();
      const orgId = intentJson?.data?.orgId as string | undefined;
      if (!orgId) throw new Error("No orgId returned from intent parse");

      // Step 2: Create mandate in draft
      const reserveFloorUsd =
        state.riskProfile === "conservative"
          ? 20_000
          : state.riskProfile === "moderate"
          ? 15_000
          : 10_000;
      const riskBudgetPct =
        state.riskProfile === "conservative"
          ? 5
          : state.riskProfile === "moderate"
          ? 10
          : 20;

      const mandateBody: Record<string, unknown> = {
        orgId,
        name: `${state.orgName} Treasury Mandate`,
        createdBy: creatorAddress,
        reserveFloorUsd,
        riskBudgetPct,
        maxProtocolAllocationPct: state.maxAllocationPerProtocolPct,
        maxSlippageBps: 50,
        approvedAssets: ["USDC", "WETH"],
        approvedProtocols: state.approvedProtocols,
        approvedActions: ["supply", "withdraw", "swap"],
      };
      // optional fields — only add when defined to satisfy exactOptionalPropertyTypes
      if (state.maxSinglePositionPct) {
        mandateBody["spendableFloorUsd"] = Math.round(
          (state.maxSinglePositionPct / 100) * 100_000
        );
      }

      const mandateRes = await fetch(`${API_BASE}/api/v1/mandates`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(mandateBody),
      });
      if (!mandateRes.ok) throw new Error("Failed to create mandate");
      const mandateJson = await mandateRes.json();
      const mandateId = mandateJson?.data?.id as string | undefined;
      if (!mandateId) throw new Error("No mandateId returned");

      // Steps 3–5: Sign and activate if wallet is connected
      if (address) {
        try {
          // Step 3: Fetch EIP-712 activation payload
          const payloadRes = await fetch(
            `${API_BASE}/api/v1/mandates/${mandateId}/activation-payload`
          );
          if (payloadRes.ok) {
            const payloadJson = await payloadRes.json();
            const { domain, types, message } = payloadJson?.data ?? {};

            if (domain && types && message) {
              // Step 4: Sign with wagmi
              const signature = await signTypedDataAsync({
                domain,
                types,
                primaryType: Object.keys(types).find(
                  (k) => k !== "EIP712Domain"
                ) as string,
                message,
              });

              // Step 5: Activate
              await fetch(`${API_BASE}/api/v1/mandates/${mandateId}/activate`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  signature,
                  signerAddress: address,
                }),
              });
            }
          }
        } catch {
          // Activation failed — redirect to draft so user can retry
          router.push(`/mandate/${mandateId}?status=draft`);
          return;
        }
      }

      // Step 6: Redirect
      router.push(`/mandate/${mandateId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  const totalSteps = 4;
  const progress = (state.step / totalSteps) * 100;

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white flex items-center justify-center p-6">
      <div className="w-full max-w-xl">
        {/* Header */}
        <div className="mb-8">
          <div className="text-xs text-[#888] mb-1">Step {state.step} of {totalSteps}</div>
          <div className="h-1 bg-[#1a1a1a] rounded-full">
            <div
              className="h-1 bg-violet-500 rounded-full transition-all"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>

        {/* Step 1: Org Identity */}
        {state.step === 1 && (
          <div>
            <h1 className="text-2xl font-bold mb-2">Tell us about your organization</h1>
            <p className="text-[#888] mb-6">We'll configure governance and risk parameters accordingly.</p>
            <div className="space-y-4">
              <div>
                <label className="text-sm text-[#888] block mb-1">Organization Name</label>
                <input
                  className="w-full bg-[#111] border border-[#222] rounded-lg px-4 py-3 text-white focus:outline-none focus:border-violet-500"
                  placeholder="e.g. Uniswap DAO, Acme Treasury"
                  value={state.orgName}
                  onChange={(e) => update({ orgName: e.target.value })}
                />
              </div>
              <div>
                <label className="text-sm text-[#888] block mb-2">Organization Type</label>
                <div className="grid grid-cols-3 gap-3">
                  {([["dao", "DAO"], ["startup", "Startup"], ["individual", "Individual"]] as [OrgType, string][]).map(([val, label]) => (
                    <button
                      key={val}
                      onClick={() => update({ orgType: val })}
                      className={`py-3 rounded-lg border text-sm font-medium transition-colors ${
                        state.orgType === val
                          ? "border-violet-500 bg-violet-500/10 text-violet-300"
                          : "border-[#222] text-[#666] hover:border-[#333]"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Step 2: Safe Address */}
        {state.step === 2 && (
          <div>
            <h1 className="text-2xl font-bold mb-2">Define treasury custody</h1>
            <p className="text-[#888] mb-6">Funds stay in your Safe or treasury wallet. DeFi Composer only monitors and proposes actions against those addresses.</p>
            <div className="space-y-4">
              <label className="text-sm text-[#888] block mb-1">Safe Address (optional)</label>
              <input
                className="w-full bg-[#111] border border-[#222] rounded-lg px-4 py-3 text-white font-mono text-sm focus:outline-none focus:border-violet-500"
                placeholder="0x..."
                value={state.safeAddress}
                onChange={(e) => update({ safeAddress: e.target.value })}
              />
              <div>
                <label className="text-sm text-[#888] block mb-1">Treasury Wallet (non-Safe)</label>
                <input
                  className="w-full bg-[#111] border border-[#222] rounded-lg px-4 py-3 text-white font-mono text-sm focus:outline-none focus:border-violet-500"
                  placeholder={address ?? "0x..."}
                  value={state.treasuryWalletAddress}
                  onChange={(e) => update({ treasuryWalletAddress: e.target.value })}
                />
              </div>
              <p className="text-xs text-[#555] mt-2">
                If you provide a Safe, the agent treats that Safe as the treasury account. If you leave both blank, the connected wallet is used temporarily.
              </p>
            </div>
            <div className="mt-6 p-4 bg-[#111] rounded-lg border border-[#222]">
              <div className="text-sm font-medium mb-2">How it works</div>
              <ul className="text-xs text-[#888] space-y-1">
                <li>• AI selects strategy based on your intent</li>
                <li>• Risk policy blocks disallowed strategies before deployment</li>
                <li>• Simulation runs before any execution</li>
                <li>• Safe proposal is queued for approval when a Safe is configured</li>
                <li>• Monitor watches health factors, APY drift, and idle capital 24/7</li>
              </ul>
            </div>
          </div>
        )}

        {/* Step 3: Risk Profile */}
        {state.step === 3 && (
          <div>
            <h1 className="text-2xl font-bold mb-2">Risk parameters</h1>
            <p className="text-[#888] mb-6">These act as governance-voted constraints — strategies must fit within them.</p>
            <div className="space-y-4">
              <div>
                <label className="text-sm text-[#888] block mb-2">Risk Profile</label>
                <div className="grid grid-cols-3 gap-3">
                  {([
                    ["conservative", "Conservative", "5% max drawdown"],
                    ["moderate", "Moderate", "15% max drawdown"],
                    ["aggressive", "Aggressive", "30% max drawdown"],
                  ] as [RiskProfile, string, string][]).map(([val, label, sub]) => (
                    <button
                      key={val}
                      onClick={() => applyRiskProfile(val)}
                      className={`py-3 px-3 rounded-lg border text-left transition-colors ${
                        state.riskProfile === val
                          ? "border-violet-500 bg-violet-500/10"
                          : "border-[#222] hover:border-[#333]"
                      }`}
                    >
                      <div className="text-sm font-medium">{label}</div>
                      <div className="text-xs text-[#666]">{sub}</div>
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex items-center justify-between py-3 border-b border-[#1a1a1a]">
                <div>
                  <div className="text-sm">Allow leverage</div>
                  <div className="text-xs text-[#666]">Borrowing against collateral</div>
                </div>
                <button
                  onClick={() => update({ allowLeverage: !state.allowLeverage })}
                  className={`w-10 h-6 rounded-full transition-colors ${state.allowLeverage ? "bg-violet-500" : "bg-[#333]"}`}
                >
                  <span className={`block w-4 h-4 bg-white rounded-full mx-1 transition-transform ${state.allowLeverage ? "translate-x-4" : ""}`} />
                </button>
              </div>
              <div className="flex items-center justify-between py-3">
                <div>
                  <div className="text-sm">Allow liquidation risk</div>
                  <div className="text-xs text-[#666]">Positions that can be liquidated</div>
                </div>
                <button
                  onClick={() => update({ allowLiquidationRisk: !state.allowLiquidationRisk })}
                  className={`w-10 h-6 rounded-full transition-colors ${state.allowLiquidationRisk ? "bg-violet-500" : "bg-[#333]"}`}
                >
                  <span className={`block w-4 h-4 bg-white rounded-full mx-1 transition-transform ${state.allowLiquidationRisk ? "translate-x-4" : ""}`} />
                </button>
              </div>
              <div className="flex items-center justify-between py-3 border-t border-[#1a1a1a]">
                <div>
                  <div className="text-sm">Allow governance-token rewards</div>
                  <div className="text-xs text-[#666]">Permit emissions like AERO as part of total yield</div>
                </div>
                <button
                  onClick={() => update({ allowGovernanceTokenRewards: !state.allowGovernanceTokenRewards })}
                  className={`w-10 h-6 rounded-full transition-colors ${state.allowGovernanceTokenRewards ? "bg-violet-500" : "bg-[#333]"}`}
                >
                  <span className={`block w-4 h-4 bg-white rounded-full mx-1 transition-transform ${state.allowGovernanceTokenRewards ? "translate-x-4" : ""}`} />
                </button>
              </div>
              <div className="grid grid-cols-3 gap-3 pt-3">
                <label className="text-xs text-[#888]">
                  Liquidity Reserve %
                  <input
                    type="number"
                    min={0}
                    max={100}
                    className="mt-1 w-full bg-[#111] border border-[#222] rounded-lg px-3 py-2 text-white"
                    value={state.minLiquidityReservePct}
                    onChange={(e) => update({ minLiquidityReservePct: Number(e.target.value) })}
                  />
                </label>
                <label className="text-xs text-[#888]">
                  Max / Protocol %
                  <input
                    type="number"
                    min={0}
                    max={100}
                    className="mt-1 w-full bg-[#111] border border-[#222] rounded-lg px-3 py-2 text-white"
                    value={state.maxAllocationPerProtocolPct}
                    onChange={(e) => update({ maxAllocationPerProtocolPct: Number(e.target.value) })}
                  />
                </label>
                <label className="text-xs text-[#888]">
                  Max Position %
                  <input
                    type="number"
                    min={0}
                    max={100}
                    className="mt-1 w-full bg-[#111] border border-[#222] rounded-lg px-3 py-2 text-white"
                    value={state.maxSinglePositionPct}
                    onChange={(e) => update({ maxSinglePositionPct: Number(e.target.value) })}
                  />
                </label>
              </div>
            </div>
          </div>
        )}

        {/* Step 4: Protocol Allowlist */}
        {state.step === 4 && (
          <div>
            <h1 className="text-2xl font-bold mb-2">Approved protocols</h1>
            <p className="text-[#888] mb-6">Only approved protocols will be used for your treasury. All are audited.</p>
            <div className="space-y-3">
              {([
                ["aave-v3", "Aave V3", "Lending/borrowing, $280M TVL on Base", "6 audits"],
                ["morpho-blue", "Morpho Blue", "Lending vaults, Steakhouse USDC vault", "4 audits"],
                ["uniswap-v3", "Uniswap V3", "Swap-only reserve conversion for WETH/USDC, no LP in V1", "audited"],
              ] as [string, string, string, string][]).map(([id, name, desc, audits]) => {
                const checked = state.approvedProtocols.includes(id);
                return (
                  <button
                    key={id}
                    onClick={() => update({
                      approvedProtocols: checked
                        ? state.approvedProtocols.filter((p) => p !== id)
                        : [...state.approvedProtocols, id],
                    })}
                    className={`w-full flex items-center gap-4 p-4 rounded-lg border text-left transition-colors ${
                      checked ? "border-violet-500 bg-violet-500/5" : "border-[#222] hover:border-[#333]"
                    }`}
                  >
                    <div className={`w-5 h-5 rounded border-2 flex items-center justify-center flex-shrink-0 ${checked ? "bg-violet-500 border-violet-500" : "border-[#444]"}`}>
                      {checked && <span className="text-white text-xs">✓</span>}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium">{name}</div>
                      <div className="text-xs text-[#666] truncate">{desc}</div>
                    </div>
                    <div className="text-xs text-green-500">{audits}</div>
                  </button>
                );
              })}
            </div>
            <div className="mt-5 rounded-lg border border-[#222] bg-[#111] p-4">
              <div className="text-sm font-medium mb-2">Treasury policy summary</div>
              <div className="grid grid-cols-2 gap-3 text-xs text-[#888]">
                <div>Risk profile: <span className="text-white">{state.riskProfile}</span></div>
                <div>Max drawdown: <span className="text-white">{state.maxDrawdownPct}%</span></div>
                <div>Liquidity reserve: <span className="text-white">{state.minLiquidityReservePct}%</span></div>
                <div>Max protocol allocation: <span className="text-white">{state.maxAllocationPerProtocolPct}%</span></div>
                <div>Max single position: <span className="text-white">{state.maxSinglePositionPct}%</span></div>
                <div>Leverage: <span className="text-white">{state.allowLeverage ? "allowed" : "blocked"}</span></div>
                <div>Gov-token rewards: <span className="text-white">{state.allowGovernanceTokenRewards ? "allowed" : "blocked"}</span></div>
              </div>
            </div>
            {error && <div className="mt-4 p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm">{error}</div>}
          </div>
        )}

        {/* Navigation */}
        <div className="flex justify-between mt-8">
          <button
            onClick={() => update({ step: state.step - 1 })}
            className={`px-5 py-2.5 rounded-lg border border-[#222] text-sm hover:border-[#333] transition-colors ${state.step === 1 ? "invisible" : ""}`}
          >
            Back
          </button>
          {state.step < totalSteps ? (
            <button
              onClick={() => update({ step: state.step + 1 })}
              disabled={state.step === 1 && !state.orgName}
              className="px-5 py-2.5 bg-violet-600 hover:bg-violet-700 disabled:opacity-40 rounded-lg text-sm font-medium transition-colors"
            >
              Continue
            </button>
          ) : (
            <button
              onClick={handleFinish}
              disabled={loading}
              className="px-5 py-2.5 bg-violet-600 hover:bg-violet-700 disabled:opacity-40 rounded-lg text-sm font-medium transition-colors"
            >
              {loading ? "Setting up..." : "Launch Treasury OS"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
