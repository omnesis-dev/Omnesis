// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Pure helpers for the replay-scenario recorder (scripts/record-replay-scenario.mjs).
//
// Split out from the CLI so the certainty-based placeholderization and the
// flag-and-fail secret/PII guard can be unit-tested without booting a gateway
// or a real agent backend. The CLI is the thin I/O shell; everything that
// decides what gets written to a cassette lives here.

import { scanText } from "../pii-scan.mjs";

/**
 * Recursively replace every occurrence of each `from → to` mapping in a value
 * tree, but ONLY as whole-string equality OR a full substring of a string —
 * never a fuzzy/regex match. Used to placeholder-ize the session/message ids
 * the harness MINTED (so we hold the exact mapping with certainty) into the
 * portable `$SESSION` / `$MSG` tokens the ReplayBackend substitutes back at
 * replay time. Because we only swap ids we minted ourselves, this can never
 * corrupt real model-authored content.
 *
 * @param {unknown} value
 * @param {ReadonlyArray<[from: string, to: string]>} mappings  longest-first
 * @returns {unknown}
 */
export function placeholderizeIds(value, mappings) {
  if (typeof value === "string") {
    let out = value;
    for (const [from, to] of mappings) {
      if (from.length === 0) continue;
      if (out === from) {
        out = to;
        continue;
      }
      if (out.includes(from)) out = out.split(from).join(to);
    }
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => placeholderizeIds(v, mappings));
  if (value && typeof value === "object") {
    /** @type {Record<string, unknown>} */
    const obj = {};
    for (const [k, v] of Object.entries(value)) obj[k] = placeholderizeIds(v, mappings);
    return obj;
  }
  return value;
}

/**
 * Build the id → placeholder mapping for a recorded session. The recorder KNOWS
 * the sessionId/messageId because it minted (created) the session and message
 * via the HTTP API, so these substitutions are certain. Sorted longest-first so
 * an id that's a prefix of another can't shadow it.
 *
 * @param {{ sessionId: string, messageId: string }} ids
 * @returns {Array<[string, string]>}
 */
export function buildIdMappings({ sessionId, messageId }) {
  /** @type {Array<[string, string]>} */
  const mappings = [];
  if (sessionId) mappings.push([sessionId, "$SESSION"]);
  if (messageId) mappings.push([messageId, "$MSG"]);
  return mappings.sort((a, b) => b[0].length - a[0].length);
}

// A "real-looking token" the id-placeholderization couldn't certainly resolve,
// beyond what pii-scan already flags. Long hex / base64url runs and UUIDs are
// the shapes a leaked secret or un-placeholdered runtime id hides behind. We
// deliberately do NOT auto-rewrite these — we flag-and-fail so a human reviews,
// because we have NO certain mapping for them (rewriting blindly would risk
// corrupting legitimate model-authored content).
const SUSPICIOUS_TOKEN_RES = [
  // 32+ hex chars (md5/sha-ish, raw tokens). Word-bounded.
  { kind: "long-hex", re: /\b[0-9a-fA-F]{32,}\b/g },
  // RFC-4122 UUID (a runtime id we couldn't map → must review).
  {
    kind: "uuid",
    re: /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g,
  },
  // 24+ char base64url run (api-key / opaque-token shapes). Requires a mix so
  // ordinary words/sentences (all letters) don't trip it.
  {
    kind: "base64ish",
    re: /\b(?=[A-Za-z0-9_-]*[0-9])(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{24,}\b/g,
  },
];

/**
 * Scan one already-id-placeholderized cassette line (the serialized JSON) for
 * anything real-looking that survived. Returns `{ kind, match }` findings:
 *
 *   - pii-scan hits (emails off reserved domains, phones, IPs, credential
 *     shapes, denylist terms) — the authoritative secret/PII detector reused
 *     verbatim from the repo's git/GitHub guard.
 *   - the extra "suspicious token" shapes (long hex, UUID, base64ish) that a
 *     leaked id or opaque key hides behind, which pii-scan's narrower
 *     credential regexes don't catch.
 *
 * The placeholder tokens we ourselves wrote (`$SESSION`, `$MSG`, `$DOC_…`,
 * `$PERSON_…`) are stripped before scanning so they can't read as real tokens.
 *
 * @param {string} line  serialized cassette line (post-placeholderization)
 * @param {{ denylist?: string[] }} [opts]
 * @returns {Array<{ kind: string, match: string }>}
 */
export function scanCassetteLine(line, opts = {}) {
  // Strip our own placeholders so they don't read as suspicious tokens.
  const scrubbed = line.replace(/\$[A-Z][A-Z0-9_]*(?:_[\w.-]+)?/g, " ");
  const findings = scanText(scrubbed, { denylist: opts.denylist });
  const seen = new Set(findings.map((f) => `${f.kind} ${f.match}`));
  for (const { kind, re } of SUSPICIOUS_TOKEN_RES) {
    for (const m of scrubbed.matchAll(re)) {
      const key = `${kind} ${m[0]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({ kind, match: m[0] });
    }
  }
  return findings;
}

/**
 * Turn the raw captured SSE events into cassette entries, placeholder-izing
 * the minted ids and running the flag-and-fail guard over every line. THROWS
 * (refusing to produce a cassette) if any line still carries a real-looking
 * token after id-placeholderization, naming the offending line numbers and
 * findings — the loud must-review-before-commit gate. The caller writes the
 * returned JSONL only when this returns without throwing.
 *
 * @param {Array<{ type: string, payload: unknown }>} events  captured in order
 * @param {{ sessionId: string, messageId: string }} ids  minted by the recorder
 * @param {{ afterMs?: number, denylist?: string[] }} [opts]
 * @returns {{ jsonl: string, lines: string[] }}
 */
export function buildCassette(events, ids, opts = {}) {
  const afterMs = opts.afterMs ?? 0;
  const mappings = buildIdMappings(ids);
  /** @type {string[]} */
  const lines = [];
  /** @type {Array<{ lineNo: number, finding: { kind: string, match: string } }>} */
  const leaks = [];

  events.forEach((event, i) => {
    const placeheld = placeholderizeIds(event, mappings);
    const line = JSON.stringify({ afterMs, event: placeheld });
    const findings = scanCassetteLine(line, { denylist: opts.denylist });
    for (const finding of findings) leaks.push({ lineNo: i + 1, finding });
    lines.push(line);
  });

  if (leaks.length > 0) {
    const detail = leaks
      .map((l) => `  line ${l.lineNo}: ${l.finding.kind}: ${l.finding.match}`)
      .join("\n");
    throw new RecorderGuardError(
      `Refusing to write cassette — ${leaks.length} real-looking token(s) survived ` +
        `id-placeholderization (these must be reviewed/redacted by a human before commit):\n${detail}\n\n` +
        `Only ids the recorder minted (session/message) are placeholder-ized automatically. ` +
        `Anything else real-looking is flagged, not silently recorded.`,
    );
  }

  return { jsonl: lines.join("\n") + "\n", lines };
}

/** Distinct error so the CLI / tests can assert the guard fired (vs a generic crash). */
export class RecorderGuardError extends Error {
  constructor(message) {
    super(message);
    this.name = "RecorderGuardError";
  }
}
