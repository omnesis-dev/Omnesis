// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What the install declares, and what moves the fingerprint.
 *
 * The fingerprint is the drift alarm: a watch records the one it validated
 * against, and the runtime pauses any watch whose install has moved. That makes
 * *what is left out of it* the load-bearing decision. Two fields look
 * declarative and are not — the person directory and provider ownership are
 * both read from the corpus — and folding either in would move the fingerprint
 * on an ordinary sync and pause every watch in the install.
 *
 * The other property here is that a real install is messier than a fixture, and
 * one row it cannot describe must not take the ontology down with it.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";

import { runSchemaSetup } from "../data/schema.js";
import {
  buildOntologySnapshot,
  coverageAlarm,
  LiveOntology,
  promptPeopleDirectory,
} from "./ontology.js";
import type { Db } from "../data/types.js";

let db: Db;

const DEPS = () => ({ db, analyticsDb: null, semanticallyIndexed: () => true });

/**
 * An analytics store that reports exactly the tables a test names.
 *
 * The catalog is the half of the ontology this file could not previously
 * exercise — `analyticsDb: null` describes an install with no analytics at all,
 * which is the one shape where a table can never be dropped.
 */
function depsWithTables(tables: { tableName: string; schema: Record<string, unknown> }[]) {
  const analyticsDb = {
    getCatalog: () =>
      Promise.resolve(
        tables.map((t) => ({ tableName: t.tableName, description: `about ${t.tableName}` })),
      ),
    getRecordTableSchema: (name: string) => {
      const found = tables.find((t) => t.tableName === name);
      return Promise.resolve(
        found ? { tableName: name, displayName: name, ...found.schema } : null,
      );
    },
  };
  return { db, analyticsDb, semanticallyIndexed: () => true } as unknown as ReturnType<typeof DEPS>;
}

function declareSource(sourceType: string, documentTypes: string[]): void {
  db.prepare(
    `INSERT INTO source_document_profiles (source_type, profile_json, published_at)
     VALUES (?, ?, '2026-01-01T00:00:00Z')
       ON CONFLICT(source_type) DO UPDATE SET profile_json = excluded.profile_json`,
  ).run(sourceType, JSON.stringify({ documentTypes, personRoles: ["sender"], metadataFields: [] }));
}

function addPerson(id: string, name: string): void {
  db.prepare(
    `INSERT INTO people (id, canonical_name, source, is_self, first_seen, last_seen, created_at, updated_at)
     VALUES (?, ?, 'test', 0, '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01')`,
  ).run(id, name);
}

/** A source the install has, on a device it has, with nothing synced yet. */
function connectSource(type: string, accountId: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO devices (id, name, kind, paired_at)
     VALUES ('dev_1', 'a-collector', 'collector', 0)`,
  ).run();
  db.prepare(
    `INSERT INTO sources (id, type, account_id, device_id, config, enabled, created_at, updated_at)
     VALUES (?, ?, ?, 'dev_1', '{}', 1, 0, 0)`,
  ).run(`${type}:${accountId}`, type, accountId);
}

function addDocument(id: string, providerId: string, sourceId: string): void {
  db.prepare(
    `INSERT INTO documents (id, provider_id, source_id, external_id, title, content, content_hash,
                            metadata, source_created_at, source_updated_at, ingested_at, updated_at)
     VALUES (?, ?, ?, ?, 't', '', 'h', '{}', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z',
             '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
  ).run(id, providerId, sourceId, id);
}

beforeEach(() => {
  db = new Database(":memory:") as unknown as Db;
  runSchemaSetup(db);
  declareSource("gmail", ["email"]);
});

afterEach(() => {
  db.close();
});

describe("the sources a watch cannot name", () => {
  it("names a source the corpus holds and no profile describes", async () => {
    // The real gap on a live install: connected, syncing, searchable — and
    // absent from the watch ontology, because nothing has said what one of its
    // events looks like.
    addDocument("11111111-2222-4333-8444-555555555551", "google", "gmail");
    addDocument("11111111-2222-4333-8444-555555555552", "fictional", "fictional-ledger");

    const snapshot = await buildOntologySnapshot(DEPS());

    expect(snapshot.unwatchableSources).toEqual(["fictional-ledger"]);
    expect(
      (snapshot.sources as { sourceId: string }[]).map((s) => s.sourceId),
      "a source with no profile was described as watchable",
    ).toEqual(["gmail"]);
  });

  it("does not name a source that publishes a profile", async () => {
    declareSource("fictional-ledger", ["receipt"]);
    addDocument("11111111-2222-4333-8444-555555555553", "fictional", "fictional-ledger");

    expect((await buildOntologySnapshot(DEPS())).unwatchableSources).toEqual([]);
  });

  it("names a source that is connected and has synced nothing yet", async () => {
    // The moment its owner is most likely to ask a watch about it, and the
    // corpus knows nothing about it — so a list derived from documents alone
    // would tell them to go and connect what they connected a minute ago.
    connectSource("fictional-ledger", "acct-1");

    expect((await buildOntologySnapshot(DEPS())).unwatchableSources).toEqual(["fictional-ledger"]);
  });

  it("names a source whose profile the ontology could not read", async () => {
    // Connected, indexed, publishing a profile — and dropped by the parse, so
    // no watch can name it. From the point of view of somebody asking why
    // their watch was refused that is the same answer as publishing none.
    db.prepare(
      `INSERT INTO source_document_profiles (source_type, profile_json, published_at)
       VALUES ('fictional-ledger', ?, '2026-01-01T00:00:00Z')`,
    ).run(JSON.stringify({ documentTypes: [{ not: "a string" }], personRoles: [] }));
    addDocument("11111111-2222-4333-8444-555555555560", "fictional", "fictional-ledger");

    const snapshot = await buildOntologySnapshot(DEPS());

    expect((snapshot.sources as { sourceId: string }[]).map((s) => s.sourceId)).toEqual(["gmail"]);
    expect(snapshot.unwatchableSources).toEqual(["fictional-ledger"]);
  });

  it("keeps the account half of a source id out of the list", async () => {
    // The one line standing between an account id — an email address, a phone
    // number — and the compiler prompt, which renders this list verbatim and
    // may be a cloud model.
    addDocument("11111111-2222-4333-8444-555555555561", "fictional", "ledger:someone@example.com");
    addDocument("11111111-2222-4333-8444-555555555562", "fictional", "ledger:other@example.org");

    expect((await buildOntologySnapshot(DEPS())).unwatchableSources).toEqual(["ledger"]);
  });

  it("survives a source id that is not a well-formed type", async () => {
    // A `write:*` token can put one in the corpus, and before this it took the
    // whole ontology down: an empty type fails the snapshot schema, and the
    // repair loop has no entry to drop for a field that is a difference.
    addDocument("11111111-2222-4333-8444-555555555563", "fictional", ":no-type-at-all");

    const snapshot = await buildOntologySnapshot(DEPS());

    expect(snapshot.unwatchableSources).toEqual([]);
    expect((snapshot.sources as { sourceId: string }[]).map((s) => s.sourceId)).toEqual(["gmail"]);
  });

  it("does not move the fingerprint", async () => {
    // The list grows whenever an operator connects anything at all, and no
    // watch was ever validated against it. In the fingerprint it would pause
    // the whole install on an ordinary setup step.
    const before = (await buildOntologySnapshot(DEPS())).fingerprint;

    addDocument("11111111-2222-4333-8444-555555555554", "fictional", "fictional-ledger");
    const after = await buildOntologySnapshot(DEPS());

    expect(after.unwatchableSources).toEqual(["fictional-ledger"]);
    expect(after.fingerprint).toBe(before);
  });
});

describe("the fingerprint", () => {
  it("does not move when a person is added", async () => {
    // A new contact is not a change to anyone's promise. Folding people in
    // would drift the fingerprint on every sync and pause the whole install.
    const before = (await buildOntologySnapshot(DEPS())).fingerprint;
    addPerson("b3f2a9d4-0000-4000-8000-000000000002", "Maya Reeves");
    const after = await buildOntologySnapshot(DEPS());

    expect(after.fingerprint, "a new contact moved the drift alarm").toBe(before);
    expect(after.people, "the directory did not pick the person up").toHaveLength(1);
  });

  it("does not move when a source produces its first document", async () => {
    // Provider ownership is read from the corpus, so it appears the moment a
    // source syncs anything. Including it would move the fingerprint on a
    // source's first sync — a field that looks declarative and is not.
    const before = (await buildOntologySnapshot(DEPS())).fingerprint;
    addDocument("11111111-2222-4333-8444-555555555555", "google", "gmail");
    const after = await buildOntologySnapshot(DEPS());

    expect(after.fingerprint, "a first sync moved the drift alarm").toBe(before);
    expect(
      (after.sources[0] as { providerId: string }).providerId,
      "the corpus's provider was not picked up",
    ).toBe("google");
  });

  it("moves when a source changes what it declares", async () => {
    // The case the alarm exists for: a filter's meaning depends on the document
    // types a source promises, so a watch written against the old set is not
    // the watch the operator approved.
    const before = (await buildOntologySnapshot(DEPS())).fingerprint;
    declareSource("gmail", ["email", "attachment"]);
    const after = await buildOntologySnapshot(DEPS());

    expect(after.fingerprint, "a changed profile left the drift alarm quiet").not.toBe(before);
  });
});

describe("an install with a row it cannot describe", () => {
  it("drops the row and keeps the rest", async () => {
    // A person with no canonical name is a real thing a real corpus holds. A
    // watch cannot reference them, but every other watch is still valid.
    addPerson("b3f2a9d4-0000-4000-8000-000000000002", "Maya Reeves");
    db.prepare(
      "INSERT INTO people (id, canonical_name, source, is_self, first_seen, last_seen, created_at, updated_at) VALUES (?, '', 'test', 0, '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01')",
    ).run("c4f2a9d4-0000-4000-8000-000000000003");

    const snapshot = await buildOntologySnapshot(DEPS());

    expect(snapshot.people, "the describable person was dropped too").toHaveLength(1);
    expect((snapshot.people[0] as { canonicalName: string }).canonicalName).toBe("Maya Reeves");
  });

  it("raises rather than describing no sources at all", async () => {
    // An empty ontology is a valid one, so it would be accepted — and then
    // every watch in the install would fail its next validation and be paused,
    // durably, with a note about an unknown source and no hint that the install
    // had simply failed to describe itself.
    db.prepare("UPDATE source_document_profiles SET profile_json = ?").run(
      JSON.stringify({ documentTypes: [{ not: "a string" }] }),
    );

    await expect(buildOntologySnapshot(DEPS())).rejects.toThrow(/described none of its/);
  });
});

describe("how much of the install the DSL can address", () => {
  const goodTable = {
    tableName: "payments",
    schema: {
      columns: [{ name: "id", type: "VARCHAR", description: "id" }],
      primaryKey: ["id"],
      semanticTimeColumn: null,
    },
  };

  it("reports coverage as a fraction, not as a warning nobody reads", async () => {
    // A fraction a reader can see is the difference between a silent hole and
    // a question someone asks. A warning is addressed to whoever happens to be
    // reading the log when it is emitted, which on a healthy install is nobody.
    const live = new LiveOntology(depsWithTables([goodTable]));
    expect(live.coverage(), "coverage was claimed before anything was assembled").toBeNull();
    await live.current();
    const coverage = live.coverage();
    expect(coverage).not.toBeNull();
    expect(coverage?.tablesDescribed).toBe(1);
    expect(coverage?.tablesTotal).toBe(1);
    expect(coverage?.unknownColumnKeys).toEqual([]);
  });

  it("keeps a table whose column carries a key it does not model, and names the key", async () => {
    // Both halves at once: the table survives, and the unmodelled key is
    // counted rather than discovered later by someone wondering why a watch
    // cannot be written against it.
    const live = new LiveOntology(
      depsWithTables([
        {
          tableName: "future_table",
          schema: {
            columns: [{ name: "id", type: "VARCHAR", description: "id", shippedNextYear: true }],
            primaryKey: ["id"],
            semanticTimeColumn: null,
          },
        },
      ]),
    );
    const snapshot = await live.current();
    expect(
      snapshot.analyticsTables.some((t) => t.tableName === "future_table"),
      "a table was dropped over a key nothing reads",
    ).toBe(true);
    expect(live.coverage()?.unknownColumnKeys).toContain("shippedNextYear");
  });

  it("counts a table lost before the parse, not only one the parse rejected", async () => {
    // The denominator has to be what the catalog holds. A table dropped for
    // having no primary key never reaches the parse, so a count taken after
    // that filter would report full coverage of an install that had quietly
    // lost most of its tables — the exact shape of claim this metric exists to
    // make impossible.
    const live = new LiveOntology(
      depsWithTables([
        goodTable,
        {
          tableName: "no_key",
          schema: {
            columns: [{ name: "id", type: "VARCHAR", description: "id" }],
            primaryKey: [],
            semanticTimeColumn: null,
          },
        },
      ]),
    );
    await live.current();
    const coverage = live.coverage();
    expect(coverage?.tablesTotal, "a pre-parse loss went missing from the denominator").toBe(2);
    expect(coverage?.tablesDescribed).toBe(1);
  });

  it("counts a table it genuinely cannot describe", async () => {
    // A column type outside the closed set is a table the validator has no
    // shape for, so dropping it is right — and saying how many were dropped is
    // what the last gap never did.
    const live = new LiveOntology(
      depsWithTables([
        goodTable,
        {
          tableName: "unreadable",
          schema: {
            columns: [{ name: "id", type: "MONEY", description: "id" }],
            primaryKey: ["id"],
            semanticTimeColumn: null,
          },
        },
      ]),
    );
    await live.current();
    const coverage = live.coverage();
    expect(coverage?.tablesTotal).toBe(2);
    expect(coverage?.tablesDescribed).toBe(1);
  });
});

/**
 * The alarm the fingerprint cannot raise.
 *
 * A watch pauses when its ontology fingerprint moves, which is meant to stop it
 * answering a question the world no longer supports. The fingerprint is hashed
 * over the *declared* surface, before the parse — so a table lost in the parse
 * is invisible to it, and 48 of 52 once went missing with the hash unchanged
 * from beginning to end. Coverage is the measurement that saw it; this is the
 * measurement acting.
 */
describe("coverage as an alarm rather than a number to notice", () => {
  const describable = (name: string) => ({
    tableName: name,
    schema: {
      columns: [{ name: "id", type: "VARCHAR", description: "id" }],
      primaryKey: ["id"],
      semanticTimeColumn: null,
    },
  });
  /** A table the parse must reject: `MONEY` is outside the closed type set. */
  const opaque = (name: string) => ({
    tableName: name,
    schema: {
      columns: [{ name: "id", type: "MONEY", description: "id" }],
      primaryKey: ["id"],
      semanticTimeColumn: null,
    },
  });

  it("says nothing at all when the whole install is addressable", async () => {
    const live = new LiveOntology(depsWithTables([describable("payments")]));
    await live.current();
    const coverage = live.coverage()!;
    expect(coverage.complete).toBe(true);
    expect(coverage.regressed).toBe(false);
    expect(coverageAlarm(coverage), "a healthy install raised an alarm").toBeNull();
  });

  it("names the numbers when part of the install cannot be described", async () => {
    const live = new LiveOntology(depsWithTables([describable("payments"), opaque("ledger")]));
    await live.current();
    const coverage = live.coverage()!;
    expect(coverage.complete).toBe(false);
    // The numbers, not an adjective. "Partly describable" is what the previous
    // version of this gap said for weeks, and it read as benign every time.
    expect(coverageAlarm(coverage)).toContain("1/2 analytics table(s)");
  });

  it("catches a fall that never reached full, which `complete` alone would miss", async () => {
    // The live shape of the bug: an install that could always describe some of
    // its tables and then, after a schema change, describes fewer. Nothing about
    // that install was ever complete, so an alarm keyed only on completeness
    // would have been firing before and after and said nothing about the fall.
    const tables = [describable("payments"), describable("ledger"), opaque("blob")];
    const live = new LiveOntology(depsWithTables(tables), { refreshMs: 0 });
    await live.current();
    expect(live.coverage()!.tablesDescribed).toBe(2);
    expect(live.coverage()!.regressed, "the first assembly cannot be a fall").toBe(false);

    // A column type the parse has no shape for arrives on a table that had one.
    tables[1] = opaque("ledger");
    addPerson("p-1", "Maya Reeves"); // moves the assembly key, so it rebuilds
    await live.current();

    const coverage = live.coverage()!;
    expect(coverage.tablesDescribed).toBe(1);
    expect(coverage.regressed, "a table lost since the last build went unremarked").toBe(true);
    expect(coverageAlarm(coverage)).toContain("ontology coverage fell");
  });

  it("does not call an install that shrank a fall", async () => {
    // A table dropped from the catalog lowers the describable count without
    // anything having stopped being describable. Measuring what *can* be
    // described rather than what cannot would raise the alarm on an ordinary
    // removal — and an alarm that fires on ordinary events is one that gets
    // ignored before the day it matters.
    const tables = [describable("payments"), describable("ledger")];
    const live = new LiveOntology(depsWithTables(tables), { refreshMs: 0 });
    await live.current();

    tables.pop();
    addPerson("p-3", "David Lin");
    await live.current();

    const coverage = live.coverage()!;
    expect(coverage.tablesDescribed).toBe(1);
    expect(coverage.tablesTotal).toBe(1);
    expect(coverage.complete).toBe(true);
    expect(coverage.regressed, "a removed table read as a lost one").toBe(false);
    expect(coverageAlarm(coverage)).toBeNull();
  });

  it("does not call a recovery a fall", async () => {
    const tables = [describable("payments"), opaque("ledger")];
    const live = new LiveOntology(depsWithTables(tables), { refreshMs: 0 });
    await live.current();
    tables[1] = describable("ledger");
    addPerson("p-2", "Jamie Lopez");
    await live.current();

    const coverage = live.coverage()!;
    expect(coverage.tablesDescribed).toBe(2);
    expect(coverage.regressed).toBe(false);
    expect(coverage.complete).toBe(true);
    expect(coverageAlarm(coverage)).toBeNull();
  });
});

describe("conformance with what a real catalog writes", () => {
  /**
   * Table schemas shaped like the ones a live install actually stores.
   *
   * Invented values throughout, but the *shape* is the point: every key here
   * is one an in-tree source really declares on a column, and any single one of
   * them going unmodelled is enough to cost a table its place in the DSL.
   */
  const LIVE_SHAPED = [
    {
      tableName: "vitals",
      schema: {
        columns: [
          { name: "id", type: "VARCHAR", description: "row id", nullable: false },
          {
            name: "metric_slug",
            type: "VARCHAR",
            description: "which metric",
            nullable: false,
            allowedValues: ["hrv", "heart_rate"],
            categoricalRole: "selector",
            valueAliases: { hrv: ["heart rate variability"] },
          },
          { name: "value", type: "DOUBLE", description: "the reading", nullable: true },
          { name: "recorded_at", type: "TIMESTAMPTZ", description: "when", nullable: false },
          { name: "fetched_at", type: "TIMESTAMPTZ", description: "sync stamp", volatile: true },
          { name: "token", type: "VARCHAR", description: "credential", sensitive: true },
          {
            name: "upstream_id",
            type: "VARCHAR",
            description: "source field",
            sourceColumnId: "u.id",
          },
          { name: "amount", type: "DECIMAL(18,4)", description: "money", nullable: true },
        ],
        primaryKey: ["id"],
        semanticTimeColumn: "recorded_at",
      },
    },
    {
      tableName: "visits",
      schema: {
        columns: [
          { name: "id", type: "VARCHAR", description: "row id", nullable: false },
          { name: "country", type: "VARCHAR", description: "where", nullable: true },
          { name: "arrival_time", type: "TIMESTAMPTZ", description: "when", nullable: false },
        ],
        primaryKey: ["id"],
        semanticTimeColumn: "arrival_time",
      },
    },
  ];

  it("describes every table in a live-shaped catalog", async () => {
    // Both of these must describe. The first carries every column property a
    // source may declare; an install where a table like it goes missing has
    // lost that table from the DSL entirely, silently.
    const live = new LiveOntology(depsWithTables(LIVE_SHAPED));
    const snapshot = await live.current();
    expect(snapshot.analyticsTables.map((t) => t.tableName).sort()).toEqual(["visits", "vitals"]);
    const coverage = live.coverage();
    expect(coverage?.tablesDescribed).toBe(coverage?.tablesTotal);
    expect(coverage?.unknownColumnKeys, "a contract key went unmodelled").toEqual([]);
  });
});

describe("the ontology the runtime reads every few seconds", () => {
  it("reuses the indexed snapshot while nothing has moved", async () => {
    const live = new LiveOntology(DEPS());
    const first = await live.current();
    expect(await live.current(), "an unchanged install was described again").toBe(first);
  });

  it("picks up a new person without waiting for the declared surface to refresh", async () => {
    // The half that must never be stale. A watch naming someone who joined
    // since the last rebuild is accepted by the admin route — which builds its
    // own snapshot — and would then be paused by the very next evaluation with
    // PERSON_UNKNOWN. Person-scoped watches are the flagship case.
    let now = 1_000;
    const live = new LiveOntology(DEPS(), { refreshMs: 60_000, now: () => now });
    await live.current();

    addPerson("b3f2a9d4-0000-4000-8000-000000000002", "Jamie Lopez");
    now += 1_000; // well inside the declared-surface refresh interval

    const after = await live.current();
    expect(after.people, "the directory was frozen behind the refresh interval").toHaveLength(1);
  });

  it("rebuilds the declared surface once its interval has passed", async () => {
    let now = 1_000;
    const live = new LiveOntology(DEPS(), { refreshMs: 60_000, now: () => now });
    const before = (await live.current()).fingerprint;

    declareSource("gmail", ["email", "attachment"]);
    expect((await live.current()).fingerprint, "the cache did not hold at all").toBe(before);

    now += 60_000;
    expect((await live.current()).fingerprint, "the cache never expired").not.toBe(before);
  });
});

describe("the fingerprint as a function of content", () => {
  /**
   * Rebuild the same install with a table whose column keys are assembled in a
   * different order — which is what the analytics catalog actually does, having
   * returned a column as both `{name, type, …}` and `{type, name, …}` on one
   * install within minutes.
   */
  function tableWith(columnKeyOrder: "name-first" | "type-first") {
    const column =
      columnKeyOrder === "name-first"
        ? { name: "id", type: "VARCHAR", description: "the row id" }
        : { type: "VARCHAR", name: "id", description: "the row id" };
    return {
      tableName: "screen_time_daily",
      displayName: "Screen time",
      description: "daily totals",
      columns: [column],
      primaryKey: ["id"],
      semanticTimeColumn: null,
    };
  }

  it("does not move when only the key order of the same content moves", async () => {
    // The defect this guards: `JSON.stringify` preserves insertion order, so
    // hashing it made the fingerprint a function of how the layer underneath
    // happened to build its objects. On a live install that paused every watch
    // every few minutes, with a note saying the ontology had changed when it
    // had not.
    const analyticsDb = (order: "name-first" | "type-first") =>
      ({
        getCatalog: () =>
          Promise.resolve([{ tableName: "screen_time_daily", description: "daily totals" }]),
        getRecordTableSchema: () => Promise.resolve(tableWith(order)),
      }) as never;

    const a = await buildOntologySnapshot({ ...DEPS(), analyticsDb: analyticsDb("name-first") });
    const b = await buildOntologySnapshot({ ...DEPS(), analyticsDb: analyticsDb("type-first") });

    expect(b.fingerprint, "the same install hashed to two different values").toBe(a.fingerprint);
  });

  it("still moves when the content genuinely differs", async () => {
    // The guard must not be a blanket "always equal": a real change to what a
    // table declares has to move it, or drift detection stops detecting.
    const withColumns = (columns: { name: string; type: string; description: string }[]) =>
      ({
        getCatalog: () =>
          Promise.resolve([{ tableName: "screen_time_daily", description: "daily totals" }]),
        getRecordTableSchema: () =>
          Promise.resolve({
            tableName: "screen_time_daily",
            displayName: "Screen time",
            description: "daily totals",
            columns,
            primaryKey: ["id"],
            semanticTimeColumn: null,
          }),
      }) as never;

    const a = await buildOntologySnapshot({
      ...DEPS(),
      analyticsDb: withColumns([{ name: "id", type: "VARCHAR", description: "the row id" }]),
    });
    const b = await buildOntologySnapshot({
      ...DEPS(),
      analyticsDb: withColumns([
        { name: "id", type: "VARCHAR", description: "the row id" },
        { name: "minutes", type: "INTEGER", description: "minutes on screen" },
      ]),
    });

    expect(b.fingerprint, "a new column left the drift alarm quiet").not.toBe(a.fingerprint);
  });
});

describe("the people a compiler is shown", () => {
  /** A person with a place in the interaction ranking, and a merge state. */
  function addRankedPerson(
    id: string,
    name: string,
    opts: { score?: number; isSelf?: boolean; mergedInto?: string } = {},
  ): void {
    db.prepare(
      `INSERT INTO people (id, canonical_name, source, is_self, interaction_score_recent,
                           merged_into, first_seen, last_seen, created_at, updated_at)
       VALUES (?, ?, 'test', ?, ?, ?, '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01')`,
    ).run(id, name, opts.isSelf === true ? 1 : 0, opts.score ?? 0, opts.mergedInto ?? null);
  }

  const SELF = "00000000-0000-4000-8000-00000000000f";
  const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

  it("stops at the bound, however large the directory is", () => {
    // The bound is the whole point. This install's directory is fifty thousand
    // people; rendering all of them made a prompt no model would accept, and
    // the request came back as a bare 400 with the size nowhere in it.
    for (let i = 0; i < 40; i++) addRankedPerson(uuid(i), `Person ${i}`, { score: i });

    expect(promptPeopleDirectory(db, 10)).toHaveLength(10);
  });

  it("keeps the people this person actually deals with", () => {
    // An arbitrary ten would usually be ten strangers: most of a real
    // directory is someone who appeared once in a CC line.
    addRankedPerson(uuid(1), "Maya Reeves", { score: 900 });
    addRankedPerson(uuid(2), "Jamie Lopez", { score: 5 });
    addRankedPerson(uuid(3), "David Lin", { score: 400 });

    const names = promptPeopleDirectory(db, 2).map((p) => p.canonicalName);
    expect(names).toContain("Maya Reeves");
    expect(names).toContain("David Lin");
    expect(names).not.toContain("Jamie Lopez");
  });

  it("keeps the user even when the ranking would not", () => {
    // The prompt marks that entry as the user, and the inbound and outbound
    // idioms are written against it — a watch about "me" needs it to be there.
    addRankedPerson(SELF, "Sarah Mendez", { isSelf: true, score: 0 });
    for (let i = 0; i < 5; i++) addRankedPerson(uuid(i), `Person ${i}`, { score: 100 + i });

    const directory = promptPeopleDirectory(db, 2);
    expect(directory.some((p) => p.isSelf)).toBe(true);
  });

  it("leaves out someone who has been merged away", () => {
    // Their id resolves through the merge chain at comparison time. Naming
    // them invites the compiler to bind a watch to an id that is no longer
    // anyone, and the surviving person is in the list anyway.
    addRankedPerson(uuid(1), "Maya Reeves", { score: 900 });
    addRankedPerson(uuid(2), "M. Reeves", { score: 800, mergedInto: uuid(1) });

    expect(promptPeopleDirectory(db, 10).map((p) => p.id)).toEqual([uuid(1)]);
  });

  it("hands back the selection in id order, not in ranking order", () => {
    // The section sits in the prompt's static prefix, and a provider serves a
    // common prefix from cache only if the bytes match. Ranking order is the
    // wrong order to render in: a score refresh that reshuffles the same set of
    // people would rewrite the section and lose the cache for nothing. The
    // scores here descend as the ids ascend, so the two orders disagree.
    addRankedPerson(uuid(1), "Maya Reeves", { score: 10 });
    addRankedPerson(uuid(2), "Jamie Lopez", { score: 900 });
    addRankedPerson(uuid(3), "David Lin", { score: 400 });

    const ids = promptPeopleDirectory(db, 3).map((p) => p.id);
    expect(ids).toEqual([uuid(1), uuid(2), uuid(3)]);
  });
});
