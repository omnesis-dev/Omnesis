#!/usr/bin/env -S npx tsx
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Rewrite every frozen trace from the current engine.
 *
 *   npx tsx packages/watch/scripts/regenerate-goldens.ts
 *
 * Run this when a change is *meant* to move the traces, then read the diff —
 * that diff is the change's real description, and it is the only place the
 * effect of an engine change is visible in full. A regeneration that produces
 * a diff you cannot explain line by line is a regression, not a golden update.
 *
 * Regenerate the universe's own fixtures first if the journal changed:
 *
 *   node packages/watch/universes/poc/_build/build.mjs
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { format } from "prettier";

import { recordGolden, watchNames } from "../src/backtest/golden.js";
import { universeDir } from "../src/universe/paths.js";

async function main(): Promise<void> {
  const dir = join(universeDir(), "traces");
  const names = watchNames();

  for (const name of names) {
    const golden = await recordGolden(name);
    // Formatted the way the repo formats every other checked-in JSON file, so
    // re-recording a golden that did not change leaves the tree clean. Raw
    // JSON.stringify disagrees with Prettier about when a short array fits on
    // one line, which is enough to make every run look like a diff.
    writeFileSync(
      join(dir, `${name}.json`),
      await format(JSON.stringify(golden), { parser: "json" }),
    );
  }

  process.stdout.write(`regenerated ${names.length} traces\n`);
}

await main();
