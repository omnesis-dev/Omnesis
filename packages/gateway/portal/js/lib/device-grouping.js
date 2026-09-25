// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Pure helpers for the Devices view: relative-time formatting, the
// plain-language activity status, and the This device / Live connections /
// Other devices
// grouping. Kept free of Preact / DOM so they can be unit-tested directly
// and so the same grouping rules are easy to mirror on iOS / Android.

/**
 * Human relative time, e.g. "just now", "5m ago", "3h ago", "2d ago", or an
 * ISO date for anything older than a week. Returns "never" for a null /
 * missing timestamp.
 */
export function relativeTime(ms) {
  if (!ms) return "never";
  const diff = Date.now() - ms;
  if (diff < 45_000) return "just now";
  if (diff < 3_600_000) return `${Math.max(1, Math.floor(diff / 60_000))}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * The single plain-language status line shown on a device card. Loading this
 * list proves the current authenticated client is active regardless of
 * whether it uses the device WebSocket. For other devices, `online` means a
 * live WebSocket connection; otherwise we surface recorded activity without
 * claiming that a request-driven client is offline.
 */
export function statusLine(device, isCurrent = false) {
  if (device.revokedAt) return `Revoked ${relativeTime(device.revokedAt)}`;
  if (isCurrent) return "Active now";
  if (device.online) return "Live connection";
  if (device.lastSeenAt) return `Last active ${relativeTime(device.lastSeenAt)}`;
  return "No activity recorded";
}

/** Count device WebSockets that are live in the gateway's current snapshot. */
export function liveConnectionCount(devices) {
  return devices.filter((device) => device.online && !device.revokedAt).length;
}

/** Devices whose access has been revoked; they keep their row and sources. */
export function revokedCount(devices) {
  return devices.filter((device) => Boolean(device.revokedAt)).length;
}

/** Revoked devices that still host sources — each one needs a repair code. */
export function needsPairingCount(devices) {
  return devices.filter((device) => Boolean(device.revokedAt) && Boolean(device.needsPairing))
    .length;
}

/**
 * Accept a session's candidate device id only when it identifies this client
 * kind. Raw-token Portal login can inherit the token owner's CLI/collector id;
 * that credential owner is not the browser currently rendering the page.
 */
export function currentDeviceIdForKind(devices, candidateId, expectedKind) {
  const candidate = devices.find((device) => device.id === candidateId);
  return candidate?.kind === expectedKind ? candidate.id : null;
}

/**
 * Split the device list into the three rendered buckets:
 *   - `thisDevice`: the device backing the current session (matched by
 *     `thisDeviceId` from /whoami), pinned at the top — or null when unknown.
 *   - `live`: everything else with a device WebSocket, most-recently-seen first.
 *   - `other`: everything else, most-recently-active first, with revoked
 *     devices sorted after the paired ones.
 *
 * The current device is pinned regardless of whether it has a live socket, so the
 * "you are here" anchor never disappears. A revoked device is never "live":
 * its socket, if one is still draining, is being evicted.
 */
export function groupDevices(devices, thisDeviceId) {
  const byLastSeen = (a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0);
  const byRevokedLast = (a, b) =>
    Number(Boolean(a.revokedAt)) - Number(Boolean(b.revokedAt)) || byLastSeen(a, b);
  let thisDevice = null;
  const live = [];
  const other = [];
  for (const d of devices) {
    if (thisDeviceId && d.id === thisDeviceId) {
      thisDevice = d;
      continue;
    }
    if (d.online && !d.revokedAt) live.push(d);
    else other.push(d);
  }
  live.sort(byLastSeen);
  other.sort(byRevokedLast);
  return { thisDevice, live, other };
}
