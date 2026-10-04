// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { normalizeEmail } from "@omnesis/core";
import { createVoiceNoteTables } from "../../voice-notes/storage.js";
import { findPersonByAlias } from "../../data/repositories/PersonRepository.js";
import {
  createTranscriptionVocabularyState,
  transcriptionVocabularyGeneration,
} from "./rebuild.js";
import {
  vocabularyConversationKey,
  type VocabularySettings,
  type VocabularyDocument,
  type ExtractedVocabularyDocument,
  type VocabularyApplyResult,
  type VocabularyScope,
} from "./types.js";
import type {
  TranscriptionContext,
  TranscriptionPerson,
  TranscriptionVocabulary,
} from "@omnesis/core";
import type { Db } from "../../data/types.js";

export function createTranscriptionVocabularyTables(db: Db): void {
  createTranscriptionVocabularyState(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS transcription_vocabulary_terms (
      scope_kind TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      term TEXT NOT NULL,
      text TEXT NOT NULL,
      document_count INTEGER NOT NULL,
      benefit REAL NOT NULL,
      base_score REAL NOT NULL,
      last_seen TEXT NOT NULL,
      PRIMARY KEY (scope_kind, scope_key, term)
    );
    CREATE INDEX IF NOT EXISTS idx_transcription_vocabulary_rank
      ON transcription_vocabulary_terms(scope_kind, scope_key, base_score DESC, term);
    CREATE INDEX IF NOT EXISTS idx_transcription_vocabulary_recent
      ON transcription_vocabulary_terms(scope_kind, scope_key, last_seen DESC, term);
    -- Intentionally retained on document deletion in V1. These keys make
    -- replay and additive updates idempotent, without subtracting vocabulary.
    -- The composite key is the only access path; avoid a duplicate rowid tree.
    CREATE TABLE IF NOT EXISTS transcription_vocabulary_document_terms (
      document_id TEXT NOT NULL,
      scope_kind TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      term TEXT NOT NULL,
      PRIMARY KEY (document_id, scope_kind, scope_key, term)
    ) WITHOUT ROWID;
  `);
}

export function installTranscriptionVocabulary(db: Db): void {
  createVoiceNoteTables(db);
  const columns = db.prepare("SELECT name FROM pragma_table_info('documents')").all() as Array<{
    name: string;
  }>;
  if (columns.length && !columns.some((c) => c.name === "vocabulary_processed_at")) {
    db.exec("ALTER TABLE documents ADD COLUMN vocabulary_processed_at TEXT");
  }
  if (columns.length && !columns.some((c) => c.name === "vocabulary_revision")) {
    db.exec("ALTER TABLE documents ADD COLUMN vocabulary_revision INTEGER NOT NULL DEFAULT 0");
  }
  createTranscriptionVocabularyTables(db);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_vocabulary_pending
    ON documents(id) WHERE vocabulary_processed_at IS NULL AND people_resolved_at IS NOT NULL`);
}

/** One partial-index page; text and participant payloads have fixed caps. */
export function fetchTranscriptionVocabularyBatch(
  db: Db,
  settings: VocabularySettings,
): VocabularyDocument[] {
  if (!settings.enabled) return [];
  const generation = transcriptionVocabularyGeneration(db);
  if (generation === null) return [];
  const rows = db
    .prepare(
      `SELECT id, content_hash, updated_at, vocabulary_revision, substr(title,1,256) AS title,
    substr(content,1,?) AS content, source_id, source_created_at,
    substr(COALESCE(json_extract(metadata,'$.extra.conversationId'),json_extract(metadata,'$.extra.threadId')),1,1024) AS thread_id
    FROM documents INDEXED BY idx_documents_vocabulary_pending
    WHERE vocabulary_processed_at IS NULL AND people_resolved_at IS NOT NULL
    ORDER BY id LIMIT ?`,
    )
    .all(Math.min(settings.maxDocumentChars, 65536), Math.min(settings.batchSize, 16)) as Array<{
    id: string;
    content_hash: string;
    updated_at: string;
    vocabulary_revision: number;
    title: string;
    content: string;
    source_id: string;
    source_created_at: string;
    thread_id: string | null;
  }>;
  const people =
    db.prepare(`SELECT DISTINCT canonical.id AS personId, substr(canonical.canonical_name,1,80) AS name,
    canonical.is_self AS isSelf, dp.role FROM (
      SELECT person_id, role FROM document_people INDEXED BY idx_document_people_doc
      WHERE document_id = ? LIMIT 32
    ) dp
    JOIN people p ON p.id = dp.person_id
    JOIN people canonical ON canonical.id = COALESCE(p.merged_into,p.id)
    LIMIT 16`);
  return rows.map((row) => ({
    id: row.id,
    contentHash: row.content_hash,
    updatedAt: row.updated_at,
    revision: row.vocabulary_revision,
    generation,
    title: row.title,
    content: row.content,
    sourceId: row.source_id,
    threadId: row.thread_id,
    recordedAt: row.source_created_at,
    people: (
      people.all(row.id) as Array<{ personId: string; name: string; isSelf: number; role: string }>
    ).map((p) => ({ ...p, isSelf: Boolean(p.isSelf) })),
  }));
}

/** Fixed 32-row write transactions; resume offsets preserve forward progress. */
export function applyTranscriptionVocabularyBatch(
  db: Db,
  input: ExtractedVocabularyDocument[],
  token?: { requested(): boolean },
): VocabularyApplyResult {
  let applied = 0;
  let skipped = 0;
  const current = db.prepare(
    `SELECT 1 FROM documents WHERE id = ? AND content_hash = ? AND updated_at = ? AND vocabulary_revision = ? AND vocabulary_processed_at IS NULL`,
  );
  const seen = db.prepare(
    `INSERT OR IGNORE INTO transcription_vocabulary_document_terms(document_id,scope_kind,scope_key,term) VALUES (?,?,?,?)`,
  );
  const existing = db.prepare(
    `SELECT text, document_count, benefit, last_seen FROM transcription_vocabulary_terms WHERE scope_kind = ? AND scope_key = ? AND term = ?`,
  );
  const upsert =
    db.prepare(`INSERT INTO transcription_vocabulary_terms(scope_kind,scope_key,term,text,document_count,benefit,base_score,last_seen)
    VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(scope_kind,scope_key,term) DO UPDATE SET
    text=excluded.text, document_count=excluded.document_count, benefit=excluded.benefit,
    base_score=excluded.base_score, last_seen=excluded.last_seen`);
  const stamp = db.prepare(
    `UPDATE documents SET vocabulary_processed_at = ? WHERE id = ? AND content_hash = ? AND updated_at = ? AND vocabulary_revision = ?`,
  );
  for (let index = 0; index < input.length; index++) {
    const doc = input[index];
    if (doc.generation !== transcriptionVocabularyGeneration(db)) {
      skipped++;
      continue;
    }
    const scopes = doc.scopes.slice(0, 18);
    const terms = doc.terms.slice(0, 128);
    const total = scopes.length * terms.length;
    let offset = doc.applyOffset ?? 0;
    if (!current.get(doc.id, doc.contentHash, doc.updatedAt, doc.revision)) {
      skipped++;
      continue;
    }
    do {
      const end = Math.min(total, offset + 32);
      let valid = true;
      db.transaction(() => {
        if (!current.get(doc.id, doc.contentHash, doc.updatedAt, doc.revision)) {
          valid = false;
          return;
        }
        for (let row = offset; row < end; row++) {
          const scope = scopes[Math.floor(row / terms.length)];
          const term = terms[row % terms.length];
          const isNew = seen.run(doc.id, scope.kind, scope.key, term.term).changes > 0;
          const prior = existing.get(scope.kind, scope.key, term.term) as
            | { text: string; document_count: number; benefit: number; last_seen: string }
            | undefined;
          const count = (prior?.document_count ?? 0) + (isNew ? 1 : 0);
          const benefit = Math.max(prior?.benefit ?? 0, term.benefit);
          const lastSeen =
            prior && prior.last_seen > doc.recordedAt ? prior.last_seen : doc.recordedAt;
          if (!isNew && prior && prior.benefit === benefit && prior.last_seen === lastSeen)
            continue;
          upsert.run(
            scope.kind,
            scope.key,
            term.term,
            prior && prior.benefit >= term.benefit ? prior.text : term.text,
            count,
            benefit,
            benefit * Math.log1p(count),
            lastSeen,
          );
        }
        if (end === total)
          stamp.run(new Date().toISOString(), doc.id, doc.contentHash, doc.updatedAt, doc.revision);
      })();
      if (!valid) {
        skipped++;
        break;
      }
      offset = end;
      if (offset === total) {
        applied++;
        break;
      }
      if (token?.requested())
        return {
          applied,
          skipped,
          remaining: [{ ...doc, applyOffset: offset }, ...input.slice(index + 1)],
        };
    } while (offset < total);
    if (token?.requested() && index + 1 < input.length)
      return { applied, skipped, remaining: input.slice(index + 1) };
  }
  return { applied, skipped, remaining: [] };
}

function resolvePerson(db: Db, person: TranscriptionPerson): string | null {
  if (person.isSelf) return null;
  if (person.personId) {
    const row = db
      .prepare(`SELECT COALESCE(merged_into,id) AS id,is_self FROM people WHERE id=?`)
      .get(person.personId) as { id: string; is_self: number } | undefined;
    if (row && !row.is_self) return row.id;
  }
  for (const identifier of (person.identifiers ?? []).slice(0, 8)) {
    const id = findPersonByAlias(
      db,
      identifier.kind,
      identifier.kind === "email" ? normalizeEmail(identifier.value) : identifier.value,
    );
    if (id) {
      const row = db.prepare(`SELECT is_self FROM people WHERE id=?`).get(id) as
        | { is_self: number }
        | undefined;
      if (row && !row.is_self) return id;
    }
  }
  return null;
}

/** Bounded indexed top-k per profile; never scan source documents at inference. */
export function getTranscriptionVocabulary(
  db: Db,
  context: TranscriptionContext,
  settings: VocabularySettings,
): TranscriptionVocabulary {
  if (!settings.enabled || transcriptionVocabularyGeneration(db) === null) return { entries: [] };
  const profiles: Array<VocabularyScope & { weight: number }> = [
    { kind: "global", key: "", weight: 1 },
  ];
  if (context.conversation)
    profiles.push({
      kind: "conversation",
      key: vocabularyConversationKey(context.conversation.sourceId, context.conversation.threadId),
      weight: 5,
    });
  const ids = new Set<string>();
  for (const person of [context.speaker, ...(context.participants ?? []).slice(0, 16)]) {
    if (!person) continue;
    const id = resolvePerson(db, person);
    if (id) ids.add(id);
  }
  const speakerId = context.speaker ? resolvePerson(db, context.speaker) : null;
  const personIds = [...ids].slice(0, 14);
  const participantWeight = 3 / Math.sqrt(Math.max(1, personIds.length));
  for (const id of personIds) {
    profiles.push({ kind: "person", key: id, weight: id === speakerId ? 3 : participantWeight });
  }
  // Historical profiles from a merge are also found through an index. Add
  // canonical profiles first so a large alias group cannot crowd out others.
  for (const id of personIds) {
    const room = 16 - profiles.length;
    if (room <= 0) break;
    const aliases = db
      .prepare("SELECT id FROM people WHERE merged_into=? LIMIT ?")
      .all(id, room) as Array<{ id: string }>;
    for (const alias of aliases)
      profiles.push({
        kind: "person",
        key: alias.id,
        weight: id === speakerId ? 3 : participantWeight,
      });
  }
  const top = db.prepare(`SELECT term,text,document_count,benefit,base_score,last_seen
    FROM transcription_vocabulary_terms INDEXED BY idx_transcription_vocabulary_rank
    WHERE scope_kind=? AND scope_key=? ORDER BY base_score DESC,term LIMIT ?`);
  const recent = db.prepare(`SELECT term,text,document_count,benefit,base_score,last_seen
    FROM transcription_vocabulary_terms INDEXED BY idx_transcription_vocabulary_recent
    WHERE scope_kind=? AND scope_key=? ORDER BY last_seen DESC,term LIMIT ?`);
  const global = db.prepare(
    `SELECT document_count FROM transcription_vocabulary_terms WHERE scope_kind='global' AND scope_key='' AND term=?`,
  );
  const globalCounts = new Map<string, number>();
  const selected = new Map<string, { text: string; score: number }>();
  const parsedTime = Date.parse(context.recordedAt ?? "");
  const anchor = Number.isFinite(parsedTime) ? parsedTime : Date.now();
  const limit = Math.min(256, Math.max(32, settings.maxTerms * 2));
  for (const profile of profiles.slice(0, 16)) {
    // Frequency-only retrieval can discard a recent relationship term before
    // its context score is considered. Union two bounded indexed streams and
    // count each term once per profile, retaining cross-profile contributions.
    const rows = [
      ...top.all(profile.kind, profile.key, limit),
      ...recent.all(profile.kind, profile.key, Math.min(limit, 128)),
    ] as Array<{
      term: string;
      text: string;
      document_count: number;
      benefit: number;
      base_score: number;
      last_seen: string;
    }>;
    const seen = new Set<string>();
    for (const row of rows) {
      if (seen.has(row.term)) continue;
      seen.add(row.term);
      if (row.benefit <= 1 && row.document_count < 2) continue;
      let total = globalCounts.get(row.term);
      if (total === undefined) {
        total =
          (global.get(row.term) as { document_count: number } | undefined)?.document_count ??
          row.document_count;
        globalCounts.set(row.term, total);
      }
      const specificity =
        profile.kind === "global"
          ? 1
          : 1 + 2 * Math.min(1, row.document_count / Math.max(1, total));
      const ageDays = Math.max(0, (anchor - Date.parse(row.last_seen)) / 86400000);
      const recency = Number.isFinite(ageDays) ? 0.5 + 0.5 * Math.exp(-ageDays / 180) : 0.5;
      const rarity = 1 / (1 + Math.log1p(total));
      const score = row.base_score * profile.weight * specificity * recency * rarity;
      const prior = selected.get(row.term);
      selected.set(row.term, { text: row.text, score: (prior?.score ?? 0) + score });
    }
  }
  return {
    entries: [...selected.values()]
      .sort((a, b) => b.score - a.score || a.text.localeCompare(b.text))
      .slice(0, settings.maxTerms),
  };
}
