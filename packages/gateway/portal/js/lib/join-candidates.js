// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Which devices could join a source. Read by the Sources page's Join action
// and by the add-source picker, which offers a configured source as a join.

/**
 * Kinds that act on sources as operators and never contribute one, so they
 * are never offered as a device to join a source to.
 */
const OPERATOR_ONLY_DEVICE_KINDS = new Set(["cli", "portal", "agent"]);

/**
 * Devices that could join `source`, as device records. The gateway names them
 * in the source's `joinCandidates` (the non-revoked non-members its hosting
 * rule admits for the source's type), resolved here through `devices`; an id
 * the device list does not know or reports as offline is skipped rather than
 * shown as a destination. A missing `online` field remains eligible for
 * compatibility with older gateways.
 *
 * A gateway that reports no `joinCandidates` gets the client-side
 * approximation of its rule: not revoked, not already a member, of a kind
 * that hosts sources, and either advertising the source's type among its
 * `hostableSourceTypes` or not advertising any (a device that has not
 * announced its capabilities yet). Empty for an exclusive source, which
 * refuses a second host.
 */
export function joinCandidates(source, devices) {
  if (!source || (source.multiDeviceMode ?? "exclusive") === "exclusive") return [];
  const list = devices ?? [];
  if (Array.isArray(source.joinCandidates)) {
    const byId = new Map(list.map((d) => [d.id, d]));
    return source.joinCandidates
      .map((id) => byId.get(id))
      .filter((device) => device && device.online !== false);
  }
  const members = new Set(source.members ?? [source.deviceId]);
  return list.filter((d) => {
    if (d.online === false || d.revokedAt || members.has(d.id)) return false;
    if (OPERATOR_ONLY_DEVICE_KINDS.has(d.kind)) return false;
    const hostable = d.capabilities?.hostableSourceTypes;
    return !Array.isArray(hostable) || hostable.includes(source.type);
  });
}
