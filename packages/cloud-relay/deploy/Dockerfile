# Cloud relay image. Built only by .github/workflows/relay-image.yml, from
# the repository root, for one exact commit of main that passed full
# validation. That workflow signs the result; a relay host should run only
# images whose signature it has checked (see packages/cloud-relay/README.md).
#
# The base image is pinned by digest. linux/amd64 only.
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9

FROM ${NODE_IMAGE} AS dependencies
WORKDIR /app
# scripts/docker/apt-get-bounded.sh fails a stalled mirror instead of hanging.
RUN --mount=type=bind,source=scripts/docker/apt-get-bounded.sh,target=/tmp/apt-get-bounded.sh \
    sh /tmp/apt-get-bounded.sh update \
    && sh /tmp/apt-get-bounded.sh install -y --no-install-recommends ca-certificates python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY packages ./packages
# Install scripts stay off; only the native SQLite binding is compiled.
RUN npm ci --ignore-scripts --omit=dev --workspace @omnesis/cloud-relay --include-workspace-root=false && npm rebuild better-sqlite3

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --chown=10001:10001 --from=dependencies /app/node_modules ./node_modules
COPY --chown=10001:10001 --from=dependencies /app/packages/cloud-relay ./packages/cloud-relay
COPY --chown=10001:10001 --from=dependencies /app/packages/core ./packages/core
COPY --chown=10001:10001 --from=dependencies /app/packages/platform ./packages/platform
COPY --chown=10001:10001 --from=dependencies /app/packages/config ./packages/config
COPY --chown=10001:10001 --from=dependencies /app/packages/source-sdk ./packages/source-sdk
COPY --chown=10001:10001 --from=dependencies /app/packages/types ./packages/types
USER 10001:10001
ENTRYPOINT ["node", "node_modules/tsx/dist/cli.mjs", "packages/cloud-relay/src/main.ts"]
CMD ["serve"]
