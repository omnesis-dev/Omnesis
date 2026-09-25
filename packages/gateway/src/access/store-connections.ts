// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { uniqueLiveName } from "./store-level-writes.js";
import { loadGrantSummary } from "./store-management.js";
import type { Db } from "../data/types.js";
import type { AccessConnectionProposal } from "./types.js";

/**
 * A sign-in that is neither revoked nor expired, under a live connection. An
 * approved sign-in still waiting for its code to be redeemed counts: it is a
 * connection in progress.
 */
const LIVE_SIGN_IN = `c.kind = 'interactive' AND c.revoked_at IS NULL
  AND (c.expires_at IS NULL OR c.expires_at > @now)
  AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at > @now)
  AND p.kind = 'interactive' AND p.revoked_at IS NULL`;
const MATCH_SELECT = `SELECT c.grant_id, p.id AS principal_id, p.name AS principal_name, g.level_id
    FROM principal_credentials c
    JOIN access_grants g ON g.id = c.grant_id
    JOIN access_principals p ON p.id = g.principal_id`;
const NEWEST = "ORDER BY c.created_at DESC, c.id DESC LIMIT 1";

interface SignInMatch {
  grant_id: string;
  principal_id: string;
  principal_name: string;
  level_id: string | null;
}

/**
 * The newest live sign-in bound to an execution device, read through the
 * credential device index: a managed integration signing in again on the
 * same machine belongs to the connection that sign-in holds.
 */
export function findDeviceBoundSignIn(
  db: Db,
  executionDeviceId: string,
  now: number,
): SignInMatch | undefined {
  return db
    .prepare<
      { now: number; device: string },
      SignInMatch
    >(`${MATCH_SELECT} WHERE c.execution_device_id = @device AND ${LIVE_SIGN_IN} ${NEWEST}`)
    .get({ now, device: executionDeviceId });
}

/**
 * What an approver is offered for a request: default names for a new
 * connection and a new level, and the live connection this request most
 * likely belongs to. A sign-in bound to the request's execution device is the
 * strongest evidence, then a sign-in of the same registered client, then one
 * of a client registered under the same name. Credentials are few, one per
 * sign-in; the device and client matches read through their indexes and the
 * name match reads the table whole.
 */
export function findConnectionProposal(
  db: Db,
  requestId: string,
  now = Date.now(),
): AccessConnectionProposal | null {
  const request = db
    .prepare<
      [string],
      { client_id: string; client_name: string; execution_device_id: string | null }
    >("SELECT client_id, client_name, execution_device_id FROM oauth_authorization_requests WHERE id = ?")
    .get(requestId);
  if (!request) return null;

  let matchedBy: "device" | "client" | "name" | null = null;
  let row: SignInMatch | undefined;
  if (request.execution_device_id !== null) {
    row = findDeviceBoundSignIn(db, request.execution_device_id, now);
    if (row) matchedBy = "device";
  }
  if (!row) {
    row = db
      .prepare<
        { now: number; client: string },
        SignInMatch
      >(`${MATCH_SELECT} WHERE c.oauth_client_id = @client AND ${LIVE_SIGN_IN} ${NEWEST}`)
      .get({ now, client: request.client_id });
    if (row) matchedBy = "client";
  }
  if (!row) {
    row = db
      .prepare<{ now: number; name: string }, SignInMatch>(
        `${MATCH_SELECT} JOIN oauth_clients oc ON oc.client_id = c.oauth_client_id
          WHERE lower(trim(oc.client_name)) = lower(trim(@name)) AND ${LIVE_SIGN_IN} ${NEWEST}`,
      )
      .get({ now, name: request.client_name });
    if (row) matchedBy = "name";
  }
  const grant = row ? loadGrantSummary(db, row.grant_id) : null;
  const match =
    row && grant && matchedBy
      ? {
          connectionId: row.principal_id,
          connectionName: row.principal_name,
          matchedBy,
          levelId: row.level_id,
          grant,
        }
      : null;
  return {
    defaultName: uniqueLiveName(db, "access_principals", request.client_name),
    defaultLevelName: uniqueLiveName(db, "access_levels", request.client_name),
    match,
    recommended:
      match?.matchedBy === "device" ? "replace" : match?.levelId ? "existing-level" : "new-level",
  };
}
