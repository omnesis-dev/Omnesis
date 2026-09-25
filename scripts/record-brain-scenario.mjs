#!/usr/bin/env -S npx tsx
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Record a background cognition run as a replayable cassette.
 *
 * Every run attempt already persists its exact prompt plus the full verbatim
 * agent event stream, so recording is a transform over a transcript rather
 * than a second execution: point this at a transcript from a DEV gateway and
 * it emits the `.jsonl` + `.meta.json` pair the replay backend serves.
 *
 * Mutating tool calls are converted to LIVE calls (their recorded result is
 * dropped) so a replay's writes really land, and ids those calls minted are
 * lifted into `$CAP_` captures so later calls address the rows that exist at
 * replay time rather than the ones the recording happened to get.
 *
 * Usage:
 *   scripts/record-brain-scenario.mjs \
 *     --transcript <path to a transcript .json> \
 *     --out evals/universes/<universe>/agent-demos/<name> \
 *     [--db <gateway sqlite path>]   # resolves doc ids to $DOC_<externalId>
 *     [--trigger "<extra trigger substring>"]
 *
 * Transcripts live under `<configDir>/briefs/transcripts/`, and are also
 * readable over `GET /admin/brain/transcripts`.
 *
 * NEVER point this at the operator's live gateway: a cassette is committed to
 * the repo, and a real corpus run would carry real content into it. The guard
 * refuses to write anything real-looking, but the guard is a backstop, not a
 * licence.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, basename } from "node:path";

import {
  buildBrainEntries,
  serializeBrainCassette,
  triggersForKind,
} from "./lib/brain-cassette.mjs";
import { scanCassetteLine } from "./lib/replay-recorder.mjs";

/**
 * Refuse to write anything real-looking. `serializeBrainCassette` already
 * guards the event lines; the JSONL header and the `.meta.json` are written
 * outside it and carry operator-supplied text (`--trigger`) and corpus-derived
 * external ids, so they get the same treatment rather than the docstring's
 * promise being true of only part of the output.
 */
function refuseIfRealLooking(what, text) {
  const findings = scanCassetteLine(text);
  if (findings.length === 0) return;
  const detail = findings.map((f) => `  ${f.kind}: ${f.match}`).join("\n");
  throw new Error(
    `Refusing to write ${what} — ${findings.length} real-looking token(s) must be ` +
      `reviewed by a human before commit:\n${detail}`,
  );
}

function parseArgs(argv) {
  const out = { trigger: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === "--transcript") out.transcript = next();
    else if (arg === "--out") out.out = next();
    else if (arg === "--db") out.db = next();
    else if (arg === "--trigger") out.trigger.push(next());
    else if (arg === "--help" || arg === "-h") out.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

/** Map every document id appearing in the transcript to its external id. */
async function resolveDocExternalIds(dbPath, text) {
  if (!dbPath) return {};
  const { default: Database } = await import("better-sqlite3");
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    /** @type {Record<string,string>} */
    const out = {};
    const rows = db.prepare("SELECT id, external_id FROM documents").all();
    for (const row of rows) {
      if (
        typeof row.id === "string" &&
        typeof row.external_id === "string" &&
        text.includes(row.id)
      ) {
        out[row.id] = row.external_id;
      }
    }
    return out;
  } finally {
    db.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.transcript || !args.out) {
    console.log(
      "Usage: scripts/record-brain-scenario.mjs --transcript <file> --out <dir/name> [--db <sqlite>] [--trigger <text>]",
    );
    process.exit(args.help ? 0 : 1);
  }

  const transcript = JSON.parse(readFileSync(args.transcript, "utf-8"));
  const events = transcript.events ?? [];
  if (events.length === 0) {
    throw new Error(`${args.transcript} carries no events — nothing to record`);
  }
  const kind = transcript.kind;
  if (typeof kind !== "string") {
    throw new Error(`${args.transcript} has no run kind`);
  }

  const { entries, liveCalls, captures } = buildBrainEntries(events);

  // The recorder KNOWS the session/message ids — the transcript names the
  // session it recorded — so those substitutions are certain.
  const sessionId =
    transcript.sessionId ?? `loop-agent-run-${transcript.runId}-a${transcript.attempt ?? 1}`;
  const messageId = transcript.messageId ?? findMessageId(events) ?? "__unknown_message__";

  const docExternalIds = await resolveDocExternalIds(args.db, JSON.stringify(events));
  const { jsonl, lines } = serializeBrainCassette(
    entries,
    { sessionId, messageId },
    {
      docExternalIds,
    },
  );

  const outDir = dirname(args.out);
  const name = basename(args.out);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  const header = [
    `# Recorded from cognition run ${transcript.runId} (kind: ${kind}, attempt ${transcript.attempt ?? 1}).`,
    `# ${liveCalls.length} live tool call(s): ${[...new Set(liveCalls)].join(", ") || "(none)"}.`,
    `# Their results are omitted deliberately — the REAL tool layer runs at replay time.`,
  ].join("\n");
  refuseIfRealLooking(`${name}.jsonl header`, header);
  writeFileSync(`${args.out}.jsonl`, `${header}\n${jsonl}`);

  const meta = `${JSON.stringify(
    {
      triggers: [...triggersForKind(kind), ...args.trigger],
      role: "background-agent",
      ...(Object.keys(docExternalIds).length > 0
        ? { placeholders: { docExternalIds: [...new Set(Object.values(docExternalIds))] } }
        : {}),
    },
    null,
    2,
  )}\n`;
  refuseIfRealLooking(`${name}.meta.json`, meta);
  writeFileSync(`${args.out}.meta.json`, meta);

  console.log(`✓ wrote ${name}.jsonl (${lines.length} entries) + ${name}.meta.json`);
  console.log(`  live calls: ${[...new Set(liveCalls)].join(", ") || "(none)"}`);
  console.log(`  captures:   ${Object.keys(captures).join(", ") || "(none)"}`);
  console.log(`  Review the cassette, then run: npx tsx scripts/validate-universes.mjs`);
}

function findMessageId(events) {
  for (const e of events) {
    const id = e?.payload?.messageId;
    if (typeof id === "string") return id;
  }
  return null;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
