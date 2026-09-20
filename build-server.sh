#!/bin/bash
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
"$SCRIPT_DIR/node_modules/@esbuild/linux-x64/bin/esbuild" \
  "$SCRIPT_DIR/server.ts" \
  --platform=node \
  --target=node22 \
  --format=esm \
  --packages=external \
  --outfile="$SCRIPT_DIR/dist/server.mjs"
