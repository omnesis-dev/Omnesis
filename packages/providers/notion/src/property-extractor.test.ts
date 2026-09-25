// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import {
  extractPropertyValue,
  summarizeProperties,
  buildPropertyColumnMap,
} from "./property-extractor.js";

// ── extractPropertyValue ──────────────────────────────────────────────

describe("extractPropertyValue", () => {
  test("title returns joined plain_text", () => {
    const prop = { type: "title", title: [{ plain_text: "Hello" }] } as any;
    expect(extractPropertyValue(prop)).toBe("Hello");
  });

  test("title returns null for empty array", () => {
    const prop = { type: "title", title: [] } as any;
    expect(extractPropertyValue(prop)).toBe(null);
  });

  test("rich_text returns joined plain_text", () => {
    const prop = { type: "rich_text", rich_text: [{ plain_text: "World" }] } as any;
    expect(extractPropertyValue(prop)).toBe("World");
  });

  test("rich_text returns null for empty array", () => {
    const prop = { type: "rich_text", rich_text: [] } as any;
    expect(extractPropertyValue(prop)).toBe(null);
  });

  test("number returns the number value", () => {
    const prop = { type: "number", number: 42 } as any;
    expect(extractPropertyValue(prop)).toBe(42);
  });

  test("number returns null when value is null", () => {
    const prop = { type: "number", number: null } as any;
    expect(extractPropertyValue(prop)).toBe(null);
  });

  test("checkbox true returns true", () => {
    const prop = { type: "checkbox", checkbox: true } as any;
    expect(extractPropertyValue(prop)).toBe(true);
  });

  test("checkbox false returns false", () => {
    const prop = { type: "checkbox", checkbox: false } as any;
    expect(extractPropertyValue(prop)).toBe(false);
  });

  test("select returns option name", () => {
    const prop = { type: "select", select: { name: "Option A" } } as any;
    expect(extractPropertyValue(prop)).toBe("Option A");
  });

  test("select returns null when value is null", () => {
    const prop = { type: "select", select: null } as any;
    expect(extractPropertyValue(prop)).toBe(null);
  });

  test("multi_select returns array of names", () => {
    const prop = { type: "multi_select", multi_select: [{ name: "A" }, { name: "B" }] } as any;
    expect(extractPropertyValue(prop)).toEqual(["A", "B"]);
  });

  test("multi_select returns empty array when no options", () => {
    const prop = { type: "multi_select", multi_select: [] } as any;
    expect(extractPropertyValue(prop)).toEqual([]);
  });

  test("status returns status name", () => {
    const prop = { type: "status", status: { name: "In Progress" } } as any;
    expect(extractPropertyValue(prop)).toBe("In Progress");
  });

  test("status returns null when value is null", () => {
    const prop = { type: "status", status: null } as any;
    expect(extractPropertyValue(prop)).toBe(null);
  });

  test("date with start and end returns object", () => {
    const prop = { type: "date", date: { start: "2024-01-01", end: "2024-01-02" } } as any;
    expect(extractPropertyValue(prop)).toEqual({ start: "2024-01-01", end: "2024-01-02" });
  });

  test("date with start only returns null end", () => {
    const prop = { type: "date", date: { start: "2024-01-01" } } as any;
    const result = extractPropertyValue(prop) as any;
    expect(result.start).toBe("2024-01-01");
    expect(result.end).toBe(null);
  });

  test("date null returns start and end as null", () => {
    const prop = { type: "date", date: null } as any;
    expect(extractPropertyValue(prop)).toEqual({ start: null, end: null });
  });

  test("url returns the URL string", () => {
    const prop = { type: "url", url: "https://example.com" } as any;
    expect(extractPropertyValue(prop)).toBe("https://example.com");
  });

  test("url returns null when value is null", () => {
    const prop = { type: "url", url: null } as any;
    expect(extractPropertyValue(prop)).toBe(null);
  });

  test("email returns the email string", () => {
    const prop = { type: "email", email: "test@test.com" } as any;
    expect(extractPropertyValue(prop)).toBe("test@test.com");
  });

  test("people returns array of names", () => {
    const prop = { type: "people", people: [{ name: "Alice", id: "u1" }] } as any;
    expect(extractPropertyValue(prop)).toEqual(["Alice"]);
  });

  test("people returns 'Unknown' for users without names", () => {
    const prop = { type: "people", people: [{ id: "u1" }] } as any;
    expect(extractPropertyValue(prop)).toEqual(["Unknown"]);
  });

  test("relation returns array of IDs without dashes", () => {
    const prop = {
      type: "relation",
      relation: [{ id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890" }],
    } as any;
    expect(extractPropertyValue(prop)).toEqual(["a1b2c3d4e5f67890abcdef1234567890"]);
  });

  test("relation returns empty array when no relations", () => {
    const prop = { type: "relation", relation: [] } as any;
    expect(extractPropertyValue(prop)).toEqual([]);
  });

  test("unique_id with prefix returns formatted string", () => {
    const prop = { type: "unique_id", unique_id: { prefix: "TASK", number: 42 } } as any;
    expect(extractPropertyValue(prop)).toBe("TASK-42");
  });

  test("unique_id without prefix returns number as string", () => {
    const prop = { type: "unique_id", unique_id: { prefix: null, number: 7 } } as any;
    expect(extractPropertyValue(prop)).toBe("7");
  });

  test("unique_id with null number returns null", () => {
    const prop = { type: "unique_id", unique_id: { prefix: "TASK", number: null } } as any;
    expect(extractPropertyValue(prop)).toBe(null);
  });

  test("formula string returns the string value", () => {
    const prop = { type: "formula", formula: { type: "string", string: "computed" } } as any;
    expect(extractPropertyValue(prop)).toBe("computed");
  });

  test("formula number returns stringified number", () => {
    const prop = { type: "formula", formula: { type: "number", number: 99 } } as any;
    expect(extractPropertyValue(prop)).toBe("99");
  });

  test("created_time returns the timestamp", () => {
    const prop = { type: "created_time", created_time: "2024-01-01T00:00:00.000Z" } as any;
    expect(extractPropertyValue(prop)).toBe("2024-01-01T00:00:00.000Z");
  });

  test("last_edited_time returns the timestamp", () => {
    const prop = { type: "last_edited_time", last_edited_time: "2024-06-15T12:00:00.000Z" } as any;
    expect(extractPropertyValue(prop)).toBe("2024-06-15T12:00:00.000Z");
  });

  test("unknown type returns null", () => {
    const prop = { type: "button" } as any;
    expect(extractPropertyValue(prop)).toBe(null);
  });
});

// ── summarizeProperties ───────────────────────────────────────────────

describe("summarizeProperties", () => {
  test("returns readable string values for properties", () => {
    const page = {
      properties: {
        Name: { type: "title", title: [{ plain_text: "My Task" }] },
        Status: { type: "select", select: { name: "Done" } },
        Tags: { type: "multi_select", multi_select: [{ name: "A" }, { name: "B" }] },
        Done: { type: "checkbox", checkbox: true },
        Empty: { type: "rich_text", rich_text: [] },
      },
    } as any;

    const result = summarizeProperties(page);

    expect(result["Name"]).toBe("My Task");
    expect(result["Status"]).toBe("Done");
    expect(result["Tags"]).toBe("A, B");
    expect(result["Done"]).toBe("Yes");
    // Empty rich_text should not appear (empty string is falsy)
    expect(result["Empty"]).toBeUndefined();
  });

  test("formats date ranges", () => {
    const page = {
      properties: {
        Period: { type: "date", date: { start: "2024-01-01", end: "2024-01-31" } },
        Single: { type: "date", date: { start: "2024-06-15" } },
        None: { type: "date", date: null },
      },
    } as any;

    const result = summarizeProperties(page);

    expect(result["Period"]).toBe("2024-01-01 - 2024-01-31");
    expect(result["Single"]).toBe("2024-06-15");
    expect(result["None"]).toBeUndefined();
  });

  test("checkbox false displays as 'No'", () => {
    const page = {
      properties: {
        Active: { type: "checkbox", checkbox: false },
      },
    } as any;

    const result = summarizeProperties(page);
    expect(result["Active"]).toBe("No");
  });
});

// ── buildPropertyColumnMap ────────────────────────────────────────────

describe("buildPropertyColumnMap", () => {
  const mockDb = {
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
  } as any;

  test("maps property names to sanitized column names", () => {
    const map = buildPropertyColumnMap(mockDb);

    expect(map.get("Name")).toBe("name");
    expect(map.get("Status")).toBe("status");
    expect(map.get("Tags")).toBe("tags");
    expect(map.get("Due Date")).toBe("due_date");
    expect(map.get("Priority")).toBe("priority");
    expect(map.get("Assignee")).toBe("assignee");
    expect(map.get("Done")).toBe("done");
    expect(map.get("URL")).toBe("url");
  });

  test("skips created_time and last_edited_time properties", () => {
    const db = {
      properties: {
        Name: { type: "title", title: {} },
        Created: { type: "created_time", created_time: {} },
        Edited: { type: "last_edited_time", last_edited_time: {} },
      },
    } as any;

    const map = buildPropertyColumnMap(db);

    expect(map.has("Name")).toBe(true);
    expect(map.has("Created")).toBe(false);
    expect(map.has("Edited")).toBe(false);
  });

  test("skips button and verification properties", () => {
    const db = {
      properties: {
        Name: { type: "title", title: {} },
        Action: { type: "button" },
        Verify: { type: "verification" },
      },
    } as any;

    const map = buildPropertyColumnMap(db);

    expect(map.has("Name")).toBe(true);
    expect(map.has("Action")).toBe(false);
    expect(map.has("Verify")).toBe(false);
  });

  test("handles column name collisions with system columns", () => {
    const db = {
      properties: {
        id: { type: "rich_text", rich_text: {} },
        notion_url: { type: "url", url: {} },
      },
    } as any;

    const map = buildPropertyColumnMap(db);

    // "id" is a system column, so the property "id" should get deduplicated
    expect(map.get("id")).toBe("id_2");
    expect(map.get("notion_url")).toBe("notion_url_2");
  });
});
