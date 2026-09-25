# ── Base ──────────────────────────────────────────────────────────────────────
# Node 24 LTS. This stage compiles and installs the application's native
# dependencies for the target image architecture.
# This stage exists only to compile and install: `python3` + `build-essential`
# are node-gyp's toolchain, needed whenever a native dependency has no prebuilt
# binary for the target platform. The published images below start from a plain
# `node:24-slim` and never carry a compiler.
FROM node:24-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates python3 build-essential \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# ── Compiled runtime closures ─────────────────────────────────────────────────
# One closure serves both daemon images. Both ship the `omnesis` CLI, because
# `docker compose exec <service> omnesis …` is the supported way to drive a
# container install — and `omnesis` depends on both `@omnesis/gateway` and
# `@omnesis/collector`, so its closure already holds everything either image
# needs. That is also why these images are large: the CLI reaches every
# provider package, and neither image can be trimmed without giving up that
# control path.
FROM base AS runtime-build
COPY package.json package-lock.json tsconfig*.json LICENSE ./
COPY packages/ packages/
COPY patches/ patches/
COPY scripts/native-runtime-preflight.mjs scripts/native-runtime-preflight.mjs
RUN npm ci
COPY scripts/release/ scripts/release/
COPY scripts/runtime/ scripts/runtime/
COPY scripts/seeded-state/ scripts/seeded-state/
RUN node scripts/runtime/stage-runtime.mjs --build \
      --package omnesis --out /opt/omnesis-runtime

# ── Production dependencies ───────────────────────────────────────────────────
# Both images ship the CLI, and the CLI's own dependency tree spans the gateway
# and the collector, so the two production trees resolve identically. Installing
# them once keeps the images consistent and halves the install work.
FROM base AS runtime-dependencies
COPY package.json package-lock.json ./
COPY packages/ packages/
COPY scripts/native-runtime-preflight.mjs scripts/native-runtime-preflight.mjs
# The root prepare/postinstall hooks are development-only. The native-runtime
# compatibility preinstall remains, as do dependency lifecycle scripts.
RUN npm pkg delete scripts.prepare scripts.postinstall \
    && npm ci --omit=dev --omit=peer \
       --workspace @omnesis/gateway \
       --workspace @omnesis/collector \
       --workspace omnesis \
       --include-workspace-root=false \
    && rm -rf /app/node_modules/typescript \
    && rm -f /app/node_modules/.bin/tsc /app/node_modules/.bin/tsserver

# ── Hardened runtime base ─────────────────────────────────────────────────────
# Shared by both daemon images: no JavaScript package managers, a fixed non-root uid/gid,
# and the state directory the daemons own. `curl` is the gateway's healthcheck
# client.
FROM node:24-slim AS runtime-base
# The compiled runtime invokes node directly; JavaScript package managers add
# executable code and dependency trees without serving a production purpose.
# The upgrade applies Debian security fixes published after the node:24-slim
# tag was last rebuilt, so a published image never ships a fixed vulnerability.
RUN apt-get update && apt-get upgrade -y --no-install-recommends \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-v* \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx \
       /usr/local/bin/corepack /usr/local/bin/pnpm /usr/local/bin/pnpx /usr/local/bin/yarn /usr/local/bin/yarnpkg \
    && groupadd --gid 10001 omnesis \
    && useradd --uid 10001 --gid omnesis --create-home --shell /usr/sbin/nologin omnesis \
    && install -d -m 0700 -o omnesis -g omnesis /var/lib/omnesis
WORKDIR /app
# The CLI entry point every image carries. `docker compose exec <service>
# omnesis …` is the supported way to drive an install, so the binary has to be
# on PATH rather than reachable only as a long node invocation.
RUN printf '#!/bin/sh\nexec node /app/packages/cli/dist/index.js "$@"\n' > /usr/local/bin/omnesis \
    && chmod 0555 /usr/local/bin/omnesis
COPY --from=runtime-dependencies /app/node_modules ./node_modules
ENV HOME=/home/omnesis \
    OMNESIS_CONFIG_DIR=/var/lib/omnesis \
    NODE_ENV=production

# ── Compiled, unprivileged gateway runtime ───────────────────────────────────
# Build with: docker build --target gateway-runtime -t omnesis-gateway-runtime .
FROM runtime-base AS gateway-runtime
COPY --from=runtime-build /opt/omnesis-runtime/packages ./packages
COPY --from=runtime-build --chmod=0555 /app/scripts/seeded-state ./scripts/seeded-state
EXPOSE 7600
USER 10001:10001
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl --fail --insecure --silent --show-error https://127.0.0.1:7600/health >/dev/null || exit 1
ENTRYPOINT ["/app/scripts/seeded-state/entrypoint.sh"]
CMD ["node", "packages/gateway/dist/index.js"]

# ── Compiled, unprivileged collector runtime ─────────────────────────────────
# Build with: docker build --target collector-runtime -t omnesis-collector-runtime .
FROM runtime-base AS collector-runtime
COPY --from=runtime-build /opt/omnesis-runtime/packages ./packages
# The loopback redirect targets the OAuth providers are registered against, so
# an interactive `omnesis sources add` inside the container can complete a
# flow. The collector listens on nothing else: it reaches the gateway over a
# WebSocket it opens itself.
EXPOSE 3000 3001 3002 3003
# Without this the base image's own entrypoint stands, and this image's command
# is the only thing it should run.
ENTRYPOINT []
USER 10001:10001
# No HEALTHCHECK: the collector serves no HTTP health endpoint. Its liveness is
# the WebSocket session it holds with the gateway, which only the gateway can
# attest to, so a probe from inside this container would assert nothing.
CMD ["node", "packages/collector/dist/main.js"]

# ── Updater ───────────────────────────────────────────────────────────────────
# `omnesis update` replaces the running containers, which is why it is a
# separate image rather than a command inside the daemons. A container cannot
# pull the image it is itself running from, nor restart itself, so the update
# has to be driven from outside the containers being replaced — and neither
# long-running daemon should hold a client for the daemon that supervises it.
# This image is run one-shot and handed the Docker socket for that invocation
# alone. The installer's compose file runs it as the invoking host account,
# with `group_add` for the socket's group, so it never needs root. It derives
# from the gateway runtime because the two share every layer up to here, which
# makes the client below all it adds.
FROM gateway-runtime AS updater
# Pinned, because a moving tag would make two builds of one Omnesis commit ship
# different clients. Both binaries are statically linked, so nothing in this
# image has to match their libc.
COPY --from=docker:28.5.2-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker:28.5.2-cli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
# The inherited probe curls the gateway's port, which nothing serves here.
HEALTHCHECK NONE
ENTRYPOINT ["/usr/local/bin/omnesis"]
CMD ["update"]
