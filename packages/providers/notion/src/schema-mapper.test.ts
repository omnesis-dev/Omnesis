// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import { sanitizeColumnName, mapDatabaseToSchema, extractDatabaseTitle } from "./schema-mapper.js";
import { buildPropertyColumnMap, extractRowRecord } from "./property-extractor.js";

// ── sanitizeColumnName ────────────────────────────────────────────────

describe("sanitizeColumnName", () => {
  test("basic name lowercases and replaces spaces with underscores", () => {
    expect(sanitizeColumnName("My Column")).toBe("my_column");
  });

  test("strips special characters", () => {
    expect(sanitizeColumnName("Price ($)")).toBe("price");
  });

  test("prefixes leading digits with underscore", () => {
    expect(sanitizeColumnName("2024 Goals")).toBe("_2024_goals");
  });

  test("empty string becomes 'col'", () => {
    expect(sanitizeColumnName("")).toBe("col");
  });

  test("deduplication appends suffix", () => {
    const existing = new Set(["name"]);
    expect(sanitizeColumnName("name", existing)).toBe("name_2");
  });

  test("unicode-only string becomes 'col'", () => {
    expect(sanitizeColumnName("日本語")).toBe("col");
  });

  test("strips leading and trailing underscores", () => {
    expect(sanitizeColumnName("__hello__")).toBe("hello");
  });

  test("collapses multiple underscores", () => {
    expect(sanitizeColumnName("a    b")).toBe("a_b");
  });
});

// ── mapDatabaseToSchema ───────────────────────────────────────────────

describe("mapDatabaseToSchema", () => {
  const mockDb = {
    object: "database",
    id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    title: [
      {
        plain_text: "Project Tasks",
        type: "text",
        text: { content: "Project Tasks" },
        annotations: {},
        href: null,
      },
    ],
    properties: {
      Name: { id: "title", type: "title", title: {} },
      Status: { id: "status", type: "select", select: { options: [] } },
      Tags: { id: "tags", type: "multi_select", multi_select: { options: [] } },
      "Due Date": { id: "date", type: "date", date: {} },
      Priority: { id: "num", type: "number", number: { format: "number" } },
      Assignee: { id: "ppl", type: "people", people: {} },
      Done: { id: "chk", type: "checkbox", checkbox: {} },
      URL: { id: "url", type: "url", url: {} },
    },
    created_time: "2024-01-01T00:00:00.000Z",
    last_edited_time: "2024-06-15T12:00:00.000Z",
    url: "https://www.notion.so/test/tasks-db",
  } as any;

  test("table name uses database ID without dashes", () => {
    const schema = mapDatabaseToSchema(mockDb);
    expect(schema.tableName).toBe("notion_a1b2c3d4e5f67890abcdef1234567890");
  });

  test("display name is the database title", () => {
    const schema = mapDatabaseToSchema(mockDb);
    expect(schema.displayName).toBe("Project Tasks");
  });

  test("declares its user-managed property columns as dynamic", () => {
    expect(mapDatabaseToSchema(mockDb).dynamicColumns).toBe(true);
  });

  test("primary key is ['id']", () => {
    const schema = mapDatabaseToSchema(mockDb);
    expect(schema.primaryKey).toEqual(["id"]);
  });

  test("declares the row→document binding: row.id under a 'row-' prefix", () => {
    const schema = mapDatabaseToSchema(mockDb);
    expect(schema.boundDocument).toEqual({ externalIdColumns: ["id"], externalIdPrefix: "row-" });
    // The reconstructed key must equal the primary key (validator invariant).
    const bound = schema.boundDocument!;
    expect([...bound.externalIdColumns, ...(bound.sourceKeyColumns ?? [])].sort()).toEqual(
      [...schema.primaryKey].sort(),
    );
  });

  test("includes system columns", () => {
    const schema = mapDatabaseToSchema(mockDb);
    const colNames = schema.columns.map((c) => c.name);
    expect(colNames).toContain("id");
    expect(colNames).toContain("notion_url");
    expect(colNames).toContain("created_time");
    expect(colNames).toContain("last_edited_time");
  });

  test("maps title property to VARCHAR", () => {
    const schema = mapDatabaseToSchema(mockDb);
    const col = schema.columns.find((c) => c.name === "name");
    expect(col).toBeDefined();
    expect(col!.type).toBe("VARCHAR");
  });

  test("maps select property to VARCHAR", () => {
    const schema = mapDatabaseToSchema(mockDb);
    const col = schema.columns.find((c) => c.name === "status");
    expect(col).toBeDefined();
    expect(col!.type).toBe("VARCHAR");
  });

  test("maps multi_select property to VARCHAR[]", () => {
    const schema = mapDatabaseToSchema(mockDb);
    const col = schema.columns.find((c) => c.name === "tags");
    expect(col).toBeDefined();
    expect(col!.type).toBe("VARCHAR[]");
  });

  test("maps date property to two TIMESTAMP columns (start + end)", () => {
    const schema = mapDatabaseToSchema(mockDb);
    const startCol = schema.columns.find((c) => c.name === "due_date_start");
    const endCol = schema.columns.find((c) => c.name === "due_date_end");
    expect(startCol).toBeDefined();
    expect(startCol!.type).toBe("TIMESTAMP");
    expect(endCol).toBeDefined();
    expect(endCol!.type).toBe("TIMESTAMP");
  });

  test("maps number property to DOUBLE", () => {
    const schema = mapDatabaseToSchema(mockDb);
    const col = schema.columns.find((c) => c.name === "priority");
    expect(col).toBeDefined();
    expect(col!.type).toBe("DOUBLE");
  });

  test("maps people property to VARCHAR[]", () => {
    const schema = mapDatabaseToSchema(mockDb);
    const col = schema.columns.find((c) => c.name === "assignee");
    expect(col).toBeDefined();
    expect(col!.type).toBe("VARCHAR[]");
  });

  test("maps checkbox property to BOOLEAN", () => {
    const schema = mapDatabaseToSchema(mockDb);
    const col = schema.columns.find((c) => c.name === "done");
    expect(col).toBeDefined();
    expect(col!.type).toBe("BOOLEAN");
  });

  test("maps url property to VARCHAR", () => {
    const schema = mapDatabaseToSchema(mockDb);
    // "URL" sanitizes to "url", but "url" collides with nothing in system columns
    // Actually "url" is not a system column name, system ones are "notion_url"
    const col = schema.columns.find((c) => c.name === "url");
    expect(col).toBeDefined();
    expect(col!.type).toBe("VARCHAR");
  });

  test("includes example queries", () => {
    const schema = mapDatabaseToSchema(mockDb);
    expect(schema.exampleQueries).toBeDefined();
    expect(schema.exampleQueries!.length).toBeGreaterThan(0);
  });
});

// ── Derived date columns ──────────────────────────────────────────────

describe("date properties next to a property named like their derived columns", () => {
  const dateProp = { id: "dt", type: "date", date: {} };
  const textProp = { id: "txt", type: "rich_text", rich_text: {} };
  const dbWith = (properties: Record<string, unknown>) =>
    ({
      object: "database",
      id: "b2c3d4e5-f6a7-8901-bcde-f12345678901",
      title: [{ plain_text: "Race calendar" }],
      properties: { Name: { id: "title", type: "title", title: {} }, ...properties },
    }) as any;
  const page = (properties: Record<string, unknown>) =>
    ({
      id: "c3d4e5f6-a7b8-9012-cdef-123456789012",
      url: "https://www.notion.so/example/row",
      created_time: "2026-01-02T00:00:00.000Z",
      last_edited_time: "2026-01-03T00:00:00.000Z",
      properties: {
        Name: { type: "title", title: [{ plain_text: "Spring 10k" }] },
        ...properties,
      },
    }) as any;
  const orders = {
    "date first": { Date: dateProp, "date start": textProp },
    "text first": { "date start": textProp, Date: dateProp },
  };

  for (const [order, properties] of Object.entries(orders)) {
    test(`gives every column a distinct name (${order})`, () => {
      const names = mapDatabaseToSchema(dbWith(properties)).columns.map((c) => c.name);
      expect(new Set(names).size).toBe(names.length);
    });

    test(`keeps the date's start and end together and its source ids stable (${order})`, () => {
      const columns = mapDatabaseToSchema(dbWith(properties)).columns;
      const start = columns.find((c) => c.sourceColumnId === "notion:dt:start");
      const end = columns.find((c) => c.sourceColumnId === "notion:dt:end");
      const text = columns.find((c) => c.sourceColumnId === "notion:txt");
      expect(start?.type).toBe("TIMESTAMP");
      expect(end?.name).toBe(start!.name.replace(/_start$/, "_end"));
      expect(text?.type).toBe("VARCHAR");
      expect(text!.name).not.toBe(start!.name);
    });

    test(`writes each row value to a column of the table (${order})`, () => {
      const db = dbWith(properties);
      const schema = mapDatabaseToSchema(db);
      const record = extractRowRecord(
        page({
          Date: { type: "date", date: { start: "2026-04-12", end: null } },
          "date start": { type: "rich_text", rich_text: [{ plain_text: "Early wave" }] },
        }),
        schema,
        buildPropertyColumnMap(db),
      );
      const columnNames = new Set(schema.columns.map((c) => c.name));
      for (const key of Object.keys(record)) expect(columnNames).toContain(key);
      const start = schema.columns.find((c) => c.sourceColumnId === "notion:dt:start")!;
      const text = schema.columns.find((c) => c.sourceColumnId === "notion:txt")!;
      expect(record[start.name]).toBe("2026-04-12");
      expect(record[text.name]).toBe("Early wave");
    });
  }

  test("leaves the names of a database without a collision unchanged", () => {
    const names = mapDatabaseToSchema(dbWith({ Date: dateProp, Notes: textProp })).columns.map(
      (c) => c.name,
    );
    expect(names).toEqual([
      "id",
      "notion_url",
      "created_time",
      "last_edited_time",
      "name",
      "date_start",
      "date_end",
      "notes",
    ]);
  });
});

// ── extractDatabaseTitle ──────────────────────────────────────────────

describe("extractDatabaseTitle", () => {
  test("extracts title from database", () => {
    const db = {
      title: [{ plain_text: "My Db" }],
    } as any;
    expect(extractDatabaseTitle(db)).toBe("My Db");
  });

  test("returns 'Untitled' for empty title array", () => {
    const db = { title: [] } as any;
    expect(extractDatabaseTitle(db)).toBe("Untitled");
  });

  test("returns 'Untitled' for missing title", () => {
    const db = { title: undefined } as any;
    expect(extractDatabaseTitle(db)).toBe("Untitled");
  });

  test("concatenates multiple title segments", () => {
    const db = {
      title: [{ plain_text: "Hello " }, { plain_text: "World" }],
    } as any;
    expect(extractDatabaseTitle(db)).toBe("Hello World");
  });
});
