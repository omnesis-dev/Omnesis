// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The sweep vocabulary — a scheduled, prompt-steered pass over the corpus.
 *
 * A sweep is deliberately the thinnest possible unit of background cognition:
 * an id, a cadence, a time of day, and a paragraph of prose. The prose is the
 * only per-theme logic that exists; the run prompt splices it into a fixed
 * guardrail envelope the sweep does not control, and nothing ever parses it.
 * That is what lets one person's sweep run unchanged against another person's
 * corpus — a sweep names a shape of signal, never a source, a tool, or a
 * person.
 *
 * Two origins share the type. `system` sweeps ship with the gateway and are
 * read-only; `user` sweeps are Markdown files under `<configDir>/sweeps/`. A
 * user file whose id matches a system sweep LAYERS over it — each front-matter
 * key it omits (and an empty body) inherits the system value — so "silence a
 * built-in" is a two-line file and "fork a built-in" is the same file with a
 * body. Deleting the file reverts to the system sweep exactly.
 */

/** Where a sweep's definition came from. */
type SweepOrigin = "system" | "user";

/** One resolved sweep theme, ready to schedule. */
export interface SweepDef {
  id: string;
  /** Human label for the surfaces that list sweeps; defaults to the id. */
  name: string;
  origin: SweepOrigin;
  /** True when a user file layers over a system sweep of the same id. */
  modified: boolean;
  cadenceHours: number;
  steeringPrompt: string;
  enabled: boolean;
  /**
   * Minutes since local midnight at which this sweep's cadence lands. Always
   * resolved — an author who omits it gets a deterministic slot derived from
   * the id, so themes spread across the day instead of welding into one
   * serialized block. Only meaningful for cadences of a day or more; see
   * `anchor.ts`.
   */
  anchorMinutes: number;
  /** True when `anchorMinutes` was chosen by the author rather than derived. */
  anchorExplicit: boolean;
  /**
   * True for a sweep the morning digest is MEANT to wait for. The digest
   * composes behind a barrier that wants the run queue quiet, so an ordinary
   * sweep landing in that window is a scheduling mistake worth reporting —
   * but the day-ahead pass is the overnight work the digest reads, so its
   * place inside the window is the design, not a conflict. Declared by the
   * system sweep; a file cannot claim it.
   */
  expectedBeforeDigest: boolean;
  /**
   * The editorial lane this sweep's briefs belong to, which decides how many
   * of the push bar's gates they face (see `CognitionBriefLane`). Declared by
   * the system sweep, because a lane is a charter — the day-ahead pass is
   * commissioned to restate today with context, which the reactive awareness
   * gate would read as an echo. A file cannot claim one: an operator's sweep
   * faces the strict bar, and so does a fork of a system sweep that carries
   * a lane, because forked prose is no longer the prose the lane was granted
   * for.
   */
  briefLane?: "lookahead" | "noticing";
  /**
   * When set, the run's prompt is primed with live temporal annotations
   * overlapping `now .. now + N days`. This LLM-owned memory avoids
   * re-deriving known interpretations while `temporal_query` remains the
   * complete temporal read.
   */
  temporalAnnotationPrimeDays?: number;
}

/**
 * A system sweep as declared in code — the same shape minus everything the
 * resolver fills in.
 */
export interface SystemSweepDef {
  id: string;
  name: string;
  cadenceHours: number;
  steeringPrompt: string;
  enabled: boolean;
  /** "HH:MM" local. System sweeps always declare one; nothing is left to chance. */
  at: string;
  /** See `SweepDef.expectedBeforeDigest`. */
  expectedBeforeDigest?: boolean;
  /** See `SweepDef.briefLane`. */
  briefLane?: "lookahead" | "noticing";
  temporalAnnotationPrimeDays?: number;
}

/** A problem found while loading a user sweep file. Never throws — reported. */
export interface SweepIssue {
  /** The sweep id the file claimed (its filename stem). */
  id: string;
  /** Path of the offending file, for the operator to go and fix. */
  file: string;
  message: string;
}

/** What a resolve pass produced: the runnable set plus everything wrong with it. */
export interface ResolvedSweeps {
  sweeps: SweepDef[];
  issues: SweepIssue[];
}
