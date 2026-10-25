// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import * as z from "zod/v4";
import { OMNESIS_CHAT_PROVIDER_ID, OMNESIS_CHAT_SOURCE_ID } from "./ids.js";
import type { RenderedConversation } from "./render.js";
import type Database from "better-sqlite3";

export const CONVERSATION_AUTHORITY_POLICY = "conversation-utterance-v1";
const projectionSchema = z.object({
  bodyHash: z.string().regex(/^[a-f0-9]{64}$/),
  policy: z.literal(CONVERSATION_AUTHORITY_POLICY),
  utterances: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        start: z.number().int().nonnegative(),
        end: z.number().int().positive(),
      }),
    )
    .max(2048),
});
export type ConversationEvidenceProjection = z.infer<typeof projectionSchema>;

export function conversationEvidenceProjection(
  rendered: RenderedConversation,
): ConversationEvidenceProjection {
  return {
    policy: CONVERSATION_AUTHORITY_POLICY,
    bodyHash: createHash("sha256").update(rendered.body).digest("hex"),
    // Exceeding the bound loses authority, never exposes an unqualified body.
    utterances: rendered.utterances.length <= 2048 ? rendered.utterances : [],
  };
}

export function createConversationEvidenceTable(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS conversation_evidence_projections (
    document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
    projection_json TEXT NOT NULL, generation INTEGER NOT NULL,
    digest TEXT NOT NULL
  )`);
}

/** Called only by the source-owned writer, within its citation transaction. */
export function sealConversationEvidence(
  db: Database.Database,
  id: string,
  input: ConversationEvidenceProjection,
): void {
  const projection = projectionSchema.parse(input);
  const row = db
    .prepare<
      [string, string, string],
      { content: string; content_hash: string; metadata: string }
    >("SELECT content,content_hash,metadata FROM documents WHERE id=? AND provider_id=? AND source_id=?")
    .get(id, OMNESIS_CHAT_PROVIDER_ID, OMNESIS_CHAT_SOURCE_ID);
  if (
    !row ||
    row.content_hash !== projection.bodyHash ||
    createHash("sha256").update(row.content).digest("hex") !== projection.bodyHash
  )
    throw new Error("Conversation evidence projection does not match its source");
  let end = 0;
  for (const range of projection.utterances) {
    if (range.start < end || range.end <= range.start || range.end > row.content.length)
      throw new Error("Invalid conversation evidence range");
    end = range.end;
  }
  const { json, generation, digest } = preparedConversationEvidence(db, id, projection);
  db.prepare(
    `INSERT INTO conversation_evidence_projections(document_id,projection_json,generation,digest)
    VALUES(?,?,?,?) ON CONFLICT(document_id) DO UPDATE SET projection_json=excluded.projection_json,
    generation=excluded.generation,digest=excluded.digest`,
  ).run(id, json, generation, digest);
  // This source-owned semantic marker activates the ordinary source lifecycle,
  // including same-body role changes. It is never sufficient without the sealed row.
  db.prepare(
    "UPDATE documents SET metadata=json_set(metadata,'$.evidenceAuthority',?) WHERE id=? AND json_extract(metadata,'$.evidenceAuthority') IS NOT ?",
  ).run(digest, id, digest);
}

export function preparedConversationEvidence(
  db: Database.Database,
  id: string | null,
  projection: ConversationEvidenceProjection,
) {
  const json = JSON.stringify(projectionSchema.parse(projection));
  const prior = db
    .prepare<
      [string | null],
      { projection_json: string; generation: number; digest: string }
    >("SELECT projection_json,generation,digest FROM conversation_evidence_projections WHERE document_id=?")
    .get(id);
  const generation =
    prior?.projection_json === json ? prior.generation : (prior?.generation ?? 0) + 1;
  const digest = createHash("sha256")
    .update(JSON.stringify([generation, json]))
    .digest("hex");
  return { json, generation, digest };
}

export function readConversationEvidence(
  db: Database.Database,
  id: string,
  content: string,
): ConversationEvidenceProjection | null {
  if (
    !db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='conversation_evidence_projections'",
      )
      .get()
  )
    return null;
  const row = db
    .prepare<
      [string],
      { projection_json: string; generation: number; digest: string; metadata: string }
    >(
      `SELECT p.projection_json,p.generation,p.digest,d.metadata FROM conversation_evidence_projections p
     JOIN documents d ON d.id=p.document_id WHERE p.document_id=?`,
    )
    .get(id);
  if (!row) return null;
  const parsed = projectionSchema.safeParse(JSON.parse(row.projection_json));
  if (
    !parsed.success ||
    createHash("sha256")
      .update(JSON.stringify([row.generation, row.projection_json]))
      .digest("hex") !== row.digest ||
    JSON.parse(row.metadata).evidenceAuthority !== row.digest ||
    parsed.data.bodyHash !== createHash("sha256").update(content).digest("hex")
  )
    return null;
  return parsed.data;
}

/** Post-migration installation: existing proofs must not retain pre-policy authority. */
export function installConversationEvidence(db: Database.Database): void {
  createConversationEvidenceTable(db);
  db.prepare(
    `UPDATE documents SET metadata=json_set(metadata,'$.evidenceAuthority',?)
    WHERE provider_id=? AND source_id=? AND NOT EXISTS (
      SELECT 1 FROM conversation_evidence_projections p WHERE p.document_id=documents.id
      AND json_extract(p.projection_json,'$.policy')=?
      AND p.digest=json_extract(documents.metadata,'$.evidenceAuthority')
    ) AND json_extract(metadata,'$.evidenceAuthority') IS NOT ?`,
  ).run(
    `unavailable:${CONVERSATION_AUTHORITY_POLICY}`,
    OMNESIS_CHAT_PROVIDER_ID,
    OMNESIS_CHAT_SOURCE_ID,
    CONVERSATION_AUTHORITY_POLICY,
    `unavailable:${CONVERSATION_AUTHORITY_POLICY}`,
  );
}

export const conversationEvidencePolicy = {
  sourceId: OMNESIS_CHAT_SOURCE_ID,
  providerId: OMNESIS_CHAT_PROVIDER_ID,
  read: readConversationEvidence,
};
