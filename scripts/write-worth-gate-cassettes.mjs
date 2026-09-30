#!/usr/bin/env -S npx tsx
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Regenerate the worth gate's replay cassette for the `loops-test-life`
 * universe from the invented mail table the `brain-decision-*` suites push
 * (`packages/collector/src/e2e/brain-bench/worth-gate-mail.ts`).
 *
 * Each line is the exact request the gateway's worth gate builds for one of
 * those emails — the rubric's own `emailWorthState` and
 * `EMAIL_WORTH_QUESTIONS` — paired with the score the table assigns it. Run it
 * after changing the rubric (question, state shape, body budget) or the mail
 * table; `worth-gate-mail.test.ts` fails until the committed file matches.
 *
 * Usage:
 *   npx tsx scripts/write-worth-gate-cassettes.mjs
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { worthGateCassetteLines } from "../packages/collector/src/e2e/brain-bench/worth-gate-mail.ts";

const out = join(
  import.meta.dirname,
  "..",
  "evals/universes/loops-test-life/decision-cassettes/worth-gate.jsonl",
);
const lines = worthGateCassetteLines();
writeFileSync(out, `${lines.join("\n")}\n`);
console.log(`✓ wrote ${lines.length} decision(s) to ${out}`);
console.log("  Validate with: npx tsx scripts/validate-universes.mjs loops-test-life");
