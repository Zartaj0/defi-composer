# ── DeFi Composer — Backend API (Railway) ─────────────────────
# Includes Foundry (Anvil) for fork simulations.

FROM node:20-slim

# System deps: curl + git for Foundry installer; procps for process management
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl git ca-certificates procps \
    && rm -rf /var/lib/apt/lists/*

# Install Foundry (includes anvil) — pins to the stable nightly build
RUN curl -L https://foundry.paradigm.xyz | bash
ENV PATH="/root/.foundry/bin:$PATH"
RUN foundryup

# Install pnpm via corepack
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate

WORKDIR /app

# Copy workspace definition files first (layer cache)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./

# Copy only the packages + the backend app (skip frontend/monitor/executor)
COPY packages/ packages/
COPY apps/backend/ apps/backend/

# Install all workspace dependencies in one pass
RUN pnpm install --frozen-lockfile

# turbo resolves the full dependency graph automatically via ^build
RUN pnpm turbo build --filter=@defi-composer/backend

ENV NODE_ENV=production

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s \
  CMD node -e "fetch('http://localhost:3001/health').catch(()=>{}).then(r=>process.exit(r&&r.ok?0:1))"

CMD ["node", "apps/backend/dist/index.js"]
