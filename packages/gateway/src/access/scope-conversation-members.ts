// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { scopeMembershipIdentifiersCodec } from "../data/json-columns.js";
import type { NativeScopeParticipant } from "@omnesis/source-sdk";
import type { ScopeIdentifier } from "@omnesis/types";
import type { Db } from "../data/types.js";

export interface ScopeMembershipMember {
  key: string;
  identifiers: ScopeIdentifier[];
  complete: boolean;
  pinned: boolean;
}
export const SCOPE_MEMBERSHIP_WRITE_BUDGET = 128;
export function memberKeys(identifiers: readonly ScopeIdentifier[]): string[] {
  const keys = new Set<string>();
  for (const identifier of identifiers) {
    keys.add(`${identifier.type}:${identifier.value}`);
    if (identifier.type === "email")
      keys.add(`domain:${identifier.value.slice(identifier.value.lastIndexOf("@") + 1)}`);
  }
  return [...keys];
}
export function memberWork(member: Pick<ScopeMembershipMember, "identifiers">): number {
  return 1 + memberKeys(member.identifiers).length;
}
export function nativeMembers(
  participants: readonly NativeScopeParticipant[],
  origin: string,
  pinned: boolean,
): ScopeMembershipMember[] {
  const keyed = new Map<string, ScopeMembershipMember>();
  for (const [index, participant] of participants.entries()) {
    const key = participant.nativeKey ?? `unknown:${origin}:${index}`;
    const member = {
      key,
      identifiers: [...participant.identifiers].sort((a, b) =>
        `${a.type}:${a.value}` < `${b.type}:${b.value}` ? -1 : 1,
      ),
      complete: participant.complete,
      pinned,
    };
    const prior = keyed.get(key);
    if (
      prior &&
      scopeMembershipIdentifiersCodec.serialize(prior.identifiers) !==
        scopeMembershipIdentifiersCodec.serialize(member.identifiers)
    )
      keyed.set(key, { key, identifiers: [], complete: false, pinned: true });
    else if (!prior) keyed.set(key, member);
  }
  return [...keyed.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

export function conversationMemberWork(
  db: Db,
  subject: string,
  member: ScopeMembershipMember,
): number {
  const prior = db
    .prepare<[string, string], { identifiers_json: string }>(
      "SELECT identifiers_json FROM scope_conversation_members WHERE subject_document_id=? AND member_key=?",
    )
    .get(subject, member.key);
  return (
    memberWork(member) +
    (prior ? memberKeys(scopeMembershipIdentifiersCodec.parse(prior.identifiers_json)).length : 0)
  );
}

/** Work is proportional to one member's identifiers, never all days or all members. */
export function writeConversationMember(
  db: Db,
  subject: string,
  member: ScopeMembershipMember,
): boolean {
  const prior = db
    .prepare<[string, string], { identifiers_json: string; complete: number; pinned: number }>(
      "SELECT identifiers_json,complete,pinned FROM scope_conversation_members WHERE subject_document_id=? AND member_key=?",
    )
    .get(subject, member.key);
  if (!member.pinned && (prior?.pinned || (prior?.complete && !member.complete))) return false;
  let next = member;
  const oldIdentifiers = prior ? scopeMembershipIdentifiersCodec.parse(prior.identifiers_json) : [];
  let serialized = scopeMembershipIdentifiersCodec.serialize(next.identifiers);
  if (
    !member.pinned &&
    prior?.complete &&
    member.complete &&
    member.key.startsWith("lid:") &&
    prior.identifiers_json !== serialized
  ) {
    next = { ...member, identifiers: [], complete: false, pinned: true };
    serialized = "[]";
  }
  if (
    prior?.identifiers_json === serialized &&
    prior.complete === +next.complete &&
    prior.pinned === +next.pinned
  )
    return false;
  const oldKeys = new Set(memberKeys(oldIdentifiers));
  const newKeys = new Set(memberKeys(next.identifiers));
  for (const key of oldKeys) {
    if (newKeys.has(key)) continue;
    const count =
      db
        .prepare<[string, string], { contributions: number }>(
          "SELECT contributions FROM scope_conversation_identifier_counts WHERE subject_document_id=? AND entity_id=?",
        )
        .get(subject, key)?.contributions ?? 0;
    if (count > 1)
      db.prepare(
        "UPDATE scope_conversation_identifier_counts SET contributions=contributions-1 WHERE subject_document_id=? AND entity_id=?",
      ).run(subject, key);
    else {
      db.prepare(
        "DELETE FROM scope_conversation_identifier_counts WHERE subject_document_id=? AND entity_id=?",
      ).run(subject, key);
      db.prepare(
        "DELETE FROM document_scope_facts WHERE document_id=? AND kind='participant' AND entity_id=?",
      ).run(subject, key);
    }
  }
  for (const key of newKeys) {
    if (oldKeys.has(key)) continue;
    db.prepare(
      `INSERT INTO scope_conversation_identifier_counts VALUES(?,?,1) ON CONFLICT(subject_document_id,entity_id) DO UPDATE SET contributions=contributions+1`,
    ).run(subject, key);
    db.prepare("INSERT OR IGNORE INTO document_scope_facts VALUES(?,'participant',?)").run(
      subject,
      key,
    );
  }
  db.prepare(
    `INSERT INTO scope_conversation_members(subject_document_id,member_key,identifiers_json,complete,pinned) VALUES(?,?,?,?,?)
    ON CONFLICT(subject_document_id,member_key) DO UPDATE SET identifiers_json=excluded.identifiers_json,complete=excluded.complete,pinned=excluded.pinned`,
  ).run(subject, next.key, serialized, +next.complete, +next.pinned);
  return true;
}
export function completeConversationMembers(db: Db, subject: string): void {
  db.prepare(
    "DELETE FROM document_scope_completeness WHERE document_id=? AND kind='participant'",
  ).run(subject);
  db.prepare(
    `INSERT INTO document_scope_completeness(document_id,kind,complete)
    SELECT ?,'participant',1 WHERE EXISTS(SELECT 1 FROM scope_conversation_members WHERE subject_document_id=?)
      AND NOT EXISTS(SELECT 1 FROM scope_conversation_members WHERE subject_document_id=? AND complete=0)
      AND NOT EXISTS(SELECT 1 FROM scope_conversation_rebuilds WHERE subject_document_id=?)
      AND EXISTS(SELECT 1 FROM scope_conversations WHERE subject_document_id=? AND conflicted=0)`,
  ).run(subject, subject, subject, subject, subject);
}
