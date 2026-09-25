// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Pure grouping helper for ReauthBanner. Extracted so the logic — which
// drives which banners appear and which sources each one heals — can be
// unit-tested without spinning up Preact / EventSource.

import { sourceAccountOf, sourceTypeOf } from "../lib/source-id.js";

/**
 * Group the sources list into one bucket per affected (providerType,
 * accountId, device). Credentials are held per device: each member of a
 * multi-device source authenticates its own grant, so a provider+account
 * is "affected" on the device whose entry is currently in `needs-auth`.
 * Other sibling sources hosted by that device under the same provider+account
 * are included regardless of their own state — there they share the same
 * refresh token, so a successful reauth fixes them all at once.
 * The collector's `source.reauth-finalize` handler re-instantiates every
 * source under the pair, so we just need to know which (providerType,
 * accountId, device) triples to surface.
 *
 * Returns an array of:
 *   {
 *     providerType,       // e.g. "google" — drives banner title + auth flow
 *     accountId,           // e.g. "user@gmail.com"
 *     deviceId,            // the device that must sign in again
 *     deviceName,          // its display name when the source row carries
 *                          //   it (the owning device), null otherwise
 *     memberScoped,        // true when the lapse came from one member of a
 *                          //   multi-device source (`syncStatus.members`),
 *                          //   so the banner names the device explicitly
 *     driverSourceType,    // any sourceType under the pair (used to start
 *                          //   the OAuth flow — descriptors all share the
 *                          //   provider's client). Stable across renders:
 *                          //   the first source we encountered for the
 *                          //   pair, sorted by id.
 *     affectedSourceIds,   // every source id hosted by that device under
 *                          //   (providerType, accountId), sorted by id
 *   }
 *
 * Sources without a `syncStatus.providerId` are skipped — without the
 * full provider id we can't drive a reauth.
 */
export function groupNeedsAuthSourcesByProvider(sources) {
  return groupSourcesByProviderForState(sources, "needs-auth");
}

/**
 * Sibling of `groupNeedsAuthSourcesByProvider` for the forward-looking
 * `auth-expiring` state (#927). A provider+account is "expiring" on a device if
 * any of its entries there is in `auth-expiring`; the same provider+account
 * re-consent heals all its siblings. Each group also carries the soonest
 * `consentExpiresAt` deadline across its sources, so the banner can render
 * "expires on <date>". Returns the same group shape as the needs-auth
 * grouping, plus `consentExpiresAt`.
 */
export function groupExpiringSourcesByProvider(sources) {
  const groups = groupSourcesByProviderForState(sources, "auth-expiring");
  if (groups.length === 0) return groups;
  // Annotate each group with the soonest deadline among its expiring entries.
  const deadlineByKey = new Map();
  for (const s of Array.isArray(sources) ? sources : []) {
    for (const entry of statusEntries(s)) {
      if (entry.state !== "auth-expiring") continue;
      const split = splitProviderId(entry.providerId);
      if (!split) continue;
      const deadline = entry.consentExpiresAt;
      if (typeof deadline !== "string") continue;
      const key = groupKey(split.providerType, split.accountId, entry.deviceId);
      const prev = deadlineByKey.get(key);
      if (!prev || Date.parse(deadline) < Date.parse(prev)) deadlineByKey.set(key, deadline);
    }
  }
  for (const g of groups) {
    const deadline = deadlineByKey.get(groupKey(g.providerType, g.accountId, g.deviceId));
    if (deadline) g.consentExpiresAt = deadline;
  }
  return groups;
}

/**
 * The per-device status entries of one source row: each member's own entry
 * when several devices contribute to the source (`syncStatus.members`), the
 * row's single status otherwise. Each entry names the device it describes,
 * so a lapse is attributed to the device that must sign in — never to the
 * owning device by default, which may be a sibling whose grant is healthy.
 */
function statusEntries(s) {
  const status = s?.syncStatus;
  if (!status) return [];
  const members = Array.isArray(status.members) ? status.members : [];
  if (members.length > 0) {
    return members.map((m) => ({
      state: m?.state,
      providerId: m?.providerId ?? status.providerId,
      deviceId: m?.deviceId ?? null,
      consentExpiresAt: m?.consentExpiresAt ?? status.consentExpiresAt,
      memberScoped: true,
    }));
  }
  return [
    {
      state: status.state,
      providerId: status.providerId,
      // The device that reported the status first; the row's owner only
      // when the status does not name one.
      deviceId: status.deviceId ?? s.deviceId ?? null,
      consentExpiresAt: status.consentExpiresAt,
      memberScoped: false,
    },
  ];
}

/**
 * Group the sources list into one bucket per (providerType, accountId, device)
 * that has at least one entry in `state`. Sibling sources hosted by that device
 * under the same provider+account are included regardless of their own state
 * (a single re-auth heals them all). Generic over the trigger state so
 * `needs-auth` and `auth-expiring` share it.
 */
function groupSourcesByProviderForState(sources, state) {
  if (!Array.isArray(sources)) return [];

  // First pass: collect every (providerType, accountId, device) with at least
  // one entry in the trigger state.
  const affected = new Map();
  for (const s of sources) {
    for (const entry of statusEntries(s)) {
      if (entry.state !== state) continue;
      const split = splitProviderId(entry.providerId);
      if (!split) continue;
      const key = groupKey(split.providerType, split.accountId, entry.deviceId);
      if (affected.has(key)) continue;
      affected.set(key, {
        providerType: split.providerType,
        accountId: split.accountId,
        deviceId: entry.deviceId,
        deviceName:
          entry.deviceId != null && s.deviceId === entry.deviceId ? (s.deviceName ?? null) : null,
        memberScoped: entry.memberScoped,
        affectedSourceIds: [],
        driverSourceType: null,
      });
    }
  }

  if (affected.size === 0) return [];

  // Second pass: gather every source whose provider+account is affected on
  // some device into each of that pair's groups, regardless of its own state.
  for (const s of sources) {
    const providerId = s?.syncStatus?.providerId ?? statusEntries(s)[0]?.providerId;
    const split = splitProviderId(providerId);
    if (!split) continue;
    const sourceType = sourceTypeOfRow(s);
    for (const entry of affected.values()) {
      if (entry.providerType !== split.providerType || entry.accountId !== split.accountId)
        continue;
      if (
        entry.deviceId != null &&
        !statusEntries(s).some((sourceEntry) => sourceEntry.deviceId === entry.deviceId)
      )
        continue;
      entry.affectedSourceIds.push(s.id);
      // Pick driverSourceType deterministically: first sourceType alphabetically.
      if (sourceType && (entry.driverSourceType == null || sourceType < entry.driverSourceType)) {
        entry.driverSourceType = sourceType;
      }
    }
  }

  // Sort each group's source list + the groups themselves for stable
  // rendering across polls.
  const out = [];
  for (const entry of affected.values()) {
    entry.affectedSourceIds.sort();
    out.push(entry);
  }
  out.sort(
    (a, b) =>
      (a.providerType + a.accountId).localeCompare(b.providerType + b.accountId) ||
      String(a.deviceId ?? "").localeCompare(String(b.deviceId ?? "")),
  );
  return out;
}

function splitProviderId(providerId) {
  // A provider id is shaped like a source id, and a grouping key needs both
  // halves — so an id missing either is not one this can group.
  const providerType = sourceTypeOf(providerId);
  const accountId = sourceAccountOf(providerId);
  if (!accountId || providerType === providerId) return null;
  return { providerType, accountId };
}

function groupKey(providerType, accountId, deviceId) {
  return `${providerType}:${accountId}\u0000${deviceId ?? ""}`;
}

function sourceTypeOfRow(source) {
  if (typeof source?.type === "string") return source.type;
  // Fall back to parsing the id when `type` isn't on the row.
  return typeof source?.id === "string" ? sourceTypeOf(source.id) : null;
}
