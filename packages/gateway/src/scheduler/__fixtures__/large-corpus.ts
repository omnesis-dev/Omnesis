// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * An invented corpus shaped like a large personal install, for writer hold
 * and query-plan tests: the table ratios of a large install (three people mentions per document, one person per ten
 * documents, a sixth of documents signed for near-duplicates, a long tail of
 * small sources), scaled to `docs`.
 *
 * Seeded with plain INSERTs on a handle the caller closes before a writer
 * opens the file. Ids are deterministic but scattered, like a live install's
 * UUIDs, and the access ledger ties on its timestamp. Document inserts fire the schema's own triggers, so the
 * knowledge source revisions and cascade jobs a sync leaves behind are there
 * too. Every value is invented.
 */

import type Database from "better-sqlite3";
type Db = Database.Database;

export interface LargeCorpusOptions {
  docs: number;
  /** Documents left with `people_resolved_at IS NULL`, mentioning many people each. */
  unresolvedDocs?: number;
  /**
   * Pending merge candidates, at most one per person; every `collapsedEvery`-th
   * one (at least every second) names two aliases of one person.
   */
  pendingCandidates?: number;
  collapsedEvery?: number;
}

export interface LargeCorpus {
  docs: number;
  people: number;
  sources: readonly CorpusSource[];
  unresolvedDocIds: string[];
  collapsedCandidateIds: string[];
}

export interface CorpusSource {
  providerId: string;
  sourceId: string;
  documentType: string;
  share: number;
}

/** Share of the corpus per source: three large ones and a long tail. */
export const CORPUS_SOURCES: readonly CorpusSource[] = [
  { providerId: "synth-mail", sourceId: "synth-mail-work", documentType: "email", share: 0.34 },
  { providerId: "synth-mail", sourceId: "synth-mail-home", documentType: "email", share: 0.14 },
  { providerId: "synth-chat", sourceId: "synth-chat", documentType: "message", share: 0.24 },
  { providerId: "synth-drive", sourceId: "synth-drive", documentType: "document", share: 0.13 },
  { providerId: "synth-photos", sourceId: "synth-photos", documentType: "photo", share: 0.06 },
  { providerId: "synth-calendar", sourceId: "synth-calendar", documentType: "event", share: 0.03 },
  { providerId: "synth-notes", sourceId: "synth-notes", documentType: "note", share: 0.02 },
  {
    providerId: "synth-contacts",
    sourceId: "synth-contacts",
    documentType: "contact",
    share: 0.01,
  },
  { providerId: "synth-tasks", sourceId: "synth-tasks", documentType: "task", share: 0.01 },
  { providerId: "synth-web", sourceId: "synth-web", documentType: "web", share: 0.01 },
  { providerId: "synth-code", sourceId: "synth-code", documentType: "issue", share: 0.005 },
  { providerId: "synth-health", sourceId: "synth-health", documentType: "metric", share: 0.005 },
];

export const CORPUS_ALGO = "synth-algo-v1";
const BANDS = 16;
const personName = (p: number): string => `synth contact ${p.toString(36)}`;

/**
 * A deterministic id in random key order. A live install's ids are UUIDs, so
 * an index on an id column starts at an arbitrary row; an approximate ANALYZE
 * samples the start of each index, and sequential ids would put the same
 * rows (the owner, the oldest documents) first in every one of them.
 */
function scatteredId(prefix: string, n: number): string {
  let h = Math.imul(n + 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return `${prefix}-${(h >>> 0).toString(16).padStart(8, "0")}-${n.toString(36)}`;
}

export const corpusDocId = (i: number): string => scatteredId("synth-doc", i);
export const corpusPersonId = (i: number): string => scatteredId("synth-person", i);
export const corpusEmail = (i: number): string => `${scatteredId("person", i)}@example.com`;
export const corpusExternalId = (i: number): string => scatteredId("ext", i);

/** Deterministic, uneven: a few people are in most documents, most in a handful. */
function mentionedPerson(doc: number, slot: number, people: number): number {
  if (slot === 0) return 0;
  const r = (Math.imul(doc + 1, 2654435761) ^ Math.imul(slot + 7, 40503)) >>> 0;
  const skew = (r % 1000) / 1000;
  return 1 + Math.floor(skew * skew * skew * (people - 1));
}

function sourceFor(i: number, docs: number): CorpusSource {
  let edge = 0;
  for (const source of CORPUS_SOURCES) {
    edge += source.share * docs;
    if (i < edge) return source;
  }
  return CORPUS_SOURCES[0];
}

const iso = (ms: number): string => new Date(ms).toISOString();

export function seedLargeCorpus(db: Db, options: LargeCorpusOptions): LargeCorpus {
  const docs = options.docs;
  const people = Math.max(50, Math.round(docs * 0.094));
  const unresolved = options.unresolvedDocs ?? 0;
  const collapsedEvery = Math.max(2, options.collapsedEvery ?? 4);
  const pendingCandidates = Math.min(options.pendingCandidates ?? 0, people - 4);
  const start = Date.parse("2016-01-01T00:00:00Z");
  const span = Date.parse("2026-10-01T00:00:00Z") - start;

  const insertDoc = db.prepare(
    `INSERT INTO documents (id, provider_id, source_id, external_id, title, content, content_hash,
       metadata, source_created_at, source_updated_at, ingested_at, updated_at, source_url,
       people_resolved_at, vocabulary_processed_at, links_extracted_at, dates_extracted_at,
       bootstrap_processed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertPerson = db.prepare(
    `INSERT INTO people (id, canonical_name, source, is_self, first_seen, last_seen, created_at,
       updated_at, doc_count, alias_count)
     VALUES (?, ?, 'synth-mail-work', ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertAlias = db.prepare(
    `INSERT INTO person_aliases (id, person_id, alias, alias_type, source_id, created_at)
     VALUES (?, ?, ?, ?, 'synth-mail-work', ?)`,
  );
  const insertDocPerson = db.prepare(
    `INSERT OR IGNORE INTO document_people (document_id, person_id, role, source_id)
     VALUES (?, ?, ?, ?)`,
  );
  const insertSig = db.prepare(
    `INSERT INTO near_dup_signatures (doc_id, algo_version, signature, shingle_count, computed_at)
     VALUES (?, ?, ?, 40, 0)`,
  );
  const insertBucket = db.prepare(
    `INSERT INTO near_dup_lsh_buckets (algo_version, band_idx, bucket_hash, doc_id) VALUES (?, ?, ?, ?)`,
  );
  const insertEdge = db.prepare(
    `INSERT OR IGNORE INTO near_dup_edges (doc_a, doc_b, algo_version, jaccard, pair_unique_df2,
       pair_unique_df5, containment_min, gate_family, computed_at)
     VALUES (?, ?, ?, 0.9, 3, 6, 0.96, 'file-like', 0)`,
  );
  const insertCandidate = db.prepare(
    `INSERT INTO merge_candidates (id, side_a_alias_type, side_a_alias, side_b_alias_type,
       side_b_alias, score, detection_kind, status, detected_at)
     VALUES (?, ?, ?, ?, ?, 0.8, 'name-token', 'pending', '2026-10-01T00:00:00Z')`,
  );
  const insertDecided = db.prepare(
    `INSERT INTO merge_candidates (id, side_a_alias_type, side_a_alias, side_b_alias_type,
       side_b_alias, score, detection_kind, status, detected_at, decided_at)
     VALUES (?, 'email', ?, 'email', ?, 0.7, 'name-token', ?, '2026-09-01T00:00:00Z', ?)`,
  );
  const insertAudit = db.prepare(
    `INSERT INTO access_audit_events (id, occurred_at, event_type, principal_id, detail)
     VALUES (?, ?, 'grant.used', ?, '{}')`,
  );
  const insertSyncState = db.prepare(
    `INSERT OR IGNORE INTO sync_state (source_id, cursor, last_synced_at) VALUES (?, '{}', ?)`,
  );

  const signature = Buffer.alloc(64, 7);
  const unresolvedDocIds: string[] = [];
  const collapsedCandidateIds: string[] = [];
  db.transaction(() => {
    for (const source of CORPUS_SOURCES) insertSyncState.run(source.sourceId, iso(start + span));
    for (let p = 0; p < people; p++) {
      const seen = iso(start + Math.floor((p / people) * span));
      insertPerson.run(
        corpusPersonId(p),
        personName(p),
        p === 0 ? 1 : 0,
        seen,
        seen,
        seen,
        seen,
        1,
        2,
      );
      insertAlias.run(
        scatteredId("synth-alias-e", p),
        corpusPersonId(p),
        corpusEmail(p),
        "email",
        seen,
      );
      if (p % 3 === 0)
        insertAlias.run(
          scatteredId("synth-alias-n", p),
          corpusPersonId(p),
          `${personName(p)} ${p}`,
          "name",
          seen,
        );
      if (p % 10 === 0)
        insertAlias.run(
          scatteredId("synth-alias-p", p),
          corpusPersonId(p),
          `+15550100${(p % 1_000).toString().padStart(3, "0")}`,
          "phone",
          seen,
        );
      if (p % 2 === 0)
        insertAlias.run(
          scatteredId("synth-alias-x", p),
          corpusPersonId(p),
          `${scatteredId("alt", p)}@example.org`,
          "email",
          seen,
        );
    }
    // One person in twenty-five is a merged duplicate of another, as rule
    // and contact merges leave behind on a live install.
    const merge = db.prepare("UPDATE people SET merged_into = ? WHERE id = ?");
    for (let p = 24; p < people; p += 25) merge.run(corpusPersonId(p - 5), corpusPersonId(p));
    for (let i = 0; i < docs; i++) {
      const source = sourceFor(i, docs);
      const id = corpusDocId(i);
      const at = iso(start + Math.floor((i / docs) * span));
      const isUnresolved = i >= docs - unresolved;
      const mentions = isUnresolved ? 40 : 1 + (i % 5);
      const persons = Array.from({ length: mentions }, (_, slot) =>
        mentionedPerson(i, slot, people),
      );
      const extra =
        source.documentType === "email"
          ? { threadId: `thread-${Math.floor(i / 4)}` }
          : source.documentType === "message"
            ? { conversationId: `conv-${i % 900}` }
            : {};
      const metadata = JSON.stringify({
        documentType: source.documentType,
        people: persons.map((p, slot) => ({
          role: slot === 0 ? "sender" : "recipient",
          emails: [corpusEmail(p)],
        })),
        extra,
      });
      if (isUnresolved) unresolvedDocIds.push(id);
      insertDoc.run(
        id,
        source.providerId,
        source.sourceId,
        corpusExternalId(i),
        `Quarterly planning note ${i}`,
        `Agenda item ${i % 97} for the review.`,
        `hash-${i}`,
        metadata,
        at,
        at,
        at,
        at,
        `https://example.com/${source.sourceId}/${i}`,
        isUnresolved ? null : at,
        at,
        at,
        at,
        at,
      );
      if (!isUnresolved)
        for (let slot = 0; slot < persons.length; slot++)
          insertDocPerson.run(
            id,
            corpusPersonId(persons[slot]),
            slot === 0 ? "sender" : "recipient",
            source.sourceId,
          );
      if (i % 6 === 0) {
        insertSig.run(id, CORPUS_ALGO, signature);
        for (let b = 0; b < BANDS; b++)
          insertBucket.run(
            CORPUS_ALGO,
            b,
            (Math.imul(i + 1, 2654435761) ^ Math.imul(b + 1, 40503)) | 0,
            id,
          );
        if (i % 42 === 6) insertEdge.run(corpusDocId(i - 6), id, CORPUS_ALGO);
      }
    }
    // The access ledger, three events to a millisecond so keyset pages tie.
    const auditEvents = Math.max(200, Math.floor(docs / 20));
    for (let k = 0; k < auditEvents; k++)
      insertAudit.run(
        scatteredId("synth-audit", k),
        start + Math.floor(k / 3) * 1_000,
        `synth-principal-${k % 5}`,
      );
    for (let c = 0; c < pendingCandidates; c++) {
      const id = scatteredId("synth-candidate", c);
      if (c % collapsedEvery === 0) {
        const p = 2 + 2 * Math.floor(c / collapsedEvery);
        insertCandidate.run(
          id,
          "email",
          corpusEmail(p),
          "email",
          `${scatteredId("alt", p)}@example.org`,
        );
        collapsedCandidateIds.push(id);
      } else {
        const p = 1 + (c % (people - 2));
        insertCandidate.run(id, "email", corpusEmail(p), "email", corpusEmail(p + 1));
      }
    }
    // The operator's decided history outnumbers what is still pending.
    for (let c = 0; c < pendingCandidates * 3; c++)
      insertDecided.run(
        scatteredId("synth-decided", c),
        `${scatteredId("decided-a", c)}@example.com`,
        `${scatteredId("decided-b", c)}@example.com`,
        c % 4 === 0 ? "denied" : "accepted",
        iso(start + span - c * 60_000),
      );
  })();
  return { docs, people, sources: CORPUS_SOURCES, unresolvedDocIds, collapsedCandidateIds };
}
