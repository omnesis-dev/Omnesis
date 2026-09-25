// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
type Db = Database.Database;
import { fullDiskAccessRemediation, toErrorMessage } from "@omnesis/core";
import { SyncError, formatSyncRemediation, type SyncRemediation } from "@omnesis/types";

/**
 * Centralised Apple SQLite open. Returns a discriminated result so callers
 * can distinguish:
 *
 * - `ok`        — DB opened, ready to query.
 * - `denied`    — the read was refused, which on macOS almost always means
 *                 the process running the collector lacks the privacy grant
 *                 the database sits behind.
 * - `busy`      — SQLITE_BUSY past the configured timeout. Apple's apps
 *                 (Notes, Reminders, Messages) are mid-write; retry next
 *                 cycle.
 * - `error`     — anything else (corrupt file, missing schema, etc.).
 *
 * Opens read-only with a 5-second busy timeout so better-sqlite3 polls past
 * transient locks before surfacing as `busy`.
 */
export type OpenAppleDbResult =
  | { kind: "ok"; db: Db }
  | { kind: "denied"; message: string }
  | { kind: "busy"; message: string }
  | { kind: "error"; error: unknown };

export function openAppleDb(path: string): OpenAppleDbResult {
  try {
    const db = new Database(path, { readonly: true, timeout: 5000 });
    return { kind: "ok", db };
  } catch (err) {
    const msg = toErrorMessage(err);
    const kind = classifyOpenError(msg);
    return kind === "error" ? { kind, error: err } : { kind, message: msg };
  }
}

/**
 * Read a failed open's message for what it says about the cause.
 *
 * SQLite reports a refused read the same way whether the file mode denied it
 * or macOS's privacy layer did (`SQLITE_CANTOPEN: unable to open database
 * file`), and reports a TCC refusal on some releases as an authorization
 * denial. Both are the same thing to the operator: something has to grant this
 * process access.
 */
export function classifyOpenError(message: string): AppleDbOpenFailure["kind"] {
  if (message.includes("authorization denied") || message.includes("unable to open")) {
    return "denied";
  }
  if (message.includes("database is locked") || message.includes("SQLITE_BUSY")) {
    return "busy";
  }
  return "error";
}

/**
 * What an operator has to do about a read macOS refused: the sentence that
 * ends the failure message, and — when the grant is one they can give — the
 * same remedy structured, for clients that render it as an affordance.
 */
export interface AppleDenial {
  hint: string;
  remediation?: SyncRemediation;
}

/**
 * The denial behind Full Disk Access. The binary to list is the one running
 * this process — the collector's own, not the terminal or the app that
 * launched it — and the prose is derived from the structured form so the
 * two can never disagree.
 */
export function fullDiskAccessDenial(): AppleDenial {
  const remediation = fullDiskAccessRemediation(process.execPath);
  return { hint: formatSyncRemediation(remediation), remediation };
}

/**
 * Why one Apple database is not usable this cycle.
 *
 * Helpers record this rather than throwing. The provider opens all seven
 * databases in one pass, so a helper that threw would decide the fate of the
 * six it knows nothing about — which is the reason this type exists. The
 * `message` is what an operator eventually reads, so it names the database and
 * what to do about it rather than quoting SQLite.
 */
export interface AppleDbOpenFailure {
  kind: "denied" | "busy" | "error";
  message: string;
  /** For a denial the operator can lift: the remedy, structured. */
  remediation?: SyncRemediation;
}

/**
 * What the provider needs from an Apple database helper — single-file or
 * multi-store — to open it and report on it without knowing which one it is.
 */
export interface AppleDbLifecycle {
  /** The database exists on this host, or is already open. */
  isAvailable(): boolean;
  /** Attempt an open. Never throws: a failure is recorded, not raised. */
  open(): void;
  /** At least one usable database is open. */
  hasOpenDb(): boolean;
  /** Why nothing is open, or `null` when there is nothing wrong to report. */
  getLastOpenFailure(): AppleDbOpenFailure | null;
}

/**
 * One store a multi-store helper's scan found and could not use.
 *
 * `absent` is the store whose file is not there yet — an address book still
 * downloading, most often. It is a hole in what the scan covers, so it must be
 * reported as a gap before any snapshot is emitted, but it is not something an
 * operator can act on and so never becomes a source failure. Same rule the
 * single-file helpers apply to a database this host simply does not have.
 */
export interface AppleStoreGap {
  kind: AppleDbOpenFailure["kind"] | "absent";
  reason: string;
  /** For a denial the operator can lift: the remedy, structured. */
  remediation?: SyncRemediation;
}

/**
 * Phrase a failed open as the tail of a sentence naming the store, e.g.
 * "<store> needs Full Disk Access (…)". Shared so the address-book and
 * Reminders scans, which report per store rather than per database, cannot
 * drift into telling the operator two different things about one condition.
 */
export function describeStoreGap(
  result: Exclude<OpenAppleDbResult, { kind: "ok" }>,
): AppleStoreGap {
  if (result.kind === "denied") {
    const denial = fullDiskAccessDenial();
    return {
      kind: "denied",
      reason: `could not be read (${result.message}). ${denial.hint}`,
      remediation: denial.remediation,
    };
  }
  if (result.kind === "busy") {
    return {
      kind: "busy",
      reason: `is locked (SQLITE_BUSY: ${result.message}) — will retry on the next sync cycle`,
    };
  }
  return { kind: "error", reason: `cannot be opened: ${toErrorMessage(result.error)}` };
}

/**
 * Phrase a directory listing that failed as the gap it leaves in a multi-store
 * scan. A listing macOS refused is the same denial as a refused open — the
 * stores directory sits behind the same grant as the stores — and carries the
 * same remedy; any other failure is reported as what it says.
 */
export function describeListingGap(err: unknown, what: string): AppleStoreGap {
  if (isPermissionError(err)) {
    const denial = fullDiskAccessDenial();
    return {
      kind: "denied",
      reason: `${what} (${toErrorMessage(err)}). ${denial.hint}`,
      remediation: denial.remediation,
    };
  }
  return { kind: "error", reason: `${what}: ${toErrorMessage(err)}` };
}

/** A store gap that is a failure to report, with the key it was recorded under. */
export interface BlockingStoreGap {
  key: string;
  kind: AppleDbOpenFailure["kind"];
  reason: string;
  remediation?: SyncRemediation;
}

/**
 * The gap that explains why a multi-store scan produced no usable store, or
 * `null` when none of them is something to report. A denial wins over the
 * rest: it is the one an operator can act on, and a scan that hit both has a
 * permission problem whatever else is true.
 */
export function blockingGap(gaps: Iterable<[string, AppleStoreGap]>): BlockingStoreGap | null {
  let first: BlockingStoreGap | null = null;
  for (const [key, gap] of gaps) {
    if (gap.kind === "absent") continue;
    const blocking = { key, kind: gap.kind, reason: gap.reason, remediation: gap.remediation };
    if (gap.kind === "denied") return blocking;
    first ??= blocking;
  }
  return first;
}

/** Whether a filesystem error is the OS refusing the read. */
export function isPermissionError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "EACCES" || code === "EPERM";
}

/**
 * Raise a recorded open failure as the typed sync error its source owes the
 * collector, so the source lands in the right state and the operator is given
 * the sentence that tells them what to do.
 *
 * A denial is `permission` — it will keep failing until someone grants access.
 * A lock is `transient` — the database is mid-write, the next cycle is likely
 * to succeed, and the source must stay retryable rather than be disabled.
 *
 * A `null` failure is the ordinary case of a database this host does not have:
 * nothing is wrong, and the source syncs nothing.
 *
 * A denial is scoped to the connection rather than this one source: Full Disk
 * Access is granted per executable, not per database, so a denial reported
 * reading this database means every other Apple database behind the same
 * grant is refused the same way, whether or not its own source has noticed
 * yet. A lock or a corrupt file belongs to this database alone, so it keeps
 * the default source scope.
 */
export function throwOnOpenFailure(failure: AppleDbOpenFailure | null): void {
  if (!failure) return;
  const kind =
    failure.kind === "denied" ? "permission" : failure.kind === "busy" ? "transient" : "unknown";
  throw new SyncError(kind, failure.message, {
    remediation: failure.remediation,
    scope: failure.kind === "denied" ? "connection" : "source",
  });
}

export type { Db };
