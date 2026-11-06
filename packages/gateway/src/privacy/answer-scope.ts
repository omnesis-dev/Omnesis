// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  parseCorpusAuthorization,
  createCorpusAuthorization,
  externalAnswerOwnerId,
  type CorpusAuthorizationIdentity,
  type CorpusAuthorization,
} from "../access/corpus-authorization.js";
import { authorizedDocumentInclusionSql } from "../access/document-inclusion.js";
import { getGrantCapabilities } from "../access/store-rules.js";
import { resolveDeviceAnswerScope } from "../access/device-answer-scope.js";
import {
  corpusAuthorizationIsLive,
  corpusAuthorizationBindingIsLive,
} from "../access/authorization-live.js";
import {
  changedScopeSources,
  readScopeSourceGenerations,
  type ScopeSourceGeneration,
} from "../access/scope-generations.js";
import { tokenAnswerOwnerId, tokenIdOfAnswerOwner } from "./token-answer-owner.js";
import { AnswerStoreError, type PrivacyDb } from "./store-types.js";

export const MAX_ANSWER_SCOPE_DOCUMENTS = 8192;

export interface AnswerScopeReadSet {
  documentIds: string[];
  complete: boolean;
}

/** Trusted input provenance recorded before document content reaches an Answer model. */
export interface AnswerScopeReadObserver {
  recordDocuments(documentIds: readonly string[]): void;
  /** All prompt and tool document reads participate in this observer. */
  markComplete(): void;
  /** Recheck cumulative trusted input immediately before another model stage. */
  assertCurrent?(): void;
}

/** Overflow or inherited incomplete provenance can never be blessed by a later tool setup. */
export function createAnswerScopeReadObserver(assertCurrent?: () => void) {
  const ids = new Set<string>();
  let complete = false;
  let incomplete = false;
  const observer: AnswerScopeReadObserver & {
    inherit(reads: AnswerScopeReadSet): void;
    snapshot(): AnswerScopeReadSet;
  } = {
    recordDocuments(documentIds) {
      for (const id of documentIds) {
        if (ids.has(id)) continue;
        if (ids.size === MAX_ANSWER_SCOPE_DOCUMENTS) {
          incomplete = true;
          complete = false;
          continue;
        }
        ids.add(id);
      }
      if (complete) assertCurrent?.();
    },
    markComplete() {
      if (!incomplete) complete = true;
    },
    assertCurrent() {
      assertCurrent?.();
    },
    inherit(reads) {
      observer.recordDocuments(reads.documentIds);
      if (!reads.complete) {
        incomplete = true;
        complete = false;
      }
    },
    snapshot() {
      return { documentIds: [...ids], complete: complete && !incomplete };
    },
  };
  return observer;
}

/** Legacy missing-proof classification resolves only the task's current binding, never task history. */
export function answerTaskRequiresScopeProof(db: PrivacyDb, taskId: string): boolean {
  const owner = db
    .prepare<[string], { owner_id: string }>("SELECT owner_id FROM answer_tasks WHERE id=?")
    .get(taskId)?.owner_id;
  if (!owner || !owner.includes(":answer-scope:")) return false;
  const tokenId = tokenIdOfAnswerOwner(owner);
  if (tokenId) {
    const token = db
      .prepare<[string], { device_id: string }>("SELECT device_id FROM tokens WHERE id=?")
      .get(tokenId);
    if (!token) return false;
    const scope = resolveDeviceAnswerScope(db, token.device_id, tokenId);
    return (
      scope.kind === "level" &&
      !!scope.authorization.scopePolicies.length &&
      tokenAnswerOwnerId(tokenId, scope.authorization) === owner
    );
  }
  const match = /^principal:([^:]+):grant:([^:]+):credential:([^:]+):answer-scope:[^:]+$/.exec(
    owner,
  );
  if (!match) return false;
  const row = db
    .prepare<[string, string, string], { revision: number }>(
      "SELECT g.revision FROM access_grants g JOIN principal_credentials c ON c.grant_id=g.id WHERE g.id=? AND g.principal_id=? AND c.id=?",
    )
    .get(match[2]!, match[1]!, match[3]!);
  if (!row) return false;
  const current = createCorpusAuthorization(
    {
      principalId: match[1]!,
      grantId: match[2]!,
      credentialId: match[3]!,
      grantRevision: row.revision,
      accessTokenId: "legacy-proof-check",
    },
    getGrantCapabilities(db, match[2]!),
    "answer",
  );
  return !!current?.scopePolicies.length && externalAnswerOwnerId(current) === owner;
}

export function beginAnswerTaskScope(db: PrivacyDb, taskId: string, serialized?: string): void {
  db.prepare("DELETE FROM answer_task_scope_documents WHERE task_id=?").run(taskId);
  db.prepare("DELETE FROM answer_task_scope WHERE task_id=?").run(taskId);
  if (!serialized) return;
  const authorization = parseCorpusAuthorization(serialized);
  if (authorization.capability !== "answer" || !authorization.scopePolicies.length)
    throw new Error("Invalid filtered Answer task authority.");
  db.prepare(
    "INSERT INTO answer_task_scope(task_id,authorization,fallback_generations) VALUES(?,?,?)",
  ).run(
    taskId,
    serialized,
    JSON.stringify(
      readScopeSourceGenerations(
        db,
        authorization.scopePolicies.map((p) => p.sourceId),
      ),
    ),
  );
}

export function saveAnswerTaskScopeReads(
  db: PrivacyDb,
  taskId: string,
  reads?: AnswerScopeReadSet,
): void {
  if (!db.prepare("SELECT 1 FROM answer_task_scope WHERE task_id=?").get(taskId)) return;
  if (!reads) return;
  if (
    !Array.isArray(reads.documentIds) ||
    reads.documentIds.length > MAX_ANSWER_SCOPE_DOCUMENTS ||
    !reads.documentIds.every((id) => typeof id === "string" && id.length > 0) ||
    typeof reads.complete !== "boolean"
  )
    throw new Error("Invalid Answer document provenance.");
  db.prepare("DELETE FROM answer_task_scope_documents WHERE task_id=?").run(taskId);
  db.prepare(
    "INSERT OR IGNORE INTO answer_task_scope_documents SELECT ?,value FROM json_each(?)",
  ).run(taskId, JSON.stringify(reads.documentIds));
  db.prepare("UPDATE answer_task_scope SET complete=? WHERE task_id=?").run(
    reads.complete ? 1 : 0,
    taskId,
  );
}

export function assertScopeDocumentsCurrent(
  db: PrivacyDb,
  authorization: CorpusAuthorization,
  documentIds: readonly string[],
): void {
  if (!authorization.scopePolicies.length || !documentIds.length) return;
  const inclusion = authorizedDocumentInclusionSql(db, authorization);
  const count =
    db
      .prepare<unknown[], { count: number }>(
        `SELECT COUNT(*) AS count FROM documents d
    WHERE d.id IN (SELECT value FROM json_each(?)) AND (${inclusion.sql})`,
      )
      .get(JSON.stringify([...new Set(documentIds)]), ...inclusion.params)?.count ?? 0;
  if (count !== new Set(documentIds).size) throw scopeChanged();
}

export interface ScopeReleaseCapture {
  observer: AnswerScopeReadObserver;
  assertCurrent(): void;
}

/** A final synchronous snapshot is the release decision after asynchronous audit work settles. */
export function createScopeReleaseCapture(
  db: PrivacyDb,
  authorization: CorpusAuthorization,
): ScopeReleaseCapture {
  const observer = createAnswerScopeReadObserver();
  const expected = readScopeSourceGenerations(
    db,
    authorization.scopePolicies.map((p) => p.sourceId),
  );
  return {
    observer,
    assertCurrent() {
      db.transaction(() => {
        const reads = observer.snapshot();
        assertScopeDocumentsCurrent(db, authorization, reads.documentIds);
        if (
          !reads.complete &&
          changedScopeSources(
            expected,
            readScopeSourceGenerations(
              db,
              authorization.scopePolicies.map((p) => p.sourceId),
            ),
          ).length
        )
          throw scopeChanged();
      })();
    },
  };
}

export function answerTaskScopeReads(db: PrivacyDb, taskId: string): AnswerScopeReadSet | null {
  const state = db
    .prepare<[string], { authorization: string; fallback_generations: string; complete: number }>(
      "SELECT * FROM answer_task_scope WHERE task_id=?",
    )
    .get(taskId);
  if (!state) {
    if (answerTaskRequiresScopeProof(db, taskId)) throw scopeChanged();
    return null;
  }
  const authorization = parseCorpusAuthorization(state.authorization);
  const documentIds = db
    .prepare<[string], { document_id: string }>(
      "SELECT document_id FROM answer_task_scope_documents WHERE task_id=?",
    )
    .all(taskId)
    .map((r) => r.document_id);
  assertScopeDocumentsCurrent(db, authorization, documentIds);
  if (!state.complete) {
    const expected = JSON.parse(state.fallback_generations) as ScopeSourceGeneration[];
    if (
      changedScopeSources(
        expected,
        readScopeSourceGenerations(
          db,
          authorization.scopePolicies.map((p) => p.sourceId),
        ),
      ).length
    )
      throw scopeChanged();
  }
  return { documentIds, complete: state.complete === 1 };
}

export function assertAnswerTaskScopeCurrent(db: PrivacyDb, taskId: string): void {
  answerTaskScopeReads(db, taskId);
}

export function assertAnswerTaskReleaseCurrent(
  db: PrivacyDb,
  taskId: string,
  currentIdentity?: CorpusAuthorizationIdentity,
): void {
  db.transaction(() => {
    assertAnswerTaskScopeCurrent(db, taskId);
    const state = db
      .prepare<[string], { authorization: string }>(
        "SELECT authorization FROM answer_task_scope WHERE task_id=?",
      )
      .get(taskId);
    if (state) {
      const saved = parseCorpusAuthorization(state.authorization);
      if (!corpusAuthorizationBindingIsLive(db, saved)) throw scopeChanged();
      if (
        currentIdentity &&
        (currentIdentity.principalId !== saved.principalId ||
          currentIdentity.grantId !== saved.grantId ||
          currentIdentity.credentialId !== saved.credentialId ||
          !corpusAuthorizationIsLive(db, {
            ...saved,
            principalId: currentIdentity.principalId,
            grantId: currentIdentity.grantId,
            grantRevision: currentIdentity.grantRevision,
            credentialId: currentIdentity.credentialId,
            accessTokenId: currentIdentity.accessTokenId,
          }))
      )
        throw scopeChanged();
    }
  })();
}

/** Recheck the in-flight trusted read-set before a candidate reaches another model stage. */
export function assertAnswerRunScopeCurrent(
  db: PrivacyDb,
  taskId: string,
  reads?: AnswerScopeReadSet,
): void {
  db.transaction(() => {
    const state = db
      .prepare<[string], { authorization: string }>(
        "SELECT authorization FROM answer_task_scope WHERE task_id=?",
      )
      .get(taskId);
    if (!state) {
      assertAnswerTaskScopeCurrent(db, taskId);
      return;
    }
    const authorization = parseCorpusAuthorization(state.authorization);
    if (!corpusAuthorizationBindingIsLive(db, authorization)) throw scopeChanged();
    if (reads) assertScopeDocumentsCurrent(db, authorization, reads.documentIds);
    if (!reads?.complete) assertAnswerTaskScopeCurrent(db, taskId);
  })();
}

export function scopeChanged(): AnswerStoreError {
  return new AnswerStoreError(
    "authority_changed",
    "Source access changed before this answer could be disclosed. Start a fresh request.",
  );
}

/** Commit stale approval cleanup without rolling it back by throwing from the transaction. */
export function invalidateStaleHeldAnswerTask(db: PrivacyDb, taskId: string, now: number): boolean {
  try {
    assertAnswerTaskScopeCurrent(db, taskId);
    return false;
  } catch (error) {
    if (!(error instanceof AnswerStoreError) || error.code !== "authority_changed") throw error;
    db.prepare(
      "UPDATE answer_approvals SET status='denied',candidate_answer=NULL,resolved_at=? WHERE task_id=? AND status='pending'",
    ).run(now, taskId);
    db.prepare(
      "UPDATE answer_tasks SET status='failed',candidate_answer=NULL,candidate_digest=NULL,resolved_at=? WHERE id=? AND status='approval_required'",
    ).run(now, taskId);
    db.prepare(
      "UPDATE answer_conversations SET active_task_id=NULL,updated_at=? WHERE active_task_id=?",
    ).run(now, taskId);
    return true;
  }
}
