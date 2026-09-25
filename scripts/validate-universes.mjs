#!/usr/bin/env -S npx tsx
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Validates every synthetic-corpus universe under evals/universes/.
 *
 * Usage:
 *   node scripts/validate-universes.mjs            # validate all in-tree universes
 *   node scripts/validate-universes.mjs <name|path># validate one universe
 *
 * Exit code is non-zero if any universe has at least one `error`-severity
 * issue. `warn`-severity issues are printed but don't fail the run.
 */
import { readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadUniverse,
  getUniversesDir,
  validateUniverse,
} from "../packages/providers-synth/_common/src/universe.ts";

function validateOne(nameOrPath) {
  let universe;
  try {
    universe = loadUniverse(nameOrPath);
  } catch (err) {
    console.error(`✗ ${nameOrPath}: failed to load — ${err instanceof Error ? err.message : err}`);
    return { errors: 1, warnings: 0 };
  }
  const issues = validateUniverse(universe);
  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warn");
  const tag = errors.length > 0 ? "✗" : warnings.length > 0 ? "!" : "✓";
  console.log(
    `${tag} ${universe.manifest.name} (${universe.dir}) — ${errors.length} error(s), ${warnings.length} warning(s)`,
  );
  for (const issue of issues) {
    const sev = issue.severity === "error" ? "ERROR" : "warn";
    console.log(`    [${sev}] ${issue.where}: ${issue.message}`);
  }
  return { errors: errors.length, warnings: warnings.length };
}

function main() {
  const arg = process.argv[2];
  let totalErrors = 0;
  let totalWarnings = 0;

  if (arg) {
    const r = validateOne(arg);
    totalErrors += r.errors;
    totalWarnings += r.warnings;
  } else {
    const root = getUniversesDir();
    const universes = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    if (universes.length === 0) {
      console.error(`No universes found under ${root}`);
      process.exit(1);
    }
    for (const name of universes) {
      const r = validateOne(name);
      totalErrors += r.errors;
      totalWarnings += r.warnings;
    }
  }

  console.log(``);
  console.log(`Total: ${totalErrors} error(s), ${totalWarnings} warning(s)`);
  if (totalErrors > 0) process.exit(1);
}

main();
