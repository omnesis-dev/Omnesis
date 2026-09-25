// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { DocumentInput, SyncIssue } from "@omnesis/types";
import type { SnapshotClaim } from "./snapshot.js";
import type { EdgeDeclaration } from "@omnesis/core";

/**
 * Sync state is an opaque cursor that a source uses to track
 * where it left off. Shape varies by source (historyId, syncToken, timestamp, etc.)
 */
export type SyncCursor = Record<string, unknown>;

/**
 * A source-level coverage claim for the sync round that produced a result.
 *
 * V1 deliberately has one implicit stream ("default") per configured source
 * instance. A cursor says where a connector resumes; this says how strongly it
 * can vouch for the source's configured scope. `semanticTimeThrough` is
 * optional because most upstream change tokens do not prove an event-time
 * frontier. `upstreamCut` is opaque and is digested by the gateway, never
 * returned through its status API.
 */
/**
 * How much of an upstream's history a source holds.
 *
 * The third value is the point. A source that has not determined whether it
 * is missing history is not the same as one that knows it is whole, and a
 * contract with only two values forces the difference to be spelled as
 * silence — which every consumer then reads as the reassuring one.
 */
export type HistoryCoverage = "complete" | "partial" | "unknown";

/**
 * Whether a coverage claim is one a client may present as fact.
 *
 * Only `"complete"` is. `"partial"` and `"unknown"` both mean the corpus may
 * be missing history, and differ in whether the source knows it — a
 * distinction worth showing a person, and not one to resolve in the
 * reassuring direction.
 */
export function coverageIsVouched(coverage: HistoryCoverage | undefined): boolean {
  return coverage === "complete";
}

export interface SourceWatermark {
  guarantee: "change-cut" | "snapshot" | "best-effort-scan" | "observation";
  semanticTimeThrough?: string;
  observedAt?: string;
  upstreamCut?: string;
  detail?: string;
}

/**
 * Progress info for a sync operation (optional, for UI/CLI display).
 */
export interface SyncProgress {
  /** Current phase */
  phase: "bootstrap" | "incremental" | (string & {});

  /** Total units in the source, if known (e.g. total emails, total messages) */
  total?: number;

  /** Units processed so far in this sync cycle */
  processed: number;

  /** Percentage complete (0-100), only meaningful during bootstrap */
  percentComplete?: number;

  /**
   * How much of the upstream history the source currently holds.
   *
   * Source-agnostic: any source whose backing archive can be truncated — an
   * interrupted one-shot history hand-off it cannot re-request, an upstream
   * that prunes — says so, and a client can then tell "history incomplete,
   * live sync healthy" from "broken".
   *
   * `"unknown"` is a real answer and not a synonym for `"complete"`. A source
   * that could be missing history but has not established whether it is has
   * said something different from one that knows it has everything, and
   * collapsing the two lets a client show a corpus as whole on the strength of
   * nobody having checked. Omitting the field entirely means the question does
   * not apply to this source.
   */
  coverage?: HistoryCoverage;

  /**
   * What the coverage claim on this page is about, when a source speaks for
   * more than one thing behind a single row.
   *
   * A bank connection holds several accounts and can be truthfully missing
   * history on one while whole on another; both claims stand at once, and the
   * host keeps the weaker, because a caveat that applies to part of a source
   * applies to the source. A messaging source has one subject and its claims
   * are a time series over it — a bootstrap that says "still arriving" and
   * then "finished" has not made two claims, it has revised one. Keeping the
   * weaker there would re-assert a question the source just answered.
   *
   * The host cannot tell those apart from the outside, so the source names the
   * subject: claims from different subjects are combined by taking the weakest,
   * and a later claim about the same subject replaces the earlier one.
   *
   * Omitted means the source speaks for one thing, which is the common case
   * and behaves as a single subject.
   */
  coverageSubject?: string;

  /** Optional human-facing hint accompanying `coverage` (e.g. a recovery tip). */
  detail?: string;
}

/**
 * Result of a sync operation.
 * Generic on cursor type for type-safe cursor handling in providers.
 * Defaults to `SyncCursor` (opaque record) for backward compatibility.
 */
export interface SyncResult<TCursor extends SyncCursor = SyncCursor> {
  /** Documents to upsert */
  documents: DocumentInput[];

  /** External IDs of documents that were deleted in the source */
  deletedExternalIds: string[];

  /**
   * Snapshot of all external IDs currently present in the source-of-truth.
   *
   * When set, the gateway diffs this set against its known external_ids for
   * `(providerId, sourceId)`. Used by sources whose backing store has no
   * reliable tombstone signal (Apple SQLite databases, Notion archive flags,
   * Things hard-deletes, Strava 404s, browser-history "Clear browsing data",
   * etc.).
   *
   * An omission does not delete. The gateway records it with a deadline: it
   * takes several later snapshots that agree, plus a minimum span of elapsed
   * time, before the document is removed, and a snapshot that names the
   * document again revokes the record. So a snapshot built from a bad read —
   * a locked database, a lapsed permission, a store mid-migration — costs a
   * delay rather than the corpus, provided the source recovers before the
   * deadline. `deletedExternalIds` is the channel that deletes at once,
   * because there the source is asserting a deletion rather than leaving one
   * to be inferred.
   *
   * Semantics:
   * - **Set only on a full snapshot.** Partial pages or incremental syncs
   *   MUST leave this `undefined` — a partial page names a fraction of what
   *   exists, so every document not on it would be recorded as absent.
   * - **Set it only for a read you can vouch for.** If the enumeration came
   *   back implausibly small, or the store could not be read cleanly, omit
   *   the field: an omitted snapshot has no effect at all, while a snapshot
   *   you cannot vouch for starts a clock on documents that still exist.
   * - The set should be the *complete* enumeration of currently-present
   *   external IDs for this source. Empty array is meaningful: "the source is
   *   empty" — every stored document begins its deadline.
   * - Combine with `deletedExternalIds` only if the source has both an
   *   explicit tombstone path AND a snapshot path.
   */
  presentExternalIds?: string[];

  /**
   * The same assertion, made partition by partition.
   *
   * `presentExternalIds` is all-or-nothing: it answers "may I delete anything
   * at all?", so one unreadable address book out of four withholds deletion
   * detection for the three that were read — for as long as the fourth stays
   * broken, which can be indefinitely.
   *
   * A claim answers the narrower question the gateway can also act on: "may I
   * delete anything *in here*?" Each entry names one partition the source
   * enumerated in full and the ids it holds. The gateway sweeps only the
   * documents whose `partitionKey` matches a claimed partition; documents in
   * partitions nobody claimed are left exactly alone, which is what
   * withholding was protecting in the first place.
   *
   * **This is the degraded cycle's form.** A read that covered every partition
   * should say so with `presentExternalIds`: that vouches for the whole
   * source, which is both the strongest available statement and the only one
   * that reaches a document stored before this source ever named a partition.
   *
   * The ordering matters more than it looks. A claim can only reach documents
   * whose stored `partitionKey` is one it names, so a source that claims on
   * every cycle silently stops reconciling every document ingested before it
   * adopted partitions, and every document whose partition name has since
   * changed — a re-signed account, a restored backup, a host that generates
   * its store ids locally. Those documents are then never marked and never
   * deleted, and nothing reports it. Claiming only when the whole read was
   * impossible leaves the next healthy cycle as the repair.
   *
   * For the same reason a partition name must mean the same thing on every
   * host that syncs the source. A replicated or handoff source whose partition
   * names are host-local would have each host claiming partitions the other's
   * documents are not in.
   *
   * A source that sets this MUST set `DocumentInput.partitionKey` to the same
   * partition names, or its claims name nothing and sweep nothing. Building
   * both from one {@link SnapshotEnumeration} is how they stay in step.
   *
   * Setting this and `presentExternalIds` together is a contradiction about
   * what was read, and is refused.
   */
  presentClaims?: SnapshotClaim[];

  /**
   * Structural edges the source declares between its documents (#430). A
   * first-class output of `sync()` alongside `documents`: the source asserts
   * relationships it knows from its own structure (a reply via `In-Reply-To`,
   * an ordered sequence, a sibling group, a cross-source reference) and the
   * gateway records each with `source-declared` provenance. Endpoints are named
   * by source-native id; the writer resolves them to documents (a forward
   * reference whose target hasn't synced yet is held and retried). Optional —
   * the implicit `metadata.extra` conventions (parentExternalId / threadId /
   * links) still produce the common structural edges for sources that don't
   * declare explicitly.
   */
  edges?: EdgeDeclaration[];

  /** Updated cursor to persist for next sync */
  cursor: TCursor;

  /** Whether there are more pages to fetch in this sync cycle */
  hasMore: boolean;

  /** Optional progress info for UI display */
  progress?: SyncProgress;

  /**
   * Problems this page survived.
   *
   * A page that finished is a success, and can still have cost something —
   * a folder that would not open, rows that would not parse, a profile locked
   * by another program. Reporting them here is what lets an operator see the
   * cost of a sync that otherwise looks clean; the alternative, which is what
   * a dozen sources do today, is to count them and write the number into a
   * log line.
   *
   * The host sums them across the pages of a run. They do not change the
   * source's state — a source with issues has still synced. Omit when this
   * run did not assess issues (for example an incremental tick without a full
   * enumeration); emit [] after assessment confirms recovery. Explicit reports
   * replace the previous completed run's durable warnings for this member.
   */
  issues?: SyncIssue[];

  /**
   * Forward-looking consent / authorization deadline (ISO 8601), if the source
   * knows one. Open-banking aggregators (Plaid `item.consent_expiration_time`,
   * PSD2/CDR 90-day windows) require periodic re-consent on a *known* schedule —
   * unlike a reactive credential failure, the deadline is visible in advance.
   *
   * A source reports its current deadline on each successful page; the gateway
   * persists it on the source's sync state and, when `now` enters the lead
   * window before it, derives a non-terminal `auth-expiring` display state (a
   * "reconnect within N days" warning) distinct from the terminal `needs-auth`
   * pill. Re-consent that restores sync simply reports a later (or absent)
   * deadline on the next page, clearing the warning. Omitted / `null` means the
   * source has no known deadline (the common case). See #927.
   */
  consentExpiresAt?: string | null;

  /** Coverage claim for this completed sync round. Must be omitted on partial pages. */
  watermark?: SourceWatermark;
}

// ---------------------------------------------------------------------------
// History import (#588) — generic one-time bulk import from a local artifact
// ---------------------------------------------------------------------------

/**
 * A single input the user must supply to run a source's history import.
 * Generic form-field shape — clients render it without knowing the source.
 */
export interface ImportField {
  /** Machine key, echoed back in the `values` map (e.g. "backupPath"). */
  key: string;
  /** Human-readable label (e.g. "iPhone backup folder"). */
  label: string;
  /** Input type — drives how clients render and collect the value. */
  type: "file" | "directory" | "secret" | "string" | "select";
  /** Whether the field is required. */
  required?: boolean;
  /** Help text / placeholder shown near the input. */
  help?: string;
  /** For `"select"`: the available options. */
  options?: Array<{ value: string; label: string }>;
}

/**
 * Declares that a source can import historical data from a user-supplied local
 * artifact — a one-time, re-runnable bulk import (#588). Source-agnostic: the
 * source owns what the artifact is and how to parse it; clients only render a
 * form from `fields`, collect the values, and call `SourceInstance.importHistory`.
 *
 * Mirrors the `authType` + `authFlow` precedent: a declarative capability on the
 * descriptor plus a runtime method on the instance. Its presence on a descriptor
 * is the signal that the source supports importing.
 */
export interface HistoryImportSpec {
  /** Short action label (e.g. "Import full history"). */
  label: string;
  /** One-line explanation shown above the form. */
  description: string;
  /** Inputs the user must supply to run the import. */
  fields: ImportField[];
}

/** Progress event emitted during a history import. Mirrors {@link SyncProgress}. */
export interface ImportProgress {
  /** Current phase, source-defined (e.g. "decrypt", "parse", "merge"). */
  phase: string;
  /** Items processed so far. */
  processed: number;
  /** Total items, if known. */
  total?: number;
  /** Optional human-facing detail line. */
  detail?: string;
}

/** Callbacks passed to {@link SourceInstance.importHistory}. */
export interface ImportCallbacks {
  /** Called as the import advances, for UI/CLI progress display. */
  onProgress?: (progress: ImportProgress) => void;
  /** Abort signal — the source should stop work and reject when it fires. */
  signal?: AbortSignal;
}

/** Outcome of a history import. */
export interface ImportSummary {
  /** New items added to the source's store. */
  imported: number;
  /** Items that already existed (matched by stable id) — idempotent no-ops. */
  merged: number;
  /** Items skipped (unparseable, out of scope, or below a cutoff). */
  skipped: number;
}

// ---------------------------------------------------------------------------
// Sync result helpers — reduce boilerplate in providers
// ---------------------------------------------------------------------------

/**
 * Build a SyncResult from documents and a cursor. Fills in sensible defaults.
 *
 * @example
 * ```typescript
 * // Simple bootstrap (all docs, done)
 * return syncPage(documents, { lastModified: maxTimestamp });
 *
 * // Paginated
 * return syncPage(documents, { page: nextPage }, { hasMore: true });
 *
 * // With deletions
 * return syncPage(documents, cursor, { deletedExternalIds: ["old-1"] });
 * ```
 */
export function syncPage<TCursor extends SyncCursor>(
  documents: DocumentInput[],
  cursor: TCursor,
  opts?: {
    hasMore?: boolean;
    deletedExternalIds?: string[];
    presentExternalIds?: string[];
    /** See `SyncResult.presentClaims`. Mutually exclusive with the above. */
    presentClaims?: SnapshotClaim[];
    progress?: SyncProgress;
    /** Omit when this page did not evaluate source health; [] reports recovery. */
    issues?: SyncIssue[];
    /** Coverage claim for the completed sync (only valid when `hasMore` is false). */
    watermark?: SourceWatermark;
    /** Source-declared structural edges for this page (#430). */
    edges?: EdgeDeclaration[];
  },
): SyncResult<TCursor> {
  return {
    documents,
    cursor,
    deletedExternalIds: opts?.deletedExternalIds ?? [],
    presentExternalIds: opts?.presentExternalIds,
    presentClaims: opts?.presentClaims,
    edges: opts?.edges,
    hasMore: opts?.hasMore ?? false,
    progress: opts?.progress,
    issues: opts?.issues,
    watermark: opts?.watermark,
  };
}

/**
 * Build an empty SyncResult (no documents, no more pages).
 * Useful for sources with no data, disabled sources, or no-op sync methods.
 *
 * @example
 * ```typescript
 * return emptySync({ lastModified: 0 });
 * ```
 */
export function emptySync<TCursor extends SyncCursor>(
  cursor: TCursor = {} as TCursor,
): SyncResult<TCursor> {
  return { documents: [], deletedExternalIds: [], cursor, hasMore: false };
}

/**
 * Filter documents whose `sourceCreatedAt` is older than the cutoff date.
 *
 * Returns the input unchanged when `cutoff` is undefined. When at least one
 * document is dropped, emits a single info-level log line via `log` (if
 * provided). `unitLabel` controls the wording — defaults to `"docs"`.
 *
 * Used by every provider that supports a per-source `dataCutoff` / `maxAge`
 * setting; the previous one-off filter+log block was copy-pasted three+ times
 * across providers/google.
 */
export function applyDataCutoff(
  documents: DocumentInput[],
  cutoff: Date | undefined,
  log?: { info: (msg: string) => void },
  unitLabel: string = "docs",
): DocumentInput[] {
  if (!cutoff) return documents;
  const cutoffMs = cutoff.getTime();
  const kept = documents.filter((d) => new Date(d.sourceCreatedAt).getTime() >= cutoffMs);
  const dropped = documents.length - kept.length;
  if (dropped > 0 && log) {
    log.info(`Filtered ${dropped} ${unitLabel} older than cutoff, kept ${kept.length}`);
  }
  return kept;
}

/**
 * How a collector starts the program that feeds a source. Only macOS
 * collectors act on it today: the app is opened through Launch Services by
 * bundle identifier, which works from a background agent and never needs the
 * app's path. A collector on any other platform ignores the declaration.
 */
export interface FeedProcessLaunch {
  /** The app's bundle identifier, as `open -b` takes it. */
  macosBundleId: string;
  /**
   * Rendered instead of `SourceFreshness.hint` once the collector has tried
   * repeatedly to open the program and it is still not running — it will not
   * start, or it does not stay up. The operator must then look at the app
   * itself, so this sentence should send them there.
   */
  failedHint: string;
}

/**
 * A source's declaration of what "suspiciously quiet" means for it, so the
 * gateway can tell a genuinely idle source apart from one whose upstream feed
 * has silently stalled.
 *
 * The problem this solves is specific to sources that read a local file some
 * *other* program keeps up to date. Such a source syncs successfully on every
 * tick — it opens the file, reads it, finds nothing new — and so reports
 * perfect health while sitting on data frozen days ago. "Synced fine, zero new
 * documents" and "the feed is dead" are indistinguishable from the outside.
 *
 * A source opts in by declaring how long a quiet stretch has to run before it
 * stops being plausible, and (optionally) the process whose absence would
 * explain it. Both halves matter, because either one alone is a false-positive
 * machine: a quiet week is normal for a task manager, and quitting an app for
 * an hour is normal for anyone. Only the conjunction — nothing new for longer
 * than the source considers plausible, AND the program that feeds it isn't
 * running — is worth telling the operator about.
 *
 * Purely advisory. The gateway derives a non-terminal `stale` display state
 * from it; sync itself is never blocked, deferred, or retried differently, and
 * nothing is pushed to the operator's phone.
 *
 * Only meaningful for a source that emits DOCUMENTS from `sync()`. The
 * "when did this source last produce something" timestamp the warning rests on
 * is stamped where documents and cursor commit together; a source that pushes
 * through the device-ingest HTTP route, or whose output is analytics records
 * rather than documents, never advances it and so is never reported stale. A
 * source that does both — bootstrapping one way and pushing the other — would
 * see its timestamp freeze while data still arrived, which is the one shape
 * that could produce a WRONG warning rather than merely no warning. Declare
 * `freshness` only if `sync()` is how your documents reach the index.
 */
export interface SourceFreshness {
  /**
   * How long this source's data may go unchanged before a stalled feed becomes
   * the better explanation than a quiet user. Tune to the source's natural
   * rhythm, generously: browser history goes quiet overnight, a task manager
   * can plausibly go quiet for a fortnight. Too tight and the warning becomes
   * noise the operator learns to ignore.
   */
  quietPeriodMs: number;

  /**
   * The process that keeps this source's local file current, if one does. The
   * collector probes whether it is running on the host owning the source and
   * reports the answer; it never learns which source or program it is checking.
   *
   * Omit when the file is maintained by something whose absence can't be
   * observed this way — an OS-level sync daemon, or a service the user picks
   * (an Obsidian vault may be fed by iCloud, Dropbox, or Obsidian's own
   * in-app sync, and only the last of those is a process worth probing).
   * Without it the source is never reported stale, since a quiet period alone
   * doesn't distinguish a dead feed from a quiet fortnight.
   */
  requiresProcess?: {
    /** Executable name, matched exactly against the process table (`pgrep -x`). */
    processName: string;
    /**
     * How the collector may start that program itself when it finds it not
     * running, so a quit app resumes feeding the source without the operator
     * noticing it had stopped. The collector opens it hidden and in the
     * background — nothing steals focus — and backs off between attempts, so a
     * program that quits again or fails to start is retried on a slowing
     * schedule rather than every sync. Omit when the program cannot be started
     * unattended (it prompts on launch, or the operator chooses when it runs).
     */
    launch?: FeedProcessLaunch;
  };

  /**
   * What the operator should actually do, in one sentence. Rendered verbatim by
   * portal / iOS / CLI, so it carries the source-specific explanation that
   * shared UI code must not hardcode.
   */
  hint: string;
}

/**
 * Icon hint for UI clients (CLI, portal, iOS).
 * Sources declare their icon; clients render it however they want.
 *
 * Each source package fully owns its icon. Two non-exclusive ways to ship one:
 *
 * - `url`: hot-link a hosted icon (preferred for trademark-friendly vendors —
 *   Google, Microsoft, Notion, Strava, Obsidian, Things, etc.). Nothing ships
 *   in the repo; clients fetch and cache at runtime.
 * - `imageDataUri`: embed a data URI (PNG or SVG) that the source package
 *   owns and is free to modify (e.g. a Lucide-derived glyph tinted to a
 *   brand color). Used when a vendor's brand guidelines forbid third-party
 *   use of their real logo (Apple first-party apps, Safari, …). Clients
 *   pass the URI straight to `<img src=…>` — no mime-sniffing required.
 *
 * `sfSymbol` is iOS's native fallback / instant-render glyph and stays
 * required: it's a system font reference (not a copyrighted asset) and
 * it shows immediately before any URL fetch resolves.
 */
export interface SourceIcon {
  /** SF Symbol name (macOS/iOS) e.g. "envelope.fill", "calendar" */
  sfSymbol: string;
  /**
   * Brand accent color as hex string, e.g. "#EA4335". Used by clients as
   * the source's chrome/border tint — citation tab borders on iOS,
   * left-bars on quote cards, source-aware highlights in portal cards.
   */
  color: string;
  /**
   * Brand background tint suitable for dark-mode surfaces, e.g.
   * "#2D1716" for Gmail. Used as the fill of citation sticky tabs and
   * quote cards. Pick a heavily desaturated/dimmed version of `color`
   * so it reads as a subtle wash, not a garish block.
   */
  bgColor?: string;
  /** Hosted icon URL — fetched and cached by clients at runtime. */
  url?: string;
  /**
   * Full data URI (`data:image/png;base64,…` or `data:image/svg+xml;base64,…`)
   * for icons owned by the source package. Clients render directly without
   * a network fetch.
   */
  imageDataUri?: string;
}

/**
 * Brand attribution requirements declared by a source.
 *
 * Some vendors (e.g. Strava) require third-party tools that display their
 * data to also display a "Powered by …" byline alongside it. Each source
 * package owns the exact wording; consumers (portal, iOS) render it
 * generically next to items from that source — no source-specific code
 * outside the source package.
 *
 * Per-item deep links ("View on Strava", "Open in Gmail") are NOT part of
 * this contract; they are already handled by `DocumentMetadata.sourceUrl`,
 * which a provider populates only when it has a reliable per-item target.
 */
export interface SourceAttribution {
  /**
   * Short byline rendered near each item from this source.
   * E.g. "Powered by Strava".
   */
  itemFooter?: string;
}

// The legacy `Source` interface is gone — every provider now lives
// behind the `defineSource()` / `defineProvider()` adapter and uses
// `SourceInstance` (declared in `define-source.ts`) as the runtime
// contract. The 6 provider classes that previously `implements Source`
// were migrated in May 2026 (#399 / #400 / #401 / #402 / #403 / #404);
// the interface itself was dropped in the cleanup PR (#405).
