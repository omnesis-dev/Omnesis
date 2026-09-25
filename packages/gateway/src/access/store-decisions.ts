// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { assertNever } from "@omnesis/core";

import { findDeviceBoundSignIn } from "./store-connections.js";
import { getConnectionGrant } from "./store-levels.js";
import { getLiveLevelRow } from "./store-level-summaries.js";
import { appendAudit, type AuthorizationRequestRow, getActiveGrant } from "./store-helpers.js";
import {
  connectionGrantName,
  createGrantOnLevel,
  grantHasUsableAnswer,
  insertLevel,
  isLevelNameConflict,
  levelHasUsableAnswer,
  levelNameTaken,
  markLevelChosen,
  uniqueLiveName,
} from "./store-level-writes.js";
import {
  normalizeGrantRules,
  readLevelRuleInputs,
  type StoredGrantRules,
  validateGrantRuleReferences,
} from "./store-rules.js";
import type { Db } from "../data/types.js";
import type { AccessMutationError } from "./store-contracts.js";
import type {
  AccessGrantRuleInput,
  AuthorizationDecisionSelection,
  StoredAuthorizationGrantSelection,
} from "./types.js";

/**
 * How an approver's decision becomes rows: the connection choices resolve to
 * the primitive a request stores, the primitive creates or finds its grant,
 * and a recorded replacement retires the sign-ins it replaces once it is
 * redeemed. Everything here runs inside the decision's or the code
 * exchange's writer transaction.
 */

/** Thrown inside the decision transaction to roll it back with a refusal. */
export class DecisionRefusedError extends Error {
  constructor(readonly code: AccessMutationError) {
    super(code);
  }
}

const CREDENTIAL_LABEL_MAX = 160;

interface ResolvedDecision {
  primitive: StoredAuthorizationGrantSelection;
  /** The level a new grant lands on, when the decision settled it. */
  levelId?: string;
  /** A level this decision created, which an abandoned approval retires. */
  createdLevelId?: string;
}

/**
 * Turns an approver's choice into the primitive the request stores. A new
 * connection always gets a principal and grant of its own, on a new level
 * made from its rules or on an existing level whose rules it takes; a
 * replacement adds a sign-in to the chosen connection's grant and is recorded
 * so that sign-in, once used, retires the others. An older client's `connect`
 * is a replacement when a live sign-in is bound to the request's execution
 * device — a managed integration signing in again on the same machine — and
 * a new connection on a new level otherwise. Primitives pass through.
 */
export function resolveDecision(
  db: Db,
  row: AuthorizationRequestRow,
  selection: AuthorizationDecisionSelection,
  actorTokenId: string,
  now: number,
): ResolvedDecision {
  switch (selection.kind) {
    case "connect": {
      const bound =
        row.execution_device_id === null
          ? undefined
          : findDeviceBoundSignIn(db, row.execution_device_id, now);
      const boundGrant = bound ? getConnectionGrant(db, bound.principal_id, now) : null;
      if (boundGrant) return replacement(db, row, boundGrant);
      const name = uniqueLiveName(db, "access_principals", row.client_name);
      const levelId = createDecisionLevel(
        db,
        row,
        uniqueLiveName(db, "access_levels", row.client_name),
        selection.rules,
        actorTokenId,
        now,
      );
      const label =
        (selection.credentialLabel ?? name).trim().slice(0, CREDENTIAL_LABEL_MAX).trim() || name;
      return { ...newConnection(db, name, levelId, label), createdLevelId: levelId };
    }
    case "new-connection": {
      const name = selection.name.trim();
      if (selection.level.kind === "new") {
        if (levelNameTaken(db, selection.level.name)) {
          throw new DecisionRefusedError("level-name-taken");
        }
        const levelId = createDecisionLevel(
          db,
          row,
          selection.level.name,
          selection.level.rules,
          actorTokenId,
          now,
        );
        return { ...newConnection(db, name, levelId, name), createdLevelId: levelId };
      }
      const level = getLiveLevelRow(db, selection.level.levelId);
      if (!level) throw new DecisionRefusedError("inactive-grant");
      if (level.revision !== selection.level.expectedLevelRevision) {
        throw new DecisionRefusedError("stale-revision");
      }
      if (row.execution_device_id !== null && !levelHasUsableAnswer(db, level.id)) {
        throw new DecisionRefusedError("invalid-selection");
      }
      markLevelChosen(db, level.id);
      return newConnection(db, name, level.id, name);
    }
    case "replace-connection": {
      const grant = getConnectionGrant(db, selection.connectionId, now);
      if (!grant) throw new DecisionRefusedError("inactive-grant");
      if (grant.revision !== selection.expectedGrantRevision) {
        throw new DecisionRefusedError("stale-revision");
      }
      return replacement(db, row, grant);
    }
    case "new-principal":
    case "new-grant":
    case "existing-grant":
      return { primitive: selection };
    default:
      return assertNever(selection);
  }
}

/** Whether a primitive leaves its sign-in with Answer it can use today. */
export function selectionHasUsableAnswer(
  db: Db,
  selection: StoredAuthorizationGrantSelection,
): boolean {
  if (selection.kind !== "existing-grant") {
    return selection.rules.some((rule) => rule.capability === "answer");
  }
  return grantHasUsableAnswer(db, selection.grantId);
}

function replacement(
  db: Db,
  row: AuthorizationRequestRow,
  grant: NonNullable<ReturnType<typeof getActiveGrant>>,
): ResolvedDecision {
  if (row.execution_device_id !== null && !grantHasUsableAnswer(db, grant.id)) {
    throw new DecisionRefusedError("invalid-selection");
  }
  return {
    primitive: {
      kind: "existing-grant",
      grantId: grant.id,
      credentialLabel: connectionName(db, grant.principal_id).slice(0, CREDENTIAL_LABEL_MAX),
      replaces: true,
    },
  };
}

/**
 * A level made for this decision from the approver's rules. An
 * execution-bound request needs Answer it can use on the level it lands on,
 * the same test an existing level passes.
 */
function createDecisionLevel(
  db: Db,
  row: AuthorizationRequestRow,
  name: string,
  suppliedRules: readonly AccessGrantRuleInput[],
  actorTokenId: string,
  now: number,
): string {
  let rules: StoredGrantRules;
  try {
    rules = normalizeGrantRules(suppliedRules);
    validateGrantRuleReferences(db, rules);
  } catch {
    throw new DecisionRefusedError("invalid-selection");
  }
  let levelId: string;
  try {
    levelId = insertLevel(db, name, rules, actorTokenId, now).id;
  } catch (error) {
    if (isLevelNameConflict(error)) throw new DecisionRefusedError("level-name-taken");
    throw error;
  }
  if (row.execution_device_id !== null && !levelHasUsableAnswer(db, levelId)) {
    throw new DecisionRefusedError("invalid-selection");
  }
  return levelId;
}

/**
 * A new connection on `levelId`. The stored primitive records the level's
 * rules as its rows hold them; a level with no rules to record cannot carry a
 * connection.
 */
function newConnection(
  db: Db,
  name: string,
  levelId: string,
  credentialLabel: string,
): ResolvedDecision & { levelId: string } {
  const rules = readLevelRuleInputs(db, levelId);
  if (rules.length === 0) throw new DecisionRefusedError("invalid-selection");
  return {
    levelId,
    primitive: {
      kind: "new-principal",
      principalName: name,
      grantName: connectionGrantName(name),
      rules,
      credentialLabel,
      expiresAt: null,
    },
  };
}

function connectionName(db: Db, principalId: string): string {
  return (
    db
      .prepare<[string], { name: string }>("SELECT name FROM access_principals WHERE id = ?")
      .get(principalId)?.name ?? ""
  );
}

/**
 * Create or find the grant a primitive names. A new grant always lands on an
 * access level: `levelId` when the decision settled one (its capabilities are
 * copied onto the grant), otherwise a new level named after the principal
 * carrying the primitive's rules, which is reported as created.
 */
export function resolveSelection(
  db: Db,
  selection: StoredAuthorizationGrantSelection,
  now: number,
  options: { levelId?: string; actorTokenId?: string } = {},
): {
  principalId: string;
  grantId: string;
  grantRevision: number;
  expiresAt: number | null;
  createdLevelId?: string;
} | null {
  if (selection.kind === "existing-grant") {
    const grant = getActiveGrant(db, selection.grantId, now);
    return grant?.principal_kind === "interactive"
      ? {
          principalId: grant.principal_id,
          grantId: grant.id,
          grantRevision: grant.revision,
          expiresAt: grant.expires_at,
        }
      : null;
  }
  let principalId: string;
  let principalName: string;
  if (selection.kind === "new-principal") {
    principalName = selection.principalName.trim();
    principalId = createPrincipal(db, principalName, now);
  } else {
    const principal = db
      .prepare<
        [string],
        { id: string; name: string; kind: string; revoked_at: number | null }
      >("SELECT id, name, kind, revoked_at FROM access_principals WHERE id = ?")
      .get(selection.principalId);
    if (!principal || principal.kind !== "interactive" || principal.revoked_at !== null) {
      return null;
    }
    principalId = principal.id;
    principalName = principal.name;
  }
  let levelId = options.levelId;
  let createdLevelId: string | undefined;
  if (levelId === undefined) {
    const rules = normalizeGrantRules(selection.rules);
    validateGrantRuleReferences(db, rules);
    levelId = insertLevel(
      db,
      uniqueLiveName(db, "access_levels", principalName),
      rules,
      options.actorTokenId ?? null,
      now,
    ).id;
    createdLevelId = levelId;
  }
  const grant = createGrantOnLevel(
    db,
    principalId,
    selection.grantName,
    levelId,
    selection.expiresAt,
    now,
  );
  return {
    principalId,
    grantId: grant.id,
    grantRevision: grant.revision,
    expiresAt: selection.expiresAt,
    ...(createdLevelId ? { createdLevelId } : {}),
  };
}

function createPrincipal(db: Db, name: string, now: number): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO access_principals (id, name, kind, created_at, updated_at)
     VALUES (?, ?, 'interactive', ?, ?)`,
  ).run(id, name.trim(), now, now);
  return id;
}

/**
 * A replacement sign-in has just been redeemed: every other active sign-in of
 * its connection stops working, in the same transaction that activated it,
 * each with its own revocation audit naming the sign-in that replaced it. A
 * sign-in still waiting for its own code is left to complete or lapse.
 */
export function retireReplacedSignIns(
  db: Db,
  input: {
    grant: NonNullable<ReturnType<typeof getActiveGrant>>;
    credentialId: string;
    row: AuthorizationRequestRow;
    now: number;
  },
): void {
  const replaced = db
    .prepare<[string, string], { id: string; oauth_client_id: string }>(
      `SELECT id, oauth_client_id FROM principal_credentials
        WHERE grant_id = ? AND id <> ? AND status = 'active' AND revoked_at IS NULL`,
    )
    .all(input.grant.id, input.credentialId);
  const revoke = db.prepare(
    "UPDATE principal_credentials SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
  );
  for (const credential of replaced) {
    revoke.run(input.now, credential.id);
    appendAudit(db, {
      eventType: "credential-revoked",
      principalId: input.grant.principal_id,
      grantId: input.grant.id,
      grantRevision: input.grant.revision,
      credentialId: credential.id,
      oauthClientId: credential.oauth_client_id,
      actorTokenId: input.row.decision_token_id,
      detail: { replacedByCredentialId: input.credentialId },
      now: input.now,
    });
  }
}
