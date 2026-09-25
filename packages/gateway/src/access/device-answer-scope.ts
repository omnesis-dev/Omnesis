// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { tokenAnswerOwnerId } from "../privacy/token-answer-owner.js";
import { createCorpusAuthorization, type CorpusAuthorization } from "./corpus-authorization.js";
import { getLiveLevelRow } from "./store-level-summaries.js";
import { levelHasUsableAnswer } from "./store-level-writes.js";
import { getLevelCapabilities } from "./store-rules.js";
import type { Db } from "../data/types.js";

/**
 * What a paired device may be answered from over `/answer`.
 *
 * - `default`: one of the operator's own devices — every source, reviewed
 *   against the default privacy policy.
 * - `level`: an integration on an access level, and `authorization` is that
 *   level's Answer rule — its sources, release mode and privacy policy — built
 *   by the same function an OAuth connection's rule goes through.
 * - `unassigned`: an integration on no access level. It is answered nothing
 *   until the operator chooses what it may use.
 * - `unavailable`: an integration on a level that can no longer answer (it was
 *   removed, lost its Answer rule, or its privacy policy is gone). Nothing is
 *   answered until it is put on another level.
 */
export type DeviceAnswerScope =
  | { kind: "default" }
  | { kind: "level"; levelId: string; authorization: CorpusAuthorization }
  | { kind: "unassigned" }
  | { kind: "unavailable"; levelId: string };

/**
 * Resolve the device's access level into an Answer authorization, read fresh
 * on every call so a level edit applies to the next question, and read as one
 * snapshot so a level's revision is never paired with another revision's rules.
 * The identity names the device and the level rather than an OAuth grant: it
 * is attributed in the answer's authorization, never used to authenticate
 * anything.
 */
export function resolveDeviceAnswerScope(
  db: Db,
  deviceId: string,
  tokenId: string,
): DeviceAnswerScope {
  return db.transaction(() => readDeviceAnswerScope(db, deviceId, tokenId))();
}

function readDeviceAnswerScope(db: Db, deviceId: string, tokenId: string): DeviceAnswerScope {
  const row = db
    .prepare<
      [string],
      { kind: string; access_level_id: string | null }
    >("SELECT kind, access_level_id FROM devices WHERE id = ?")
    .get(deviceId);
  if (row?.kind !== "integration") return { kind: "default" };
  const levelId = row.access_level_id;
  if (levelId === null) return { kind: "unassigned" };
  const level = getLiveLevelRow(db, levelId);
  if (!level || !levelHasUsableAnswer(db, levelId)) return { kind: "unavailable", levelId };
  const authorization = createCorpusAuthorization(
    {
      principalId: `device:${deviceId}`,
      grantId: `level:${levelId}`,
      grantRevision: level.revision,
      credentialId: `device:${deviceId}`,
      accessTokenId: tokenId,
    },
    getLevelCapabilities(db, levelId),
    "answer",
  );
  return authorization
    ? { kind: "level", levelId, authorization }
    : { kind: "unavailable", levelId };
}

/**
 * The answer owner a device token holds right now, or null when it holds none:
 * the device is revoked, the token is gone or expired, or the integration is
 * on no level or one that can no longer answer. Checked inside the egress transaction, so an answer is
 * released only to the owner it was made for while that owner still stands —
 * a level narrowed, changed or removed while the answer was being made fences
 * its release, as an OAuth grant change fences an MCP answer.
 */
export function currentDeviceAnswerOwner(
  db: Db,
  deviceId: string,
  tokenId: string,
  now = Date.now(),
): string | null {
  const live = db
    .prepare<[string, string, number], { present: number }>(
      `SELECT 1 AS present FROM tokens t JOIN devices d ON d.id = t.device_id
        WHERE t.id = ? AND t.device_id = ? AND d.revoked_at IS NULL
          AND (t.expires_at IS NULL OR t.expires_at > ?)`,
    )
    .get(tokenId, deviceId, now);
  if (!live) return null;
  const scope = readDeviceAnswerScope(db, deviceId, tokenId);
  if (scope.kind === "unavailable" || scope.kind === "unassigned") return null;
  return tokenAnswerOwnerId(tokenId, scope.kind === "level" ? scope.authorization : undefined);
}
