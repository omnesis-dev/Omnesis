// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { FailureScope, QuotaBucket } from "./failure-scope.js";

/**
 * Classification buckets for sync-time errors. Sources may throw a typed
 * `SyncError` to communicate `kind` to the collector without relying on
 * substring matching against `message`. The collector's error-classifier
 * inspects the typed instance first and falls back to message regex for
 * legacy throw paths.
 */
export type SyncErrorKind =
  | "auth"
  | "network"
  | "rate-limit"
  | "permission"
  | "transient"
  | "unknown";

export interface SyncErrorOptions {
  /** Minimum delay before a retry would be useful (e.g. Retry-After). */
  retryAfterMs?: number;
  /** What the operator has to do before this failure can clear — see `SyncRemediation`. */
  remediation?: SyncRemediation;
  /**
   * How much this failure took with it — see {@link FailureScope}.
   *
   * The kind says what went wrong; this says how much stopped working, and
   * only the second decides whether the page may step over it, whether the
   * source may still claim a complete snapshot, and whether its siblings on
   * the same credential are affected too. Defaults to `source`, which is the
   * answer that is wrong in the least damaging direction.
   */
  scope?: FailureScope;
  /**
   * The budget a rate limit was counted against, when the source knows.
   *
   * An `app` bucket is shared by every account this installation holds for the
   * provider, so backing off one account and letting the rest run spends the
   * same exhausted budget from another direction.
   */
  quota?: QuotaBucket;
  cause?: unknown;
}

/**
 * A problem the page survived.
 *
 * A failure is thrown, and throwing ends the page — that is the whole of what
 * `SyncError` can say. So the axis missing from it is not cause, which it
 * covers well, but *fatality*: a source that read nine folders of ten, dropped
 * four hundred malformed rows, or skipped a locked profile has finished
 * successfully and has something to report, and until now the only place to
 * put it was a log line. A dozen sources compute exactly this number and then
 * interpolate it into a string nobody reads.
 *
 * It reuses the thrown vocabulary deliberately — the same kinds, the same
 * blast radii, the same remedy shape — because the difference between the two
 * is whether the run continued, not what went wrong. Adding a non-fatal member
 * to `SyncError` would put a value nobody can throw into a class every caller
 * catches; this is the returned half of the same idea.
 */
export interface SyncIssue {
  /** Stable source-independent diagnostic category; prose may change between ticks. */
  code?: string;
  /**
   * How much this cost, and no more than that.
   *
   * Only the two scopes a page can survive are permitted. `source` and
   * `connection` mean the page stopped, which is a throw — the type is what
   * keeps the two channels from blurring into each other.
   */
  scope: Extract<FailureScope, "item" | "partition">;
  /** Same vocabulary as the thrown failure: why, not how badly. */
  kind: SyncErrorKind;
  /** How many units it cost. The number an operator actually wants. */
  count: number;
  /** What was skipped, in the source's own words — a folder, a repository. */
  subject?: string;
  message: string;
  /**
   * What the operator can do about it.
   *
   * The first carrier of a remedy that is not an error. A remedy today is
   * shown only for a source in the `error` state, so "grant access to this
   * folder" cannot be surfaced for a source that is otherwise syncing fine —
   * which is exactly the source that has one.
   */
  remediation?: SyncRemediation;
}

/** The gateway's first observation of an issue that has not yet recovered. */
export interface SyncIssueStatus extends SyncIssue {
  since: number;
}

/** Exact diagnostic scope assessed by a partial completed-run report. */
export interface SyncIssueAssessment {
  code: string;
  scope: SyncIssue["scope"];
  subject?: string;
}

/**
 * What an operator has to do about a sync failure that will not clear until
 * they act, in a shape a client renders as its own affordance rather than
 * quoting the error. The provider that recognised the condition authors it;
 * it rides on the `SyncError`, then on the sync status the collector reports,
 * then on the display status the gateway serves, unchanged at every hop.
 *
 * The fields describe an access grant the host keys on the executable and
 * never prompts for, without naming any: the condition, the steps, the binary
 * the grant is given to, and whether the collector must be restarted
 * afterwards. `executable` is the collector's own process: a grant is listed
 * by binary, and the one the operator sees in a terminal or launcher is
 * usually not it. It is a path on the collector's host, and reaches the same
 * audience as `errorMessage` — the administrative status routes and every
 * paired device's status stream — and nothing wider.
 */
export interface SyncRemediation {
  /** The condition in one line, e.g. "Full Disk Access is required". */
  summary: string;
  /** What the operator does, in order; each step one sentence. */
  steps: string[];
  /** The executable the grant must be given to — the one running the collector. */
  executable?: string;
  /** Whether the collector must be restarted once the steps are done. */
  restartRequired: boolean;
}

/**
 * The remediation as one sentence, for a surface that can only show text: a
 * log line, an error message on a client without the affordance. Composed
 * here so the prose and the structured form can never say different things.
 */
export function formatSyncRemediation(remediation: SyncRemediation): string {
  const parts = [`${remediation.summary}.`, ...remediation.steps];
  if (remediation.executable) {
    parts.push(`The executable running the collector is ${remediation.executable}.`);
  }
  if (remediation.restartRequired) parts.push("Then restart the collector.");
  return parts.join(" ");
}

/**
 * Sync-time error with a normalised classification. Sources catch
 * provider-specific shapes (GaxiosError, Microsoft Graph errors,
 * fetch errors, …) and re-throw a `SyncError` so the collector can route
 * the source to the right state (`needs-auth`, `rate-limited`, `error`)
 * and honour any retry hint without parsing free-form text.
 */
export class SyncError extends Error {
  readonly kind: SyncErrorKind;
  readonly retryAfterMs?: number;
  readonly remediation?: SyncRemediation;
  /** How much stopped working. Defaults to `source` — see {@link SyncErrorOptions.scope}. */
  readonly scope: FailureScope;
  readonly quota?: QuotaBucket;
  override readonly cause?: unknown;

  constructor(kind: SyncErrorKind, message: string, opts: SyncErrorOptions = {}) {
    super(message);
    this.name = "SyncError";
    this.kind = kind;
    this.retryAfterMs = opts.retryAfterMs;
    this.remediation = opts.remediation;
    this.scope = opts.scope ?? "source";
    this.quota = opts.quota;
    this.cause = opts.cause;
  }
}

/**
 * How much a thrown value took with it.
 *
 * An untyped throw is `source`: it came from code that did not classify
 * itself, so the host knows only that this source stopped. Reading it as an
 * item would let a page step over an unknown failure and keep going, which is
 * how a walk stores a fraction of a corpus and reports success.
 */
export function failureScopeOf(err: unknown): FailureScope {
  return err instanceof SyncError ? err.scope : "source";
}

/** The budget a thrown value was counted against, when it named one. */
export function quotaBucketOf(err: unknown): QuotaBucket | undefined {
  return err instanceof SyncError ? err.quota : undefined;
}

/** The remedy a thrown value carries, when it is a `SyncError` raised with one. */
export function syncRemediationOf(err: unknown): SyncRemediation | undefined {
  return err instanceof SyncError ? err.remediation : undefined;
}

/**
 * Whether `err` is a typed transient `SyncError` — a server-side blip (5xx) or
 * a momentarily-unreachable dependency that is worth retrying rather than
 * treating as a permanent failure.
 *
 * Used by source call sites to decide whether a thrown provider or
 * transcription failure should be re-thrown so the sync page retries instead
 * of advancing its cursor past the durable input. Optional OCR is
 * normalized to a non-fatal result at the collector's shared attachment
 * boundary before it reaches these call sites; an OCR outage must not hold
 * primary source freshness behind one attachment.
 */
export function isTransientSyncError(err: unknown): boolean {
  return err instanceof SyncError && err.kind === "transient";
}
