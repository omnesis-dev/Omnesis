// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Whether a paired agent device can still reach the corpus on its own.
 *
 * A managed harness holds two unrelated authorities: the operational device
 * tokens it was paired with, which never read corpus data, and a separately
 * approved OAuth credential that does. Only the second one can lapse without
 * anybody noticing — its refresh token rotates on use and expires on a timer,
 * so a harness that asks Omnesis nothing for a month wakes up with a live
 * pairing and a dead Answer path.
 *
 * That is the state this module names. It is derived, never stored: a device
 * is authorized while a credential bound to it still holds a refresh token it
 * could trade, and needs re-authorization the moment none does — whether
 * because the operator revoked the grant or because the ticket simply ran out.
 *
 * The predicate is deliberately stricter than the one headless recovery uses
 * (`reissueExecutionDeviceTokens`), by the live refresh token: everything this
 * accepts, recovery can re-key. So "authorized" never promises more than the
 * recovery path can deliver, and a device whose ticket has run out is reported
 * as needing the operator even though recovery would in fact still repair it.
 *
 * Revoking the operational device also revokes every principal credential
 * bound to it. Revoking an Access Grant remains intentionally asymmetric: it
 * ends corpus reads without removing the operational pairing.
 */

import { createHash } from "node:crypto";
import type { Db } from "../data/types.js";
import type { PrincipalCredentialKind } from "./types.js";

/**
 * A discriminated union rather than an optional remedy: the only state that
 * has one is the one that needs one, and a consumer rendering the command
 * should not have to handle its absence.
 */
export type AgentDeviceAuthorization =
  | { status: "authorized" }
  | { status: "needs-reauthorization"; remedy: string };

export interface AgentDeviceRevocationCredential {
  credentialLabel: string;
  principalName: string;
  grantName: string;
}

export interface AgentDeviceRevocationImpact {
  /** Opaque precondition for revoking exactly the credentials shown. */
  fingerprint: string;
  /** Unrevoked, unexpired corpus credentials that device revocation will permanently revoke. */
  corpusCredentials: AgentDeviceRevocationCredential[];
  /** The credential authorities that can resolve or refresh a token right now. */
  corpusAccess: AgentDeviceRevocationCredential[];
}

export const STALE_DEVICE_REVOCATION_IMPACT_ERROR = "OMNESIS_STALE_DEVICE_REVOCATION_IMPACT";

export function isStaleDeviceRevocationImpactError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    if (current.message.includes(STALE_DEVICE_REVOCATION_IMPACT_ERROR)) return true;
    current = (current as Error & { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Classify every paired, unrevoked agent device.
 *
 * One statement, because the answer is a property of the join and the caller
 * renders a whole device list: a per-device query would multiply the same read
 * by the roster. The correlated subquery walks the credentials of one device
 * at a time, and both sides of it are small — a harness holds one approved
 * credential, and only the credentials of an agent device are ever visited.
 */
export function agentDeviceAuthorizations(
  db: Db,
  now = Date.now(),
): Map<string, AgentDeviceAuthorization> {
  const rows = db
    .prepare<[number, number, number], { device_id: string; harness: string; refreshable: number }>(
      `SELECT d.id AS device_id,
              json_extract(d.capabilities, '$.agentIntegration.harness') AS harness,
              EXISTS (
                SELECT 1
                FROM principal_credentials c
                JOIN access_grants g ON g.id = c.grant_id
                JOIN access_principals p ON p.id = g.principal_id
                JOIN oauth_refresh_tokens r ON r.credential_id = c.id
                WHERE c.execution_device_id = d.id
                  AND c.kind = 'interactive'
                  AND c.status = 'active' AND c.revoked_at IS NULL
                  AND (c.expires_at IS NULL OR c.expires_at > ?)
                  AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at > ?)
                  AND p.revoked_at IS NULL
                  AND r.used_at IS NULL AND r.revoked_at IS NULL AND r.expires_at > ?
              ) AS refreshable
       FROM devices d
         WHERE d.kind = 'agent' AND d.revoked_at IS NULL
         AND json_extract(d.capabilities, '$.agentIntegration.harness') IS NOT NULL`,
    )
    .all(now, now, now);
  const states = new Map<string, AgentDeviceAuthorization>();
  for (const row of rows) {
    states.set(
      row.device_id,
      row.refreshable === 1
        ? { status: "authorized" }
        : {
            status: "needs-reauthorization",
            remedy: agentReauthorizationCommand(row.harness),
          },
    );
  }
  return states;
}

/**
 * Name the corpus credentials device revocation would end, and which of them
 * are usable right now.
 *
 * This is presentation data, not an authorization decision. Access-token and
 * refresh-token resolution independently require the bound device to remain
 * unrevoked, so a stale preview can never preserve authority. The focused
 * execution-device index keeps this roster-sized read bounded.
 */
export function agentDeviceRevocationImpacts(
  db: Db,
  now = Date.now(),
): Map<string, AgentDeviceRevocationImpact> {
  return revocationImpactsFromRows(
    db
      .prepare<[number, number, number, number], AgentDeviceRevocationRow>(
        `${AGENT_DEVICE_REVOCATION_IMPACT_SELECT}
         WHERE d.kind = 'agent'
         ORDER BY d.id, p.name, g.name, c.label, c.id`,
      )
      .all(now, now, now, now),
  );
}

/** Read one device's OCC value through the execution-device index. */
export function agentDeviceRevocationImpact(
  db: Db,
  deviceId: string,
  now = Date.now(),
): AgentDeviceRevocationImpact | undefined {
  return revocationImpactsFromRows(
    db
      .prepare<[number, number, number, number, string], AgentDeviceRevocationRow>(
        `${AGENT_DEVICE_REVOCATION_IMPACT_SELECT}
         WHERE d.kind = 'agent' AND d.id = ?
         ORDER BY p.name, g.name, c.label, c.id`,
      )
      .all(now, now, now, now, deviceId),
  ).get(deviceId);
}

interface AgentDeviceRevocationRow {
  device_id: string;
  credential_id: string | null;
  grant_id: string | null;
  principal_id: string | null;
  credential_kind: PrincipalCredentialKind | null;
  credential_label: string | null;
  principal_name: string | null;
  grant_name: string | null;
  credential_status: "pending" | "active" | null;
  corpus_access: number;
}

const AGENT_DEVICE_REVOCATION_IMPACT_SELECT = `
       SELECT d.id AS device_id, c.id AS credential_id, g.id AS grant_id,
              p.id AS principal_id, c.kind AS credential_kind, c.label AS credential_label,
              p.name AS principal_name, g.name AS grant_name, c.status AS credential_status,
              CASE WHEN c.status = 'active' AND (
                -- The credential, grant and principal conditions of
                -- active-access-token.ts are the LEFT JOINs below plus this
                -- CASE's status check; a null principal here means "no live
                -- chain", which the shared predicate's NULL-tolerant
                -- p.revoked_at check would not.
                EXISTS (
                  SELECT 1 FROM oauth_access_tokens a
                   WHERE a.credential_id = c.id AND a.revoked_at IS NULL
                     AND a.expires_at > ? AND a.grant_revision = g.revision
                )
                OR EXISTS (
                  SELECT 1 FROM oauth_refresh_tokens r
                   WHERE r.credential_id = c.id AND r.used_at IS NULL
                     AND r.revoked_at IS NULL AND r.expires_at > ?
                )
              ) THEN 1 ELSE 0 END AS corpus_access
         FROM devices d
         LEFT JOIN principal_credentials c
           ON c.execution_device_id = d.id
          AND c.status IN ('pending', 'active')
          AND c.revoked_at IS NULL AND (c.expires_at IS NULL OR c.expires_at > ?)
         LEFT JOIN access_grants g
           ON g.id = c.grant_id
          AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at > ?)
         LEFT JOIN access_principals p ON p.id = g.principal_id AND p.revoked_at IS NULL`;

function revocationImpactsFromRows(
  rows: AgentDeviceRevocationRow[],
): Map<string, AgentDeviceRevocationImpact> {
  const impacts = new Map<string, AgentDeviceRevocationImpact>();
  const fingerprintEntries = new Map<string, AgentDeviceRevocationFingerprintEntry[]>();
  for (const row of rows) {
    const impact = impacts.get(row.device_id) ?? {
      fingerprint: "",
      corpusCredentials: [],
      corpusAccess: [],
    };
    if (
      row.credential_id === null ||
      row.grant_id === null ||
      row.principal_id === null ||
      row.credential_kind === null ||
      row.credential_label === null ||
      row.principal_name === null ||
      row.grant_name === null ||
      row.credential_status === null
    ) {
      impacts.set(row.device_id, impact);
      continue;
    }
    const credential = {
      credentialLabel: row.credential_label,
      principalName: row.principal_name,
      grantName: row.grant_name,
    };
    impact.corpusCredentials.push(credential);
    const entries = fingerprintEntries.get(row.device_id) ?? [];
    entries.push({
      credentialId: row.credential_id,
      grantId: row.grant_id,
      principalId: row.principal_id,
      credentialKind: row.credential_kind,
      credentialStatus: row.credential_status,
      corpusAccess: row.corpus_access === 1,
      ...credential,
    });
    fingerprintEntries.set(row.device_id, entries);
    if (row.corpus_access === 1) impact.corpusAccess.push(credential);
    impacts.set(row.device_id, impact);
  }
  for (const [deviceId, impact] of impacts) {
    impact.fingerprint = revocationImpactFingerprint(fingerprintEntries.get(deviceId) ?? []);
  }
  return impacts;
}

interface AgentDeviceRevocationFingerprintEntry extends AgentDeviceRevocationCredential {
  credentialId: string;
  grantId: string;
  principalId: string;
  credentialKind: PrincipalCredentialKind;
  credentialStatus: "pending" | "active";
  corpusAccess: boolean;
}

function revocationImpactFingerprint(entries: AgentDeviceRevocationFingerprintEntry[]): string {
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

/** The line an operator runs on the harness host to restore corpus access. */
function agentReauthorizationCommand(harness: string): string {
  return `omnesis connect ${harness} --refresh`;
}
