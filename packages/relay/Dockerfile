# Push relay image. Built only by .github/workflows/relay-image.yml, from the
# repository root, for one exact commit of main that passed full validation.
# That workflow signs the result; the relay host runs only images whose
# signature it has checked (see README.md, "Container image").
#
# The base image is pinned by digest. linux/amd64 only. The process runs as
# the image's `node` user (UID 1000), which owns the relay's data directory.
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9

FROM ${NODE_IMAGE} AS dependencies
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY packages ./packages
# Install scripts stay off; only the native SQLite binding is compiled.
RUN npm ci --ignore-scripts --omit=dev --workspace @omnesis/relay --include-workspace-root=false && npm rebuild better-sqlite3

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    OMNESIS_RELAY_HOST=0.0.0.0 \
    OMNESIS_RELAY_PORT=8080 \
    OMNESIS_RELAY_DB_PATH=/var/lib/omnesis-relay/relay.db
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY --chown=node:node --from=dependencies /app/packages/relay ./packages/relay
COPY --chown=node:node --from=dependencies /app/packages/core ./packages/core
COPY --chown=node:node --from=dependencies /app/packages/platform ./packages/platform
COPY --chown=node:node --from=dependencies /app/packages/config ./packages/config
COPY --chown=node:node --from=dependencies /app/packages/source-sdk ./packages/source-sdk
COPY --chown=node:node --from=dependencies /app/packages/types ./packages/types
RUN install -d -o node -g node -m 0700 /var/lib/omnesis-relay
USER node
EXPOSE 8080
ENTRYPOINT ["node", "node_modules/tsx/dist/cli.mjs", "packages/relay/src/main.ts"]
