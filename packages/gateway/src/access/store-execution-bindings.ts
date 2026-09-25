// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomBytes, randomUUID } from "node:crypto";

import { hashSecret } from "./store-helpers.js";
import type { Db } from "../data/types.js";
import type { AccessMutationResult } from "./store-contracts.js";
import type { ExecutionBindingCreateInput, ExecutionBindingCreateResult } from "./types.js";

const EXECUTION_BINDING_TTL_MS = 10 * 60_000;

export function createExecutionBinding(
  db: Db,
  input: ExecutionBindingCreateInput,
  now = Date.now(),
): AccessMutationResult<ExecutionBindingCreateResult> {
  const eligible = db
    .prepare<[string, string, string], { present: number }>(
      `SELECT 1 AS present
       FROM devices d JOIN oauth_clients c ON c.client_id = ?
       WHERE d.id = ? AND d.kind = 'agent' AND d.revoked_at IS NULL
         AND json_extract(d.capabilities, '$.agentIntegration.harness') = ?`,
    )
    .get(input.oauthClientId, input.deviceId, input.harness);
  if (!eligible) return { ok: false, error: "invalid-binding" };

  const binding = `omn_oeb_${randomBytes(24).toString("base64url")}`;
  const expiresAt = now + EXECUTION_BINDING_TTL_MS;
  db.prepare(
    `INSERT INTO oauth_execution_bindings (
       id, binding_hash, device_id, oauth_client_id, harness, created_at, expires_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    hashSecret(binding),
    input.deviceId,
    input.oauthClientId,
    input.harness,
    now,
    expiresAt,
  );
  return { ok: true, value: { binding, expiresAt } };
}

export function consumeExecutionBinding(
  db: Db,
  binding: string,
  oauthClientId: string,
  now: number,
): AccessMutationResult<string> {
  const row = db
    .prepare<
      [string],
      {
        id: string;
        device_id: string;
        oauth_client_id: string;
        expires_at: number;
        used_at: number | null;
        device_revoked_at: number | null;
        device_kind: string;
        harness: string | null;
      }
    >(
      `SELECT b.*, d.revoked_at AS device_revoked_at, d.kind AS device_kind,
              json_extract(d.capabilities, '$.agentIntegration.harness') AS harness
       FROM oauth_execution_bindings b JOIN devices d ON d.id = b.device_id
       WHERE b.binding_hash = ?`,
    )
    .get(hashSecret(binding));
  if (
    !row ||
    row.oauth_client_id !== oauthClientId ||
    row.used_at !== null ||
    row.expires_at <= now ||
    row.device_revoked_at !== null ||
    row.device_kind !== "agent" ||
    row.harness === null
  ) {
    return { ok: false, error: "invalid-binding" };
  }
  const claimed = db
    .prepare(
      `UPDATE oauth_execution_bindings SET used_at = ?
       WHERE id = ? AND used_at IS NULL AND expires_at > ?`,
    )
    .run(now, row.id, now);
  return claimed.changes === 1
    ? { ok: true, value: row.device_id }
    : { ok: false, error: "invalid-binding" };
}
