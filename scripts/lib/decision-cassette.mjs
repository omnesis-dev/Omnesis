// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Pure helpers for the decision-cassette recorder
// (scripts/record-decision-cassette.mjs).
//
// The gateway already stores every decision it asked for in its ledger
// (`cognition_decisions`): the exact request (model, state, questions) and the
// reply (model, answers). Recording is therefore a transform over ledger rows,
// not a second execution. Split out from the CLI so the transform, the dedupe
// and the real-content guard can be unit-tested without a database.

import { homedir } from "node:os";
import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";

import {
  decisionFingerprint,
  formatDecisionCassetteEntry,
} from "../../packages/core/src/models/decision-cassette.ts";
import { scanCassetteLine } from "./replay-recorder.mjs";

/**
 * The ledger query: answered decisions that made their own call. A reused
 * decision repeats an earlier one (no request of its own) and an unavailable
 * one has no answer, so neither is replayable.
 */
export const DECISION_ROWS_SQL = `
  SELECT id, run_id, request_json, response_json, input_tokens, created_at
    FROM cognition_decisions
   WHERE reused_from IS NULL
     AND request_json IS NOT NULL
     AND response_json IS NOT NULL
   ORDER BY created_at, id`;

/**
 * Convert one ledger row into a cassette entry's request and response. The
 * request's `model` is dropped: a cassette is keyed on state and questions
 * only, so it replays under any pinned model version.
 *
 * @param {{ id: string, request_json: string, response_json: string, input_tokens: number | null }} row
 * @returns {{ request: { state: unknown, questions: Record<string, unknown> }, response: { model: string, answers: Record<string, unknown>, inputTokens?: number } }}
 */
export function decisionRowToEntry(row) {
  const request = JSON.parse(row.request_json);
  const response = JSON.parse(row.response_json);
  if (
    !request ||
    typeof request !== "object" ||
    request.state === undefined ||
    !request.questions
  ) {
    throw new Error(`decision ${row.id}: request_json has no {state, questions}`);
  }
  if (!response || typeof response.model !== "string" || !response.answers) {
    throw new Error(`decision ${row.id}: response_json has no {model, answers}`);
  }
  return {
    request: { state: request.state, questions: request.questions },
    response: {
      model: response.model,
      answers: response.answers,
      ...(typeof row.input_tokens === "number" ? { inputTokens: row.input_tokens } : {}),
    },
  };
}

/**
 * Build cassette text from ledger rows. One line per distinct request (the
 * newest answer wins, matching how the replay backend keys its map), in the
 * order the requests were first asked.
 *
 * THROWS, writing nothing, when any entry carries a real-looking token
 * (emails off reserved domains, phone numbers, credential or opaque-id
 * shapes): a cassette is committed to the repo, so it must be reviewed by a
 * human before anything real-looking can land. The fingerprint itself is a
 * hash the recorder computed and is not scanned.
 *
 * @param {ReadonlyArray<{ id: string, request_json: string, response_json: string, input_tokens: number | null }>} rows
 * @param {{ denylist?: string[] }} [opts]
 * @returns {{ jsonl: string, lines: string[] }}
 */
export function buildDecisionCassette(rows, opts = {}) {
  /** @type {Map<string, { id: string, line: string }>} */
  const byFp = new Map();
  /** @type {Array<{ id: string, finding: { kind: string, match: string } }>} */
  const leaks = [];
  for (const row of rows) {
    const { request, response } = decisionRowToEntry(row);
    const findings = scanCassetteLine(JSON.stringify({ request, response }), {
      denylist: opts.denylist,
    });
    for (const finding of findings) leaks.push({ id: row.id, finding });
    const fp = decisionFingerprint(request);
    const line = formatDecisionCassetteEntry(request, response);
    if (byFp.has(fp)) byFp.get(fp).line = line;
    else byFp.set(fp, { id: row.id, line });
  }
  if (leaks.length > 0) {
    const detail = leaks
      .map(({ id, finding }) => `  ${id}: ${finding.kind}: ${finding.match}`)
      .join("\n");
    throw new Error(
      `Refusing to write a decision cassette — ${leaks.length} real-looking token(s) must be reviewed by a human before commit:\n${detail}`,
    );
  }
  const lines = [...byFp.values()].map((v) => v.line);
  return { jsonl: lines.length > 0 ? `${lines.join("\n")}\n` : "", lines };
}

/**
 * Refuse a database under the operator's live config directory
 * (`~/.config/omnesis`). A cassette is committed to the repo, and a ledger
 * from a real corpus carries real mail in every request; the content guard is
 * a backstop, not a licence. Symlinks are resolved so a link into the live
 * directory is refused too.
 *
 * @param {string} dbPath
 * @param {string} [home]  the home directory (tests pass a fixture)
 */
export function refuseLiveDatabase(dbPath, home = homedir()) {
  const real = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  const live = real(resolve(home, ".config", "omnesis"));
  const target = real(resolve(dbPath));
  if (target === live || target.startsWith(`${live}${sep}`)) {
    throw new Error(
      `Refusing to record from ${dbPath}: it is inside the live config directory ${live}. Record from a dev or synthetic gateway's database instead.`,
    );
  }
}
