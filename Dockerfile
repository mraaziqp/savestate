# ─────────────────────────────────────────────────────────────────────────────
# NexusEmu control plane — stateless container for AWS (ECS Fargate or EC2).
#
# Written 2026-09-20 during the recovery from the loss of the local media drive.
# The design rule is simple: THIS CONTAINER OWNS NO DATA.
#   * relational state  → Neon PostgreSQL (DATABASE_URL)
#   * files and media   → Google Drive, over the Drive API
#   * logs              → stdout/stderr, for CloudWatch to collect
# Nothing is written to the container filesystem that matters after exit, so
# any task can be killed and replaced at any moment.
#
# NOTE ON THE FRONTEND: the Vite sources (vite.config.ts, index.html, the app
# entrypoint) were lost with the drive — only the compiled dist/ survived. The
# image therefore SHIPS the prebuilt dist/ rather than running `vite build`.
# Once the frontend sources are recovered, add a build stage and drop the copy.
# ─────────────────────────────────────────────────────────────────────────────

# ── Stage 1: dependencies ────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS deps
WORKDIR /app
# sharp and other native modules need a toolchain to build when no prebuilt
# binary matches; dropped from the final image.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
# omit=dev: the server bundle is built in the next stage with esbuild, which is
# the only devDependency needed at build time and is installed explicitly.
RUN npm ci --omit=dev --no-audit --no-fund \
 || npm install --omit=dev --no-audit --no-fund

# ── Stage 2: build the server bundle ─────────────────────────────────────────
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY server.ts ./
RUN npm install --no-save esbuild@^0.25.0 \
 && ./node_modules/.bin/esbuild server.ts \
      --platform=node \
      --target=node22 \
      --format=esm \
      --packages=external \
      --outfile=dist/server.mjs \
 && test -s dist/server.mjs

# ── Stage 3: runtime ─────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

# tini reaps zombies: the server shells out (ffprobe, emulator helpers) and a
# bare node PID 1 would leave defunct children behind for the life of the task.
RUN apt-get update && apt-get install -y --no-install-recommends \
      tini ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=3000 \
    # Cloud-first: local disk is scratch only. These are deliberately NOT the
    # host paths — inside the container there is no rclone mount, so the Drive
    # API is the only storage path.
    NEXUS_CLOUD_FIRST=1 \
    NEXUS_STREAM_ONLY=1 \
    NEXUS_DISABLE_LOCAL_SCAN=1 \
    NEXUS_VAULT_FALLBACK=/tmp/nexus-vault \
    NEXUS_DATA_DIR=/tmp/nexus-data \
    # Node's own heap ceiling; Fargate kills the task rather than swapping.
    NODE_OPTIONS=--max-old-space-size=1536

COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/dist/server.mjs ./dist/server.mjs
# Prebuilt frontend + static assets (see NOTE above).
COPY dist ./dist
COPY public ./public
COPY package.json ./

# Scratch dirs owned by the unprivileged user. Mount a tmpfs over /tmp in the
# task definition if you want to guarantee nothing survives a restart.
RUN mkdir -p /tmp/nexus-vault /tmp/nexus-data \
 && chown -R node:node /tmp/nexus-vault /tmp/nexus-data /app

USER node
EXPOSE 3000

# The ALB/nginx health check uses the same endpoint, so a container that cannot
# reach Neon is replaced instead of silently serving errors.
HEALTHCHECK --interval=30s --timeout=10s --start-period=45s --retries=3 \
  CMD curl -fsS http://127.0.0.1:${PORT}/api/health || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/server.mjs"]
