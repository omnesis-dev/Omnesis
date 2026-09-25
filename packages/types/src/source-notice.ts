// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * How loudly a client presents a {@link SourceNotice}.
 *
 * - `info`: nothing is wrong and nothing needs doing — a standing caveat about
 *   what the source can reach, or a protective behaviour worth knowing about.
 * - `warning`: the source is working, but part of it is not, or will stop
 *   working without the operator.
 * - `error`: the source is not syncing until something changes.
 */
export type SourceNoticeSeverity = "info" | "warning" | "error";

/**
 * One thing a person should be told about a source on one device, written for
 * them rather than for a log.
 *
 * The gateway composes these from the status fields it already serves
 * (`errorMessage`, `remediation`, `issues`, `coverage`, `restoredClaims`, …) so
 * every client — portal, iOS, Android, CLI — shows the same words, and none has
 * to know what any of those fields mean. A client renders a notice as an icon
 * beside the device it belongs to and reveals the text on demand.
 */
export interface SourceNotice {
  /** Stable category, for tests and for a client that styles one kind specially. */
  kind: SourceNoticeKind;
  severity: SourceNoticeSeverity;
  /** One short sentence: what is going on. */
  title: string;
  /** Why, in plain words, when the title alone would leave the reader guessing. */
  detail?: string;
  /** What the operator can do about it, in order. Absent when nothing needs doing. */
  steps?: string[];
  /** ISO 8601 time the condition was first observed, when the gateway knows it. */
  since?: string;
}

export type SourceNoticeKind =
  | "error"
  | "needs-auth"
  | "rate-limited"
  | "stale"
  | "auth-expiring"
  | "permission"
  | "sync-issue"
  | "replica-dispute"
  | "coverage-partial"
  | "coverage-unknown";
