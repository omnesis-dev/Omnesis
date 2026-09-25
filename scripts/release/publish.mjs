#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Publish the staged Omnesis package graph.
 *
 *   node scripts/release/publish.mjs --registry <url> [--tag <dist-tag>] [--access public|restricted] [--dry-run]
 *
 * Stages every publishable package (stage-packages.mjs), packs each one,
 * then publishes them in dependency order against the given registry,
 * skipping versions the registry already holds byte for byte and stopping
 * on one it holds with different content — see publish-graph.mjs. Running
 * the same command again after an interruption continues the graph.
 *
 * `--registry` is required and explicit on purpose: it makes "publish to
 * the local verdaccio for an E2E test" and "publish to npmjs for a release"
 * the same deliberate command with no implicit default. `--dry-run` stops
 * after packing, leaving tarballs in release/tarballs/ for inspection.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { publishGraph } from "./publish-graph.mjs";
import { assertPublishPolicy, normalizePublishAccess } from "./publish-policy.mjs";
import { listPublishablePackages, stagePackage } from "./stage-packages.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function arg(name) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const registry = arg("--registry");
const tag = arg("--tag") ?? "latest";
// Fail closed: npmjs publishes default to org-private artifacts, and public
// npmjs publishes require an explicit env override in addition to
// --access public.
const dryRun = process.argv.includes("--dry-run");
let access;
try {
  access = normalizePublishAccess(arg("--access"));
  assertPublishPolicy({ registry, access, dryRun });
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(2);
}

if (!registry && !dryRun) {
  console.error(
    "Usage: publish.mjs --registry <url> [--tag <dist-tag>] [--access public|restricted] [--dry-run]",
  );
  process.exit(2);
}

try {
  await publishGraph({
    packages: listPublishablePackages(),
    registry,
    tag,
    access,
    dryRun,
    stagingBase: join(repoRoot, "release", "staging"),
    tarballDir: join(repoRoot, "release", "tarballs"),
    stage: stagePackage,
  });
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
