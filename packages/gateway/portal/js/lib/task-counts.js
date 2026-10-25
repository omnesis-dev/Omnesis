// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The Tasks view tells the shell the counts each of its reads returned, so
 * the nav's "Tasks (n)" moves the moment a task is done, struck or moved —
 * without the shell asking the gateway again. The shell still reads
 * `/tasks/counts` on its own for every other moment.
 */

export const TASK_COUNTS_EVENT = "omnesis:task-counts";

/** Announce the journal's counts, as `/tasks` or `/tasks/counts` returned them. */
export function publishTaskCounts(counts) {
  if (!counts || typeof counts !== "object") return;
  window.dispatchEvent(new window.CustomEvent(TASK_COUNTS_EVENT, { detail: { counts } }));
}

/** Call `listener(counts)` on every announcement; returns the unsubscribe. */
export function onTaskCounts(listener) {
  const handler = (event) => {
    const counts = event?.detail?.counts;
    if (counts && typeof counts === "object") listener(counts);
  };
  window.addEventListener(TASK_COUNTS_EVENT, handler);
  return () => window.removeEventListener(TASK_COUNTS_EVENT, handler);
}
