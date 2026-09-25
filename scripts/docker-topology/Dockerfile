# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath
#
# Topology-E2E host image: a stock Linux box with Node and git and NOTHING
# else of Omnesis on it. The point of this lane is that the installer puts
# Omnesis there itself, exactly as a real operator's second machine would, so
# the repo must not be baked into the image.
#
# The npm cache IS warmed at build time: a throwaway `npm ci` populates the
# cache so the installer's own `npm ci` resolves from it instead of the
# network. The tree it installed is deleted again — only the cache survives.
FROM node:24-bookworm

# curl drives the health probes and pipes the installer; git is what the
# installer clones with; procps supplies `pkill` for the daemon helpers;
# ca-certificates keeps outbound HTTPS honest.
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl git procps ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Every scenario runs as this unprivileged account: the installer is
# documented to need no root except an optional Node bootstrap, and this
# proves it. Debian already ships an `operator` group, so the account is named
# for the product rather than for the role.
RUN useradd --create-home --shell /bin/bash omnesis
USER omnesis
WORKDIR /home/omnesis

# Warm the cache AS THAT ACCOUNT. Warming it as root would fill root's cache
# directory, which the unprivileged installer cannot read — the install would
# silently fall back to the network and take minutes longer.
#
# Only the manifests and the lockfile matter here, but workspace globs mean
# npm wants the whole tree present to resolve them, so copy it, install, and
# throw the tree away. `npm ci` also caches prebuilt native binaries, which is
# where most of an install's time goes.
COPY --chown=omnesis:omnesis . /home/omnesis/warm
RUN cd /home/omnesis/warm \
  && (npm ci --no-audit --no-fund >/tmp/warm.log 2>&1 \
      || { echo "cache warm incomplete; the installer will fetch more at run time"; \
           tail -20 /tmp/warm.log; }) \
  ; rm -rf /home/omnesis/warm /tmp/warm.log
