// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// What the Resync dialog offers for one source, and in which words.
//
// A resync has two modes. "In place" deletes nothing: the source is read
// again and each item updates the record it already has. "From scratch"
// deletes what the source ingested and imports it again. Which of them a
// resync offers comes from the gateway — `resyncModes` on the source for the
// whole source, the source's multi-device mode for one of its devices — so a
// choice that would do nothing is never drawn.

export const RESYNC_IN_PLACE = "in-place";
export const RESYNC_FROM_SCRATCH = "from-scratch";

/**
 * The scope entry that resyncs every device's data at once, listed ahead of
 * the devices when a resync can be scoped to one of them.
 */
export const RESYNC_WHOLE_SOURCE = "whole-source";

/**
 * How a resync of `source` is scoped:
 *   - "single": one member — the whole source is the only scope.
 *   - "whole": several members that share one cursor (handoff) — the same;
 *     there is no per-device slice to resync.
 *   - "per-device": several members on their own cursors (replicated or
 *     partitioned) — the whole source, or one of its devices.
 */
export function resyncChoices(source) {
  if ((source?.members?.length ?? 1) <= 1) return "single";
  const mode = source?.multiDeviceMode ?? "exclusive";
  return mode === "replicated" || mode === "partitioned" ? "per-device" : "whole";
}

/** The modes a resync offers: the whole source's, or one device's when `device` is given. */
function offeredModes(source, device) {
  if (!device) {
    return Array.isArray(source?.resyncModes)
      ? source.resyncModes
      : [RESYNC_IN_PLACE, RESYNC_FROM_SCRATCH];
  }
  // A replicated device shares its records with the other devices, so there
  // is nothing of its own to delete.
  return source?.multiDeviceMode === "partitioned"
    ? [RESYNC_IN_PLACE, RESYNC_FROM_SCRATCH]
    : [RESYNC_IN_PLACE];
}

/**
 * The dialog's content for one scope of one source.
 *
 * @param {object} args
 * @param {object} args.source — the Sources row (`resyncModes`, `multiDeviceMode`).
 * @param {string} args.label — the source's display name.
 * @param {{name: string} | null} [args.device] — the device the resync is
 *   scoped to; null for the whole source.
 * @param {boolean} [args.brainNote] — whether the gateway runs the Brain, so
 *   "From scratch" says what that does to what the Brain built.
 * @returns {{modes: Array<{id: string, title: string, body: string, note: string | null}>, footnote: string | null}}
 */
export function resyncOptions({ source, label, device = null, brainNote = false }) {
  const offered = offeredModes(source, device);
  const copy = {
    [RESYNC_IN_PLACE]: {
      title: "In place",
      body: device
        ? `${device.name} reads ${label} again and updates what it already sent. Your records keep their place, anything you deleted stays deleted, and search keeps working meanwhile.`
        : `Reads ${label} again and updates what is already here. Your records keep their place, anything you deleted stays deleted, and search keeps working meanwhile.`,
      note: null,
    },
    [RESYNC_FROM_SCRATCH]: {
      title: "From scratch",
      body: device
        ? `Deletes everything ${device.name} sent for ${label}, then imports it again from that device. What it sent is missing from search until it finishes, items you had deleted one by one come back, and what other devices sent stays.`
        : `Deletes everything indexed from ${label}, then imports it again. Search for this source is empty until it finishes, and items you had deleted one by one come back.`,
      note: brainNote
        ? `What the Brain built from ${label} will point at records that no longer exist.`
        : null,
    },
  };
  const modes = [RESYNC_IN_PLACE, RESYNC_FROM_SCRATCH]
    .filter((id) => offered.includes(id))
    .map((id) => ({ id, ...copy[id] }));
  let footnote = null;
  if (modes.length === 2) {
    footnote =
      "In place never deletes, so it does not clear duplicate or stray records. From scratch is the tool for that.";
  } else if (modes.length === 1 && modes[0].id === RESYNC_IN_PLACE && device) {
    footnote = `Nothing is deleted. To clear duplicate or stray records, resync the whole source from scratch.`;
  }
  return { modes, footnote };
}

/**
 * The mode a scope starts on, and the one it falls back to when the scope
 * changes under a mode it does not offer: in place when offered, since it is
 * the one that deletes nothing.
 */
export function defaultResyncMode(modes) {
  return (modes.find((m) => m.id === RESYNC_IN_PLACE) ?? modes[0])?.id ?? null;
}
