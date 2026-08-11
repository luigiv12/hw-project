# syntax=docker/dockerfile:1

# Build context is the REPO ROOT — the workspace manifests and packages/contracts
# live there.
#   docker build -f apps/web/Dockerfile .

# ---------------------------------------------------------------------------
# builder
# ---------------------------------------------------------------------------
FROM node:24-alpine AS builder

RUN npm install -g pnpm@11.21.0
WORKDIR /app

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/

RUN pnpm install --frozen-lockfile --filter @emissions/web...

COPY packages/contracts packages/contracts
COPY apps/web apps/web

# Inlined into the client bundle at build time, so it must be the URL a BROWSER
# can reach — the published host port, never the compose service name.
ARG NEXT_PUBLIC_API_URL=http://localhost:3000
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL

RUN pnpm --filter @emissions/web build

# ---------------------------------------------------------------------------
# runner — Next.js standalone output, no package manager, no install
# ---------------------------------------------------------------------------
FROM node:24-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production

# `output: standalone` traces the exact files the server needs and emits them
# with node_modules already in place, so nothing is installed here.
COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static ./apps/web/.next/static

USER node

EXPOSE 3001
ENV PORT=3001
ENV HOSTNAME=0.0.0.0

HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3001').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/web/server.js"]
