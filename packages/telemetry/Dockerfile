# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9
FROM ${NODE_IMAGE} AS dependencies
WORKDIR /app
RUN --mount=type=bind,source=scripts/docker/apt-get-bounded.sh,target=/tmp/apt-get-bounded.sh \
    sh /tmp/apt-get-bounded.sh update \
    && sh /tmp/apt-get-bounded.sh install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY packages ./packages
RUN npm ci --ignore-scripts --omit=dev --workspace @omnesis/telemetry --include-workspace-root=false && npm rebuild better-sqlite3
FROM ${NODE_IMAGE}
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=dependencies /app/packages/telemetry ./packages/telemetry
RUN install -d -o node -g node -m 0700 /var/lib/omnesis-telemetry
USER node
ENV OMNESIS_TELEMETRY_HOST=0.0.0.0 OMNESIS_TELEMETRY_PORT=8080 OMNESIS_TELEMETRY_DB=/var/lib/omnesis-telemetry/census.db
ENTRYPOINT ["node", "node_modules/tsx/dist/cli.mjs", "packages/telemetry/src/main.ts"]
