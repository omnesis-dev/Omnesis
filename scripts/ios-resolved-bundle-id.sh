#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Adrien Conrath

# Read the identity Xcode will actually build after xcodegen generate.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${1:?usage: ios-resolved-bundle-id.sh TARGET [CONFIGURATION]}"
CONFIGURATION="${2:-Debug}"

xcodebuild -project "$ROOT/ios/Omnesis.xcodeproj" -target "$TARGET" \
  -configuration "$CONFIGURATION" -showBuildSettings -json \
  | python3 -c 'import json,sys
records = json.load(sys.stdin)
if len(records) != 1:
    raise SystemExit("expected one Xcode target build-settings record")
identifier = records[0]["buildSettings"]["PRODUCT_BUNDLE_IDENTIFIER"]
if not identifier or "$(" in identifier:
    raise SystemExit("unresolved PRODUCT_BUNDLE_IDENTIFIER: " + identifier)
print(identifier)'
