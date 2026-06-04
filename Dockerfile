# ── DeFi Composer — Backend API (Railway) ─────────────────────
# Stagenet execution: no Anvil needed — agent submits directly to stagenet RPC.

FROM node:20-slim

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
