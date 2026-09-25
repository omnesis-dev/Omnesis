// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { SCOPE_ADMIN, scopeSatisfies, type Scope } from "@omnesis/types";
import { ForbiddenError } from "./http/errors.js";
import { setExpectedKnownUrlPatternDeclarers } from "./known-url-patterns.js";
import { setExpectedUrlGraphRoleDeclarers } from "./url-graph-roles.js";
import { setExpectedLinkDeclarationKeys } from "./link-declaration-readiness.js";
import { setExpectedUrlCanonicalizerDeclarers } from "./url-canonicalizers.js";
import type Database from "better-sqlite3";

type Db = Database.Database;
const connectedCollectorIds = new Set<string>();

export interface CollectorRosterSnapshot {
  revision: number;
}

/** Read the O(1) writer-side OCC token for the process-local declaration roster. */
export function collectorRosterSnapshot(db: Db): CollectorRosterSnapshot {
  const revision =
    db
      .prepare<
        [],
        { revision: number }
      >("SELECT revision FROM mutable_list_revisions WHERE scope = 'link-declarations'")
      .get()?.revision ?? 0;
  return { revision };
}

/** Refresh every declaration registry from collectors connected to this process. */
export function refreshCollectorDeclarationRoster(): string[] {
  const ids = [...connectedCollectorIds].sort();
  applyCollectorDeclarationRoster(ids);
  return ids;
}

export function collectorDeclarationConnected(deviceId: string): boolean {
  return connectedCollectorIds.has(deviceId);
}

/** Called under the link-declaration revision fence on first WS connect. */
export function connectCollectorDeclarations(deviceId: string): void {
  connectedCollectorIds.add(deviceId);
  refreshCollectorDeclarationRoster();
}

/** Called under the link-declaration revision fence on last WS disconnect. */
export function disconnectCollectorDeclarations(deviceId: string): void {
  connectedCollectorIds.delete(deviceId);
  refreshCollectorDeclarationRoster();
}

/** Test/process teardown helper. Production starts with an empty process roster. */
export function resetConnectedCollectorDeclarations(): void {
  connectedCollectorIds.clear();
  refreshCollectorDeclarationRoster();
}

export function applyCollectorDeclarationRoster(ids: readonly string[]): void {
  setExpectedUrlCanonicalizerDeclarers(ids);
  setExpectedKnownUrlPatternDeclarers(ids);
  setExpectedUrlGraphRoleDeclarers(ids);
  setExpectedLinkDeclarationKeys(ids);
}

export function collectorRosterRevisionMatches(db: Db, expectedRevision: number): boolean {
  const current = db
    .prepare<
      [],
      { revision: number }
    >("SELECT revision FROM mutable_list_revisions WHERE scope = 'link-declarations'")
    .get();
  return expectedRevision % 2 === 0 && current?.revision === expectedRevision;
}

/**
 * Device bearer tokens may declare global descriptor metadata only for a live
 * collector. A portal/bootstrap admin has no device id and uses the explicit
 * `admin` override layer.
 */
export function collectorDeclarationKey(
  db: Db,
  deviceId: string | null,
  scopes: readonly Scope[],
  socketConnected?: boolean,
): string {
  if (deviceId !== null) {
    const active = db
      .prepare<
        [string],
        { present: number }
      >("SELECT 1 AS present FROM devices WHERE id = ? AND kind = 'collector' AND revoked_at IS NULL")
      .get(deviceId);
    // Collector tokens currently carry broad administrative scopes. They must
    // still declare under their device id so readiness represents every live
    // collector, rather than collapsing all declarations into the admin layer.
    if (active && (socketConnected ?? collectorDeclarationConnected(deviceId))) return deviceId;
    throw new ForbiddenError("a connected collector device token is required");
  }
  if (scopeSatisfies(scopes, SCOPE_ADMIN)) return "admin";
  throw new ForbiddenError("a connected collector device token is required");
}
