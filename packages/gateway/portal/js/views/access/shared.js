// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Helpers the Access pages and the neighbouring Policies tab read: which
// policies an overview carries, the connections and access levels it lists,
// how a server error is worded, how a moment is printed, what a capability is
// called and whether a piece of access is still active.

import { defaultPolicyFamilyId, normalizeGrantRules } from "../../components/grant-builder-state.js";

export function overviewPolicies(overview) {
  return overview.policyFamilies ?? overview.privacyPolicies ?? [];
}

/**
 * The rules a connection's grant or an access level carries, in the builder's
 * shape. A reviewed Answer that names no policy is read under the gateway's
 * default one, which is what the gateway itself does.
 */
export function accessRules(subject, overview) {
  return normalizeGrantRules(
    subject.rules ?? subject.capabilities,
    defaultPolicyFamilyId(overviewPolicies(overview), overview.defaultPolicyFamilyId),
  );
}

/** The sentence every place that chooses an access level says beside the choice. */
export const LEVEL_HELPER = "Connections that use the same access level share its permissions.";

export function compareNames(left, right) {
  return left.localeCompare(right, undefined, { sensitivity: "base" });
}

/** The overview's access levels, by name. A gateway that has none sends none. */
export function accessLevels(overview) {
  return [...(overview.levels ?? [])].sort((left, right) => compareNames(left.name, right.name));
}

export function connectionCountLabel(count) {
  if (count === 0) return "No connections";
  return `${count} connection${count === 1 ? "" : "s"}`;
}

/** The integrations whose `/answer` requests use a level. */
export function levelDevices(level) {
  return level.devices ?? [];
}

export function deviceCountLabel(count) {
  return `${count} integration${count === 1 ? "" : "s"}`;
}

/** Who uses a level, where a level is offered for a choice: its connections, and its integrations when any. */
export function levelUsersLabel(level) {
  const devices = levelDevices(level).length;
  const connections = connectionCountLabel(level.connectionCount ?? 0);
  return devices > 0 ? `${connections} · ${deviceCountLabel(devices)}` : connections;
}

/** Whether an entity the overview may send without `revokedAt` has been removed. */
function removed(entity) {
  return entity.revokedAt !== null && entity.revokedAt !== undefined;
}

function stateOf(entity) {
  return effectiveAccessState({ ...entity, revokedAt: entity.revokedAt ?? null });
}

/**
 * Whether a connection is live access, and if not, what stopped it.
 *
 * A connection reads the corpus while it and its permissions are active and
 * any one of its sign-ins is. One whose sign-in has not finished is pending;
 * one approved but never signed in is still access granted, so it is active.
 * One whose every sign-in was revoked is signed out: it keeps its name and
 * access level, and a new sign-in can take it over, but nothing reads through
 * it until one does.
 */
function connectionState(principal, grant, credentials, signIns) {
  for (const entity of [principal, grant]) {
    const state = stateOf(entity);
    if (state !== "active") return state;
  }
  if (signIns.length === 0) return credentials.length === 0 ? "active" : "signed-out";
  const states = signIns.map(stateOf);
  if (states.includes("active")) return "active";
  return states.includes("pending") ? "pending" : states[0];
}

/**
 * One entry per connection the gateway still recognises, by name.
 *
 * A connection is one approved agent install: its name, the access level it
 * uses (`levelId`), the permissions it holds from that level and its sign-ins.
 * Something removed is gone and is not listed; expired access stays, because
 * the owner can still act on it. `hadSignIn` says whether it ever signed in,
 * revoked sign-ins included.
 */
export function connectionEntries(overview) {
  return (overview.principals ?? [])
    .filter((principal) => !removed(principal))
    .flatMap((principal) => (principal.grants ?? [])
      .filter((grant) => !removed(grant))
      .map((grant) => {
        const credentials = grant.credentials ?? [];
        const signIns = credentials.filter((credential) => !removed(credential));
        return {
          id: principal.id,
          name: principal.name,
          principal,
          grant,
          levelId: grant.levelId ?? null,
          signIns,
          hadSignIn: credentials.length > 0,
          lastUsedAt: signIns.reduce((latest, credential) => Math.max(latest, credential.lastUsedAt ?? 0), 0) || null,
          state: connectionState(principal, grant, credentials, signIns),
        };
      }))
    .sort((left, right) => compareNames(left.name, right.name));
}

/**
 * Whether a connection is still live: its permissions neither removed nor
 * expired, whatever its sign-ins say. This is the gateway's rule for the
 * connections an access level counts and for the ones a change can reach, so
 * a signed-out connection can still be moved, replaced and counted.
 */
export function isLiveConnection(entry) {
  return entry.state === "active" || entry.state === "pending" || entry.state === "signed-out";
}

/**
 * How many live connections use a level: the gateway's own count where the
 * overview carries one, otherwise counted from `entries` by the same rule.
 */
export function liveConnectionCount(level, entries) {
  if (typeof level.connectionCount === "number") return level.connectionCount;
  return entries.filter((entry) => entry.levelId === level.id && isLiveConnection(entry)).length;
}

// A refusal the gateway words as a machine token (`expired`, `not-found`) is
// addressed to the code that reads it; a person is only ever shown a sentence.
const MACHINE_TOKEN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// The gateway's own sentence when it sent one, and the caller's fallback
// otherwise — also when what it sent is a machine token, which the caller
// maps to a sentence of its own before coming here or does not show at all.
// The fallback is what names the failed operation, so it stays the caller's
// to write: no wording here can be true of every page that reads it.
export function errorMessage(error, fallback) {
  const served = error?.serverMessage;
  if (!served || MACHINE_TOKEN.test(served)) return fallback;
  return served;
}

export function timestamp(value) {
  if (!value) return "Never";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

/**
 * How long a pending authorization request still has, in prose.
 *
 * These requests live minutes, not days, so the remaining time is what the
 * owner acts on; an absolute wall-clock moment makes them do the subtraction.
 * Past the hour the remainder stops being the useful fact and the moment
 * itself is printed instead.
 */
export function expiresInLabel(expiresAt, now = Date.now()) {
  if (!expiresAt) return "No expiry";
  const remaining = expiresAt - now;
  if (remaining <= 0) return "Expired";
  if (remaining >= 3_600_000) return `Expires ${timestamp(expiresAt)}`;
  if (remaining < 60_000) return "Expires in under a minute";
  // Whole minutes down, never up: a label that rounded 90 seconds to two
  // minutes would promise time the request does not have.
  const minutes = Math.floor(remaining / 60_000);
  return `Expires in ${minutes} minute${minutes === 1 ? "" : "s"}`;
}

export function capabilityLabel(capability) {
  return capability === "notes" ? "Notes" : capability === "direct" ? "Direct" : "Answer";
}

export function effectiveAccessState(entity, now = Date.now()) {
  if (entity.revokedAt !== null) return "revoked";
  if (entity.status === "pending") return "pending";
  if (entity.expiresAt !== undefined && entity.expiresAt !== null && entity.expiresAt <= now) {
    return "expired";
  }
  return "active";
}
