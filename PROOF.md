# DeFi Composer — Technical Proof

**Autonomous treasury agent for Gnosis Safe DAOs. Fork-simulates every action before executing it onchain, within hard limits enforced by a custom Safe module.**

---

## What Is Live (Base Sepolia, today)

| Item | Status |
|------|--------|
| Safe multisig | `0xead39d939A83A8e57a61b9ebf4209142Df8ED690` |
| PolicyEnforcedModule V2 | `0x0f19895c838a05203fea681774367deedf74e8d8` — enabled |
| Policy | $100/action · $500/day · $50 reserve floor — enforced **onchain** |
| USDC balance | $755 liquid |
| aUSDC (Aave V3) | $245+ and accruing yield |
| forge tests | 58/58 passing |
| TypeScript packages | 20/20 type-check clean |

**Verified autonomous transaction** (no manual Safe signature):  
[`0x6585a094…`](https://sepolia.basescan.org/tx/0x6585a094c65d1d277e36376b50226df978ecd3924991a11b292607a3f4bd8bad)  
Block 42220461 · caller: executor EOA → PolicyModule → Safe → USDC.approve + Aave.supply → 20 aUSDC minted

---

## The Problem

DAO treasuries leave yield on the table. A Safe with $1M idle USDC at 0% when Aave pays 5% APY is $50K/year in unrealised return. The barrier is not the transaction cost — it's the friction of getting Safe signers to execute deposits repeatedly, and the risk of delegating a hot key with broad Safe access.

---

## The Solution

A three-layer architecture:

```
Monitor detects idle capital
  ↓
Agent selects playbook (supply USDC to Aave)
  ↓
Fork simulation: exact calldata executed against Anvil fork
  – confirm balances before/after
  – gas estimate
  – calldata hash recorded
  ↓
PolicyEnforcedModule.execute()  ← onchain policy enforcement
  – reserve floor: Safe USDC balance ≥ floor + action amount
  – per-target allowlist: only approved protocols
  – per-selector guard: only approved function signatures
  – daily spend accumulator: no replay beyond cap
  ↓
Safe execTransactionFromModule()
  ↓
USDC → Aave → aUSDC minted to Safe
  ↓
Reconciliation worker confirms onchain state
```

The executor key can **only** call two functions on two contracts within a $100 action cap. It cannot transfer tokens, cannot add signers, cannot disable the module. The policy is enforced by Solidity, not by the caller.

---

## What Makes This Different

**Fork-simulation-before-execution** is the key differentiator. Every action that reaches the PolicyModule was first tested against a forked snapshot of the chain. The simulationId is recorded onchain in the `ActionExecuted` event, creating an audit trail from decision → simulation artifact → transaction.

Competitors (Karpatkey, Aera) execute manually or with broad signer delegation. This system executes autonomously within provably-bounded limits.

---

## Onchain Proof

```
Module contract:
https://sepolia.basescan.org/address/0x0f19895c838a05203fea681774367deedf74e8d8

Last autonomous tx:
https://sepolia.basescan.org/tx/0x6585a094c65d1d277e36376b50226df978ecd3924991a11b292607a3f4bd8bad

Safe (app.safe.global):
https://app.safe.global/home?safe=basesep:0xead39d939A83A8e57a61b9ebf4209142Df8ED690
```

---

## Run the Proof Yourself

```bash
# Clone and install
git clone <repo>
pnpm install

# Verify build
pnpm type-check        # 20/20
cd contracts && forge test --offline   # 58/58

# Live system snapshot (requires .env with DATABASE_URL + RPC)
node scripts/proof.mjs

# View the activity feed (requires backend + frontend running)
pnpm --filter @defi-composer/backend run dev
pnpm --filter @defi-composer/frontend run dev
# open http://localhost:3000/mandate/mandate_c6cd43ff-1a7
```

---

## What's Real vs. What's Not Yet

**Real:**
- Autonomous cycle on Base Sepolia (no manual signatures, no human in the loop)
- Onchain policy enforcement: reserve floor, action cap, selector guard, target allowlist
- 58 forge tests covering all enforcement paths including fuzz tests
- Fork simulation before every execution (Anvil, full calldata replay)
- Reconciliation worker confirming onchain state post-execution

**Not yet:**
- Mainnet deployment (executor key needs KMS before mainnet)
- Multi-protocol (only Aave supply/withdraw currently wired)
- Governance UX (DAO vote to enable/configure agent)
- External audit (module is unaudited; Zodiac Roles is the audited alternative)
- AI decision quality (current: rule-based playbook selection; target: LLM-ranked strategy with live APY feeds)

---

## Roadmap (next 90 days)

1. **KMS signing** — move executor key to AWS KMS; one-file change in module-executor.ts
2. **Mainnet pilot** — $500 in a fresh Safe, $50/action cap, Aave only
3. **Zodiac Roles evaluation** — audited permission alternative; if equivalent, migrate V2 module to wrapper
4. **LLM strategy ranking** — rate comparison across Aave / Morpho / Compound with live APY, risk, mandate constraints
5. **DAO onboarding flow** — Safe app plugin; one-click mandate configuration

---

## Stack

| Layer | Tech |
|-------|------|
| Contracts | Solidity 0.8.26, Foundry, Safe{Core} |
| Simulation | Anvil fork (Foundry), viem |
| Execution | Node.js, BullMQ, viem |
| Backend | Fastify, Drizzle ORM, PostgreSQL, Redis |
| Frontend | Next.js 14, Tailwind |
| Chain | Base / Base Sepolia |
