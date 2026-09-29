#!/usr/bin/env -S npx tsx
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Record a gateway's typed decisions as a replayable decision cassette.
 *
 * Every decision the Brain asks of the decision model (the worth gate today)
 * is stored in the `cognition_decisions` ledger with its exact request and
 * reply, so recording is a transform over that table rather than a second
 * execution: point this at a DEV gateway's database and it writes the `.jsonl`
 * the `replay` decision backend serves (see `@omnesis/core`'s
 * `decision-cassette`). Commit it under a universe's `decisionCassettes`
 * directory to replay those decisions with no network.
 *
 * Usage:
 *   scripts/record-decision-cassette.mjs \
 *     --db <gateway sqlite path> \
 *     --out evals/universes/<universe>/decision-cassettes/<name>.jsonl \
 *     [--run <run id>]...      # only the decisions made for these runs
 *
 * The database is opened read-only. NEVER point this at the operator's live
 * gateway: the script refuses a database under ~/.config/omnesis, and refuses
 * to write anything real-looking, but both guards are backstops, not a licence.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  DECISION_ROWS_SQL,
  buildDecisionCassette,
  refuseLiveDatabase,
} from "./lib/decision-cassette.mjs";

function parseArgs(argv) {
  const out = { runs: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === "--db") out.db = next();
    else if (arg === "--out") out.out = next();
    else if (arg === "--run") out.runs.push(next());
    else if (arg === "--help" || arg === "-h") out.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.db || !args.out) {
    console.log(
      "Usage: scripts/record-decision-cassette.mjs --db <sqlite> --out <file.jsonl> [--run <run id>]...",
    );
    process.exit(args.help ? 0 : 1);
  }
  refuseLiveDatabase(args.db);

  const { default: Database } = await import("better-sqlite3");
  const db = new Database(args.db, { readonly: true, fileMustExist: true });
  let rows;
  try {
    rows = db.prepare(DECISION_ROWS_SQL).all();
  } finally {
    db.close();
  }
  if (args.runs.length > 0) {
    const wanted = new Set(args.runs);
    rows = rows.filter((row) => wanted.has(row.run_id));
  }
  if (rows.length === 0) {
    throw new Error(
      `${args.db} holds no answered decisions${args.runs.length ? " for those runs" : ""}`,
    );
  }

  const { jsonl, lines } = buildDecisionCassette(rows);
  const outDir = dirname(args.out);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  writeFileSync(args.out, jsonl);

  console.log(
    `✓ wrote ${args.out} (${lines.length} decision(s) from ${rows.length} ledger row(s))`,
  );
  console.log(`  Review the cassette, then run: npx tsx scripts/validate-universes.mjs`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
