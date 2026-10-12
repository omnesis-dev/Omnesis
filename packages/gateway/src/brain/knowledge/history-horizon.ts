// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * How far back proactive review of history reaches (`brain.bootstrap.horizon`).
 *
 * An install with years of history would otherwise spend for weeks walking the
 * deep past before review reached anything the operator still acts on. The
 * horizon bounds the two lanes that seed backlog work from documents already
 * in the corpus: historical admission and a source's initial-import inventory.
 * Live arrivals and edits stay reactive whatever their date, and agents still
 * reach older documents through search when a question needs them.
 *
 * The boundary is the document's own date, `source_created_at` — when it was
 * written or sent, the same column both lanes order by — never the time it
 * reached the gateway, which on an upgraded install is the same recent instant
 * for the whole corpus. The column is an ISO-8601 string and the floor is one
 * too, so the comparison is a plain string range that the
 * `(source_id, source_created_at)` index serves.
 *
 * The floor moves with the clock. A document that ages past it before it was
 * admitted is out of scope from then on, and pending historical work for it is
 * retired rather than bought; work already reviewed is kept.
 */

/** The oldest document date historical review still admits, as an ISO instant. */
export function historyHorizonFloor(now: number, horizonMs: number): string {
  return new Date(now - horizonMs).toISOString();
}
