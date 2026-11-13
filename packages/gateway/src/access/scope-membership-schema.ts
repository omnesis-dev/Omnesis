// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { Db } from "../data/types.js";

/** Participant subjects are independent of any single day and of mutable person rows. */
export function createConversationScopeSchema(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS scope_conversations (
    subject_document_id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    stream_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'observed' CHECK (mode IN ('observed','snapshot')),
    revision_epoch TEXT,
    revision_sequence INTEGER,
    write_epoch INTEGER,
    authority_id TEXT,
    snapshot_digest TEXT,
    conflicted INTEGER NOT NULL DEFAULT 0 CHECK (conflicted IN (0,1)),
    UNIQUE(source_id,provider_id,stream_id,conversation_id)
  );
  CREATE INDEX IF NOT EXISTS idx_scope_conversations_source ON scope_conversations(source_id);
  CREATE TABLE IF NOT EXISTS document_scope_conversations (
    document_id TEXT PRIMARY KEY,
    subject_document_id TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_scope_conversation_subject ON document_scope_conversations(subject_document_id);
  CREATE TABLE IF NOT EXISTS scope_conversation_members (
    subject_document_id TEXT NOT NULL,
    member_key TEXT NOT NULL,
    identifiers_json TEXT NOT NULL,
    complete INTEGER NOT NULL CHECK (complete IN (0,1)),
    pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0,1)),
    PRIMARY KEY(subject_document_id,member_key)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS idx_scope_members_unknown ON scope_conversation_members(subject_document_id,complete);
  CREATE TABLE IF NOT EXISTS scope_conversation_identifier_counts (
    subject_document_id TEXT NOT NULL, entity_id TEXT NOT NULL,
    contributions INTEGER NOT NULL CHECK(contributions > 0),
    PRIMARY KEY(subject_document_id,entity_id)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS scope_conversation_rebuilds (
    operation_id TEXT PRIMARY KEY,
    subject_document_id TEXT NOT NULL,
    members_json TEXT NOT NULL,
    mode TEXT NOT NULL CHECK(mode IN ('observed','snapshot')),
    phase TEXT NOT NULL CHECK(phase IN ('members','facts','counts','insert')),
    next_member INTEGER NOT NULL DEFAULT 0,
    authority_required INTEGER NOT NULL CHECK(authority_required IN (0,1)),
    authority_id TEXT, write_epoch INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_scope_rebuild_subject ON scope_conversation_rebuilds(subject_document_id);
  `);
}
