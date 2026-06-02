# ── DeFi Composer — Backend API (Railway) ─────────────────────
# Single-stage build: installs pnpm, builds all workspace deps,
# then starts the Fastify API. No Anvil/Foundry required.

FROM node:20-slim

# Install pnpm via corepack
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate

WORKDIR /app

# Copy workspace definition files first (layer cache)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./

# Copy only the packages the backend needs at build time
COPY packages/ packages/
COPY apps/backend/ apps/backend/

# Install all workspace dependencies in one pass
RUN pnpm install --frozen-lockfile

# Build packages in dependency order, then the backend
RUN pnpm --filter @defi-composer/shared build && \
    pnpm --filter @defi-composer/db build && \
    pnpm --filter @defi-composer/protocol-adapters build && \
    pnpm --filter @defi-composer/risk-engine build && \
    pnpm --filter @defi-composer/simulation-engine build && \
    pnpm --filter @defi-composer/strategy-engine build && \
    pnpm --filter @defi-composer/execution-engine build && \
    pnpm --filter @defi-composer/backend build

ENV NODE_ENV=production

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s \
  CMD node -e "fetch('http://localhost:3001/health').catch(()=>{}).then(r=>process.exit(r&&r.ok?0:1))"

CMD ["node", "apps/backend/dist/index.js"]
