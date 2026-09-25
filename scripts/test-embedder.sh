#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath

# Start or stop the reference embedding server the semantic E2E suites
# (search-quality, embedder-swap) require: Qwen3-Embedding-0.6B served by
# llama.cpp on the CPU behind an OpenAI-compatible `/v1` API. CI starts it
# before those suites; a contributor without a local embedding server can use
# it the same way.
#
# Usage:
#   scripts/test-embedder.sh start    # download (once), verify, serve, wait ready
#   scripts/test-embedder.sh stop
#
# Environment:
#   OMNESIS_TEST_EMBEDDER_PORT   host port (default 8001, the suites' default)
#   OMNESIS_TEST_EMBEDDER_CACHE  model directory
#                                (default ${XDG_CACHE_HOME:-$HOME/.cache}/omnesis-test-embedder)
#
# Everything the server runs is pinned: the model file to an exact Hugging Face
# revision and SHA-256, the server to an image digest. The served model id is
# the suites' default, so they need no override.
set -euo pipefail

PORT="${OMNESIS_TEST_EMBEDDER_PORT:-8001}"
CACHE_DIR="${OMNESIS_TEST_EMBEDDER_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/omnesis-test-embedder}"
CONTAINER="omnesis-test-embedder-${PORT}"

MODEL_ID="Qwen/Qwen3-Embedding-0.6B"
MODEL_REPO="Qwen/Qwen3-Embedding-0.6B-GGUF"
MODEL_REVISION="370f27d7550e0def9b39c1f16d3fbaa13aa67728"
MODEL_FILE="Qwen3-Embedding-0.6B-Q8_0.gguf"
MODEL_SHA256="06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439"
# ghcr.io/ggml-org/llama.cpp:server, multi-arch index.
SERVER_IMAGE="ghcr.io/ggml-org/llama.cpp@sha256:6257697a7f5d034b8fb499ddb07af3e250506352f94102054252a23f3b85e0af"

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

fetch_model() {
  mkdir -p "$CACHE_DIR"
  local path="$CACHE_DIR/$MODEL_FILE"
  if [[ -f "$path" && "$(sha256_of "$path")" == "$MODEL_SHA256" ]]; then
    return
  fi
  echo "→ Downloading $MODEL_REPO@$MODEL_REVISION/$MODEL_FILE…"
  curl -fL --retry 3 --retry-delay 5 -o "$path.partial" \
    "https://huggingface.co/$MODEL_REPO/resolve/$MODEL_REVISION/$MODEL_FILE"
  local actual
  actual="$(sha256_of "$path.partial")"
  if [[ "$actual" != "$MODEL_SHA256" ]]; then
    rm -f "$path.partial"
    echo "Model checksum mismatch: expected $MODEL_SHA256, got $actual" >&2
    exit 1
  fi
  mv -f "$path.partial" "$path"
}

start() {
  command -v docker >/dev/null 2>&1 || {
    echo "docker is required to run the test embedder" >&2
    exit 1
  }
  fetch_model
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  echo "→ Starting $MODEL_ID on http://127.0.0.1:$PORT (llama.cpp, CPU)…"
  # --pooling last is the model's pooling; a single 8192-token micro-batch
  # lets one request embed a whole chunk, as the model card recommends.
  docker run -d --name "$CONTAINER" \
    -p "127.0.0.1:$PORT:8080" \
    -v "$CACHE_DIR:/models:ro" \
    "$SERVER_IMAGE" \
    -m "/models/$MODEL_FILE" \
    --alias "$MODEL_ID" \
    --embedding --pooling last \
    -c 8192 -b 8192 -ub 8192 \
    --host 0.0.0.0 --port 8080 >/dev/null

  for _ in $(seq 1 120); do
    if curl -sf "http://127.0.0.1:$PORT/v1/models" >/dev/null 2>&1; then
      local dim
      dim="$(curl -sf "http://127.0.0.1:$PORT/v1/embeddings" \
        -H 'Content-Type: application/json' \
        -d "{\"model\":\"$MODEL_ID\",\"input\":[\"readiness probe\"]}" |
        node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>console.log(JSON.parse(s).data[0].embedding.length))')"
      echo "✓ Test embedder ready: $MODEL_ID, ${dim}-dim, http://127.0.0.1:$PORT/v1"
      return
    fi
    if [[ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" != "true" ]]; then
      break
    fi
    sleep 1
  done
  echo "Test embedder did not become ready on port $PORT" >&2
  docker logs "$CONTAINER" 2>&1 | tail -40 >&2 || true
  exit 1
}

stop() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  *)
    echo "Usage: $0 start|stop" >&2
    exit 64
    ;;
esac
