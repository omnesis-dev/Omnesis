// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Delta-priming — the compact, deterministic "your current model" block
 * injected into the low-frequency runs (per-source daily batches, the morning
 * digest, synthesis and sweeps), so the Cognition Steward reasons about what
 * CHANGED since it last looked instead of rebuilding its whole picture from
 * scratch every time.
 *
 * Two hard contracts, both pinned by tests:
 *
 *  1. The block injects ONLY the agent's OWN derived state — the open/snoozed
 *     loops it maintains and the recent decisions (loop touches + brief
 *     creations) it made — NEVER raw source document content or data points.
 *     The daily prompt's "nothing is inlined here" contract still holds: the
 *     agent queries the source's actual data itself with its tools.
 *
 *  2. It is NON-authoritative. The header frames it as a possibly-stale
 *     memory to reason about and re-verify with tools, never as ground truth
 *     — the agent must confirm before acting.
 *
 * Deterministic: SQL projections + string rendering, zero model tokens to
 * build. Every projection is bounded by a `ResolvedBrainSettings` cap
 * (`primeMaxLoops` / `primeLedgerChars` / `primeMaxDecisions`) so the block
 * stays a few hundred prompt tokens on the busiest install. `data` runs are
 * deliberately NOT primed — their delta is the graph-based reconcile
 * candidates the datum itself seeds (`open_loop_search`).
 */

import { deadlineDueDay } from "../ranking.js";
import { cognitionSpendDay } from "../storage/spend.js";
import { listRecentLiveAnnotations } from "../storage/annotations.js";
import { listRecentLivePersonAnnotations } from "../storage/person-annotations.js";
import type Database from "better-sqlite3";
import type { ResolvedBrainSettings } from "../config.js";

type Db = Database.Database;

/** The resolved caps + window the prime rendering reads. */
type PrimeCfg = Pick<
  ResolvedBrainSettings,
  "primeMaxLoops" | "primeLedgerChars" | "primeMaxDecisions" | "recencyWindowMs"
>;

/** The states a loop must be in to be part of the agent's live model. */
const ACTIVE_LOOP_STATES = ["open", "snoozed"] as const;

/**
 * The non-authoritative header. States, in the strongest possible terms,
 * that the block is the agent's remembered model (possibly stale) and must
 * be re-verified with tools before it drives any action.
 */
const PRIME_HEADER =
  "Your current model (as of earlier runs — it may be stale; reason about what CHANGED since, and verify with your tools before acting on any of it). This lists only your OWN tracked loops and recent decisions — no source data is inlined here; query the source's actual data points yourself:";

/** A loop row projected for one prime line (never carries source content). */
interface PrimeLoopRow {
  id: string;
  title: string;
  state: string;
  importance: number;
  deadline_json: string | null;
  last_update: number;
}

/** A recent-decision row (a loop touch or a brief creation). */
interface PrimeDecisionRow {
  at: number;
  line: string;
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function ageDays(at: number, now: number): string {
  const days = Math.max(0, Math.floor((now - at) / 86_400_000));
  return days === 0 ? "today" : days === 1 ? "1d ago" : `${days}d ago`;
}

/**
 * Render one loop as a single compact line:
 *   [id] "title" (state, importance 0.80, due 2026-08-01) — last: <ledger tail> — updated Nd ago
 * The ledger tail is the loop's most recent ledger note, truncated to the
 * `primeLedgerChars` cap — the agent's OWN note, never source content.
 */
function renderLoopLine(db: Db, loop: PrimeLoopRow, cfg: PrimeCfg, now: number): string {
  const attrs = [loop.state, `importance ${loop.importance.toFixed(2)}`];
  const deadline = loop.deadline_json === null ? null : safeJson(loop.deadline_json);
  const due = deadline === null ? null : deadlineDueDay(deadline);
  if (due !== null) attrs.push(`due ${due}`);

  const tail = db
    .prepare<
      [string],
      { note: string }
    >("SELECT note FROM open_loop_ledger WHERE loop_id = ? ORDER BY seq DESC LIMIT 1")
    .get(loop.id);
  const last =
    tail === undefined ? "no ledger notes yet" : truncate(tail.note, cfg.primeLedgerChars);

  return `[${loop.id}] "${truncate(loop.title, 120)}" (${attrs.join(", ")}) — last: ${last} — updated ${ageDays(loop.last_update, now)}`;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * The recent decisions the agent made inside `[fromMs, toMs]` — loops it
 * touched (`last_update` in window) and briefs it created (`created_at` in
 * window), most-recent first, capped. Titles + ids only; never source data.
 */
function recentDecisions(db: Db, fromMs: number, toMs: number, cap: number): PrimeDecisionRow[] {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs > toMs) return [];
  const loops = db
    .prepare<[number, number, number], { id: string; title: string; at: number }>(
      `SELECT id, title, last_update AS at FROM open_loops
        WHERE last_update >= ? AND last_update <= ?
        ORDER BY last_update DESC LIMIT ?`,
    )
    .all(fromMs, toMs, cap)
    .map((r) => ({ at: r.at, line: `updated loop [${r.id}] "${truncate(r.title, 100)}"` }));
  const briefs = db
    .prepare<[number, number, number], { id: string; title: string; kind: string; at: number }>(
      `SELECT id, title, kind, created_at AS at FROM briefs
        WHERE created_at >= ? AND created_at <= ?
        ORDER BY created_at DESC LIMIT ?`,
    )
    .all(fromMs, toMs, cap)
    .map((r) => ({
      at: r.at,
      line: `created ${r.kind} brief [${r.id}] "${truncate(r.title, 100)}"`,
    }));
  return [...loops, ...briefs].sort((a, b) => b.at - a.at).slice(0, cap);
}

/** Assemble the header + a loops section + a recent-decisions section. */
function assemble(loopLines: string[], decisions: PrimeDecisionRow[], loopsLabel: string): string {
  const parts: string[] = ["", PRIME_HEADER, "", loopsLabel];
  parts.push(...(loopLines.length > 0 ? loopLines.map((l) => `- ${l}`) : ["- (none)"]));
  parts.push("", "Recent decisions in this window:");
  parts.push(...(decisions.length > 0 ? decisions.map((d) => `- ${d.line}`) : ["- (none)"]));
  return parts.join("\n");
}

export interface SourceDeltaPrimeInput {
  /** The source whose daily batch this run reviews. */
  sourceId: string;
  /** Recent-decisions window start (unix ms) — the daily payload's `dateFrom`. */
  fromMs: number;
  /** Recent-decisions window end (unix ms) — the daily payload's `dateTo`. */
  toMs: number;
  now: number;
  cfg: PrimeCfg;
}

/**
 * The delta-prime block for a per-source `daily` run: the open/snoozed loops
 * that touch this source (any of their `docs[]` is a document from it),
 * importance-ordered, plus the recent decisions in the run's own
 * `[fromMs, toMs]` window. A source with no tracked loops and no recent
 * decisions yields a clean minimal block (both sections "(none)"), never a
 * crash.
 */
export function buildSourceDeltaPrime(db: Db, input: SourceDeltaPrimeInput): string {
  const { sourceId, fromMs, toMs, now, cfg } = input;
  const loops = db
    .prepare<[string, ...string[], number], PrimeLoopRow>(
      `SELECT o.id AS id, o.title AS title, o.state AS state, o.importance AS importance,
              o.deadline_json AS deadline_json, o.last_update AS last_update
         FROM open_loops o
         JOIN open_loop_docs old ON old.loop_id = o.id
         JOIN documents d ON d.id = old.doc_id
        WHERE d.source_id = ?
          AND o.state IN (${ACTIVE_LOOP_STATES.map(() => "?").join(", ")})
        GROUP BY o.id
        ORDER BY o.importance DESC, o.last_update DESC
        LIMIT ?`,
    )
    .all(sourceId, ...ACTIVE_LOOP_STATES, cfg.primeMaxLoops);
  const loopLines = loops.map((l) => renderLoopLine(db, l, cfg, now));
  const decisions = recentDecisions(db, fromMs, toMs, cfg.primeMaxDecisions);
  return assemble(
    loopLines,
    decisions,
    `Tracked loops touching source "${sourceId}" (most important first):`,
  );
}

export interface DueSoonDeltaPrimeInput {
  now: number;
  cfg: PrimeCfg;
}

/**
 * The due-soon delta-prime block, used by the morning digest: the
 * open/snoozed loops that are due-soon (deadline within `recencyWindowMs` of
 * now, overdue included) OR were touched in the last `recencyWindowMs`,
 * importance-ordered, plus the recent decisions in that same trailing window.
 * Reuses `recencyWindowMs` for both directions — no new timescale is invented.
 *
 * Narrower than the synthesis prime on purpose: a composition pass about
 * TODAY wants what is landing, not the whole tracked world.
 */
export function buildDueSoonDeltaPrime(db: Db, input: DueSoonDeltaPrimeInput): string {
  const { now, cfg } = input;
  const windowStart = now - cfg.recencyWindowMs;
  const dueWindowEdgeDay = cognitionSpendDay(now + cfg.recencyWindowMs);
  const rows = db
    .prepare<string[], PrimeLoopRow>(
      `SELECT id, title, state, importance, deadline_json, last_update
         FROM open_loops
        WHERE state IN (${ACTIVE_LOOP_STATES.map(() => "?").join(", ")})
        ORDER BY importance DESC, last_update DESC`,
    )
    .all(...ACTIVE_LOOP_STATES);
  const relevant = rows
    .filter((r) => {
      if (r.last_update >= windowStart) return true;
      const deadline = r.deadline_json === null ? null : safeJson(r.deadline_json);
      const due = deadline === null ? null : deadlineDueDay(deadline);
      // Local YYYY-MM-DD days compare correctly as strings.
      return due !== null && due <= dueWindowEdgeDay;
    })
    .slice(0, cfg.primeMaxLoops);
  const loopLines = relevant.map((l) => renderLoopLine(db, l, cfg, now));
  const decisions = recentDecisions(db, windowStart, now, cfg.primeMaxDecisions);
  return assemble(
    loopLines,
    decisions,
    "Loops due soon or recently touched (most important first):",
  );
}

/** The wider cfg slice the synthesis prime reads (loops + decisions + annotations). */
type SynthesisPrimeCfg = Pick<
  ResolvedBrainSettings,
  | "primeMaxLoops"
  | "primeLedgerChars"
  | "primeMaxDecisions"
  | "recencyWindowMs"
  | "synthesisLookbackMs"
  | "primeMaxAnnotations"
  | "annotations"
>;

export interface SynthesisDeltaPrimeInput {
  now: number;
  cfg: SynthesisPrimeCfg;
  /**
   * Consumption-provenance seam: called with the annotation ids the prime
   * inlines as priors (they are consumed by the run reading this prompt).
   */
  onAnnotationsInlined?: (store: "doc" | "person", ids: readonly string[]) => void;
}

/**
 * The delta-prime block for a `synthesis` ("Noticing") run: ALL active loops
 * cross-source (importance-ordered), the recent decisions in the lookback
 * window, and — when annotations are enabled — the recent durable observations
 * the agent recorded, surfaced as priors under the SAME non-authoritative
 * header. Everything here is a hint to re-ground against the source, never a
 * fact. Reuses the loop/decision renderers; the whole block stays a few
 * hundred prompt tokens via the display caps.
 */
export function buildSynthesisDeltaPrime(db: Db, input: SynthesisDeltaPrimeInput): string {
  const { now, cfg } = input;
  const windowStart = now - cfg.synthesisLookbackMs;
  const rows = db
    .prepare<(string | number)[], PrimeLoopRow>(
      `SELECT id, title, state, importance, deadline_json, last_update
         FROM open_loops
        WHERE state IN (${ACTIVE_LOOP_STATES.map(() => "?").join(", ")})
        ORDER BY importance DESC, last_update DESC
        LIMIT ?`,
    )
    .all(...ACTIVE_LOOP_STATES, cfg.primeMaxLoops);
  const loopLines = rows.map((l) => renderLoopLine(db, l, cfg, now));
  const decisions = recentDecisions(db, windowStart, now, cfg.primeMaxDecisions);
  const base = assemble(loopLines, decisions, "All tracked loops (most important first):");
  if (!cfg.annotations.enabled) return base;
  const annos = listRecentLiveAnnotations(db, {
    sinceMs: windowStart,
    limit: cfg.primeMaxAnnotations,
  });
  const personAnnos = listRecentLivePersonAnnotations(db, {
    sinceMs: windowStart,
    limit: cfg.primeMaxAnnotations,
  });
  input.onAnnotationsInlined?.(
    "doc",
    annos.map((a) => a.id),
  );
  input.onAnnotationsInlined?.(
    "person",
    personAnnos.map((a) => a.id),
  );
  const sections: string[] = [base];
  if (annos.length > 0) {
    sections.push(
      "",
      "Recent durable observations you recorded (priors — re-ground against the cited documents before use):",
      ...annos.map(
        (a) =>
          `- [annotation doc:${a.id}; ${a.claimType}] ${truncate(a.claimText, 160)} (conf ${a.confidence.toFixed(2)}; re-read doc ${a.docId} before use)`,
      ),
    );
  }
  if (personAnnos.length > 0) {
    sections.push(
      "",
      "Recent observations about people you recorded (priors — re-ground against the cited documents before use):",
      ...personAnnos.map(
        (a) =>
          `- [annotation person:${a.id}; ${a.claimType}] ${truncate(a.claimText, 160)} (conf ${a.confidence.toFixed(2)}; re-read doc ${a.evidenceDocId} before use)`,
      ),
    );
  }
  return sections.join("\n");
}
