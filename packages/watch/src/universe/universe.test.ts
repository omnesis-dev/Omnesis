// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The universe has to describe a world the ontology permits.
 *
 * A fixture journal is only worth something if it could have come out of a real
 * materializer, and the fastest way for it to stop being that is to drift: a
 * source that stops declaring a metadata field, a role a normalizer never
 * writes, a table column renamed. These checks make that drift a test failure
 * rather than a golden trace that quietly asserts the wrong thing.
 *
 * The last group is different in kind. It asserts that the awkward cases are
 * *present* — a backfilled event, a revised row, a merged person, an outage
 * across a deadline. Those are the cases the runtime is most likely to get
 * wrong, and a fixture that lost one would still pass every other check here
 * while silently no longer testing anything hard.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { readJournal } from "../journal/read.js";
import { isKind, type JournalEvent } from "../journal/event.js";
import { AnalyticsDatabase } from "./analytics.js";
import { analyticsDir, journalPath, loadOntology } from "./paths.js";

const ontology = loadOntology();
const journal = readJournal(journalPath());

/** Tables a projection maintains rather than a source ingesting into them. */
const SYSTEM_OWNED_TABLES: ReadonlySet<string> = new Set(["people"]);

function sortRows(rows: readonly Record<string, unknown>[]): string[] {
  return rows.map((row) => JSON.stringify(row)).sort();
}

function docEvents(): Extract<JournalEvent, { kind: "doc.event" }>[] {
  return journal.filter((e) => isKind(e, "doc.event"));
}

describe("the poc journal", () => {
  it("is a journal at all — parsed, dense, and forward-only", () => {
    // `readJournal` throws on a gap or a backwards `observedAt`; reaching here
    // is the assertion. The count guards against a truncated regeneration.
    expect(journal.length).toBeGreaterThan(100);
    expect(journal[0]!.seq).toBe(1);
    expect(journal.at(-1)!.seq).toBe(journal.length);
  });

  it("only ever names sources the ontology declares", () => {
    for (const event of docEvents()) {
      expect(ontology.source(event.payload.sourceId), event.payload.sourceId).toBeDefined();
    }
  });

  it("only emits document types and person roles those sources declare", () => {
    for (const event of docEvents()) {
      const source = ontology.source(event.payload.sourceId)!;
      const types = source.profile.documentTypes ?? [];
      if (types.length > 0) expect(types).toContain(event.payload.documentType);

      const roles = source.profile.personRoles ?? [];
      for (const person of event.payload.people) {
        expect(roles, `${event.payload.sourceId} role ${person.role}`).toContain(person.role);
      }
    }
  });

  it("only carries metadata fields those sources declare", () => {
    for (const event of docEvents()) {
      for (const path of flatten(event.payload.metadata)) {
        expect(
          ontology.metadataField(event.payload.sourceId, path),
          `${event.payload.sourceId} declares metadata.${path}`,
        ).toBeDefined();
      }
    }
  });

  it("names only people in the directory", () => {
    for (const event of docEvents()) {
      for (const person of event.payload.people) {
        if (person.personId === null) continue;
        expect(ontology.person(person.personId), person.personId).toBeDefined();
      }
    }
  });

  it("writes analytics rows only to catalogued tables, and only declared columns", () => {
    for (const event of journal) {
      if (!isKind(event, "analytics.row")) continue;
      const table = ontology.table(event.payload.table);
      expect(table, event.payload.table).toBeDefined();
      const declared = new Set(table!.columns.map((c) => c.name));
      for (const column of Object.keys(event.payload.row)) {
        expect(declared, `${event.payload.table}.${column}`).toContain(column);
      }
      for (const column of Object.keys(event.payload.pk)) {
        expect(table!.primaryKey, `${event.payload.table} pk`).toContain(column);
      }
    }
  });

  it("indexes only documents it also emitted, and never before emitting them", () => {
    // A document can be emitted more than once — a create followed by updates
    // that revise it. An index belongs after the document first existed, not
    // after the most recent revision, which may itself still be to come.
    const emitted = new Map<string, number>();
    for (const event of docEvents()) {
      if (!emitted.has(event.payload.docId)) emitted.set(event.payload.docId, event.seq);
    }
    for (const event of journal) {
      if (!isKind(event, "doc.indexed")) continue;
      const docSeq = emitted.get(event.payload.docId);
      expect(docSeq, event.payload.docId).toBeDefined();
      // Embeddings land on a later clock than the document. Never an earlier one.
      expect(event.seq).toBeGreaterThan(docSeq!);
    }
  });

  it("indexes every document from a semantically-indexed source, and no others", () => {
    const indexed = new Set(
      journal.filter((e) => isKind(e, "doc.indexed")).map((e) => e.payload.docId),
    );
    for (const event of docEvents()) {
      const source = ontology.source(event.payload.sourceId)!;
      expect(
        indexed.has(event.payload.docId),
        `${event.payload.sourceId} ${event.payload.docId}`,
      ).toBe(source.semanticallyIndexed);
    }
  });
});

describe("the awkward cases the runtime has to survive", () => {
  it("contains an event whose semantic time precedes an earlier-observed one", () => {
    const backfilled = journal.filter((event, i) => {
      const previous = journal[i - 1];
      return (
        previous !== undefined && Date.parse(event.occurredAt) < Date.parse(previous.occurredAt)
      );
    });
    expect(backfilled.length).toBeGreaterThan(0);
  });

  it("contains an analytics row revised in place under a key already seen", () => {
    const seen = new Set<string>();
    const revised = journal.filter((event) => {
      if (!isKind(event, "analytics.row")) return false;
      const key = `${event.payload.table}:${JSON.stringify(event.payload.pk)}`;
      const isRevision = event.payload.op === "updated" && seen.has(key);
      seen.add(key);
      return isRevision;
    });
    expect(revised.length).toBeGreaterThan(0);
  });

  it("never redelivers an unchanged row — the journal is post-dedup", () => {
    const seen = new Map<string, string>();
    for (const event of journal) {
      if (!isKind(event, "analytics.row")) continue;
      const key = `${event.payload.table}:${JSON.stringify(event.payload.pk)}`;
      const row = JSON.stringify(event.payload.row);
      expect(seen.get(key), `unchanged redelivery of ${key}`).not.toBe(row);
      seen.set(key, row);
    }
  });

  it("names one human by two ids, the merged one only before the merge", () => {
    const merged = ontology.snapshot.people.find((p) => p.mergedInto !== null);
    expect(merged, "the directory declares a merged person").toBeDefined();

    // Scope to the one conversation where the same human is named by both ids.
    // Elsewhere the canonical id is used throughout, which is what makes this
    // conversation the interesting one: within it, the id changes mid-stream.
    const inChat = (personId: string) =>
      docEvents().filter(
        (e) =>
          (e.payload.metadata.extra as { chatJid?: string } | undefined)?.chatJid === "chat-maya" &&
          e.payload.people.some((p) => p.personId === personId),
      );

    const before = inChat(merged!.id);
    const after = inChat(merged!.mergedInto!);
    expect(before.length, "the pre-merge id appears").toBeGreaterThan(0);
    expect(after.length, "the canonical id appears").toBeGreaterThan(0);
    // The merge sits between them: the old id is never used again afterwards.
    expect(Math.max(...before.map((e) => e.seq))).toBeLessThan(
      Math.min(...after.map((e) => e.seq)),
    );

    // And both resolve to the same human, which is the property a keyed watch
    // depends on to avoid splitting into two instances.
    expect(ontology.canonicalPersonId(merged!.id)).toBe(
      ontology.canonicalPersonId(merged!.mergedInto!),
    );
  });

  it("contains an outage long enough to swallow a deadline", () => {
    let longest = 0;
    for (let i = 1; i < journal.length; i++) {
      const gap = Date.parse(journal[i]!.observedAt) - Date.parse(journal[i - 1]!.observedAt);
      longest = Math.max(longest, gap);
    }
    // Longer than a day, so a wait armed before it comes due inside it.
    expect(longest).toBeGreaterThan(86_400_000);
  });
});

describe("the analytics rows and the journal agree", () => {
  /**
   * The row files are the state the journal's analytics events add up to. They
   * are generated together, so nothing stops them drifting apart except this:
   * a regeneration that touched one and not the other passes every other check
   * in this file.
   */
  it("holds exactly the final state of every row the journal reports", () => {
    const final = new Map<string, Record<string, unknown>>();
    for (const event of journal) {
      if (!isKind(event, "analytics.row")) continue;
      final.set(`${event.payload.table}:${JSON.stringify(event.payload.pk)}`, event.payload.row);
    }

    for (const table of ontology.snapshot.analyticsTables) {
      const path = join(analyticsDir(), `${table.tableName}.json`);
      const rows: Record<string, unknown>[] = existsSync(path)
        ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>[])
        : [];

      const fromJournal = [...final.entries()]
        .filter(([key]) => key.startsWith(`${table.tableName}:`))
        .map(([, row]) => row);

      if (SYSTEM_OWNED_TABLES.has(table.tableName)) {
        // A projection the system maintains, not a source ingest. It has rows
        // and deliberately no events; asserting that keeps the exception
        // visible rather than letting any table quietly opt out.
        expect(fromJournal, `${table.tableName} emits no events`).toEqual([]);
        expect(rows.length, `${table.tableName} still has rows`).toBeGreaterThan(0);
        continue;
      }

      expect(sortRows(rows), table.tableName).toEqual(sortRows(fromJournal));
    }
  });
});

describe("the analytics database", () => {
  it("materializes from the declared schemas and answers real SQL", async () => {
    const db = await AnalyticsDatabase.materialize(ontology, analyticsDir());
    try {
      const result = await db.query(
        "SELECT count(*) AS n FROM health_vitals WHERE metric_slug = 'resting_hr' AND value > 70",
      );
      expect(Number(result.rows[0]!.n)).toBeGreaterThan(20);
    } finally {
      db.close();
    }
  });

  it("binds DSL references as parameters rather than interpolating them", async () => {
    const db = await AnalyticsDatabase.materialize(ontology, analyticsDir());
    try {
      const result = await db.query(
        "SELECT sum(amount) AS total FROM plaid_transactions WHERE category LIKE '%Restaurants%' AND date <= $today",
        { $today: "2026-03-31" },
      );
      // 120.00 + 185.40 + 250.75, with the pending row revised rather than doubled.
      expect(Number(result.rows[0]!.total)).toBeCloseTo(556.15, 2);
    } finally {
      db.close();
    }
  });

  it("joins the projected graph tables the sqlite store is off-limits for", async () => {
    const db = await AnalyticsDatabase.materialize(ontology, analyticsDir());
    try {
      const result = await db.query(
        "SELECT p.canonical_name AS who FROM google_calendar_events e " +
          "JOIN google_calendar_attendees a ON a.event_id = e.id " +
          "JOIN people p ON p.id = a.person_id " +
          "WHERE NOT p.is_self AND p.last_seen < $now - INTERVAL 1 YEAR",
        { $now: "2026-03-24T09:00:00Z" },
      );
      // One row per meeting she is on, and nobody else: every other person in
      // the diary was seen this week.
      expect(result.rows.map((r) => r.who)).toEqual(["Priya Raman", "Priya Raman", "Priya Raman"]);
    } finally {
      db.close();
    }
  });

  it("refuses to run a query whose references were not all supplied", async () => {
    const db = await AnalyticsDatabase.materialize(ontology, analyticsDir());
    try {
      await expect(
        db.query("SELECT $today AS d, $key.month AS m", { $today: "2026-03-01" }),
      ).rejects.toThrow(/\$key\.month/);
    } finally {
      db.close();
    }
  });
});

/** Dotted paths of every leaf in a metadata object. */
function flatten(value: Record<string, unknown>, prefix = ""): string[] {
  const paths: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (child !== null && typeof child === "object" && !Array.isArray(child)) {
      paths.push(...flatten(child as Record<string, unknown>, path));
    } else {
      paths.push(path);
    }
  }
  return paths;
}
