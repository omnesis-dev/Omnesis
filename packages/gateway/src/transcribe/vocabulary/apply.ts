// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { transcriptionVocabularyGeneration } from "./rebuild.js";
import { hasMixedVocabularyCase, vocabularySpellingBenefit } from "./spelling.js";
import { authoredDecay, AUTHORED_HALF_LIFE_DAYS } from "./ranking.js";
import {
  MIN_VOCABULARY_DOCUMENTS,
  type ExtractedVocabularyDocument,
  type VocabularyApplyResult,
  type VocabularyScope,
} from "./types.js";
import type { Db } from "../../data/types.js";

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
    `SELECT text, document_count, benefit, last_seen,recent_mass,evidence_count,ordinary_document_count,spelling_count FROM transcription_vocabulary_terms WHERE scope_kind = ? AND scope_key = ? AND term = ?`,
  );
  const observed =
    db.prepare(`SELECT observed_text,observed_at,observed_automated FROM transcription_vocabulary_document_terms
    WHERE document_id=? AND scope_kind=? AND scope_key=? AND term=?`);
  const observe = db.prepare(`UPDATE transcription_vocabulary_document_terms SET observed_text=?
    WHERE document_id=? AND scope_kind=? AND scope_key=? AND term=?`);
  const observeAutomated =
    db.prepare(`UPDATE transcription_vocabulary_document_terms SET observed_automated=?
    WHERE document_id=? AND scope_kind=? AND scope_key=? AND term=?`);
  const documentProfile = db.prepare(
    `INSERT OR IGNORE INTO transcription_vocabulary_document_profiles VALUES(?,?,?)`,
  );
  const countProfile = db.prepare(`INSERT INTO transcription_vocabulary_profiles VALUES(?,?,1)
    ON CONFLICT(scope_kind,scope_key) DO UPDATE SET document_count=document_count+1`);
  const observeAt = db.prepare(`UPDATE transcription_vocabulary_document_terms SET observed_at=?
    WHERE document_id=? AND scope_kind=? AND scope_key=? AND term=?`);
  const addSpelling = db.prepare(`INSERT INTO transcription_vocabulary_spellings VALUES(?,?,?,?,1,?)
    ON CONFLICT(scope_kind,scope_key,term,text) DO UPDATE SET document_count=document_count+1,benefit=MAX(benefit,excluded.benefit)`);
  const subtractSpelling =
    db.prepare(`UPDATE transcription_vocabulary_spellings SET document_count=document_count-1
    WHERE scope_kind=? AND scope_key=? AND term=? AND text=? AND document_count>0`);
  const bestSpelling =
    db.prepare(`SELECT text,document_count,benefit FROM transcription_vocabulary_spellings
    INDEXED BY idx_transcription_vocabulary_spelling_rank
    WHERE scope_kind=? AND scope_key=? AND term=? ORDER BY document_count DESC,text LIMIT 1`);
  const upgradeSpelling = db.prepare(`UPDATE transcription_vocabulary_spellings SET benefit=?
    WHERE scope_kind=? AND scope_key=? AND term=? AND text=? AND benefit<?`);
  const removeUnusedSpelling = db.prepare(`DELETE FROM transcription_vocabulary_spellings
    WHERE scope_kind=? AND scope_key=? AND term=? AND text=? AND document_count=0`);
  const upsert =
    db.prepare(`INSERT INTO transcription_vocabulary_terms(scope_kind,scope_key,term,text,document_count,benefit,base_score,last_seen,recent_mass,evidence_count,ordinary_document_count,spelling_count)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(scope_kind,scope_key,term) DO UPDATE SET
    text=excluded.text, document_count=excluded.document_count, benefit=excluded.benefit,
    base_score=excluded.base_score, last_seen=excluded.last_seen,recent_mass=excluded.recent_mass,
    evidence_count=excluded.evidence_count,ordinary_document_count=excluded.ordinary_document_count,
    spelling_count=excluded.spelling_count`);
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
    const authored = (doc.selfTerms ?? []).slice(0, 128);
    const ordinaryRows = scopes.length * terms.length;
    const total = ordinaryRows + authored.length;
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
        if (offset === 0) {
          const opportunities = [...((doc.hasText ?? terms.length > 0) ? scopes : [])];
          if (doc.hasSelfText ?? authored.length > 0) {
            if (!opportunities.some((scope) => scope.kind === "global"))
              opportunities.push({ kind: "global", key: "" });
            opportunities.push({ kind: "self", key: "" });
          }
          for (const scope of opportunities)
            if (documentProfile.run(doc.id, scope.kind, scope.key).changes)
              countProfile.run(scope.kind, scope.key);
        }
        for (let row = offset; row < end; row++) {
          const isAuthored = row >= ordinaryRows;
          const scope: VocabularyScope = isAuthored
            ? { kind: "self", key: "" }
            : scopes[Math.floor(row / terms.length)];
          const term = isAuthored ? authored[row - ordinaryRows] : terms[row % terms.length];
          const recordedAt = isAuthored ? authored[row - ordinaryRows].recordedAt : doc.recordedAt;
          const isNew = seen.run(doc.id, scope.kind, scope.key, term.term).changes > 0;
          const observation = observed.get(doc.id, scope.kind, scope.key, term.term) as {
            observed_text: string | null;
            observed_at: string | null;
            observed_automated: number | null;
          };
          const oldSpelling = observation.observed_text;
          const changedSpelling = oldSpelling !== term.text;
          if (changedSpelling) {
            if (oldSpelling !== null) {
              subtractSpelling.run(scope.kind, scope.key, term.term, oldSpelling);
              removeUnusedSpelling.run(scope.kind, scope.key, term.term, oldSpelling);
            }
            addSpelling.run(scope.kind, scope.key, term.term, term.text, term.benefit);
            observe.run(term.text, doc.id, scope.kind, scope.key, term.term);
          } else
            upgradeSpelling.run(
              term.benefit,
              scope.kind,
              scope.key,
              term.term,
              term.text,
              term.benefit,
            );
          const spelling = bestSpelling.get(scope.kind, scope.key, term.term) as {
            text: string;
            document_count: number;
            benefit: number;
          };
          const text =
            spelling.document_count < MIN_VOCABULARY_DOCUMENTS &&
            hasMixedVocabularyCase(spelling.text)
              ? term.term
              : spelling.text;
          const prior = existing.get(scope.kind, scope.key, term.term) as
            | {
                text: string;
                document_count: number;
                benefit: number;
                last_seen: string;
                recent_mass: number;
                evidence_count: number;
                ordinary_document_count: number;
                spelling_count: number;
              }
            | undefined;
          const spellingCount = text === spelling.text ? spelling.document_count : 0;
          const count = (prior?.document_count ?? 0) + (isNew ? 1 : 0);
          const freshEvidence = oldSpelling === null;
          const evidenceCount = (prior?.evidence_count ?? 0) + (freshEvidence ? 1 : 0);
          const automated = doc.automatedEvidence === true ? 1 : 0;
          const ordinaryDelta = isAuthored
            ? 0
            : observation.observed_automated === null
              ? automated
                ? 0
                : 1
              : observation.observed_automated === automated
                ? 0
                : automated
                  ? -1
                  : 1;
          const ordinaryCount = Math.max(0, (prior?.ordinary_document_count ?? 0) + ordinaryDelta);
          if (!isAuthored && observation.observed_automated !== automated)
            observeAutomated.run(automated, doc.id, scope.kind, scope.key, term.term);
          const benefit =
            text === spelling.text ? spelling.benefit : vocabularySpellingBenefit(text);
          const lastSeen = prior && prior.last_seen > recordedAt ? prior.last_seen : recordedAt;
          const oldDate = observation.observed_at;
          const observationDate = oldDate && oldDate > recordedAt ? oldDate : recordedAt;
          const massChanged = isAuthored && oldDate !== observationDate;
          const mass = isAuthored
            ? Math.max(
                0,
                (prior?.recent_mass ?? 0) * authoredDecay(prior?.last_seen ?? lastSeen, lastSeen) +
                  (massChanged
                    ? authoredDecay(observationDate, lastSeen) -
                      (oldDate ? authoredDecay(oldDate, lastSeen) : 0)
                    : 0),
              )
            : (prior?.recent_mass ?? 0);
          if (massChanged) observeAt.run(observationDate, doc.id, scope.kind, scope.key, term.term);
          if (
            !isNew &&
            !massChanged &&
            !freshEvidence &&
            ordinaryDelta === 0 &&
            prior &&
            prior.spelling_count === spellingCount &&
            prior.text === text &&
            prior.benefit === benefit &&
            prior.last_seen === lastSeen
          )
            continue;
          upsert.run(
            scope.kind,
            scope.key,
            term.term,
            text,
            count,
            benefit,
            // Keep uncorroborated candidates out of the indexed top stream;
            // filtering only after LIMIT would let singletons hide useful hints.
            isAuthored
              ? count >= MIN_VOCABULARY_DOCUMENTS && mass > 0
                ? // A fixed-epoch logarithm orders decayed support without
                  // periodically rewriting every term or overflowing exp().
                  Math.log(mass) +
                  (Date.parse(lastSeen) * Math.LN2) / (86400000 * AUTHORED_HALF_LIFE_DAYS)
                : -1e300
              : count >= MIN_VOCABULARY_DOCUMENTS
                ? benefit * Math.log1p(count)
                : 0,
            lastSeen,
            mass,
            evidenceCount,
            ordinaryCount,
            spellingCount,
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
