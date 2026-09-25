// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Decodes an Agent Run Queue row's opaque per-kind payload into a small,
 * display-safe "trigger" view — what the operator's `brain runs` table
 * (the DOC / TRIGGER column) and `brain run <id>` detail render to show
 * WHAT a run reacts to, so the operator never has to read `payload_json`
 * out of SQLite. Decoding goes through the same per-kind zod schemas the
 * queue validates with (`run-payloads.ts`) — never a hand parse.
 *
 * The view is reference-shaped by construction: it carries ids, an event
 * flavour, a date range, a scheduled prompt, and a DERIVED diff summary
 * (added/removed line counts) — never the transient pre-update
 * `snapshot` body nor the raw diff text, so it is always safe to
 * serialise for the operator.
 *
 * Settled runs keep a reference-shaped payload (settling strips only the
 * `snapshot`/`diff` fields), so they decode like pending runs. Rows
 * settled before payload retention existed were wiped to `{}`; for those
 * the decoder falls back to the surviving `dedupe_key`, recovering a
 * coarse trigger (the doc / loop / brief / source id — fields the key
 * doesn't carry come back null). A run matching neither decodes to
 * `{ type: "unknown" }`.
 */

import {
  DAILY_SOURCE_DEDUPE_PREFIX,
  DATA_DOC_DEDUPE_PREFIX,
  DATA_THREAD_DEDUPE_PREFIX,
  DECAY_CHECK_DEDUPE_PREFIX,
  FEEDBACK_DEDUPE_PREFIX,
  PROVENANCE_RECHECK_DEDUPE_PREFIX,
  MAY_DAY_DEDUPE_PREFIX,
  DIGEST_DEDUPE_PREFIX,
  SYNTHESIS_DEDUPE_PREFIX,
  SWEEP_DEDUPE_PREFIX,
  BOOTSTRAP_DEDUPE_PREFIX,
  VERIFICATION_DEDUPE_PREFIX,
  MERGE_ADJUDICATION_DEDUPE_PREFIX,
  NOTES_COMPACTION_DEDUPE_KEY,
  parseCognitionMergeAdjudicationRunPayload,
  parseCognitionNotesCompactionRunPayload,
  parseCognitionSubscriptionCompileRunPayload,
  parseCognitionDailyRunPayload,
  parseCognitionDataRunPayload,
  parseCognitionDecayCheckRunPayload,
  parseCognitionFeedbackRunPayload,
  parseCognitionProvenanceRecheckPayload,
  parseCognitionMayDayRunPayload,
  parseCognitionDigestRunPayload,
  parseCognitionSynthesisRunPayload,
  parseCognitionSweepRunPayload,
  parseCognitionTimeBasedRunPayload,
  parseCognitionBootstrapRunPayload,
  parseCognitionVerificationRunPayload,
} from "./run-payloads.js";
import type { DiffSummary, RunTrigger } from "@omnesis/core";
import type { CognitionRunKind } from "./storage/types.js";

// The wire contract lives in core so producer and consumers share one
// declaration; it is re-exported here because this is where it is decoded.
export type { DiffSummary, RunTrigger };

const UNKNOWN: RunTrigger = { type: "unknown" };

/** Count added/removed lines in a unified diff, ignoring the `+++`/`---` headers. */
function summarizeDiff(diff: string): DiffSummary {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  return { added, removed };
}

/**
 * Recover a coarse trigger from a row's surviving `dedupe_key` — the
 * fallback for legacy rows settled before payload retention existed
 * (their `payload_json` was wiped to `{}`). Each key family names the
 * entity the run was about; fields the key doesn't carry come back
 * null. The `kind` must agree with the key's family so a corrupted
 * kind/key pair stays `unknown` rather than mislabelling.
 */
function triggerFromDedupeKey(kind: CognitionRunKind, dedupeKey: string): RunTrigger | null {
  switch (kind) {
    case "data":
      if (dedupeKey.startsWith(DATA_DOC_DEDUPE_PREFIX)) {
        return {
          type: "data",
          docId: dedupeKey.slice(DATA_DOC_DEDUPE_PREFIX.length),
          event: null,
          diff: null,
        };
      }
      // A thread-keyed run's key carries no doc id — still a `data` trigger.
      if (dedupeKey.startsWith(DATA_THREAD_DEDUPE_PREFIX)) {
        return { type: "data", docId: null, event: null, diff: null };
      }
      return null;
    case "daily": {
      if (dedupeKey.startsWith(MAY_DAY_DEDUPE_PREFIX)) {
        return { type: "daily-mayday", date: dedupeKey.slice(MAY_DAY_DEDUPE_PREFIX.length) };
      }
      if (dedupeKey.startsWith(DIGEST_DEDUPE_PREFIX)) {
        return { type: "daily-digest", date: dedupeKey.slice(DIGEST_DEDUPE_PREFIX.length) };
      }
      if (dedupeKey.startsWith(DAILY_SOURCE_DEDUPE_PREFIX)) {
        // `daily:source:<sourceId>:<day>` — the source id may itself contain
        // colons, so the day is the LAST segment.
        const rest = dedupeKey.slice(DAILY_SOURCE_DEDUPE_PREFIX.length);
        const cut = rest.lastIndexOf(":");
        if (cut > 0) {
          return {
            type: "daily-source",
            sourceId: rest.slice(0, cut),
            dateFrom: null,
            dateTo: null,
          };
        }
      }
      return null;
    }
    case "time_based":
      if (dedupeKey.startsWith(DECAY_CHECK_DEDUPE_PREFIX)) {
        return { type: "decay-check", loopId: dedupeKey.slice(DECAY_CHECK_DEDUPE_PREFIX.length) };
      }
      return null;
    case "feedback":
      if (dedupeKey.startsWith(FEEDBACK_DEDUPE_PREFIX)) {
        return {
          type: "feedback",
          briefId: dedupeKey.slice(FEEDBACK_DEDUPE_PREFIX.length),
          snoozeUntil: null,
        };
      }
      if (dedupeKey.startsWith(PROVENANCE_RECHECK_DEDUPE_PREFIX)) {
        // `feedback:provenance:<kind>:<id>` — the kind rides in the key.
        const rest = dedupeKey.slice(PROVENANCE_RECHECK_DEDUPE_PREFIX.length);
        const cut = rest.indexOf(":");
        if (cut <= 0) return null;
        const kind = rest.slice(0, cut);
        if (kind !== "brief" && kind !== "loop") return null;
        return {
          type: "provenance-recheck",
          dependentKind: kind,
          dependentId: rest.slice(cut + 1),
        };
      }
      return null;
    case "synthesis": {
      if (!dedupeKey.startsWith(SYNTHESIS_DEDUPE_PREFIX)) return null;
      const rest = dedupeKey.slice(SYNTHESIS_DEDUPE_PREFIX.length);
      if (rest.startsWith("noticing:")) {
        return { type: "synthesis-noticing", date: rest.slice("noticing:".length) };
      }
      if (rest.startsWith("collision:")) {
        return {
          type: "synthesis-collision",
          loopIds: rest.slice("collision:".length).split(",").filter(Boolean),
        };
      }
      if (rest.startsWith("anno-contradiction:")) {
        return {
          type: "synthesis-annotation-contradiction",
          annotationIds: rest.slice("anno-contradiction:".length).split(",").filter(Boolean),
          store: null,
        };
      }
      return null;
    }
    case "sweep": {
      if (!dedupeKey.startsWith(SWEEP_DEDUPE_PREFIX)) return null;
      // `sweep:<sweepId>:<day>` — the theme id may itself contain colons,
      // so the day is the LAST segment.
      const rest = dedupeKey.slice(SWEEP_DEDUPE_PREFIX.length);
      const cut = rest.lastIndexOf(":");
      if (cut > 0) {
        return { type: "sweep", sweepId: rest.slice(0, cut), date: rest.slice(cut + 1) };
      }
      return { type: "sweep", sweepId: rest, date: null };
    }
    case "bootstrap":
      if (dedupeKey.startsWith(BOOTSTRAP_DEDUPE_PREFIX)) {
        return { type: "bootstrap", docId: dedupeKey.slice(BOOTSTRAP_DEDUPE_PREFIX.length) };
      }
      return null;
    case "verification": {
      // `verify:<store>:<id>,<id>,…` — the store rides in the key.
      if (!dedupeKey.startsWith(VERIFICATION_DEDUPE_PREFIX)) return null;
      const rest = dedupeKey.slice(VERIFICATION_DEDUPE_PREFIX.length);
      const cut = rest.indexOf(":");
      if (cut <= 0) return null;
      const store = rest.slice(0, cut);
      if (store !== "doc" && store !== "person") return null;
      return {
        type: "verification",
        annotationIds: rest
          .slice(cut + 1)
          .split(",")
          .filter(Boolean),
        store,
      };
    }
    case "merge_adjudication":
      if (dedupeKey.startsWith(MERGE_ADJUDICATION_DEDUPE_PREFIX)) {
        return {
          type: "merge-adjudication",
          candidateId: dedupeKey.slice(MERGE_ADJUDICATION_DEDUPE_PREFIX.length),
        };
      }
      return null;
    case "notes_compaction":
      // The fold key is fixed (one pending compaction at a time), so it
      // identifies the kind but recovers no reason.
      if (dedupeKey === NOTES_COMPACTION_DEDUPE_KEY) {
        return { type: "notes-compaction", reason: null };
      }
      return null;
    default:
      return null;
  }
}

/**
 * Decode a run's opaque payload into its display-safe trigger. Both
 * `daily` flavours (a per-source batch vs. the historical open-ended may-day
 * lookahead) and both `time_based` flavours (a scheduled prompt vs. an
 * engine decay check) are disambiguated by trying each flavour's strict
 * schema — the schemas are mutually exclusive, so the order is
 * irrelevant. When the payload matches no schema (a legacy wiped row),
 * the optional `dedupeKey` recovers a coarse trigger; anything matching
 * neither is `unknown`.
 */
export function decodeRunTrigger(
  kind: CognitionRunKind,
  payload: unknown,
  dedupeKey?: string | null,
): RunTrigger {
  const decoded = decodeRunTriggerFromPayload(kind, payload);
  if (decoded.type !== "unknown" || !dedupeKey) return decoded;
  return triggerFromDedupeKey(kind, dedupeKey) ?? UNKNOWN;
}

function decodeRunTriggerFromPayload(kind: CognitionRunKind, payload: unknown): RunTrigger {
  switch (kind) {
    case "data": {
      const p = parseCognitionDataRunPayload(payload);
      if (!p) return UNKNOWN;
      return {
        type: "data",
        docId: p.docId,
        event: p.event,
        diff: p.diff !== undefined ? summarizeDiff(p.diff) : null,
      };
    }
    case "daily": {
      const source = parseCognitionDailyRunPayload(payload);
      if (source) {
        return {
          type: "daily-source",
          sourceId: source.sourceId,
          dateFrom: source.dateFrom,
          dateTo: source.dateTo,
        };
      }
      const mayDay = parseCognitionMayDayRunPayload(payload);
      if (mayDay) return { type: "daily-mayday", date: mayDay.date };
      const digest = parseCognitionDigestRunPayload(payload);
      return digest ? { type: "daily-digest", date: digest.date } : UNKNOWN;
    }
    case "time_based": {
      const scheduled = parseCognitionTimeBasedRunPayload(payload);
      if (scheduled) return { type: "scheduled", prompt: scheduled.prompt };
      const decay = parseCognitionDecayCheckRunPayload(payload);
      return decay ? { type: "decay-check", loopId: decay.decayCheckLoopId } : UNKNOWN;
    }
    case "feedback": {
      const p = parseCognitionFeedbackRunPayload(payload);
      if (p) return { type: "feedback", briefId: p.briefId, snoozeUntil: p.snoozeUntil ?? null };
      // The provenance-recheck variant rides the feedback kind with its own
      // strict payload shape — the two schemas are mutually exclusive.
      const recheck = parseCognitionProvenanceRecheckPayload(payload);
      return recheck
        ? {
            type: "provenance-recheck",
            dependentKind: recheck.recheckDependentKind,
            dependentId: recheck.recheckDependentId,
          }
        : UNKNOWN;
    }
    case "synthesis": {
      const p = parseCognitionSynthesisRunPayload(payload);
      if (!p) return UNKNOWN;
      if (p.focus === "collision") {
        return {
          type: "synthesis-collision",
          loopIds: p.loopIds ?? [],
          ...(p.temporalAnnotationIds && p.temporalAnnotationIds.length > 0
            ? { temporalAnnotationIds: p.temporalAnnotationIds }
            : {}),
        };
      }
      if (p.focus === "annotation-contradiction") {
        return {
          type: "synthesis-annotation-contradiction",
          annotationIds: p.annotationIds ?? [],
          store: p.store ?? null,
        };
      }
      return { type: "synthesis-noticing", date: p.date ?? null };
    }
    case "sweep": {
      const p = parseCognitionSweepRunPayload(payload);
      return p ? { type: "sweep", sweepId: p.sweepId, date: p.date } : UNKNOWN;
    }
    case "bootstrap": {
      const p = parseCognitionBootstrapRunPayload(payload);
      return p ? { type: "bootstrap", docId: p.docId } : UNKNOWN;
    }
    case "verification": {
      const p = parseCognitionVerificationRunPayload(payload);
      return p ? { type: "verification", annotationIds: p.annotationIds, store: p.store } : UNKNOWN;
    }
    case "merge_adjudication": {
      const p = parseCognitionMergeAdjudicationRunPayload(payload);
      return p ? { type: "merge-adjudication", candidateId: p.candidateId } : UNKNOWN;
    }
    case "notes_compaction": {
      const p = parseCognitionNotesCompactionRunPayload(payload);
      return p ? { type: "notes-compaction", reason: p.reason } : UNKNOWN;
    }
    case "subscription_compile": {
      const p = parseCognitionSubscriptionCompileRunPayload(payload);
      return p
        ? {
            type: "subscription-compile",
            request: p.request,
            authoredBy: p.authoredBy,
            path: p.path,
            replaces: p.replaces ?? null,
            attempts: p.attempts ?? null,
            refusalCodes: p.refusalCodes ?? [],
            compileOnly: p.compileOnly === true,
            withoutBacktest: p.withoutBacktest === true,
          }
        : UNKNOWN;
    }
    default:
      return UNKNOWN;
  }
}
