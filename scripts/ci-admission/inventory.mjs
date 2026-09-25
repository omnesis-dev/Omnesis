// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// These are logical requirements, not GitHub job names. The manifest adapter maps
// every job to one of these stable IDs, which keeps a workflow rename from silently
// shrinking the full-validation contract.
export const REQUIRED_LANES = Object.freeze([
  "privacy",
  "production-audit",
  "linux-typecheck",
  "suite-typecheck",
  "linux-lint",
  "format",
  "release-staging",
  "universe-validation",
  "parity-validation",
  "extension-package",
  "linux-unit",
  "linux-e2e",
  "browser-e2e",
  "embedder-e2e",
  "portal",
  "knip",
  "macos-typecheck",
  "macos-unit",
  "hermes",
  "swiftlint",
  "swiftformat",
  "ios-build",
  "ios-test",
  "ios-snapshots",
  "ios-live-e2e",
  "android-jvm",
  "android-policy",
  "android-render",
  "android-build",
  "android-live-e2e",
  "install-source",
  "install-package",
  "install-update",
  "docker-image-build",
  "docker-image-boot",
  "docker-install",
  "docker-runtime",
  "docker-security",
  "docker-hardened-systemd",
  "topology",
  "harness-openclaw",
  "harness-hermes",
  "security-static",
]);

export const VALIDATION_DEFINITION_FILES = Object.freeze([
  "full-validation.yml",
  "ci.yml",
  "knip.yml",
  "swiftlint.yml",
  "ios.yml",
  "android.yml",
  "docker-smoke.yml",
  "install-smoke.yml",
  "topology-e2e.yml",
  "harness-conformance.yml",
  "docker-e2e.yml",
  "docker.yml",
  "security-static.yml",
]);

export function validationDefinitionHash({
  lanes = REQUIRED_LANES,
  definitions = VALIDATION_DEFINITION_FILES.map((name) => [
    name,
    readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url)),
  ]),
} = {}) {
  const digest = createHash("sha256");
  digest.update("omnesis-full-validation-v1\0");
  for (const lane of lanes) digest.update(`lane\0${lane}\0`);
  for (const [name, contents] of definitions) {
    digest.update(`workflow\0${name}\0`);
    digest.update(contents);
    digest.update("\0");
  }
  return digest.digest("hex");
}

export const INVENTORY_VERSION = validationDefinitionHash();

export function evaluateManifest(results, version = INVENTORY_VERSION) {
  const missing = REQUIRED_LANES.filter((lane) => !(lane in results));
  const unsuccessful = REQUIRED_LANES.filter(
    (lane) => lane in results && results[lane] !== "success",
  );
  return {
    success: version === INVENTORY_VERSION && missing.length === 0 && unsuccessful.length === 0,
    versionMatches: version === INVENTORY_VERSION,
    missing,
    unsuccessful,
  };
}
