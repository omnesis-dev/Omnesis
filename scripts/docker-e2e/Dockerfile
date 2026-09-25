# Security-E2E image: the full Omnesis monorepo, installable and runnable from
# source on a stock Debian/Node base — the closest containerized stand-in for
# a fresh headless Linux host. Scenarios mount nothing from the host; every
# run starts from a clean layer.
FROM node:24-bookworm

# curl for health probes; procps for ps in the dedicated-user scenario.
RUN apt-get update && apt-get install -y --no-install-recommends curl procps \
  && rm -rf /var/lib/apt/lists/*

RUN mkdir /e2e
WORKDIR /repo
COPY . .
# Native modules (better-sqlite3-multiple-ciphers, duckdb) install their
# prebuilt binaries here; the layer is reused while the lockfile is unchanged.
RUN npm ci --no-audit --no-fund
# The build host's umask can bake owner-only modes into the copied tree; the
# dedicated-user scenario needs non-root accounts to read + traverse the repo.
RUN chmod -R a+rX /repo && chmod 0777 /e2e

