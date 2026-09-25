#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath
set -eu

if [ -n "${OMNESIS_SEEDED_STATE_DIR:-}" ]; then
  : "${OMNESIS_SEEDED_STATE_MANIFEST_SHA256:?OMNESIS_SEEDED_STATE_MANIFEST_SHA256 is required}"
  OMNESIS_SEEDED_STATE_PRODUCT_VERSION="$(node -p "require('/app/packages/gateway/package.json').version")"
  OMNESIS_SEEDED_STATE_MAX_SCHEMA_VERSION="$(node --input-type=module -e "import('/app/packages/gateway/dist/data/schema-version.js').then(m => process.stdout.write(String(m.LATEST_SCHEMA_VERSION)))")"
  env \
    OMNESIS_SEEDED_STATE_PRODUCT_VERSION="$OMNESIS_SEEDED_STATE_PRODUCT_VERSION" \
    OMNESIS_SEEDED_STATE_MAX_SCHEMA_VERSION="$OMNESIS_SEEDED_STATE_MAX_SCHEMA_VERSION" \
    node /app/scripts/seeded-state/artifact.mjs install \
      "$OMNESIS_SEEDED_STATE_DIR" "${OMNESIS_CONFIG_DIR:?OMNESIS_CONFIG_DIR is required}"
fi

exec "$@"
