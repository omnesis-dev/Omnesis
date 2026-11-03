// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A hook a host sets so the session's entry points are named while they run.
 *
 * The gateway runs every agent turn on its main event loop and keeps a stall
 * watchdog that names the unit of work a stall happened in. The work this
 * package starts arrives from callbacks the gateway never sees: a child
 * process's stdout, a tool call, an event fanned out to subscribers. So the
 * gateway installs its marker here once at boot, and this package marks those
 * entry points through it. Without a marker, marking is a plain call.
 *
 * Names passed to the marker are labels this package chooses, or the names of
 * tools the host itself registered — never text from a model or a user.
 */

/** Runs `fn` marked as `name`, returning what it returns. */
export type ActivityMarker = <T>(name: string, fn: () => T) => T;

const unmarked: ActivityMarker = (_name, fn) => fn();

let marker: ActivityMarker = unmarked;

/** Install the host's marker, or remove it with `null`. */
export function setActivityMarker(next: ActivityMarker | null): void {
  marker = next ?? unmarked;
}

/** Run `fn` marked as `name` through the installed marker. */
export function markActivity<T>(name: string, fn: () => T): T {
  return marker(name, fn);
}
