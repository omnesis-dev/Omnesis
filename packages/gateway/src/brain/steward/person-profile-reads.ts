// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { KnowledgeStorageError } from "../knowledge/types.js";
import {
  getPersonProfileFingerprint,
  listPersonAnnotationEvidence,
  DEFAULT_PERSON_PROFILE_BUDGET,
  getReadablePersonProfileStats,
  listLivePersonAnnotationsForPerson,
  type PersonProfileBudget,
} from "../storage/person-annotations.js";
import type Database from "better-sqlite3";

export const MAX_PERSON_PROFILE_PAGE_BYTES = 32_768;

/** Run-local complete-profile receipts. A later page alone never grants a complete read. */
export class PersonProfileReads {
  private readonly reads = new Map<string, { fingerprint: string; nextCursor: string | null }>();
  constructor(private readonly db: Database.Database) {}

  page(
    personId: string,
    limit: number,
    cursor?: string,
    budget: PersonProfileBudget = DEFAULT_PERSON_PROFILE_BUDGET,
  ) {
    return this.db.transaction(() => {
      const fingerprint = getPersonProfileFingerprint(this.db, personId);
      let before: { sortAt: number; id: string } | undefined;
      if (cursor !== undefined) {
        const read = this.reads.get(personId);
        if (!read || read.fingerprint !== fingerprint || read.nextCursor !== cursor)
          throw this.conflict();
        try {
          const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
          if (
            parsed.personId !== personId ||
            parsed.fingerprint !== fingerprint ||
            typeof parsed.id !== "string" ||
            !parsed.id ||
            typeof parsed.sortAt !== "number" ||
            !Number.isFinite(parsed.sortAt)
          )
            throw this.conflict();
          before = { sortAt: parsed.sortAt, id: parsed.id };
        } catch {
          throw this.conflict();
        }
      }
      const rows = listLivePersonAnnotationsForPerson(this.db, personId, {
        limit: limit + 1,
        before,
      });
      const stats = getReadablePersonProfileStats(this.db, personId);
      const projected = rows.slice(0, limit).map((row) => ({
        id: row.id,
        claimType: row.claimType,
        claimText: row.claimText,
        evidenceDocId: row.evidenceDocId,
        evidenceQuote: row.evidenceQuote,
        confidence: row.confidence,
        createdAt: new Date(row.createdAt).toISOString(),
        evidence: listPersonAnnotationEvidence(this.db, row.id).map((atom) => ({
          docId: atom.evidenceDocId,
          quote: atom.evidenceQuote,
        })),
      }));
      let count = Math.min(rows.length, limit);
      while (true) {
        const selected = rows.slice(0, count);
        const last = selected.at(-1);
        const nextCursor =
          rows.length > count && last
            ? Buffer.from(
                JSON.stringify({
                  personId,
                  fingerprint,
                  sortAt: last.updatedAt ?? last.createdAt,
                  id: last.id,
                }),
              ).toString("base64url")
            : null;
        const data = {
          personId,
          annotations: projected.slice(0, count),
          profile: {
            ...stats,
            readComplete: nextCursor === null,
            budget: { maxFacts: budget.maxFacts, maxCharacters: budget.maxCharacters },
            overBudget:
              stats.totalFacts > budget.maxFacts || stats.totalCharacters > budget.maxCharacters,
          },
          nextCursor,
          truncated: nextCursor !== null,
        };
        if (
          Buffer.byteLength(
            JSON.stringify({ kind: "structured", resultType: "annotation.search_results", data }),
            "utf8",
          ) <= MAX_PERSON_PROFILE_PAGE_BYTES
        ) {
          this.reads.set(personId, { fingerprint, nextCursor });
          return data;
        }
        if (count <= 1) {
          this.reads.delete(personId);
          throw new KnowledgeStorageError(
            "revision_conflict",
            "A profile fact exceeds the bounded complete-read page. Its text and evidence were not truncated and no complete-profile receipt was granted. Inspect or retire it through its canonical owner tools before reconciling this profile.",
          );
        }
        count--;
      }
    })();
  }

  require(personId: string, budget: PersonProfileBudget): PersonProfileBudget {
    const read = this.reads.get(personId);
    if (
      !read ||
      read.nextCursor !== null ||
      read.fingerprint !== getPersonProfileFingerprint(this.db, personId)
    )
      throw this.conflict();
    return { ...budget, expectedProfileFingerprint: read.fingerprint };
  }

  private conflict(): KnowledgeStorageError {
    return new KnowledgeStorageError(
      "revision_conflict",
      "Read the person's complete current profile with annotation_search({personId}), following each exact nextCursor before creating, consolidating, revising or withdrawing a person fact. If the profile changed, start again without a cursor. Compare all useful facts; do not keep only the first page or invent a replacement to fit the budget.",
    );
  }
}
