// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Work moved off the writer, or sliced on it, leaves the same rows as the
 * single-handle, single-transaction version it replaces:
 *
 * - collapsed merge candidates found on a read-only handle, re-checked and
 *   accepted by the writer in chunks — and an undo landing in between keeps
 *   the candidate pending;
 * - the people backfill stopped between documents and resumed.
 *
 * Twin databases are seeded from the same invented corpus.
 */

import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { afterEach, describe, expect, test } from "vitest";
import { createDatabase } from "../db.js";
import { backfillManyPeople } from "../domain/PeopleResolutionService.js";
import {
  acceptCollapsedMergeCandidates,
  COLLAPSED_ACCEPT_CHUNK,
  findCollapsedMergeCandidates,
  sweepCollapsedMergeCandidates,
} from "../merge-candidates.js";
import { pilotEmail, seedPilotCorpus, type PilotCorpus } from "./__fixtures__/pilot-corpus.js";

type Db = Database.Database;

const opened: Array<{ db: Db; path: string }> = [];

function twin(options: Parameters<typeof seedPilotCorpus>[1]): {
  db: Db;
  path: string;
  corpus: PilotCorpus;
} {
  const path = `/tmp/omnesis-test-${randomUUID()}.db`;
  const db = createDatabase(path) as unknown as Db;
  const corpus = seedPilotCorpus(db, options);
  opened.push({ db, path });
  return { db, path, corpus };
}

function reader(path: string): Db {
  const db = new Database(path, { readonly: true });
  opened.push({ db, path: "" });
  return db;
}

afterEach(() => {
  for (const { db, path } of opened.splice(0).reverse()) {
    if (db.open) db.close();
    if (path)
      for (const suffix of ["", "-wal", "-shm", "-journal"])
        if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
});

function candidateStatuses(db: Db): string[] {
  return db
    .prepare<[], { id: string; status: string; rule_id: string | null }>(
      "SELECT id, status, rule_id FROM merge_candidates ORDER BY id",
    )
    .all()
    .map((r) => `${r.id}:${r.status}:${r.rule_id ?? "-"}`);
}

describe("collapsed merge candidates found on a reader", () => {
  test("accept, in chunks, exactly what the single-handle sweep accepts", () => {
    const single = twin({ docs: 6_000, pendingCandidates: 400, collapsedEvery: 2 });
    const split = twin({ docs: 6_000, pendingCandidates: 400, collapsedEvery: 2 });
    expect(single.corpus.collapsedCandidateIds.length).toBeGreaterThan(COLLAPSED_ACCEPT_CHUNK * 2);

    const swept = sweepCollapsedMergeCandidates(single.db).swept;
    expect(swept).toBe(single.corpus.collapsedCandidateIds.length);

    const found = findCollapsedMergeCandidates(reader(split.path));
    expect(found.sort()).toEqual([...split.corpus.collapsedCandidateIds].sort());
    let chunks = 0;
    let total = 0;
    let remaining = found;
    while (remaining.length > 0) {
      let asked = 0;
      const result = acceptCollapsedMergeCandidates(split.db, remaining, {
        shouldStop: () => ++asked > 0,
      });
      total += result.swept;
      remaining = result.remaining;
      chunks += 1;
    }
    expect(chunks).toBe(Math.ceil(found.length / COLLAPSED_ACCEPT_CHUNK));
    expect(total).toBe(swept);
    const strip = (rows: string[]) => rows.map((r) => r.replace(/:accepted:-$/, ":accepted"));
    expect(strip(candidateStatuses(split.db))).toEqual(strip(candidateStatuses(single.db)));
  });

  test("a candidate whose sides came apart after the read stays pending", () => {
    const { db, path, corpus } = twin({ docs: 600, pendingCandidates: 40, collapsedEvery: 2 });
    const found = findCollapsedMergeCandidates(reader(path));
    expect(found.length).toBeGreaterThan(1);
    const [undone, ...kept] = found;
    const sides = db
      .prepare<[string], { side_b_alias: string }>(
        "SELECT side_b_alias FROM merge_candidates WHERE id = ?",
      )
      .get(undone)!;
    db.prepare(
      `INSERT INTO people (id, canonical_name, source, first_seen, last_seen, created_at, updated_at)
       VALUES ('synth-person-split', 'synth contact split', 'synth-mail-work', '2026-10-01', '2026-10-01', '2026-10-01', '2026-10-01')`,
    ).run();
    db.prepare(
      "UPDATE person_aliases SET person_id = 'synth-person-split' WHERE alias_type = 'email' AND alias = ?",
    ).run(sides.side_b_alias);

    expect(acceptCollapsedMergeCandidates(db, found).swept).toBe(kept.length);
    const status = db.prepare<[string], { status: string }>(
      "SELECT status FROM merge_candidates WHERE id = ?",
    );
    expect(status.get(undone)!.status).toBe("pending");
    for (const id of kept) expect(status.get(id)!.status).toBe("accepted");
    expect(corpus.collapsedCandidateIds).toContain(undone);
  });
});

function resolvedGraph(db: Db): string[] {
  return db
    .prepare<[], { document_id: string; alias: string; role: string }>(
      `SELECT dp.document_id, pa.alias, dp.role
         FROM document_people dp
         JOIN person_aliases pa ON pa.person_id = dp.person_id AND pa.alias_type = 'email'
        WHERE pa.alias LIKE 'person%@example.com'
        ORDER BY 1, 2, 3`,
    )
    .all()
    .map((r) => `${r.document_id}|${r.alias}|${r.role}`);
}

describe("people backfill stopped between documents", () => {
  test("resumes to the same people graph as one uninterrupted batch", () => {
    const whole = twin({ docs: 1_500, unresolvedDocs: 30 });
    const sliced = twin({ docs: 1_500, unresolvedDocs: 30 });

    expect(backfillManyPeople(whole.db, 30)).toMatchObject({ processed: 30, stopped: false });

    let processed = 0;
    let calls = 0;
    let owed = 30;
    while (owed > 0) {
      let asked = 0;
      const r = backfillManyPeople(sliced.db, owed, { shouldStop: () => ++asked >= 4 });
      processed += r.processed;
      owed -= r.processed;
      calls += 1;
      if (!r.stopped) break;
    }
    expect(processed).toBe(30);
    expect(calls).toBeGreaterThan(5);
    const unresolved = (db: Db) =>
      db
        .prepare<[], { n: number }>(
          "SELECT COUNT(*) AS n FROM documents WHERE people_resolved_at IS NULL",
        )
        .get()!.n;
    expect(unresolved(sliced.db)).toBe(0);
    expect(unresolved(whole.db)).toBe(0);
    expect(resolvedGraph(sliced.db)).toEqual(resolvedGraph(whole.db));
    expect(resolvedGraph(sliced.db).some((row) => row.includes(pilotEmail(0)))).toBe(true);
  });

  test("a batch that runs out of documents is not stopped", () => {
    const { db } = twin({ docs: 300, unresolvedDocs: 5 });
    expect(backfillManyPeople(db, 50, { shouldStop: () => false })).toMatchObject({
      processed: 5,
      stopped: false,
    });
  });
});
