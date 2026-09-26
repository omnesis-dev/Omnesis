// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { createDirectListTablesTool } from "./direct-list-tables.js";

const context = { sessionId: "schema", messageId: "schema" };

describe("Direct schema discovery", () => {
  const table = (tableName: string) => ({ tableName, columns: [{ name: "id", type: "VARCHAR" }] });

  it("pages sorted tables without gaps, including empty and out-of-range pages", async () => {
    const tool = createDirectListTablesTool(async () => [
      table("z_events"),
      table("a_events"),
      table("m_events"),
    ]);
    expect(await tool.invoke({ limit: 2 }, context)).toMatchObject({
      data: {
        tables: [table("a_events"), table("m_events")],
        nextOffset: 2,
      },
    });
    expect(await tool.invoke({ offset: 2, limit: 2 }, context)).toMatchObject({
      data: {
        tables: [table("z_events")],
        nextOffset: null,
      },
    });
    expect(await tool.invoke({ offset: 3 }, context)).toMatchObject({
      data: { tables: [], nextOffset: null },
    });
    const empty = createDirectListTablesTool(async () => []);
    expect(await empty.invoke({}, context)).toMatchObject({
      data: { tables: [], nextOffset: null },
    });
  });

  it("defaults to a bounded page and supports traversing catalogs larger than the instruction limit", async () => {
    const tables = Array.from({ length: 130 }, (_, i) => ({
      tableName: `events_${String(i).padStart(3, "0")}`,
      columns: Array.from({ length: 128 }, (_, j) => ({
        name: `column_${j}_${"x".repeat(110)}`,
        type: "VARCHAR",
      })),
    }));
    const tool = createDirectListTablesTool(async () => tables);
    let offset = 0;
    const names: string[] = [];
    while (true) {
      const result = await tool.invoke({ offset }, context);
      expect(result.kind).toBe("structured");
      if (result.kind !== "structured") throw new Error("Expected schema page");
      const data = result.data as { tables: { tableName: string }[]; nextOffset: number | null };
      expect(data.tables.length).toBeLessThanOrEqual(20);
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(1024 * 1024);
      names.push(...data.tables.map((t) => t.tableName));
      if (data.nextOffset === null) break;
      offset = data.nextOffset;
    }
    expect(names).toEqual(tables.map((t) => t.tableName));
  });

  it.each([
    { offset: -1 },
    { offset: 0.5 },
    { offset: Number.MAX_SAFE_INTEGER + 1 },
    { limit: 0 },
    { limit: 101 },
    { limit: "20" },
    { sourceId: "outside" },
  ])("rejects invalid paging %j", async (args) => {
    const tool = createDirectListTablesTool(async () => {
      throw new Error("Must not read");
    });
    expect(await tool.invoke(args, context)).toMatchObject({ kind: "error", code: "invalid_args" });
  });

  it("keeps dependency errors private", async () => {
    const tool = createDirectListTablesTool(async () => {
      throw new Error("Private catalog path canary");
    });
    expect(await tool.invoke({}, context)).toEqual({
      kind: "error",
      code: "catalog_failed",
      message: "The analytics catalog could not be read.",
    });
  });
});
