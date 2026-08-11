# syntax=docker/dockerfile:1

# Build context is the REPO ROOT, not apps/api — the pnpm workspace manifests
# and lockfile live there and an install cannot be reproduced without them.
#   docker build -f apps/api/Dockerfile .

# ---------------------------------------------------------------------------
# builder — full install, compile contracts then the API
# ---------------------------------------------------------------------------
FROM node:24-alpine AS builder

RUN npm install -g pnpm@11.21.0
WORKDIR /app

# Manifests before source: this layer is what makes the install cacheable. Source
# edits rebuild the compile step only, not the dependency install.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY packages/contracts/package.json packages/contracts/

# The trailing "..." in the filter pulls in @emissions/contracts as a workspace
# dependency. Without it the build fails on a package that is right there.
RUN pnpm install --frozen-lockfile --filter @emissions/api...

COPY packages/contracts packages/contracts
COPY apps/api apps/api

RUN pnpm --filter @emissions/api build

# ---------------------------------------------------------------------------
# runner — production dependencies plus compiled output
# ---------------------------------------------------------------------------
FROM node:24-alpine AS runner

RUN npm install -g pnpm@11.21.0
WORKDIR /app

ENV NODE_ENV=production

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY packages/contracts/package.json packages/contracts/

# --prod drops build tooling; the workspace symlink to packages/contracts is
# recreated here and resolves against the dist copied in below.
RUN pnpm install --prod --frozen-lockfile --filter @emissions/api...

COPY --from=builder /app/packages/contracts/dist packages/contracts/dist
COPY --from=builder /app/apps/api/dist apps/api/dist

# Migrations are read from disk at runtime by the migrate entrypoint.
COPY apps/api/drizzle apps/api/drizzle

# Run unprivileged. The node image ships a `node` user for exactly this.
USER node

EXPOSE 3000

# Liveness only — readiness touches the database and would report unhealthy
# during a transient database blip, causing the orchestrator to restart a
# container that is doing nothing wrong.
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/api/dist/main.js"]
