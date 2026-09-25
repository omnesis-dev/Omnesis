# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY packages ./packages
RUN npm ci --ignore-scripts --omit=dev --workspace @omnesis/relay --include-workspace-root=false \
    && npm rebuild better-sqlite3

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production \
    OMNESIS_RELAY_HOST=0.0.0.0 \
    OMNESIS_RELAY_PORT=8080 \
    OMNESIS_RELAY_DB_PATH=/var/lib/omnesis-relay/relay.db
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY --chown=node:node --from=dependencies /app/packages/relay ./packages/relay
COPY --chown=node:node --from=dependencies /app/packages/core ./packages/core
COPY --chown=node:node --from=dependencies /app/packages/config ./packages/config
COPY --chown=node:node --from=dependencies /app/packages/source-sdk ./packages/source-sdk
COPY --chown=node:node --from=dependencies /app/packages/types ./packages/types
RUN install -d -o node -g node -m 0700 /var/lib/omnesis-relay
USER node
EXPOSE 8080
ENTRYPOINT ["node", "node_modules/tsx/dist/cli.mjs", "packages/relay/src/main.ts"]
