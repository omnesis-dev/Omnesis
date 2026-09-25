// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Turn a recorded cognition-run transcript into a replayable cassette.
 *
 * A background run's transcript already holds everything a cassette needs —
 * the exact prompt plus the full verbatim agent event stream. Two
 * transformations make it replayable rather than merely readable:
 *
 *  - **Mutating calls become live.** Their recorded `agent.tool.result` is
 *    dropped, so the replay backend invokes the real tool. That is the whole
 *    point of a brain cassette: the writes must actually land, through the
 *    real gates and cascades. Read-only calls keep their recorded result, so
 *    a replay does not depend on the corpus still answering the same way.
 *  - **Minted ids become captures.** A live create returns a NEW id, so any
 *    later call that referenced the recorded id would address a row that does
 *    not exist. Each such id is lifted from its live result under a name and
 *    the later references are rewritten to `$CAP_<name>`.
 *
 * Split out from the CLI so both transformations can be unit-tested without
 * booting a gateway.
 */

import { placeholderizeIds, buildIdMappings, scanCassetteLine } from "./replay-recorder.mjs";

/**
 * Tools whose call IS the outcome. Mirrors `COGNITION_MUTATING_TOOL_NAMES`
 * in `packages/gateway/src/brain/steward/tools.ts`; a tool missing here
 * replays its recorded result and silently writes nothing, so the list is
 * checked against the gateway's by `brain-cassette.test.mjs`.
 */
export const MUTATING_TOOLS = [
  "open_loop_create",
  "open_loop_update",
  "open_loop_ledger_append",
  "open_loop_delete",
  "brief_create",
  "brief_update",
  "brief_delete",
  "notes_append",
  "notes_rewrite",
  "notes_edit",
  "schedule_agent_run",
  "annotate_durable",
  "annotation_revise",
  "annotation_retract",
  "annotation_supersede",
  "annotate_person",
  "person_annotation_revise",
  "person_annotation_retract",
  "person_annotation_supersede",
  "temporal_annotation_add",
  "temporal_annotation_update",
  "temporal_annotation_delete",
  "merge_adjudicate",
];

/** A gateway-minted id: a short lowercase prefix, an underscore, then an opaque tail. */
const MINTED_ID_RE = /^[a-z]+_[A-Za-z0-9_-]{6,}$/;

/**
 * Every `[path, value]` pair in a tool result whose value looks like a
 * gateway-minted id. Paths are dot notation rooted at the result object, so
 * they can be replayed by `ReplayEntry.capture`.
 *
 * @param {unknown} value
 * @param {string} prefix
 * @returns {Array<[string, string]>}
 */
function mintedIdPaths(value, prefix = "") {
  /** @type {Array<[string, string]>} */
  const out = [];
  if (typeof value === "string") {
    if (MINTED_ID_RE.test(value) && prefix !== "") out.push([prefix, value]);
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) =>
      out.push(...mintedIdPaths(v, prefix === "" ? `${i}` : `${prefix}.${i}`)),
    );
    return out;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.push(...mintedIdPaths(v, prefix === "" ? k : `${prefix}.${k}`));
    }
  }
  return out;
}

/**
 * A readable capture name for a path — `data.loop.id` → `loop`, disambiguated
 * with a counter so two creates of the same kind stay distinct.
 *
 * @param {string} path
 * @param {Set<string>} taken
 */
function captureNameFor(path, taken) {
  const segments = path.split(".").filter((s) => s !== "id" && s !== "data" && !/^\d+$/.test(s));
  const stem = segments.at(-1) ?? "cap";
  let n = 1;
  let name = `${stem}${n}`;
  while (taken.has(name)) {
    n += 1;
    name = `${stem}${n}`;
  }
  taken.add(name);
  return name;
}

/** Replace every whole-string occurrence of `from` with `to` in a value tree. */
function replaceExact(value, from, to) {
  if (typeof value === "string") return value === from ? to : value;
  if (Array.isArray(value)) return value.map((v) => replaceExact(v, from, to));
  if (value && typeof value === "object") {
    /** @type {Record<string, unknown>} */
    const obj = {};
    for (const [k, v] of Object.entries(value)) obj[k] = replaceExact(v, from, to);
    return obj;
  }
  return value;
}

/**
 * Build cassette entries from a transcript's event stream.
 *
 * @param {Array<{ type: string, payload: any }>} events
 * @param {{ liveTools?: string[] }} [opts]
 * @returns {{ entries: Array<{ afterMs: number, event: unknown, capture?: Record<string,string> }>, liveCalls: string[], captures: Record<string,string> }}
 */
export function buildBrainEntries(events, opts = {}) {
  const live = new Set(opts.liveTools ?? MUTATING_TOOLS);

  // Which recorded results belong to calls that will run live.
  /** @type {Map<string, string>} */
  const toolByCallId = new Map();
  for (const e of events) {
    if (e.type !== "agent.tool.start") continue;
    const { toolCallId, tool } = e.payload ?? {};
    if (typeof toolCallId === "string" && typeof tool === "string")
      toolByCallId.set(toolCallId, tool);
  }
  const liveCallIds = new Set(
    [...toolByCallId.entries()].filter(([, tool]) => live.has(tool)).map(([id]) => id),
  );

  /** @type {Map<string, unknown>} */
  const resultByCallId = new Map();
  for (const e of events) {
    if (e.type !== "agent.tool.result") continue;
    const { toolCallId, result } = e.payload ?? {};
    if (typeof toolCallId === "string") resultByCallId.set(toolCallId, result);
  }

  // Pass 1: work out, per live call, which minted ids later calls reuse.
  const startIndexByCallId = new Map();
  events.forEach((e, i) => {
    if (e.type === "agent.tool.start" && typeof e.payload?.toolCallId === "string") {
      startIndexByCallId.set(e.payload.toolCallId, i);
    }
  });

  /** @type {Map<string, Record<string,string>>} capture map per live call id */
  const capturesByCallId = new Map();
  /** @type {Array<[string, string]>} value → placeholder */
  const idSubstitutions = [];
  const takenNames = new Set();

  for (const callId of liveCallIds) {
    const result = resultByCallId.get(callId);
    if (result === undefined) continue;
    const startAt = startIndexByCallId.get(callId) ?? -1;
    for (const [path, value] of mintedIdPaths(result)) {
      // Only worth capturing if a LATER call actually uses this id.
      const usedLater = events.some(
        (e, i) =>
          i > startAt &&
          e.type === "agent.tool.start" &&
          JSON.stringify(e.payload?.args ?? {}).includes(value),
      );
      if (!usedLater) continue;
      if (idSubstitutions.some(([v]) => v === value)) continue;
      const name = captureNameFor(path, takenNames);
      const existing = capturesByCallId.get(callId) ?? {};
      existing[name] = path;
      capturesByCallId.set(callId, existing);
      idSubstitutions.push([value, `$CAP_${name}`]);
    }
  }

  // Pass 2: emit entries, dropping live results and rewriting reused ids.
  /** @type {Array<{ afterMs: number, event: unknown, capture?: Record<string,string> }>} */
  const entries = [];
  for (const e of events) {
    if (e.type === "agent.tool.result" && liveCallIds.has(e.payload?.toolCallId)) {
      continue; // the real tool supplies this at replay time
    }
    let event = { type: e.type, payload: e.payload };
    for (const [from, to] of idSubstitutions) event = replaceExact(event, from, to);
    const capture =
      e.type === "agent.tool.start" ? capturesByCallId.get(e.payload?.toolCallId) : undefined;
    entries.push({ afterMs: 0, event, ...(capture ? { capture } : {}) });
  }

  return {
    entries,
    liveCalls: [...liveCallIds].map((id) => toolByCallId.get(id) ?? id),
    captures: Object.fromEntries(idSubstitutions.map(([v, p]) => [p, v])),
  };
}

/**
 * Serialize entries to JSONL, placeholder-izing the ids we know with
 * certainty and refusing to write if anything real-looking survives. Same
 * flag-and-fail contract as the chat-scenario recorder: only ids we can map
 * with certainty are substituted; everything else is reported, never guessed.
 *
 * @param {Array<{ afterMs: number, event: unknown, capture?: Record<string,string> }>} entries
 * @param {{ sessionId: string, messageId: string }} ids
 * @param {{ docExternalIds?: Record<string,string>, denylist?: string[] }} [opts]
 * @returns {{ jsonl: string, lines: string[] }}
 */
export function serializeBrainCassette(entries, ids, opts = {}) {
  const mappings = [
    ...buildIdMappings(ids),
    // Document ids → `$DOC_<externalId>`, which the replay factory resolves
    // against the live corpus at session-create.
    ...Object.entries(opts.docExternalIds ?? {}).map(([docId, externalId]) => [
      docId,
      `$DOC_${externalId}`,
    ]),
  ].sort((a, b) => b[0].length - a[0].length);

  /** @type {string[]} */
  const lines = [];
  /** @type {Array<{ lineNo: number, finding: { kind: string, match: string } }>} */
  const leaks = [];

  entries.forEach((entry, i) => {
    const event = placeholderizeIds(entry.event, mappings);
    const line = JSON.stringify({
      afterMs: entry.afterMs,
      event,
      ...(entry.capture ? { capture: entry.capture } : {}),
    });
    // `scanCassetteLine` checks emails, phones, IPs, credential shapes and the
    // denylist — but NOT bare person names, which `scanText` only scans on
    // fixture-shaped paths. `pii-scan --all` covers the committed cassette for
    // those, so this is the first of two gates, not the only one.
    for (const finding of scanCassetteLine(line, { denylist: opts.denylist })) {
      leaks.push({ lineNo: i + 1, finding });
    }
    lines.push(line);
  });

  if (leaks.length > 0) {
    const detail = leaks
      .map((l) => `  line ${l.lineNo}: ${l.finding.kind}: ${l.finding.match}`)
      .join("\n");
    throw new Error(
      `Refusing to write cassette — ${leaks.length} real-looking token(s) survived ` +
        `placeholderization and must be reviewed by a human before commit:\n${detail}`,
    );
  }
  return { jsonl: `${lines.join("\n")}\n`, lines };
}

/**
 * The trigger a background cassette matches on. A run prompt's envelope
 * carries the kind, which is stable; the run id is not, and the subject
 * (a document id) is minted per test, so neither can be matched on.
 *
 * @param {string} kind
 */
export function triggersForKind(kind) {
  return [`kind: ${kind}`];
}
