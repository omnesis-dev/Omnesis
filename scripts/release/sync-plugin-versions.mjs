// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PLUGIN_MANIFESTS = [
  "plugins/omnesis/plugin.json",
  "plugins/omnesis-claude/.claude-plugin/plugin.json",
  "extension/public/manifest.json",
  "integrations/openclaw-omnesis-plugin/package.json",
];

export const YAML_PLUGIN_MANIFESTS = ["packages/agent-integration/hermes/plugin.yaml"];

export const PRODUCT_VERSION_CONTRACTS = ["extension/release-contract.json"];

/**
 * Rewrite one top-level string field of a JSON file in place. The file is
 * edited as text rather than re-serialized so Prettier's formatting of
 * everything else (inline short arrays, in particular) survives the bump.
 */
function rewriteTopLevelStringField(path, relativePath, key, value) {
  const text = readFileSync(path, "utf8");
  const field = new RegExp(`^( {2}"${key}":\\s*)"[^"]*"`, "mu");
  if (!field.test(text)) throw new Error(`${relativePath} has no top-level "${key}" string`);
  writeFileSync(path, text.replace(field, `$1${JSON.stringify(value)}`));
}

export function syncPluginVersions(repoRoot) {
  const cli = JSON.parse(readFileSync(join(repoRoot, "packages/cli/package.json"), "utf8"));
  if (typeof cli.version !== "string" || cli.version.length === 0) {
    throw new Error("packages/cli/package.json has no product version");
  }

  for (const relativePath of PLUGIN_MANIFESTS) {
    rewriteTopLevelStringField(join(repoRoot, relativePath), relativePath, "version", cli.version);
  }
  for (const relativePath of YAML_PLUGIN_MANIFESTS) {
    const path = join(repoRoot, relativePath);
    const manifest = readFileSync(path, "utf8");
    if (!/^version:\s*\S+/mu.test(manifest)) throw new Error(`${relativePath} has no version`);
    writeFileSync(path, manifest.replace(/^version:\s*\S+/mu, `version: ${cli.version}`));
  }
  for (const relativePath of PRODUCT_VERSION_CONTRACTS) {
    rewriteTopLevelStringField(
      join(repoRoot, relativePath),
      relativePath,
      "productVersion",
      cli.version,
    );
  }
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  syncPluginVersions(join(dirname(scriptPath), "..", ".."));
}
