// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash, randomUUID } from "node:crypto";
import * as z from "zod/v4";
import { projectNativeScopeParticipants } from "@omnesis/source-sdk";
import {
  replaceNativeScopeKindWitness,
  clearNativeScopeWitnesses,
  withNativeScopePublication,
  publishNativeScopeWitnesses,
} from "./scope-native-witnesses.js";
import type { DocumentMetadata, SourceScopeConversationUpdate, SourceScopes } from "@omnesis/types";
import type { NativeScopeParticipant } from "@omnesis/source-sdk";
import {
  completeConversationMembers,
  conversationMemberWork,
  memberWork,
  nativeMembers,
  SCOPE_MEMBERSHIP_WRITE_BUDGET,
  writeConversationMember,
} from "./scope-conversation-members.js";
import {
  hasSubjectConversationRebuild,
  queueConversationRebuild,
  retagConversationRebuild,
} from "./scope-conversation-rebuilds.js";
export {
  drainConversationScopeRebuilds,
  hasConversationScopeRebuilds,
  drainLegacyConversationScopeRebuilds,
  hasLegacyConversationScopeRebuilds,
} from "./scope-conversation-rebuilds.js";
import { getSourceScopes } from "./scope-descriptors.js";
import type { Db } from "../data/types.js";

const text = z.string().min(1).max(512);
const mention = z
  .object({
    role: z.literal("participant"),
    name: z.string().max(512).optional(),
    isSelf: z.boolean().optional(),
    identifiers: z
      .array(z.object({ kind: z.enum(["phone", "email", "lid"]), value: text }))
      .max(8)
      .optional(),
    emails: z.array(text).max(8).optional(),
    phones: z.array(text).max(8).optional(),
    lids: z.array(text).max(8).optional(),
  })
  .passthrough();
export const conversationScopeUpdateSchema = z.strictObject({
  refreshEpoch: z.string().min(1).max(128).optional(),
  id: text,
  participants: z.array(mention).max(4096),
  mode: z.enum(["observed", "snapshot"]),
  observedAt: z.iso.datetime({ offset: true }),
  revision: z.strictObject({
    epoch: z.string().min(1).max(128),
    sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  }),
});

export interface ConversationScopeContext {
  sourceId: string;
  providerId: string;
  streamId: string;
  /** Trusted gateway admission context, never part of a provider's wire payload. */
  writeEpoch?: number;
  /** Verified source owner or current sync-lease holder. */
  snapshotAuthority?: boolean;
  authorityId?: string;
}
interface ConversationState {
  subject_document_id: string;
  mode: "observed" | "snapshot";
  revision_epoch: string | null;
  revision_sequence: number | null;
  write_epoch: number | null;
  snapshot_digest: string | null;
  conflicted: number;
  authority_id: string | null;
}
function conversation(db: Db, context: ConversationScopeContext, id: string): ConversationState {
  db.prepare(
    `INSERT OR IGNORE INTO scope_conversations
    (subject_document_id,source_id,provider_id,stream_id,conversation_id) VALUES(?,?,?,?,?)`,
  ).run(
    `scope-conversation:${randomUUID()}`,
    context.sourceId,
    context.providerId,
    context.streamId,
    id,
  );
  return db
    .prepare<[string, string, string, string], ConversationState>(
      `SELECT * FROM scope_conversations
    WHERE source_id=? AND provider_id=? AND stream_id=? AND conversation_id=?`,
    )
    .get(context.sourceId, context.providerId, context.streamId, id)!;
}
function covered(
  native: ReturnType<typeof projectNativeScopeParticipants>,
): NativeScopeParticipant[] {
  return !native.complete && native.participants.every((member) => member.complete)
    ? [...native.participants, { nativeKey: null, identifiers: [], complete: false }]
    : native.participants;
}
function canonical(members: NativeScopeParticipant[]): string {
  return JSON.stringify(
    members
      .map((member) =>
        JSON.stringify({
          key: member.nativeKey,
          complete: member.complete,
          identifiers: [...member.identifiers].sort((a, b) =>
            `${a.type}:${a.value}` < `${b.type}:${b.value}` ? -1 : 1,
          ),
        }),
      )
      .sort(),
  );
}
function rebuild(db: Db, subject: string): void {
  completeConversationMembers(db, subject);
}
function priorSnapshotWork(db: Db, subject: string): number {
  return [
    "scope_conversation_members",
    "scope_conversation_identifier_counts",
    "document_scope_facts",
  ].reduce((sum, table) => {
    const owner = table === "document_scope_facts" ? "document_id" : "subject_document_id";
    const row = db
      .prepare<[string, number], { n: number }>(
        `SELECT COUNT(*) AS n FROM (SELECT 1 FROM ${table} WHERE ${owner}=?${table === "document_scope_facts" ? " AND kind='participant'" : ""} LIMIT ?)`,
      )
      .get(subject, SCOPE_MEMBERSHIP_WRITE_BUDGET + 1)!;
    return sum + row.n;
  }, 0);
}
function replaceMembers(db: Db, subject: string, members: NativeScopeParticipant[]): void {
  db.prepare("DELETE FROM scope_conversation_members WHERE subject_document_id=?").run(subject);
  db.prepare("DELETE FROM scope_conversation_identifier_counts WHERE subject_document_id=?").run(
    subject,
  );
  db.prepare("DELETE FROM document_scope_facts WHERE document_id=? AND kind='participant'").run(
    subject,
  );
  for (const member of nativeMembers(members, "snapshot", true))
    writeConversationMember(db, subject, member);
}
function observeMembers(
  db: Db,
  state: ConversationState,
  members: NativeScopeParticipant[],
  origin: string,
  context: ConversationScopeContext,
  strong = false,
): void {
  if (state.mode === "snapshot") return;
  // Unknown original identities remain uncertain until a native roster supersedes them.
  const normalized = nativeMembers(members, origin, strong);
  if (
    normalized.reduce(
      (sum, member) => sum + conversationMemberWork(db, state.subject_document_id, member),
      0,
    ) > SCOPE_MEMBERSHIP_WRITE_BUDGET
  ) {
    queueConversationRebuild(
      db,
      context,
      state.subject_document_id,
      normalized,
      "observed",
      strong,
    );
    return;
  }
  for (const member of normalized) writeConversationMember(db, state.subject_document_id, member);
  rebuild(db, state.subject_document_id);
}
function conflict(db: Db, state: ConversationState): void {
  db.prepare("UPDATE scope_conversations SET conflicted=1 WHERE subject_document_id=?").run(
    state.subject_document_id,
  );
  db.prepare(
    "DELETE FROM document_scope_completeness WHERE document_id=? AND kind='participant'",
  ).run(state.subject_document_id);
}

/** Apply current native snapshots once per conversation, without rewriting every day. */
export function applyConversationScopeUpdates(
  db: Db,
  context: ConversationScopeContext,
  updates: readonly SourceScopeConversationUpdate[],
): void {
  const source = db
    .prepare<[string], { type: string; multi_device_mode: string }>(
      "SELECT type,multi_device_mode FROM sources WHERE id=?",
    )
    .get(context.sourceId);
  const scopes = source ? getSourceScopes(db, source.type) : null;
  if (
    !scopes?.legacyProjection?.participants ||
    scopes.legacyProjection.participants.membership !== "conversation"
  )
    return;
  for (const raw of updates) {
    const update = conversationScopeUpdateSchema.parse(raw);
    const state = conversation(db, context, update.id);
    const native = projectNativeScopeParticipants(update.participants, scopes);
    const members = covered(native);
    const digest = createHash("sha256").update(canonical(members)).digest("hex");
    if (context.snapshotAuthority !== true) continue;
    const actorChanged =
      !!context.authorityId && !!state.authority_id && context.authorityId !== state.authority_id;
    // Write epochs are local to a collector's cursor. A lease handover is
    // authoritative only because the actor was revalidated under admission.
    if (
      !actorChanged &&
      state.write_epoch !== null &&
      context.writeEpoch !== undefined &&
      context.writeEpoch < state.write_epoch
    )
      continue;
    if (update.mode === "observed" && state.mode === "snapshot") {
      if (
        actorChanged ||
        state.revision_epoch !== update.revision.epoch ||
        update.revision.sequence > (state.revision_sequence ?? 0)
      )
        conflict(db, state);
      continue;
    }
    if (!actorChanged && state.revision_epoch !== null) {
      if (state.revision_epoch === update.revision.epoch) {
        if (update.revision.sequence < state.revision_sequence!) continue;
        if (update.revision.sequence === state.revision_sequence) {
          if (digest !== state.snapshot_digest) conflict(db, state);
          else if (
            (context.writeEpoch !== undefined &&
              (state.write_epoch === null || context.writeEpoch > state.write_epoch)) ||
            (!state.authority_id && context.authorityId)
          )
            db.prepare(
              "UPDATE scope_conversations SET write_epoch=COALESCE(?,write_epoch),authority_id=COALESCE(?,authority_id) WHERE subject_document_id=?",
            ).run(
              context.writeEpoch ?? null,
              context.authorityId ?? null,
              state.subject_document_id,
            );
          if (digest === state.snapshot_digest)
            replaceNativeScopeKindWitness(
              db,
              state.subject_document_id,
              "participant",
              update.refreshEpoch,
            );
          if (digest === state.snapshot_digest)
            retagConversationRebuild(
              db,
              context,
              state.subject_document_id,
              nativeMembers(
                members,
                update.mode === "snapshot" ? "snapshot" : `native:${update.revision.epoch}`,
                true,
              ),
              update.mode,
            );
          continue;
        }
      } else if (
        !(context.authorityId && !state.authority_id) &&
        (context.writeEpoch === undefined ||
          state.write_epoch === null ||
          context.writeEpoch <= state.write_epoch)
      ) {
        conflict(db, state);
        continue;
      }
    }
    const snapshotUnchanged =
      update.mode === "snapshot" &&
      state.mode === "snapshot" &&
      digest === state.snapshot_digest &&
      !state.conflicted &&
      !hasSubjectConversationRebuild(db, state.subject_document_id);
    const normalized = nativeMembers(members, "snapshot", true);
    const staged =
      update.mode === "snapshot" &&
      !snapshotUnchanged &&
      (normalized.reduce((sum, member) => sum + memberWork(member), 0) +
        priorSnapshotWork(db, state.subject_document_id) >
        SCOPE_MEMBERSHIP_WRITE_BUDGET ||
        hasSubjectConversationRebuild(db, state.subject_document_id));
    if (staged)
      queueConversationRebuild(
        db,
        context,
        state.subject_document_id,
        normalized,
        "snapshot",
        true,
      );
    else if (update.mode === "snapshot" && !snapshotUnchanged)
      replaceMembers(db, state.subject_document_id, members);
    else if (update.mode === "observed")
      observeMembers(db, state, members, `native:${update.revision.epoch}`, context, true);
    db.prepare(
      `UPDATE scope_conversations SET mode=?,revision_epoch=?,revision_sequence=?,write_epoch=COALESCE(?,write_epoch),authority_id=COALESCE(?,authority_id),snapshot_digest=?,conflicted=0
      WHERE subject_document_id=?`,
    ).run(
      update.mode,
      update.revision.epoch,
      update.revision.sequence,
      context.writeEpoch ?? null,
      context.authorityId ?? null,
      digest,
      state.subject_document_id,
    );
    if (!snapshotUnchanged && !staged) rebuild(db, state.subject_document_id);
    replaceNativeScopeKindWitness(
      db,
      state.subject_document_id,
      "participant",
      update.refreshEpoch,
    );
  }
}

function metadataValue(metadata: DocumentMetadata, path: readonly string[] | undefined): unknown {
  if (!path) return undefined;
  let value: unknown = metadata;
  for (const key of path)
    value =
      value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, key)
        ? (value as Record<string, unknown>)[key]
        : undefined;
  return value;
}
/** Attach a day to its kind-specific participant subject and retain native speaker observations. */
export function observeDocumentConversation(
  db: Db,
  doc: {
    id: string;
    sourceId: string;
    providerId: string;
    streamId: string;
    metadata: DocumentMetadata;
    writeEpoch?: number;
    historical?: boolean;
    snapshotAuthority?: boolean;
    authorityId?: string;
    reprojection?: boolean;
  },
  scopes: SourceScopes,
): void {
  db.prepare("DELETE FROM document_scope_conversations WHERE document_id=?").run(doc.id);
  if (
    scopes.legacyProjection?.participants?.membership !== "conversation" ||
    doc.metadata.documentType === "attachment" ||
    (doc.metadata.extra &&
      Object.prototype.hasOwnProperty.call(doc.metadata.extra, "parentExternalId"))
  )
    return;
  const id = metadataValue(doc.metadata, scopes.legacyProjection.conversationIdPath);
  if (typeof id !== "string" || !id.trim()) return;
  const state = conversation(db, doc, id);
  if (doc.reprojection) clearNativeScopeWitnesses(db, state.subject_document_id, "participant");
  db.prepare("INSERT INTO document_scope_conversations VALUES(?,?)").run(
    doc.id,
    state.subject_document_id,
  );
  const snapshot = conversationScopeUpdateSchema.safeParse(
    metadataValue(doc.metadata, scopes.legacyProjection.participants.snapshotPath),
  );
  if (snapshot.success && snapshot.data.id === id && !doc.historical) {
    const source = db
      .prepare<[string], { multi_device_mode: string }>(
        "SELECT multi_device_mode FROM sources WHERE id=?",
      )
      .get(doc.sourceId);
    applyConversationScopeUpdates(
      db,
      {
        ...doc,
        snapshotAuthority: doc.snapshotAuthority ?? source?.multi_device_mode === "exclusive",
      },
      [snapshot.data],
    );
  } else {
    if (state.mode === "snapshot") {
      if (!doc.historical && doc.snapshotAuthority !== false) conflict(db, state);
      return;
    }
    const native = projectNativeScopeParticipants(doc.metadata.people, scopes);
    if (doc.historical && !doc.reprojection)
      withNativeScopePublication(db, state.subject_document_id, () => {
        observeMembers(db, state, covered(native), doc.id, doc);
        publishNativeScopeWitnesses(db, state.subject_document_id);
      });
    else observeMembers(db, state, covered(native), doc.id, doc);
  }
}
