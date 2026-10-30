// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { isBaileysAuthEnoent } from "./baileys-enoent-filter.js";

/**
 * What the collector does with an error nobody caught.
 *
 * - `suppress`: the known-benign Baileys auth-state ENOENT race (see
 *   `baileys-enoent-filter.ts`), logged as a warning.
 * - `continue`: logged as an error; the collector keeps running.
 * - `exit`: logged, then the process exits so the supervisor restarts it.
 *
 * An uncaught exception unwound a synchronous stack part way through whatever
 * it was doing, so in-memory state may be half-updated: exit. An unhandled
 * rejection is different in kind. The code that created the promise has
 * already moved on without its result, and the rejection is a lost error
 * report, not evidence of corrupted state; library internals produce them
 * routinely (pdf.js leaves rejecting promises behind on corrupt files). And
 * exiting is not a safe default for a sync daemon: when the rejection is
 * deterministic — the same input reached on every start — each restart meets
 * it again, and the crash loop stops every source's sync, not just the one that
 * hit it. So an unhandled rejection is reported loudly and the collector
 * continues; the operation that lost it fails or retries on its own terms.
 */
export type ProcessFailureVerdict = "suppress" | "continue" | "exit";

export function processFailureVerdict(
  kind: "unhandledRejection" | "uncaughtException",
  reason: unknown,
): ProcessFailureVerdict {
  if (isBaileysAuthEnoent(reason)) return "suppress";
  return kind === "unhandledRejection" ? "continue" : "exit";
}
