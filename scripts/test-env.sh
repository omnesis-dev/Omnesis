#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath

# Create an isolated test environment.
# Uses a stable path so all terminals share the same env.
# Run `rm -rf /tmp/omnesis-test` to start fresh.
#
# Source this file (`source scripts/test-env.sh`) before running `omnesis …` or
# curl against an isolated gateway. The gateway serves HTTPS with a self-signed
# cert written to "$OMNESIS_CONFIG_DIR/tls/cert.pem" on first boot, so the URLs
# use https:// and NODE_EXTRA_CA_CERTS points Node (and the `omnesis` CLI) at
# that cert — otherwise the TLS handshake fails with a self-signed-cert error.
export OMNESIS_CONFIG_DIR=/tmp/omnesis-test
export OMNESIS_GATEWAY_PORT=7700
export OMNESIS_COLLECTOR_PORT=7701
export OMNESIS_GATEWAY_URL=https://localhost:7700
export OMNESIS_COLLECTOR_URL=https://localhost:7701
export NODE_EXTRA_CA_CERTS="$OMNESIS_CONFIG_DIR/tls/cert.pem"

mkdir -p "$OMNESIS_CONFIG_DIR"
echo "Test env: $OMNESIS_CONFIG_DIR"
echo "  Gateway:   $OMNESIS_GATEWAY_URL"
echo "  CA cert:   $NODE_EXTRA_CA_CERTS"
if [ ! -f "$NODE_EXTRA_CA_CERTS" ]; then
  echo "  (cert not present yet — it appears after the gateway's first boot)"
fi
