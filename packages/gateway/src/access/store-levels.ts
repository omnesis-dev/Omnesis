// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { appendAudit, getActiveGrant } from "./store-helpers.js";
import {
  getLiveLevelRow,
  liveLevelDevices,
  liveLevelMemberGrantIds,
  loadAccessLevelSummary,
  type AccessLevelRow,
} from "./store-level-summaries.js";
import {
  insertLevel,
  isLevelNameConflict,
  levelHasUsableAnswer,
  levelNameTaken,
  markLevelChosen,
  writeLevelCapabilities,
} from "./store-level-writes.js";
import {
  getGrantCapabilities,
  getLevelCapabilities,
  normalizeGrantRules,
  storedRuleShape,
  type StoredGrantRules,
  validateGrantRuleReferences,
} from "./store-rules.js";
import type { Db } from "../data/types.js";
import type { AccessMutationError, AccessMutationResult } from "./store-contracts.js";
import type {
  AccessConnectionLevelInput,
  AccessConnectionLevelResult,
  AccessDeviceLevelInput,
  AccessDeviceLevelResult,
  AccessGrantCapability,
  AccessGrantUpdateInput,
  AccessGrantUpdateResult,
  AccessLevelCreateInput,
  AccessLevelSummary,
  AccessLevelUpdateInput,
  AccessLevelDeleteInput,
} from "./types.js";

type ActiveGrant = NonNullable<ReturnType<typeof getActiveGrant>>;

/** Thrown inside a level transaction to roll every member write back. */
class LevelChangeRefusedError extends Error {
  constructor(readonly code: AccessMutationError) {
    super(code);
  }
}

/**
 * A connection's live grant: the oldest live grant of a live interactive
 * principal. A connection holds exactly one, so "oldest" only settles the
 * order of rows no flow writes any more.
 */
export function getConnectionGrant(db: Db, connectionId: string, now: number): ActiveGrant | null {
  const row = db
    .prepare<[string, number], { id: string }>(
      `SELECT g.id FROM access_grants g
         JOIN access_principals p ON p.id = g.principal_id
        WHERE g.principal_id = ? AND p.kind = 'interactive' AND p.revoked_at IS NULL
          AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at > ?)
        ORDER BY g.created_at, g.id LIMIT 1`,
    )
    .get(connectionId, now);
  return row ? getActiveGrant(db, row.id, now) : null;
}

export function createAccessLevel(
  db: Db,
  input: AccessLevelCreateInput,
  now = Date.now(),
): AccessMutationResult<AccessLevelSummary> {
  const name = input.name.trim();
  let rules: StoredGrantRules;
  try {
    rules = normalizeGrantRules(input.rules);
  } catch {
    return { ok: false, error: "invalid-selection" };
  }
  return inLevelTransaction(db, (): AccessMutationResult<AccessLevelSummary> => {
    if (levelNameTaken(db, name)) return { ok: false, error: "level-name-taken" };
    try {
      validateGrantRuleReferences(db, rules);
    } catch {
      return { ok: false, error: "invalid-selection" };
    }
    const level = insertLevel(db, name, rules, input.actorTokenId, now);
    return { ok: true, value: loadAccessLevelSummary(db, level.id, now)! };
  });
}

/**
 * Rename a level and/or give it new rules. New rules reach every live member
 * grant in the same transaction, each through the ordinary grant edit, so the
 * members' revisions advance and their outstanding access tokens are fenced.
 * A member that cannot take the rules — an execution-bound sign-in that
 * would lose Answer — refuses the whole edit.
 */
export function updateAccessLevel(
  db: Db,
  input: AccessLevelUpdateInput,
  now = Date.now(),
): AccessMutationResult<AccessLevelSummary> {
  let rules: StoredGrantRules | undefined;
  try {
    rules = input.rules ? normalizeGrantRules(input.rules) : undefined;
  } catch {
    return { ok: false, error: "invalid-selection" };
  }
  return inLevelTransaction(db, (): AccessMutationResult<AccessLevelSummary> => {
    const level = getLiveLevelRow(db, input.levelId);
    if (!level) return { ok: false, error: "not-found" };
    if (level.revision !== input.expectedRevision) return { ok: false, error: "stale-revision" };
    const name = input.name?.trim() ?? level.name;
    const renamed = name !== level.name;
    if (renamed && levelNameTaken(db, name, level.id)) {
      return { ok: false, error: "level-name-taken" };
    }
    const rulesChanged = rules ? applyLevelRules(db, level, rules, input.actorTokenId, now) : false;
    if (renamed || rulesChanged) {
      advanceLevel(db, level, name, input.actorTokenId, now, rulesChanged ? rules : undefined);
    }
    return { ok: true, value: loadAccessLevelSummary(db, level.id, now)! };
  });
}

/**
 * Retire a level no live connection or unrevoked device uses. A level in use
 * is refused, and a connection whose sign-in still waits for its code to be
 * redeemed uses its level: its grant already exists. A revoked device keeps
 * its level so a repair brings it back as it was; once the level is retired
 * that device's questions are refused until it is put on another.
 */
export function deleteAccessLevel(
  db: Db,
  input: AccessLevelDeleteInput,
  now = Date.now(),
): AccessMutationResult<null> {
  return db.transaction((): AccessMutationResult<null> => {
    const level = getLiveLevelRow(db, input.levelId);
    if (!level) return { ok: false, error: "not-found" };
    if (
      liveLevelMemberGrantIds(db, level.id, now).length > 0 ||
      liveLevelDevices(db, level.id).size > 0
    ) {
      return { ok: false, error: "level-in-use" };
    }
    db.prepare("UPDATE access_levels SET revoked_at = ?, updated_at = ? WHERE id = ?").run(
      now,
      now,
      level.id,
    );
    appendAudit(db, {
      eventType: "level-deleted",
      actorTokenId: input.actorTokenId,
      detail: { levelId: level.id, name: level.name },
      now,
    });
    return { ok: true, value: null };
  })();
}

/**
 * Move a connection onto another level. An existing level's rules replace
 * the connection's; a new level copies the connection's current rules, so
 * nothing about its access changes. The level it leaves stays, even with no
 * connections left on it. A connection with an execution-bound sign-in only
 * moves onto a level whose Answer it can use today.
 */
export function setConnectionLevel(
  db: Db,
  input: AccessConnectionLevelInput,
  now = Date.now(),
): AccessMutationResult<AccessConnectionLevelResult> {
  return inLevelTransaction(db, (): AccessMutationResult<AccessConnectionLevelResult> => {
    const grant = getConnectionGrant(db, input.connectionId, now);
    if (!grant) return { ok: false, error: "not-found" };
    if (grant.revision !== input.expectedGrantRevision) {
      return { ok: false, error: "stale-revision" };
    }
    let levelId: string;
    let updated: AccessGrantUpdateResult;
    if ("newLevel" in input) {
      const name = input.newLevel.name.trim();
      if (levelNameTaken(db, name)) return { ok: false, error: "level-name-taken" };
      const capabilities = getGrantCapabilities(db, grant.id);
      if (capabilities.length === 0) return { ok: false, error: "invalid-selection" };
      levelId = insertLevel(db, name, storedRuleShape(capabilities), input.actorTokenId, now).id;
      updated = { grantId: grant.id, revision: grant.revision, capabilities };
    } else {
      const level = getLiveLevelRow(db, input.levelId);
      if (!level) return { ok: false, error: "inactive-grant" };
      if (
        input.expectedLevelRevision !== undefined &&
        level.revision !== input.expectedLevelRevision
      ) {
        return { ok: false, error: "stale-revision" };
      }
      if (grantHasExecutionBoundSignIn(db, grant.id, now) && !levelHasUsableAnswer(db, level.id)) {
        return { ok: false, error: "invalid-selection" };
      }
      levelId = level.id;
      markLevelChosen(db, level.id);
      const levelCapabilities = getLevelCapabilities(db, level.id);
      const applied = replaceGrantRules(
        db,
        grant,
        storedRuleShape(levelCapabilities),
        input.actorTokenId,
        now,
        levelCapabilities,
      );
      if (!applied.ok) throw new LevelChangeRefusedError(applied.error);
      updated = applied.value;
    }
    if (grant.level_id !== levelId) {
      db.prepare("UPDATE access_grants SET level_id = ?, updated_at = ? WHERE id = ?").run(
        levelId,
        now,
        grant.id,
      );
      appendAudit(db, {
        eventType: "grant-level-changed",
        principalId: grant.principal_id,
        grantId: grant.id,
        grantRevision: updated.revision,
        actorTokenId: input.actorTokenId,
        detail: { levelId, previousLevelId: grant.level_id },
        now,
      });
    }
    return {
      ok: true,
      value: { grant: updated, level: loadAccessLevelSummary(db, levelId, now)! },
    };
  });
}

/**
 * Put an integration on a level, or take it off every level.
 *
 * Only an integration is put on a level: the operator's own devices read the
 * corpus directly, and an integration's tokens are answer-bounded by its kind,
 * so its level is the whole of what it can read. The level must be live and
 * able to release answers today, the same bar an execution-bound sign-in must
 * clear. Taking an integration off a level always succeeds — it is then
 * answered nothing — and a revoked device is otherwise treated as absent.
 */
export function setDeviceLevel(
  db: Db,
  input: AccessDeviceLevelInput,
  now = Date.now(),
): AccessMutationResult<AccessDeviceLevelResult> {
  return inLevelTransaction(db, (): AccessMutationResult<AccessDeviceLevelResult> => {
    const device = db
      .prepare<
        [string],
        { name: string; kind: string; revoked_at: number | null; access_level_id: string | null }
      >("SELECT name, kind, revoked_at, access_level_id FROM devices WHERE id = ?")
      .get(input.deviceId);
    if (!device) return { ok: false, error: "not-found" };
    if (input.levelId !== null) {
      if (device.revoked_at !== null) return { ok: false, error: "not-found" };
      if (device.kind !== "integration") return { ok: false, error: "device-not-integration" };
      const level = getLiveLevelRow(db, input.levelId);
      if (!level) return { ok: false, error: "inactive-grant" };
      if (
        input.expectedLevelRevision !== undefined &&
        level.revision !== input.expectedLevelRevision
      ) {
        return { ok: false, error: "stale-revision" };
      }
      if (!levelHasUsableAnswer(db, level.id)) return { ok: false, error: "invalid-selection" };
      markLevelChosen(db, level.id);
    }
    if (device.access_level_id !== input.levelId) {
      db.prepare("UPDATE devices SET access_level_id = ? WHERE id = ?").run(
        input.levelId,
        input.deviceId,
      );
      appendAudit(db, {
        eventType: "device-level-changed",
        actorTokenId: input.actorTokenId,
        detail: {
          deviceId: input.deviceId,
          deviceName: device.name,
          levelId: input.levelId,
          previousLevelId: device.access_level_id,
        },
        now,
      });
    }
    return {
      ok: true,
      value: {
        deviceId: input.deviceId,
        level: input.levelId === null ? null : loadAccessLevelSummary(db, input.levelId, now),
      },
    };
  });
}

/**
 * Edit one connection's rules. A connection carries its level's rules, so
 * the edit is applied to the level — which is only allowed while this
 * connection is the level's one live user. With others on the level, or no
 * level to edit, the edit is refused as `level-managed`.
 */
export function updateAccessGrant(
  db: Db,
  input: AccessGrantUpdateInput,
  now = Date.now(),
): AccessMutationResult<AccessGrantUpdateResult> {
  let rules: StoredGrantRules;
  try {
    rules = normalizeGrantRules(input.rules);
  } catch {
    return { ok: false, error: "invalid-selection" };
  }
  return inLevelTransaction(db, (): AccessMutationResult<AccessGrantUpdateResult> => {
    const grant = getActiveGrant(db, input.grantId, now);
    if (!grant) return { ok: false, error: "inactive-grant" };
    if (grant.revision !== input.expectedRevision) {
      return { ok: false, error: "stale-revision" };
    }
    const level = grant.level_id === null ? null : getLiveLevelRow(db, grant.level_id);
    const members = level ? liveLevelMemberGrantIds(db, level.id, now) : [];
    if (!level || members.length !== 1 || members[0] !== grant.id) {
      return { ok: false, error: "level-managed" };
    }
    if (applyLevelRules(db, level, rules, input.actorTokenId, now)) {
      advanceLevel(db, level, level.name, input.actorTokenId, now, rules);
    }
    return {
      ok: true,
      value: {
        grantId: grant.id,
        revision: getActiveGrant(db, grant.id, now)!.revision,
        capabilities: getGrantCapabilities(db, grant.id),
      },
    };
  });
}

/**
 * Store `rules` on a level and carry them to its live members. Returns
 * whether anything changed; throws to roll the transaction back when a
 * member refuses them.
 */
function applyLevelRules(
  db: Db,
  level: AccessLevelRow,
  rules: StoredGrantRules,
  actorTokenId: string,
  now: number,
): boolean {
  const previous = getLevelCapabilities(db, level.id);
  try {
    validateRetainingPrevious(db, rules, previous);
  } catch {
    throw new LevelChangeRefusedError("invalid-selection");
  }
  if (JSON.stringify(storedRuleShape(previous)) === JSON.stringify(rules)) return false;
  // A device asks the level for answers and nothing else: rules without Answer
  // would leave it with no way to ask, so they wait until it is moved off.
  if (
    !rules.some((rule) => rule.capability === "answer") &&
    liveLevelDevices(db, level.id).size > 0
  ) {
    throw new LevelChangeRefusedError("level-in-use");
  }
  writeLevelCapabilities(db, level.id, rules);
  for (const grantId of liveLevelMemberGrantIds(db, level.id, now)) {
    const member = getActiveGrant(db, grantId, now);
    if (!member) continue;
    const applied = replaceGrantRules(db, member, rules, actorTokenId, now, previous);
    if (!applied.ok) throw new LevelChangeRefusedError(applied.error);
  }
  return true;
}

/** A rule may keep naming a source the level already named, even after it has gone. */
function validateRetainingPrevious(
  db: Db,
  rules: StoredGrantRules,
  previous: readonly AccessGrantCapability[],
): void {
  for (const rule of rules) {
    const retained = previous.find(
      (candidate) =>
        candidate.capability === rule.capability && candidate.sourceMode === rule.sourceMode,
    );
    validateGrantRuleReferences(db, [rule], new Set(retained?.sourceIds ?? []));
  }
}

/**
 * Gives an active grant a new set of rules, advancing its revision — unless
 * the rules are the ones it already has, which leaves it untouched. Runs
 * inside the caller's transaction against the grant row the caller just read,
 * so a concurrent edit that moved the revision on is refused as stale.
 *
 * A rule may keep naming a source that has since gone when the grant already
 * named it, or when `retained` — the level the rules come from — did.
 */
function replaceGrantRules(
  db: Db,
  grant: ActiveGrant,
  rules: StoredGrantRules,
  actorTokenId: string,
  now: number,
  retained: readonly AccessGrantCapability[] = [],
): AccessMutationResult<AccessGrantUpdateResult> {
  const current = getGrantCapabilities(db, grant.id);
  try {
    for (const rule of rules) {
      const kept = [...current, ...retained]
        .filter(
          (candidate) =>
            candidate.capability === rule.capability && candidate.sourceMode === rule.sourceMode,
        )
        .flatMap((candidate) => candidate.sourceIds);
      validateGrantRuleReferences(db, [rule], new Set(kept));
    }
  } catch {
    return { ok: false, error: "invalid-selection" };
  }
  const answer = rules.some((rule) => rule.capability === "answer");
  if (!answer && grantHasExecutionBoundSignIn(db, grant.id, now)) {
    return { ok: false, error: "invalid-selection" };
  }
  if (JSON.stringify(storedRuleShape(current)) === JSON.stringify(rules)) {
    return {
      ok: true,
      value: { grantId: grant.id, revision: grant.revision, capabilities: current },
    };
  }
  const revision = grant.revision + 1;
  const advanced = db
    .prepare(
      `UPDATE access_grants SET revision = ?, updated_at = ?
       WHERE id = ? AND revision = ? AND revoked_at IS NULL`,
    )
    .run(revision, now, grant.id, grant.revision);
  if (advanced.changes !== 1) return { ok: false, error: "stale-revision" };
  db.prepare("DELETE FROM access_grant_capabilities WHERE grant_id = ?").run(grant.id);
  const insert = db.prepare(
    `INSERT INTO access_grant_capabilities
       (grant_id, capability, source_mode, source_ids, release_mode, policy_family_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const rule of rules) {
    insert.run(
      grant.id,
      rule.capability,
      rule.sourceMode,
      JSON.stringify(rule.sourceIds),
      rule.releaseMode,
      rule.policyFamilyId,
    );
  }
  const updatedCapabilities = getGrantCapabilities(db, grant.id);
  appendAudit(db, {
    eventType: "grant-updated",
    principalId: grant.principal_id,
    grantId: grant.id,
    grantRevision: revision,
    actorTokenId,
    detail: { rules },
    now,
  });
  return {
    ok: true,
    value: { grantId: grant.id, revision, capabilities: updatedCapabilities },
  };
}

/**
 * Put an integration being paired on the level its pairing code carries, in
 * the redemption's transaction. A level that has since gone or lost Answer is
 * not bound: the integration then starts on none and is answered nothing until
 * the operator chooses again.
 */
export function putPairedIntegrationOnLevel(
  db: Db,
  deviceId: string,
  levelId: string,
  now: number,
): void {
  const previous = db
    .prepare<
      [string],
      { access_level_id: string | null }
    >("SELECT access_level_id FROM devices WHERE id = ?")
    .get(deviceId);
  if (!previous || previous.access_level_id === levelId) return;
  if (!getLiveLevelRow(db, levelId) || !levelHasUsableAnswer(db, levelId)) return;
  markLevelChosen(db, levelId);
  db.prepare("UPDATE devices SET access_level_id = ? WHERE id = ?").run(levelId, deviceId);
  appendAudit(db, {
    eventType: "device-level-changed",
    detail: { deviceId, levelId, previousLevelId: previous.access_level_id, viaPairing: true },
    now,
  });
}

/** Whether a live sign-in on the grant is bound to an execution device. */
function grantHasExecutionBoundSignIn(db: Db, grantId: string, now: number): boolean {
  return (
    db
      .prepare<[string, number], { present: number }>(
        `SELECT 1 AS present FROM principal_credentials
         WHERE grant_id = ? AND execution_device_id IS NOT NULL
           AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
         LIMIT 1`,
      )
      .get(grantId, now) !== undefined
  );
}

function advanceLevel(
  db: Db,
  level: AccessLevelRow,
  name: string,
  actorTokenId: string,
  now: number,
  rules: StoredGrantRules | undefined,
): void {
  const advanced = db
    .prepare(
      `UPDATE access_levels SET name = ?, revision = revision + 1, updated_at = ?
        WHERE id = ? AND revision = ? AND revoked_at IS NULL`,
    )
    .run(name, now, level.id, level.revision);
  if (advanced.changes !== 1) throw new LevelChangeRefusedError("stale-revision");
  markLevelChosen(db, level.id);
  appendAudit(db, {
    eventType: "level-updated",
    actorTokenId,
    detail: {
      levelId: level.id,
      revision: level.revision + 1,
      ...(name !== level.name ? { previousName: level.name, name } : {}),
      ...(rules ? { rules } : {}),
    },
    now,
  });
}

/**
 * Run a level write in one transaction. A refusal thrown from inside rolls
 * every member write back; a concurrent writer that took the level's name
 * between the check and the write is refused the same way.
 */
function inLevelTransaction<T>(
  db: Db,
  body: () => AccessMutationResult<T>,
): AccessMutationResult<T> {
  try {
    return db.transaction(body)();
  } catch (error) {
    if (error instanceof LevelChangeRefusedError) return { ok: false, error: error.code };
    if (isLevelNameConflict(error)) return { ok: false, error: "level-name-taken" };
    throw error;
  }
}
