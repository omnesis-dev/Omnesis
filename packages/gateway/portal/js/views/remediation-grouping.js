// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Pure grouping helper for RemediationBanner. A sync failure the operator has
// to act on carries a structured remedy on its status; several sources on one
// device usually share it (every Apple database behind one missing grant), so
// the banner shows the procedure once per device and lists the sources it
// frees. Extracted so the grouping can be unit-tested without Preact.

/**
 * The per-device status entries of one source row: each member's own entry
 * when several devices contribute to the source (`syncStatus.members`), the
 * row's single status otherwise. A remedy is a fact about the device that hit
 * the failure — its grant, its executable — so it is never attributed to a
 * sibling, and never to the owning device by default.
 */
function statusEntries(s) {
  const status = s?.syncStatus;
  if (!status) return [];
  const members = Array.isArray(status.members) ? status.members : [];
  if (members.length > 0) {
    return members.map((m) => ({
      state: m?.state,
      remediation: m?.remediation ?? null,
      deviceId: m?.deviceId ?? null,
      memberScoped: true,
    }));
  }
  return [
    {
      state: status.state,
      remediation: status.remediation ?? null,
      deviceId: status.deviceId ?? s.deviceId ?? null,
      memberScoped: false,
    },
  ];
}

// PARITY:remediation-group-key — `omnesis status` groups by the same two fields.
function groupKey(deviceId, remediation) {
  return `${deviceId ?? ""} ${remediation.summary} ${remediation.executable ?? ""}`;
}

/**
 * Group the sources list into one bucket per (device, remedy) with at least
 * one entry in `error` state carrying a structured remediation. Two remedies
 * are the same when they say the same thing — same summary, same executable —
 * so the sources one grant frees are listed under one procedure.
 *
 * Returns an array of:
 *   {
 *     deviceId,            // the device whose collector hit the failure
 *     deviceName,          // its display name when the source row carries
 *                          //   it (the owning device), null otherwise
 *     memberScoped,        // true when the failure came from one member of a
 *                          //   multi-device source, so the banner names it
 *     remediation,         // { summary, steps, executable?, restartRequired }
 *     affectedSourceIds,   // every source on that device carrying the remedy,
 *                          //   sorted by id for stable rendering
 *   }
 */
export function groupRemediationsByDevice(sources) {
  if (!Array.isArray(sources)) return [];
  const groups = new Map();
  for (const s of sources) {
    for (const entry of statusEntries(s)) {
      if (entry.state !== "error" || !entry.remediation) continue;
      const key = groupKey(entry.deviceId, entry.remediation);
      let group = groups.get(key);
      if (!group) {
        group = {
          deviceId: entry.deviceId,
          deviceName:
            entry.deviceId != null && s.deviceId === entry.deviceId ? (s.deviceName ?? null) : null,
          memberScoped: entry.memberScoped,
          remediation: entry.remediation,
          affectedSourceIds: [],
        };
        groups.set(key, group);
      }
      if (!group.affectedSourceIds.includes(s.id)) group.affectedSourceIds.push(s.id);
    }
  }
  const out = [...groups.values()];
  for (const g of out) g.affectedSourceIds.sort();
  out.sort(
    (a, b) =>
      String(a.deviceId ?? "").localeCompare(String(b.deviceId ?? "")) ||
      a.remediation.summary.localeCompare(b.remediation.summary),
  );
  return out;
}
