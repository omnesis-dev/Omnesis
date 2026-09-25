// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Whether a source is telling the gateway something new or replaying what it
 * always had.
 *
 * The row itself cannot say. A transaction from four years ago arriving today
 * because the account was just connected is identical in shape to one that
 * happened this morning, and carries the semantic time it always had. Only the
 * phase that produced it knows, and the phase is not on the wire — the ingest
 * endpoint takes rows, not a story about where they came from.
 *
 * So the classification rests on two facts the gateway owns, and both are
 * *positive* evidence that a replay is under way:
 *
 * - **A history import is running.** The operator asked for one and the gateway
 *   is tracking the flow it started.
 * - **The source says its phase is `bootstrap`.** One of the two phase names
 *   `SyncProgress.phase` declares in the source SDK, so reading it is reading a
 *   shared contract rather than branching on any particular source.
 *
 * Absence means live, and that asymmetry is the design rather than a default.
 * Classifying a live row as history makes a watch silently ignore a real event,
 * which nobody can see; classifying a historical row as live makes a watch
 * noisy, which somebody reports. Only positive evidence moves a row into the
 * quiet class.
 *
 * ## What this deliberately does not use
 *
 * **Whether the source has ever completed a sync.** The obvious signal, and it
 * is wrong in both directions. `sync_state.last_synced_at` is stamped by the
 * *per-page* cursor commit, so it is already set from the second page of a
 * source's very first bootstrap — it does not mean "has finished
 * bootstrapping". And a gateway-hosted push source never syncs at all, so its
 * row is seeded with a null timestamp on purpose, and every event it ever
 * pushed would be classified as history forever. That is exactly the failure
 * the asymmetry above exists to prevent, reached through a signal that looked
 * like the conservative choice.
 *
 * **A phase name the SDK does not declare.** A source is free to report
 * `detail-backfill`, `body-backfill` or `snapshot-balances`, and several do
 * while walking their entire history. Deciding which of those replay history
 * would mean shared code holding opinions about individual sources. So they
 * read as live, and the cost is real: a source's own enrichment sweeps produce
 * rows this calls news. Closing that gap belongs in the SDK — a declared
 * "I am replaying history" bit on `SyncProgress` — not in per-source guesses
 * here.
 *
 * Two further gaps, stated plainly rather than left to be discovered. The first
 * page of a bootstrap is ingested before the source reports any progress, so
 * its rows read as live. And this classifies **analytics rows only** — the
 * document journal carries no backfill flag at all, so every document of a
 * first sync is journaled as live. Both are known and deliberate rather than
 * oversights, and both err in the direction the asymmetry above chooses.
 */

/** The SDK's declared name for a source catching up on everything it has. */
const BOOTSTRAP_PHASE = "bootstrap";

/**
 * The gateway-owned facts, behind an interface so the classification can be
 * tested against a hand-written object rather than a sync registry and an
 * import registry.
 */
export interface SyncPhaseSignals {
  /** A history import the operator started is in flight for this source. */
  importing(sourceId: string): boolean;
  /** The phase the source reported on its last status message, if any. */
  reportedPhase(sourceId: string): string | undefined;
}

export function isReplayingHistory(signals: SyncPhaseSignals, sourceId: string): boolean {
  if (signals.importing(sourceId)) return true;
  return signals.reportedPhase(sourceId) === BOOTSTRAP_PHASE;
}
