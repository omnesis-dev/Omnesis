// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { scopeMembershipRebuildCodec } from "../data/json-columns.js";
import {
  withNativeScopePublication,
  publishNativeScopeWitnesses,
} from "./scope-native-witnesses.js";
import {
  completeConversationMembers,
  conversationMemberWork,
  SCOPE_MEMBERSHIP_WRITE_BUDGET,
  writeConversationMember,
} from "./scope-conversation-members.js";
import type { ScopeMembershipMember } from "./scope-conversation-members.js";
import type { Db } from "../data/types.js";

export interface ConversationRebuildContext {
  sourceId: string;
  providerId: string;
  streamId: string;
  authorityId?: string;
  writeEpoch?: number;
  snapshotAuthority?: boolean;
  legacyOnly?: boolean;
}
export function hasSubjectConversationRebuild(db: Db, subject: string): boolean {
  return !!db
    .prepare("SELECT 1 FROM scope_conversation_rebuilds WHERE subject_document_id=? LIMIT 1")
    .get(subject);
}
export function queueConversationRebuild(
  db: Db,
  context: ConversationRebuildContext,
  subject: string,
  members: ScopeMembershipMember[],
  mode: "snapshot" | "observed",
  authoritative: boolean,
): void {
  const json = scopeMembershipRebuildCodec.serialize(members);
  const id = createHash("sha256").update(`${subject}:${mode}:${json}`).digest("hex");
  if (mode === "snapshot")
    db.prepare(
      "DELETE FROM scope_conversation_rebuilds WHERE subject_document_id=? AND operation_id<>?",
    ).run(subject, id);
  db.prepare(
    `INSERT INTO scope_conversation_rebuilds(operation_id,subject_document_id,members_json,mode,phase,authority_required,authority_id,write_epoch)
    VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(operation_id) DO UPDATE SET members_json=excluded.members_json,authority_id=excluded.authority_id,write_epoch=excluded.write_epoch`,
  ).run(
    id,
    subject,
    json,
    mode,
    mode === "snapshot" ? "members" : "insert",
    +authoritative,
    context.authorityId ?? null,
    context.writeEpoch ?? null,
  );
  db.prepare(
    "DELETE FROM document_scope_completeness WHERE document_id=? AND kind='participant'",
  ).run(subject);
}
export function retagConversationRebuild(
  db: Db,
  context: ConversationRebuildContext,
  subject: string,
  members: ScopeMembershipMember[],
  mode: "snapshot" | "observed",
): void {
  const json = scopeMembershipRebuildCodec.serialize(members);
  const id = createHash("sha256").update(`${subject}:${mode}:${json}`).digest("hex");
  db.prepare(
    "UPDATE scope_conversation_rebuilds SET authority_id=?,write_epoch=? WHERE operation_id=? AND subject_document_id=? AND authority_required=1",
  ).run(context.authorityId ?? null, context.writeEpoch ?? null, id, subject);
}
function pending(db: Db, context: ConversationRebuildContext) {
  return db
    .prepare<
      [string, string, string, number, string | null, number | null],
      {
        operation_id: string;
        subject_document_id: string;
        members_json: string;
        phase: "members" | "facts" | "counts" | "insert";
        next_member: number;
      }
    >(
      `
    SELECT p.operation_id,p.subject_document_id,p.members_json,p.phase,p.next_member FROM scope_conversation_rebuilds p
    JOIN scope_conversations c ON c.subject_document_id=p.subject_document_id WHERE c.source_id=? AND c.provider_id=? AND c.stream_id=?
      AND (p.authority_required=0 OR (?=0 AND p.authority_id IS ? AND p.write_epoch IS ?)) ORDER BY p.operation_id LIMIT 1`,
    )
    .get(
      context.sourceId,
      context.providerId,
      context.streamId,
      context.legacyOnly ? 1 : 0,
      context.authorityId ?? null,
      context.writeEpoch ?? null,
    );
}
export function hasConversationScopeRebuilds(db: Db, context: ConversationRebuildContext): boolean {
  return !!pending(db, context);
}

/** One bounded physical transaction; a pending source never has complete participant facts. */
export function drainConversationScopeRebuilds(
  db: Db,
  context: ConversationRebuildContext,
  budget = SCOPE_MEMBERSHIP_WRITE_BUDGET,
): { processed: number; pending: boolean } {
  if (!Number.isInteger(budget) || budget < 1 || budget > SCOPE_MEMBERSHIP_WRITE_BUDGET)
    throw new Error("Invalid membership write budget.");
  return db.transaction(() => {
    let processed = 0;
    while (processed < budget) {
      const work = pending(db, context);
      if (!work) break;
      const stop = withNativeScopePublication(db, work.subject_document_id, () => {
        if (work.phase !== "insert") {
          const table =
            work.phase === "members"
              ? "scope_conversation_members"
              : work.phase === "facts"
                ? "document_scope_facts"
                : "scope_conversation_identifier_counts";
          const owner = work.phase === "facts" ? "document_id" : "subject_document_id";
          const key = work.phase === "members" ? "member_key" : "entity_id";
          const remainingBudget = budget - processed;
          const keys = db
            .prepare<[string, number], { key: string }>(
              `SELECT ${key} AS key FROM ${table} WHERE ${owner}=?${work.phase === "facts" ? " AND kind='participant'" : ""} LIMIT ?`,
            )
            .all(work.subject_document_id, budget - processed);
          const remove = db.prepare(
            `DELETE FROM ${table} WHERE ${owner}=? AND ${key}=?${work.phase === "facts" ? " AND kind='participant'" : ""}`,
          );
          for (const row of keys) remove.run(work.subject_document_id, row.key);
          processed += keys.length;
          if (keys.length < remainingBudget) {
            const phase =
              work.phase === "members" ? "facts" : work.phase === "facts" ? "counts" : "insert";
            db.prepare("UPDATE scope_conversation_rebuilds SET phase=? WHERE operation_id=?").run(
              phase,
              work.operation_id,
            );
          }
          return false;
        }
        const members = scopeMembershipRebuildCodec.parse(work.members_json, {
          rowId: work.operation_id,
        });
        let index = work.next_member;
        while (index < members.length) {
          const member = members[index]!;
          const cost = conversationMemberWork(db, work.subject_document_id, member);
          if (processed > 0 && processed + cost > budget) break;
          writeConversationMember(db, work.subject_document_id, member);
          processed += cost;
          index += 1;
          if (processed >= budget) break;
        }
        if (index === members.length) {
          db.prepare("DELETE FROM scope_conversation_rebuilds WHERE operation_id=?").run(
            work.operation_id,
          );
          completeConversationMembers(db, work.subject_document_id);
          publishNativeScopeWitnesses(db, work.subject_document_id);
        } else {
          db.prepare(
            "UPDATE scope_conversation_rebuilds SET next_member=? WHERE operation_id=?",
          ).run(index, work.operation_id);
          // Yield a remainder that cannot fit the next whole member.
          if (
            processed > 0 &&
            processed + conversationMemberWork(db, work.subject_document_id, members[index]!) >
              budget
          )
            return true;
        }
        return false;
      });
      if (stop) break;
    }
    return { processed, pending: hasConversationScopeRebuilds(db, context) };
  })();
}

/** Corpus backfill may finish original metadata observations, never a stale native lease snapshot. */
export function drainLegacyConversationScopeRebuilds(
  db: Db,
  budget = SCOPE_MEMBERSHIP_WRITE_BUDGET,
): { processed: number; pending: boolean } {
  const context = db
    .prepare<[], { sourceId: string; providerId: string; streamId: string }>(
      `SELECT c.source_id AS sourceId,c.provider_id AS providerId,c.stream_id AS streamId
    FROM scope_conversation_rebuilds p JOIN scope_conversations c ON c.subject_document_id=p.subject_document_id
    WHERE p.authority_required=0 ORDER BY p.operation_id LIMIT 1`,
    )
    .get();
  return context
    ? drainConversationScopeRebuilds(db, { ...context, legacyOnly: true }, budget)
    : { processed: 0, pending: false };
}
export function hasLegacyConversationScopeRebuilds(db: Db, sourceId: string): boolean {
  return !!db
    .prepare(
      `SELECT 1 FROM scope_conversation_rebuilds p JOIN scope_conversations c ON c.subject_document_id=p.subject_document_id
    WHERE p.authority_required=0 AND c.source_id=? LIMIT 1`,
    )
    .get(sourceId);
}
