# ─────────────────────────────────────────────────────────────────────────────
# NexusEmu control plane — stateless image for ECS Fargate / App Runner.
#
# THE CONTAINER OWNS NO DATA:
#   relational state -> Neon PostgreSQL (DATABASE_URL)
#   files and media  -> Google Drive, via the Drive API
#   logs             -> stdout/stderr, for CloudWatch
#
# Two things about this image that are not obvious:
#
#  * The frontend is NOT built here. The Vite sources were lost when the media
#    drive failed, so dist/ is prebuilt and committed. Running a build step
#    would produce an empty app. Restore the sources before adding one back.
#
#  * There is no /dev/dri on Fargate or App Runner, so hardware transcoding is
#    unavailable and NEXUS_DISABLE_HW_TRANSCODE is forced on. Software x264
#    measured 3.2x realtime at 323% CPU on the laptop; size tasks accordingly,
#    or keep transcoding on hardware you control. See the notes in
#    aws-infrastructure.yaml.
# ─────────────────────────────────────────────────────────────────────────────

# ── deps: production node_modules only ───────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app
# node-gyp fallbacks for any native module without a musl prebuild; none of
# this reaches the final image.
RUN apk add --no-cache python3 make g++ libc6-compat vips-dev
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund \
 || npm install --omit=dev --no-audit --no-fund

# ── build: bundle the server ─────────────────────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app
RUN apk add --no-cache libc6-compat
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json server.ts ./
# esbuild is the only build-time dependency; --packages=external keeps
# node_modules out of the bundle so the layer stays cacheable.
RUN npm install --no-save esbuild@^0.25.0 \
 && ./node_modules/.bin/esbuild server.ts \
      --platform=node --target=node20 --format=esm --packages=external \
      --outfile=dist/server.mjs \
 && test -s dist/server.mjs

# ── runtime ──────────────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app

# ffmpeg is required: ~76% of the library is HEVC/AC3 in Matroska and must be
# transcoded before a browser can play it. tini reaps the ffmpeg children a
# bare node PID 1 would leave behind.
RUN apk add --no-cache ffmpeg tini curl \
 && rm -rf /var/cache/apk/*

ENV NODE_ENV=production \
    PORT=3000 \
    NEXUS_CLOUD_FIRST=1 \
    NEXUS_STREAM_ONLY=1 \
    NEXUS_DISABLE_LOCAL_SCAN=1 \
    NEXUS_DISABLE_HW_TRANSCODE=1 \
    NEXUS_VAULT_FALLBACK=/tmp/nexus-vault \
    NEXUS_DATA_DIR=/tmp/nexus-data \
    NODE_OPTIONS=--max-old-space-size=1536

COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/dist/server.mjs ./dist/server.mjs
# Prebuilt frontend (see the note at the top).
COPY dist ./dist
COPY public ./public
COPY package.json ./

RUN mkdir -p /tmp/nexus-vault /tmp/nexus-data \
 && chown -R node:node /tmp/nexus-vault /tmp/nexus-data /app

USER node
EXPOSE 3000

# App Runner and ECS both health-check the container; a task that cannot reach
# Neon is replaced rather than left serving errors.
HEALTHCHECK --interval=30s --timeout=10s --start-period=45s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/api/health" || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server.mjs"]
