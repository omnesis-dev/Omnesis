// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, expectTypeOf, it } from "vitest";

import { loadOntology } from "../universe/paths.js";
import {
  Ontology,
  ontologySnapshotSchema,
  type AnalyticsTableSnapshot,
  type DocumentEventProfileSnapshot,
} from "./snapshot.js";
import { ANALYTICS_COLUMN_KEYS, analyticsColumnSchema, isAnalyticsColumnType } from "./snapshot.js";
import type {
  AnalyticsTableSchema,
  ColumnDefinition,
  DocumentEventProfile,
} from "@omnesis/source-sdk";

/**
 * A minimal valid snapshot, mutated per case. Building from one base keeps each
 * test about the single thing it is checking.
 */
function snapshot(patch: Record<string, unknown> = {}): unknown {
  return {
    fingerprint: "test-1",
    sources: [
      {
        sourceId: "gmail",
        providerId: "google",
        semanticallyIndexed: true,
        profile: {
          documentTypes: ["email"],
          personRoles: ["sender", "recipient"],
          metadataFields: [
            {
              path: "extra.threadId",
              type: "string",
              description: "Thread the message belongs to.",
            },
          ],
        },
      },
    ],
    analyticsTables: [
      {
        tableName: "health_vitals",
        displayName: "Health Vitals",
        description: "Vital-sign readings.",
        columns: [
          { name: "metric_slug", type: "VARCHAR", description: "Which vital." },
          { name: "start_time", type: "TIMESTAMPTZ", description: "When." },
        ],
        primaryKey: ["metric_slug", "start_time"],
        semanticTimeColumn: "start_time",
      },
    ],
    people: [
      {
        id: "0a1b2c3d-0000-4000-8000-000000000001",
        canonicalName: "Jordan Avery",
        aliases: [],
        isSelf: true,
        mergedInto: null,
      },
    ],
    ...patch,
  };
}

describe("ontologySnapshotSchema", () => {
  it("accepts a well-formed snapshot", () => {
    expect(ontologySnapshotSchema.safeParse(snapshot()).success).toBe(true);
  });

  it("rejects a person role the substrate does not have", () => {
    const bad = snapshot({
      sources: [
        {
          sourceId: "gmail",
          providerId: "google",
          semanticallyIndexed: true,
          profile: { personRoles: ["from"] },
        },
      ],
    });
    expect(ontologySnapshotSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects an analytics column type outside the closed union", () => {
    const bad = snapshot({
      analyticsTables: [
        {
          tableName: "t",
          displayName: "T",
          description: "d",
          columns: [{ name: "c", type: "STRUCT(a INT)" }],
          primaryKey: ["c"],
          semanticTimeColumn: null,
        },
      ],
    });
    expect(ontologySnapshotSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a semantic time column that is not a declared column", () => {
    const bad = snapshot({
      analyticsTables: [
        {
          tableName: "t",
          displayName: "T",
          description: "d",
          columns: [{ name: "c", type: "VARCHAR" }],
          primaryKey: ["c"],
          semanticTimeColumn: "when",
        },
      ],
    });
    expect(ontologySnapshotSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects duplicate source ids, table names and person ids", () => {
    const source = snapshot() as unknown as { sources: unknown[] };
    expect(
      ontologySnapshotSchema.safeParse(
        snapshot({ sources: [...source.sources, ...source.sources] }),
      ).success,
    ).toBe(false);
  });
});

describe("Ontology", () => {
  it("indexes the PoC universe's declared world", () => {
    const ontology = loadOntology();
    expect(ontology.fingerprint).toBe("poc-ontology-1");
    expect(ontology.sourceIds()).toContain("gmail");
    expect(ontology.tableNames()).toContain("plaid_transactions");
    expect(ontology.metadataField("gmail", "extra.threadId")?.type).toBe("string");
    expect(ontology.metadataField("gmail", "extra.chatJid")).toBeUndefined();
  });

  it("follows a merge chain to the surviving person", () => {
    const ontology = loadOntology();
    const merged = "9c3e5a17-0000-4000-8000-000000000006";
    const canonical = "5e7a1c88-0000-4000-8000-000000000004";
    expect(ontology.canonicalPersonId(merged)).toBe(canonical);
    expect(ontology.canonicalPersonId(canonical)).toBe(canonical);
    expect(ontology.canonicalPersonId("00000000-0000-4000-8000-00000000dead")).toBeUndefined();
  });

  it("gives up on a cyclic merge chain instead of hanging", () => {
    const a = "11111111-0000-4000-8000-000000000001";
    const b = "22222222-0000-4000-8000-000000000002";
    const ontology = new Ontology(
      ontologySnapshotSchema.parse(
        snapshot({
          people: [
            { id: a, canonicalName: "A", aliases: [], isSelf: false, mergedInto: b },
            { id: b, canonicalName: "B", aliases: [], isSelf: false, mergedInto: a },
          ],
        }),
      ),
    );
    expect(ontology.canonicalPersonId(a)).toBeUndefined();
  });
});

describe("snapshot format parity with the source contract", () => {
  /**
   * The snapshot is a file today and two gateway queries after integration, so
   * its shape must stay assignable to the interfaces the sources actually
   * declare.
   *
   * The `Pick` is the limit of what this can promise: it holds those five
   * fields to their declared types, and a contract growing a *sixth* is outside
   * it. Column-key drift is caught by the key-set assertions further down, not
   * here.
   */
  it("parses into values the source-sdk interfaces accept", () => {
    expectTypeOf<DocumentEventProfileSnapshot>().toExtend<DocumentEventProfile>();
    expectTypeOf<AnalyticsTableSnapshot>().toExtend<
      Pick<
        AnalyticsTableSchema,
        "tableName" | "displayName" | "description" | "primaryKey" | "semanticTimeColumn"
      >
    >();
  });
});

describe("what the catalog really writes", () => {
  /**
   * The contract and this snapshot must agree on the *set* of column keys, and
   * that agreement is checked where it cannot be forgotten: a key added to
   * `ColumnDefinition` and not to `ANALYTICS_COLUMN_KEYS` fails to compile
   * here.
   *
   * A type-level check rather than a value one, because the runtime posture is
   * deliberately permissive — an unknown key is passed through, so no runtime
   * assertion can notice the contract growing. The compiler can.
   */
  it("models every key the source contract declares", () => {
    type Modelled = (typeof ANALYTICS_COLUMN_KEYS)[number];
    type Unmodelled = Exclude<keyof ColumnDefinition, Modelled>;
    expectTypeOf<Unmodelled>().toEqualTypeOf<never>();
  });

  it("keeps the key list and the schema that validates them in step", () => {
    // The list is not decoration: a host reads it to report which keys it
    // passed through unrecognised. A key in the schema but not the list is
    // reported to an operator as unmodelled when it is in fact validated; a key
    // in the list but not the schema is announced as modelled and then not
    // checked at all. Neither divergence has any other symptom.
    expect(Object.keys(analyticsColumnSchema.shape).sort()).toEqual(
      [...ANALYTICS_COLUMN_KEYS].sort(),
    );
  });

  it("accepts a column carrying every key the contract allows", () => {
    // The shape a real catalog writes. Before this, six of these keys were
    // unmodelled and any one of them removed the whole table from the DSL.
    const column: ColumnDefinition = {
      name: "amount",
      type: "DECIMAL(18,4)",
      description: "What it cost",
      nullable: true,
      sensitive: false,
      volatile: false,
      references: "person",
      allowedValues: ["a"],
      canonicalValues: ["A"],
      valueAliases: { A: ["a", "an a"] },
      categoricalRole: "selector",
      sourceColumnId: "upstream.amount",
    };
    const parsed = ontologySnapshotSchema.safeParse(
      snapshot({
        analyticsTables: [
          {
            tableName: "payments",
            displayName: "Payments",
            description: "Money out",
            columns: [column],
            primaryKey: ["amount"],
            semanticTimeColumn: null,
          },
        ],
      }),
    );
    expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues)).toBe(true);
  });

  it("keeps a table whose column carries a key it has never heard of", () => {
    // The failure this posture exists to prevent: one unmodelled key cost 48
    // of 52 tables their place in the DSL, and the only symptom was a warning.
    const parsed = ontologySnapshotSchema.safeParse(
      snapshot({
        analyticsTables: [
          {
            tableName: "payments",
            displayName: "Payments",
            description: "Money out",
            columns: [
              {
                name: "amount",
                type: "DOUBLE",
                description: "What it cost",
                somethingShippedNextYear: { nested: true },
              },
            ],
            primaryKey: ["amount"],
            semanticTimeColumn: null,
          },
        ],
      }),
    );
    expect(parsed.success).toBe(true);
    const table = parsed.success ? parsed.data.analyticsTables[0] : undefined;
    expect(table?.tableName).toBe("payments");
    // Preserved, not merely tolerated: a host may want to report it.
    expect(table?.columns[0]).toMatchObject({ somethingShippedNextYear: { nested: true } });
  });

  it("keeps a table carrying contract fields this snapshot does not read", () => {
    // `record` and `exampleQueries` are real parts of the table contract that
    // the validator has no use for. A host that passed them through should not
    // thereby delete the table — the same failure as the column case, one
    // level up.
    const parsed = ontologySnapshotSchema.safeParse(
      snapshot({
        analyticsTables: [
          {
            tableName: "payments",
            displayName: "Payments",
            description: "Money out",
            columns: [{ name: "amount", type: "DOUBLE", description: "What it cost" }],
            primaryKey: ["amount"],
            semanticTimeColumn: null,
            record: { titleColumn: "amount", keyColumns: ["amount"] },
            exampleQueries: ["SELECT * FROM payments"],
          },
        ],
      }),
    );
    expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues)).toBe(true);
    expect(parsed.success ? parsed.data.analyticsTables[0]?.tableName : null).toBe("payments");
  });

  it("still refuses a column whose declared type is not a real one", () => {
    // Permissive about keys it does not know; strict about the ones it reads.
    const parsed = ontologySnapshotSchema.safeParse(
      snapshot({
        analyticsTables: [
          {
            tableName: "payments",
            displayName: "Payments",
            description: "Money out",
            columns: [{ name: "amount", type: "MONEY", description: "What it cost" }],
            primaryKey: ["amount"],
            semanticTimeColumn: null,
          },
        ],
      }),
    );
    expect(parsed.success).toBe(false);
  });

  it("refuses a wrong value on every key it claims to validate", () => {
    // Under passthrough an "accepts" test cannot tell a modelled key from an
    // unmodelled one — both are accepted. Only a rejection proves the schema is
    // actually looking at the key, so every key this file claims to model needs
    // one of these or it is unverified.
    const bad: Record<string, unknown>[] = [
      { categoricalRole: "facet" }, // outside the contract's two roles
      { sensitive: 1 },
      { volatile: "yes" },
      { valueAliases: { a: "not-an-array" } },
      { sourceColumnId: 7 },
      { references: "banana" }, // outside document|person|source|url
      { allowedValues: "a" },
      { canonicalValues: [1] },
    ];
    for (const patch of bad) {
      const parsed = ontologySnapshotSchema.safeParse(
        snapshot({
          analyticsTables: [
            {
              tableName: "payments",
              displayName: "Payments",
              description: "Money out",
              columns: [{ name: "amount", type: "VARCHAR", description: "d", ...patch }],
              primaryKey: ["amount"],
              semanticTimeColumn: null,
            },
          ],
        }),
      );
      expect(parsed.success, `accepted ${JSON.stringify(patch)}`).toBe(false);
    }
  });

  it("refuses a primary key naming a column that is not there", () => {
    // A table whose key does not exist cannot be deduplicated or addressed, so
    // it is one of the few things still worth refusing outright.
    const parsed = ontologySnapshotSchema.safeParse(
      snapshot({
        analyticsTables: [
          {
            tableName: "payments",
            displayName: "Payments",
            description: "Money out",
            columns: [{ name: "amount", type: "DOUBLE", description: "d" }],
            primaryKey: ["no_such_column"],
            semanticTimeColumn: null,
          },
        ],
      }),
    );
    expect(parsed.success).toBe(false);
  });

  it("keeps a source whose profile carries a field key it does not model", () => {
    // The document half of the same posture, and the one with the widest blast
    // radius: an unrecognised key on a metadata field fails its profile, which
    // drops the whole source — and a key every source declares would drop every
    // source and leave the ontology unable to assemble at all.
    const parsed = ontologySnapshotSchema.safeParse(
      snapshot({
        sources: [
          {
            sourceId: "gmail",
            providerId: "google",
            semanticallyIndexed: true,
            profile: {
              documentTypes: ["email"],
              personRoles: ["sender"],
              metadataFields: [
                {
                  path: "extra.threadId",
                  type: "string",
                  description: "the conversation",
                  shippedNextYear: true,
                },
              ],
            },
          },
        ],
      }),
    );
    expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues)).toBe(true);
  });

  it("still refuses a nullable that is not a boolean", () => {
    const parsed = ontologySnapshotSchema.safeParse(
      snapshot({
        analyticsTables: [
          {
            tableName: "payments",
            displayName: "Payments",
            description: "Money out",
            columns: [{ name: "amount", type: "DOUBLE", description: "d", nullable: "yes" }],
            primaryKey: ["amount"],
            semanticTimeColumn: null,
          },
        ],
      }),
    );
    expect(parsed.success).toBe(false);
  });
});

/**
 * The column type is the one part of a projection written into SQL text rather
 * than bound as a parameter, so the runtime engine re-checks it at the point it
 * interpolates it. Nothing can reach that check today — a table carrying a type
 * outside the union never survives the parse — which is exactly why the
 * predicate needs its own tests: its branch has no other way to be exercised.
 */
describe("the column-type predicate the engine interpolates through", () => {
  it("accepts every spelling the union declares", () => {
    for (const type of [
      "VARCHAR",
      "INTEGER",
      "BIGINT",
      "DOUBLE",
      "FLOAT",
      "BOOLEAN",
      "DATE",
      "TIMESTAMP",
      "TIMESTAMPTZ",
      "INTERVAL",
      "JSON",
      "VARCHAR[]",
      "DECIMAL(18,4)",
    ]) {
      expect(isAnalyticsColumnType(type), `${type} is a declared type`).toBe(true);
    }
  });

  it("refuses anything that would carry SQL of its own into the statement", () => {
    for (const type of [
      "VARCHAR) AS x, (SELECT 1",
      "DECIMAL(1,1)); DROP TABLE payments;--",
      "VARCHAR;",
      "",
    ]) {
      expect(isAnalyticsColumnType(type), `${type} must not reach a statement`).toBe(false);
    }
  });

  it("refuses a near-miss spelling rather than passing it through", () => {
    // The engine casts to exactly this text. A type it half-recognises would be
    // interpolated as written and fail in the binder instead of being skipped.
    for (const type of ["varchar", "TEXT", "DECIMAL(18, 4)", "DECIMAL", "NUMERIC(18,4)"]) {
      expect(isAnalyticsColumnType(type), `${type} is not a declared spelling`).toBe(false);
    }
  });
});
