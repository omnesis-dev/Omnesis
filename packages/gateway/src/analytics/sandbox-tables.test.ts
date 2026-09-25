// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Coverage for the source-restricted `run_sql` gate:
 *
 * - `extractSandboxTableRefs` reads DuckDB's `json_serialize_sql` shapes
 *   (BASE_TABLE / cte_map / TABLE_FUNCTION). The trees below are minimal
 *   projections of the engine's real output — the sql-port tests prove the
 *   same behavior against live parse trees.
 * - `authorizeSandboxTables` is fail-closed: unknown tables, views,
 *   system schemas, and every table function deny the statement, and a
 *   case-folded match only passes when all same-folded entries agree.
 */

import { describe, expect, test } from "vitest";

import { catalogOwnerIds } from "./catalog-store.js";
import {
  authorizeSandboxTables,
  extractSandboxTableRefs,
  ScopedSqlDeniedError,
  type SandboxCatalogEntry,
} from "./sandbox-tables.js";

function baseTable(table: string, schema = "", catalog = ""): unknown {
  return { type: "BASE_TABLE", table_name: table, schema_name: schema, catalog_name: catalog };
}

function selectNode(from: unknown, ctes: Array<{ key: string; value: unknown }> = []): unknown {
  return {
    type: "SELECT_NODE",
    cte_map: { map: ctes.map((entry) => ({ key: entry.key, value: entry.value })) },
    from_table: from,
  };
}

const CATALOG: SandboxCatalogEntry[] = [
  { tableName: "bank_transactions", sourceId: "lunchflow:local" },
  { tableName: "bank_balances", sourceId: "lunchflow:local" },
  { tableName: "other_events", sourceId: "other:remote" },
];

const LUNCHFLOW_ONLY = new Set(["lunchflow:local"]);

function authorizeRefs(
  tree: unknown,
  permitted = LUNCHFLOW_ONLY,
  macroNames: readonly string[] = [],
): void {
  authorizeSandboxTables({
    refs: extractSandboxTableRefs(tree),
    catalog: CATALOG,
    permittedSourceIds: permitted,
    macroNames,
  });
}

describe("extractSandboxTableRefs", () => {
  test("finds plain, qualified, and joined tables", () => {
    const refs = extractSandboxTableRefs({
      statements: [
        selectNode(baseTable("bank_transactions")),
        {
          type: "JOIN",
          left: selectNode(baseTable("bank_balances")),
          right: selectNode(baseTable("other_events")),
        },
      ],
    });
    expect(refs.tables.map((ref) => ref.table).sort()).toEqual([
      "bank_balances",
      "bank_transactions",
      "other_events",
    ]);
    expect(refs.tableFunctions).toEqual([]);
  });

  test("keeps qualifiers and reports table functions", () => {
    const refs = extractSandboxTableRefs(
      selectNode({ type: "TABLE_FUNCTION", function: { function_name: "summary" } }),
    );
    expect(refs.tables).toEqual([]);
    expect(refs.tableFunctions).toEqual(["summary"]);
  });

  test("subtracts CTE names where they are in scope", () => {
    const refs = extractSandboxTableRefs(
      selectNode(baseTable("w"), [{ key: "w", value: selectNode(baseTable("bank_transactions")) }]),
    );
    expect(refs.tables.map((ref) => ref.table)).toEqual(["bank_transactions"]);
  });

  test("keeps a real table shadowed outside its CTE's scope", () => {
    // `other_events` is a real table at the outer level; the WITH only
    // shadows the name inside the EXISTS subquery. A global CTE subtract
    // would drop the outer reference and wrongly allow the query. (The
    // subquery's own FROM correctly resolves to the CTE and is dropped.)
    const refs = extractSandboxTableRefs({
      type: "SELECT_NODE",
      cte_map: { map: [] },
      from_table: baseTable("other_events"),
      where_clause: {
        type: "SUBQUERY",
        subquery: selectNode(baseTable("other_events"), [
          { key: "other_events", value: selectNode(baseTable("bank_transactions")) },
        ]),
      },
    });
    expect(refs.tables.map((ref) => ref.table).sort()).toEqual([
      "bank_transactions",
      "other_events",
    ]);
  });

  test("a qualified ref is never hidden by a same-named CTE", () => {
    // DuckDB binds `main.other_events` to the real table even when a CTE
    // named `other_events` is in scope — only a bare ref sees the CTE.
    // Dropping the qualified ref would let a denied-table read vanish.
    const refs = extractSandboxTableRefs(
      selectNode(baseTable("other_events", "main"), [
        { key: "other_events", value: selectNode(baseTable("bank_transactions")) },
      ]),
    );
    expect(refs.tables.map((ref) => ref.table).sort()).toEqual([
      "bank_transactions",
      "other_events",
    ]);
  });

  test("a bare SHOW is reported with no tables", () => {
    for (const tree of [
      { type: "SHOW_REF", show_type: "SHOW_UNQUALIFIED", query: null },
      {
        type: "SELECT_NODE",
        cte_map: { map: [] },
        from_table: { type: "SHOW_REF", show_type: "SHOW_UNQUALIFIED", query: null },
      },
    ]) {
      const refs = extractSandboxTableRefs(tree);
      expect(refs.tables).toEqual([]);
      expect(refs.bareShows).toEqual(["SHOW_UNQUALIFIED"]);
    }
  });

  test("a table-bound SHOW walks its inner query like any SELECT", () => {
    const refs = extractSandboxTableRefs({
      type: "SHOW_REF",
      show_type: "SUMMARY",
      query: selectNode(baseTable("other_events")),
    });
    expect(refs.tables.map((ref) => ref.table)).toEqual(["other_events"]);
    expect(refs.bareShows).toEqual([]);
  });

  test("scalar calls are collected, and only stored macros deny", () => {
    const tree = {
      type: "SELECT_NODE",
      cte_map: { map: [] },
      select_list: [{ class: "FUNCTION", type: "FUNCTION", function_name: "m_plus" }],
      from_table: baseTable("bank_transactions"),
    };
    expect(extractSandboxTableRefs(tree).scalarFunctions).toEqual(["m_plus"]);
    // Ordinary scalars pass beside a macro catalog that names nothing used …
    expect(() =>
      authorizeRefs(selectNode(baseTable("bank_transactions")), LUNCHFLOW_ONLY, [
        "unrelated_macro",
      ]),
    ).not.toThrow();
    // … but a call matching a stored macro denies, naming the call.
    try {
      authorizeRefs(tree, LUNCHFLOW_ONLY, ["m_plus"]);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ScopedSqlDeniedError);
      expect((error as ScopedSqlDeniedError).macros).toEqual(["m_plus"]);
      expect((error as ScopedSqlDeniedError).tables).toEqual([]);
    }
  });

  test("a bare SHOW denies even with no table refs at all", () => {
    try {
      authorizeRefs({ type: "SHOW_REF", show_type: "SHOW_UNQUALIFIED", query: null });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ScopedSqlDeniedError);
      expect((error as ScopedSqlDeniedError).shows).toEqual(["SHOW_UNQUALIFIED"]);
    }
  });

  test("a CTE body still reports the real tables it reads", () => {
    const refs = extractSandboxTableRefs(
      selectNode(baseTable("w"), [{ key: "w", value: selectNode(baseTable("other_events")) }]),
    );
    expect(refs.tables.map((ref) => ref.table)).toEqual(["other_events"]);
  });
});

describe("authorizeSandboxTables", () => {
  test("allows permitted tables however they are qualified", () => {
    for (const sql of [
      selectNode(baseTable("bank_transactions")),
      selectNode(baseTable("bank_transactions", "main")),
      selectNode(baseTable("bank_transactions", "main", "omnesis_analytics")),
    ]) {
      expect(() => authorizeRefs(sql)).not.toThrow();
    }
  });

  test("denies a table from a source outside the grant, naming it", () => {
    try {
      authorizeRefs(selectNode(baseTable("other_events")));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ScopedSqlDeniedError);
      expect((error as ScopedSqlDeniedError).tables).toEqual(["other_events"]);
    }
  });

  test("denies a shared table whose owner collapsed to the bare source type", () => {
    // The catalog store collapses a shared table's owner to the bare
    // source type once a second account registers it — so a grant
    // permitting both accounts still matches no exact member. Accepting
    // the bare type on any single permitted account would expose
    // sibling-account rows, so the fail-closed rule stands until
    // shared-table ownership is arbitrated: restricted clients cannot
    // query shared tables, even when all accounts are permitted.
    const shared: SandboxCatalogEntry[] = [{ tableName: "shared_events", sourceId: "example" }];
    const bothAccounts = new Set(["example:private", "example:second"]);
    try {
      authorizeSandboxTables({
        refs: extractSandboxTableRefs(selectNode(baseTable("shared_events"))),
        catalog: shared,
        permittedSourceIds: bothAccounts,
        macroNames: [],
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ScopedSqlDeniedError);
      expect((error as ScopedSqlDeniedError).tables).toEqual(["shared_events"]);
    }
  });

  test("denies a join the moment one side is outside the grant", () => {
    try {
      authorizeRefs({
        type: "JOIN",
        left: selectNode(baseTable("bank_transactions")),
        right: selectNode(baseTable("other_events")),
      });
      expect.unreachable();
    } catch (error) {
      expect((error as ScopedSqlDeniedError).tables).toEqual(["other_events"]);
    }
  });

  test("denies unknown tables, views, and system schemas", () => {
    for (const sql of [
      selectNode(baseTable("no_such_table")),
      selectNode(baseTable("some_view")),
      selectNode(baseTable("tables", "information_schema")),
      selectNode(baseTable("_analytics_catalog")),
      selectNode(baseTable("bank_transactions", "memory")),
    ]) {
      expect(() => authorizeRefs(sql), JSON.stringify(sql)).toThrow(ScopedSqlDeniedError);
    }
  });

  test("denies every table function for a restricted grant", () => {
    try {
      authorizeRefs(
        selectNode({ type: "TABLE_FUNCTION", function: { function_name: "generate_series" } }),
      );
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ScopedSqlDeniedError);
      expect((error as ScopedSqlDeniedError).tableFunctions).toEqual(["generate_series"]);
      expect((error as ScopedSqlDeniedError).tables).toEqual([]);
    }
  });

  test("a same-folded match passes only when every variant is permitted", () => {
    const mixed: SandboxCatalogEntry[] = [
      { tableName: "Events", sourceId: "lunchflow:local" },
      { tableName: "EVENTS", sourceId: "other:remote" },
    ];
    expect(() =>
      authorizeSandboxTables({
        refs: {
          tables: [{ catalog: "", schema: "", table: "events" }],
          tableFunctions: [],
          scalarFunctions: [],
          bareShows: [],
        },
        catalog: mixed,
        permittedSourceIds: LUNCHFLOW_ONLY,
        macroNames: [],
      }),
    ).toThrow(ScopedSqlDeniedError);
    expect(() =>
      authorizeSandboxTables({
        refs: {
          tables: [{ catalog: "", schema: "", table: "Events" }],
          tableFunctions: [],
          scalarFunctions: [],
          bareShows: [],
        },
        catalog: [{ tableName: "Events", sourceId: "lunchflow:local" }],
        permittedSourceIds: LUNCHFLOW_ONLY,
        macroNames: [],
      }),
    ).not.toThrow();
  });

  test("a qualified denied ref is denied even under a same-named CTE", () => {
    try {
      authorizeRefs(
        selectNode(baseTable("other_events", "main"), [
          { key: "other_events", value: selectNode(baseTable("bank_transactions")) },
        ]),
      );
      expect.unreachable();
    } catch (error) {
      expect((error as ScopedSqlDeniedError).tables).toEqual(["main.other_events"]);
    }
  });

  test("an empty permitted set denies everything with a table", () => {
    expect(() => authorizeRefs(selectNode(baseTable("bank_transactions")), new Set())).toThrow(
      ScopedSqlDeniedError,
    );
  });
});

describe("a source reaching its own tables", () => {
  // The catalog records a table one account owns outright under the full
  // `<type>:<account>` id, and one its sibling accounts share under the bare
  // type. `catalogOwnerIds` is the single place that pair is written down, and
  // this is the seam where getting it wrong is felt: a source denied the very
  // table its own rows live in.
  const OWNED_AND_SHARED: SandboxCatalogEntry[] = [
    { tableName: "lunchflow_personal_rows", sourceId: "lunchflow:personal" },
    { tableName: "lunchflow_shared_rows", sourceId: "lunchflow" },
    { tableName: "other_events", sourceId: "other:remote" },
  ];

  const asSource = (table: string, sourceId: string) =>
    authorizeSandboxTables({
      refs: extractSandboxTableRefs(selectNode(baseTable(table))),
      catalog: OWNED_AND_SHARED,
      permittedSourceIds: new Set(catalogOwnerIds(sourceId)),
      macroNames: [],
    });

  test("reaches the table it owns outright and the one its siblings share", () => {
    expect(() => asSource("lunchflow_personal_rows", "lunchflow:personal")).not.toThrow();
    expect(() => asSource("lunchflow_shared_rows", "lunchflow:personal")).not.toThrow();
  });

  test("still cannot reach another source's table", () => {
    expect(() => asSource("other_events", "lunchflow:personal")).toThrow(ScopedSqlDeniedError);
  });

  test("a sibling account reaches the shared table but not the other's own", () => {
    expect(() => asSource("lunchflow_shared_rows", "lunchflow:business")).not.toThrow();
    expect(() => asSource("lunchflow_personal_rows", "lunchflow:business")).toThrow(
      ScopedSqlDeniedError,
    );
  });
});
