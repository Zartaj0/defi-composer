# DeFi Composer

Self-custodial autonomous capital mandate protocol for crypto companies, DAOs, funds, and serious onchain investors.

## Product Standard

The system must not present fake strategy generation, fake deployment, fake balances, or frontend-only success states.

A capital action is executable only when:

- a user-approved mandate permits it
- policy and risk checks pass
- the exact calldata is built by deterministic code
- Base mainnet fork simulation passes against real protocol state
- the simulation artifact is fresh and matches the proposed calldata
- a real Safe proposal or execution record exists

## V1 Scope

V1 is intentionally narrow:

- Chain: Base mainnet
- Simulation: Base mainnet fork
- Yield protocols: Aave V3 and approved Morpho USDC vaults
- Conversion protocol: Uniswap V3 swap-only WETH/USDC reserve conversion
- Execution mode: Safe proposal mode
- Mandates: structured reserve, spend, and risk rules

Out of scope for V1:

- leverage
- LP positions
- cross-chain execution
- arbitrary protocol actions
- backend custody
- frontend-only demo flows
- autonomous execution without explicit bounded permission

## Development

```bash
pnpm install
pnpm type-check
pnpm dev
```

Required local services:

- PostgreSQL
- Redis
- Anvil

Required environment variables:

- `BASE_RPC_URL`
- `DATABASE_URL`
- `REDIS_URL`
- at least one configured LLM provider key

Optional but expected for production execution:

- Tenderly variables for external simulation/reporting
- Safe proposer credentials for proposal mode
