// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The wire contract for what a cognition run reacts to.
 *
 * The gateway decodes a stored run payload into this shape and serves it on
 * `/admin/brain/runs` and `/admin/brain/runs/:id`; the CLI and the portal
 * render it. It lives here rather than beside the decoder so that the producer
 * and every consumer compile against one declaration — a variant that gains or
 * loses a field is then a type error at each render site rather than a crash
 * the first time a run of that kind is opened.
 *
 * Every variant carries reference-shaped fields only — ids, dates, counts,
 * and the operator's own words where they are the subject of the run. Nothing
 * derived from a document's content appears here.
 */

/**
 * A document named on the cognition admin wire, resolved to something an
 * operator can read — the document a run reacts to, a brief's citation.
 *
 * Only the run-detail read carries it: the list read serves many runs and
 * resolving a title per row would cost a query per row, so a list renders the
 * id alone. Optional for exactly that reason — a consumer must fall back to
 * `docId`, which is always present, and never assume a title it was not given.
 *
 * Reference-shaped like everything else here: an id, the title the source gave
 * the document, and which kind of source it came from. No content.
 */
export interface CognitionDocumentRef {
  id: string;
  title: string | null;
  sourceType: string | null;
}

/** Added/removed line counts of a unified diff — a summary, never the text. */
export interface DiffSummary {
  added: number;
  removed: number;
}

/**
 * The decoded, display-safe trigger of a run — a flat discriminated
 * union keyed on `type`, so both the runs table (a compact label) and
 * the run detail (per-field) render from one shape. Every variant
 * carries only reference-shaped fields (see the module doc). The two
 * `daily` flavours and the two `time_based` flavours each get their own
 * `type` so a consumer never has to re-sniff the payload.
 *
 * The nullable fields (`docId`, `event`, `dateFrom`/`dateTo`) are null
 * only on the dedupe-key fallback path for legacy wiped rows — a live or
 * settled-with-retained-payload decode always fills them.
 */
export type RunTrigger =
  | {
      type: "data";
      docId: string | null;
      event: "created" | "updated" | null;
      diff: DiffSummary | null;
      doc?: CognitionDocumentRef;
    }
  | { type: "daily-source"; sourceId: string; dateFrom: string | null; dateTo: string | null }
  | { type: "daily-mayday"; date: string }
  | { type: "daily-digest"; date: string }
  | { type: "scheduled"; prompt: string }
  | { type: "decay-check"; loopId: string }
  | { type: "feedback"; briefId: string; snoozeUntil: number | null }
  // The provenance-recheck flavour of a feedback run: a prior the dependent
  // was built on died, so the run re-examines that brief/loop.
  | { type: "provenance-recheck"; dependentKind: "brief" | "loop"; dependentId: string }
  | { type: "synthesis-noticing"; date: string | null }
  | {
      type: "synthesis-collision";
      loopIds: string[];
      temporalAnnotationIds?: string[];
    }
  // `store` is null only on the dedupe-key fallback path (the key carries
  // the annotation ids but not which store they live in).
  | {
      type: "synthesis-annotation-contradiction";
      annotationIds: string[];
      store: "doc" | "person" | null;
    }
  | { type: "sweep"; sweepId: string; date: string | null }
  | { type: "bootstrap"; docId: string | null; doc?: CognitionDocumentRef }
  // Both decode paths carry the store — the dedupe key bakes it in.
  | { type: "verification"; annotationIds: string[]; store: "doc" | "person" }
  | { type: "merge-adjudication"; candidateId: string }
  // A background curation pass over the agent-notes blob. `reason` is the
  // payload's human-readable why-compaction-was-scheduled string; null only
  // on the dedupe-key fallback path (the fixed fold key carries no fields).
  | { type: "notes-compaction"; reason: string | null }
  // A watch compilation, recorded already settled. `request` is the condition
  // that was compiled (the run's subject — admin-only surface); `path` says
  // whether the compiler could look things up in the corpus or answered from
  // one prompt; `replaces` is set only when the compile rewrites a watch that
  // already exists; `compileOnly` marks a preview, which installed nothing and
  // is otherwise indistinguishable from a compile whose install failed after it;
  // `withoutBacktest` marks one asked to skip replaying its own candidate, which
  // is where the replay's cost is attributable from and cannot be read off a
  // missing backtest — a refusal never carries one either.
  | {
      type: "subscription-compile";
      request: string;
      authoredBy: "operator" | "integration";
      path: "session" | "single-shot";
      replaces: string | null;
      attempts: number | null;
      refusalCodes: readonly string[];
      compileOnly: boolean;
      withoutBacktest: boolean;
    }
  | { type: "unknown" };
