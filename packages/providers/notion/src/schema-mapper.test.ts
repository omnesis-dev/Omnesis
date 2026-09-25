// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import { sanitizeColumnName, mapDatabaseToSchema, extractDatabaseTitle } from "./schema-mapper.js";

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
