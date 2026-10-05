// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { normalizeEmail } from "@omnesis/core";
import { boundedSelfAuthoredText, type SelfAuthoredTextSegment } from "@omnesis/types";
import { createVoiceNoteTables } from "../../voice-notes/storage.js";
import { findPersonByAlias } from "../../data/repositories/PersonRepository.js";
import { contextualVocabularyLift, authoredDecay } from "./ranking.js";
import { ordinaryEvidenceQuality } from "./evidence-quality.js";
import { isCommonVocabularyWord } from "./common-words.js";
import { contextualVocabularyNames } from "./identity.js";
import {
  createTranscriptionVocabularyState,
  transcriptionVocabularyGeneration,
} from "./rebuild.js";
import {
  vocabularyConversationKey,
  MIN_VOCABULARY_DOCUMENTS,
  type VocabularySettings,
  type VocabularyDocument,
  type VocabularyScope,
} from "./types.js";
import type {
  TranscriptionContext,
  TranscriptionPerson,
  TranscriptionVocabulary,
} from "@omnesis/core";
import type { Db } from "../../data/types.js";

export { applyTranscriptionVocabularyBatch } from "./apply.js";

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
      recent_mass REAL NOT NULL DEFAULT 0,
      evidence_count INTEGER NOT NULL DEFAULT 0,
      ordinary_document_count INTEGER NOT NULL DEFAULT 0,
      spelling_count INTEGER NOT NULL DEFAULT 0,
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
      observed_text TEXT,
      observed_at TEXT,
      observed_automated INTEGER,
      PRIMARY KEY (document_id, scope_kind, scope_key, term)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS transcription_vocabulary_profiles (
      scope_kind TEXT NOT NULL, scope_key TEXT NOT NULL, document_count INTEGER NOT NULL,
      PRIMARY KEY(scope_kind,scope_key)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS transcription_vocabulary_document_profiles (
      document_id TEXT NOT NULL, scope_kind TEXT NOT NULL, scope_key TEXT NOT NULL,
      PRIMARY KEY(document_id,scope_kind,scope_key)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS transcription_vocabulary_spellings (
      scope_kind TEXT NOT NULL, scope_key TEXT NOT NULL, term TEXT NOT NULL,
      text TEXT NOT NULL, document_count INTEGER NOT NULL, benefit REAL NOT NULL,
      PRIMARY KEY(scope_kind,scope_key,term,text)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS idx_transcription_vocabulary_spelling_rank
      ON transcription_vocabulary_spellings(scope_kind,scope_key,term,document_count DESC,text);
  `);
  const columns = db
    .prepare("SELECT name FROM pragma_table_info('transcription_vocabulary_document_terms')")
    .all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "observed_text"))
    db.exec("ALTER TABLE transcription_vocabulary_document_terms ADD COLUMN observed_text TEXT");
  if (!columns.some((column) => column.name === "observed_at"))
    db.exec("ALTER TABLE transcription_vocabulary_document_terms ADD COLUMN observed_at TEXT");
  if (!columns.some((column) => column.name === "observed_automated"))
    db.exec(
      "ALTER TABLE transcription_vocabulary_document_terms ADD COLUMN observed_automated INTEGER",
    );
  const termColumns = db
    .prepare("SELECT name FROM pragma_table_info('transcription_vocabulary_terms')")
    .all() as Array<{ name: string }>;
  if (!termColumns.some((column) => column.name === "recent_mass"))
    db.exec(
      "ALTER TABLE transcription_vocabulary_terms ADD COLUMN recent_mass REAL NOT NULL DEFAULT 0",
    );
  for (const column of ["evidence_count", "ordinary_document_count", "spelling_count"])
    if (!termColumns.some((existing) => existing.name === column))
      db.exec(
        `ALTER TABLE transcription_vocabulary_terms ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`,
      );

  db.exec(`CREATE INDEX IF NOT EXISTS idx_transcription_vocabulary_ordinary
    ON transcription_vocabulary_terms(scope_kind,scope_key,ordinary_document_count DESC,term)
    WHERE ordinary_document_count>=2`);
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
    substr(json_extract(metadata,'$.selfAuthoredText'),1,131072) AS self_authored_text,
    (json_type(metadata,'$.bulkMail')='true' OR json_type(metadata,'$.automatedSender')='true') AS automated_evidence,
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
    self_authored_text: string | null;
    automated_evidence: number | null;
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
    automatedEvidence: row.automated_evidence === 1,
    selfAuthoredText: parseAuthoredEvidence(row.self_authored_text),
    people: (
      people.all(row.id) as Array<{ personId: string; name: string; isSelf: number; role: string }>
    ).map((p) => ({ ...p, isSelf: Boolean(p.isSelf) })),
  }));
}

/** Metadata is untrusted; reject truncated or malformed evidence before extraction. */
function parseAuthoredEvidence(payload: string | null): SelfAuthoredTextSegment[] {
  if (!payload) return [];
  try {
    const value: unknown = JSON.parse(payload);
    if (!Array.isArray(value)) return [];
    return boundedSelfAuthoredText(
      value
        .slice(0, 128)
        .filter((segment): segment is SelfAuthoredTextSegment =>
          Boolean(
            segment &&
            typeof segment.text === "string" &&
            typeof segment.recordedAt === "string" &&
            Number.isFinite(Date.parse(segment.recordedAt)),
          ),
        ),
    );
  } catch {
    return [];
  }
}

function resolvePerson(db: Db, person: TranscriptionPerson, includeSelf = false): string | null {
  if (person.isSelf) return null;
  if (person.personId) {
    const row = db
      .prepare(
        `SELECT canonical.id,canonical.is_self FROM people p JOIN people canonical ON canonical.id=COALESCE(p.merged_into,p.id) WHERE p.id=?`,
      )
      .get(person.personId) as { id: string; is_self: number } | undefined;
    if (row && (includeSelf || !row.is_self)) return row.id;
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
      if (row && (includeSelf || !row.is_self)) return id;
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
  const speakerCanonical = context.speaker ? resolvePerson(db, context.speaker, true) : null;
  const canonicalSelf =
    speakerCanonical &&
    (
      db.prepare("SELECT is_self FROM people WHERE id=?").get(speakerCanonical) as
        | { is_self: number }
        | undefined
    )?.is_self;
  if (
    (settings.authoredWeight ?? 4) > 0 &&
    (context.purpose !== "source-audio" || context.speaker?.isSelf || canonicalSelf)
  )
    profiles.push({ kind: "self", key: "", weight: settings.authoredWeight ?? 4 });
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
  const top =
    db.prepare(`SELECT term,text,document_count,benefit,base_score,last_seen,recent_mass,evidence_count,ordinary_document_count,spelling_count
    FROM transcription_vocabulary_terms INDEXED BY idx_transcription_vocabulary_rank
    WHERE scope_kind=? AND scope_key=? ORDER BY base_score DESC,term LIMIT ?`);
  const recent =
    db.prepare(`SELECT term,text,document_count,benefit,base_score,last_seen,recent_mass,evidence_count,ordinary_document_count,spelling_count
    FROM transcription_vocabulary_terms INDEXED BY idx_transcription_vocabulary_recent
    WHERE scope_kind=? AND scope_key=? ORDER BY last_seen DESC,term LIMIT ?`);
  const ordinary =
    db.prepare(`SELECT term,text,document_count,benefit,base_score,last_seen,recent_mass,evidence_count,ordinary_document_count,spelling_count
    FROM transcription_vocabulary_terms INDEXED BY idx_transcription_vocabulary_ordinary
    WHERE scope_kind=? AND scope_key=? AND ordinary_document_count>=2
    ORDER BY ordinary_document_count DESC,term LIMIT ?`);
  const global = db.prepare(
    `SELECT document_count,evidence_count FROM transcription_vocabulary_terms WHERE scope_kind='global' AND scope_key='' AND term=?`,
  );
  const globalCounts = new Map<string, { document_count: number; evidence_count: number }>();
  const profileCount = db.prepare(
    "SELECT document_count FROM transcription_vocabulary_profiles WHERE scope_kind=? AND scope_key=?",
  );
  const globalDocuments =
    (profileCount.get("global", "") as { document_count: number } | undefined)?.document_count ?? 0;
  const selected = new Map<string, { text: string; score: number }>();
  const spellingEvidence = new Map<string, { score: number; count: number }>();
  const commonTerms = new Map<string, boolean>();
  const parsedTime = Date.parse(context.recordedAt ?? "");
  const anchor = Number.isFinite(parsedTime) ? parsedTime : Date.now();
  const limit = Math.min(256, Math.max(32, settings.maxTerms * 2));
  for (const profile of profiles.slice(0, 16)) {
    // Frequency-only retrieval can discard a recent relationship term before
    // its context score is considered. Combine bounded rank, recent and
    // ordinary-evidence streams; count each term once per profile.
    const rows = [
      ...top.all(profile.kind, profile.key, limit),
      ...recent.all(profile.kind, profile.key, Math.min(limit, 128)),
      ...(profile.kind === "self"
        ? []
        : ordinary.all(profile.kind, profile.key, Math.min(limit, 128))),
    ] as Array<{
      term: string;
      text: string;
      document_count: number;
      benefit: number;
      base_score: number;
      last_seen: string;
      recent_mass: number;
      evidence_count: number;
      ordinary_document_count: number;
      spelling_count: number;
    }>;
    const profileDocuments =
      (profileCount.get(profile.kind, profile.key) as { document_count: number } | undefined)
        ?.document_count ?? 0;
    const seen = new Set<string>();
    for (const row of rows) {
      if (seen.has(row.term)) continue;
      seen.add(row.term);
      if (row.document_count < MIN_VOCABULARY_DOCUMENTS) continue;
      // Retained evidence must obey the same lexical filter as extraction.
      // Terms are normalized keys; overlapping profiles share this lookup.
      let common = commonTerms.get(row.term);
      if (common === undefined) {
        common = isCommonVocabularyWord(row.term);
        commonTerms.set(row.term, common);
      }
      if (common) continue;
      let background = globalCounts.get(row.term);
      if (!background) {
        background = (global.get(row.term) as
          | { document_count: number; evidence_count: number }
          | undefined) ?? { document_count: row.document_count, evidence_count: 0 };
        globalCounts.set(row.term, background);
      }
      const total = background.document_count;
      const specificity =
        profile.kind === "global"
          ? 1
          : (contextualVocabularyLift(
              {
                profileOccurrences: row.evidence_count,
                profileDocuments,
                globalOccurrences: background.evidence_count,
                globalDocuments,
              },
              settings.contextPriorDocuments ?? 10,
            ) ?? 1 + 2 * Math.min(1, row.document_count / Math.max(1, total)));
      const ageDays = Math.max(0, (anchor - Date.parse(row.last_seen)) / 86400000);
      // Ordinary profiles retain a bounded last-seen recency factor.
      const recency = Number.isFinite(ageDays) ? 0.5 + 0.5 * Math.exp(-ageDays / 180) : 0.5;
      const rarity = 1 / (1 + Math.log1p(total));
      // Authored support decays each original contribution with a 90-day
      // half-life; received material cannot refresh this separate profile.
      const support =
        profile.kind === "self"
          ? row.benefit *
            Math.log1p(
              row.recent_mass * authoredDecay(row.last_seen, new Date(anchor).toISOString()),
            )
          : row.base_score * recency;
      const quality =
        profile.kind === "self"
          ? 1
          : ordinaryEvidenceQuality(
              row.evidence_count,
              row.ordinary_document_count,
              settings.machineEvidenceWeight ?? 0.15,
            );
      if (quality === 0) continue;
      const score = support * profile.weight * specificity * rarity * quality;
      const prior = selected.get(row.term);
      const priorSpelling = spellingEvidence.get(row.term);
      const useSpelling =
        !prior ||
        (row.spelling_count >= MIN_VOCABULARY_DOCUMENTS &&
          (!priorSpelling ||
            priorSpelling.count < MIN_VOCABULARY_DOCUMENTS ||
            score > priorSpelling.score));
      selected.set(row.term, {
        text: useSpelling ? row.text : prior!.text,
        score: (prior?.score ?? 0) + score,
      });
      if (useSpelling) spellingEvidence.set(row.term, { score, count: row.spelling_count });
    }
  }
  // Identity evidence is a small contextual prior, not a fabricated corpus
  // occurrence. Keep it separate from the document-frequency materialization.
  // Only self and the speaker receive this priority; group participants still
  // contribute normal profiles so their names cannot consume the whole prompt.
  const identityNames = contextualVocabularyNames(
    db,
    context.speaker
      ? [resolvePerson(db, context.speaker, true)].filter((id): id is string => id !== null)
      : [],
    context.purpose !== "source-audio" ||
      Boolean(context.speaker?.isSelf || context.participants?.some((person) => person.isSelf)),
  );
  const identityScore =
    Math.max(0, ...[...selected.values()].map((term) => term.score).filter(Number.isFinite)) + 1;
  for (const [index, text] of identityNames.entries()) {
    const term = text.normalize("NFC").toLocaleLowerCase("und");
    selected.set(term, { text, score: identityScore + 1 / (index + 1) });
  }
  return {
    entries: [...selected.values()]
      .filter((entry) => Number.isFinite(entry.score) && entry.score > 0)
      .sort((a, b) => b.score - a.score || a.text.localeCompare(b.text))
      .slice(0, settings.maxTerms),
  };
}
