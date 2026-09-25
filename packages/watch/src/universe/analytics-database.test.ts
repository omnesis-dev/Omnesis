// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Ontology } from "../ontology/snapshot.js";
import { AnalyticsDatabase } from "./analytics.js";

const ontology = Ontology.parse({
  fingerprint: "analytics-fixture",
  sources: [],
  people: [],
  analyticsTables: [
    {
      tableName: "samples",
      displayName: "Samples",
      description: "Fixture values",
      primaryKey: ["id"],
      semanticTimeColumn: null,
      columns: [
        { name: "id", type: "VARCHAR" },
        { name: "amount", type: "DECIMAL(18,4)" },
        { name: "tags", type: "VARCHAR[]" },
        { name: "details", type: "JSON" },
      ],
    },
    {
      tableName: "events",
      displayName: "Events",
      description: "Rows populated by replay",
      sourceId: "fixture",
      primaryKey: ["id"],
      semanticTimeColumn: null,
      columns: [{ name: "id", type: "VARCHAR" }],
    },
  ],
});

const sample = { id: "sample", amount: "12.3456", tags: ["first", "second"], details: { n: 2 } };
const directories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixtures(rows: unknown = [sample]): string {
  const directory = mkdtempSync(join(tmpdir(), "watch-analytics-"));
  directories.push(directory);
  writeFileSync(join(directory, "samples.json"), JSON.stringify(rows));
  writeFileSync(join(directory, "events.json"), JSON.stringify([{ id: "event" }]));
  return directory;
}

describe("fixture analytics databases", () => {
  it.each(["all", "projections"] as const)("loads typed rows with %s seeding", async (seed) => {
    const db = await AnalyticsDatabase.materialize(ontology, fixtures(), seed);
    try {
      expect((await db.query("SELECT * FROM samples")).rows).toEqual([
        { ...sample, amount: 12.3456, details: JSON.stringify(sample.details) },
      ]);
      expect((await db.query("SELECT * FROM events")).rows).toEqual(
        seed === "all" ? [{ id: "event" }] : [],
      );
      await db.applyRow(ontology.table("samples")!, { id: "sample", amount: null, tags: [] });
      expect((await db.query("SELECT * FROM samples")).rows).toEqual([
        { id: "sample", amount: null, tags: [], details: null },
      ]);
      await expect(db.query("SELECT * FROM read_csv('/not-a-fixture.csv')")).rejects.toThrow(
        /disabled|permission/i,
      );
    } finally {
      db.close();
    }
  });

  it("keeps concurrent replays' mutable rows independent", async () => {
    const directory = fixtures();
    const first = await AnalyticsDatabase.materialize(ontology, directory);
    try {
      const second = await AnalyticsDatabase.materialize(ontology, directory);
      try {
        await first.applyRow(ontology.table("samples")!, { id: "sample", amount: 99 });
        expect((await first.query("SELECT amount FROM samples")).rows).toEqual([{ amount: 99 }]);
        expect((await second.query("SELECT amount FROM samples")).rows).toEqual([
          { amount: 12.3456 },
        ]);
      } finally {
        second.close();
      }
    } finally {
      first.close();
    }
  });

  it.each([
    { rows: [sample, { id: "other", extra: "undeclared" }], error: /does not declare/ },
    { rows: [sample, sample], error: /duplicate key|constraint/i },
    { rows: [sample, { id: "other", amount: "not a number" }], error: /convert/i },
    { rows: [sample, null], error: /not an object/ },
  ])("releases native resources when row loading fails: $error", async ({ rows, error }) => {
    const closeConnection = vi.spyOn(DuckDBConnection.prototype, "closeSync");
    const closeInstance = vi.spyOn(DuckDBInstance.prototype, "closeSync");
    await expect(AnalyticsDatabase.materialize(ontology, fixtures(rows))).rejects.toThrow(error);
    expect(closeConnection).toHaveBeenCalledOnce();
    expect(closeInstance).toHaveBeenCalledOnce();
    expect(closeConnection.mock.invocationCallOrder[0]).toBeLessThan(
      closeInstance.mock.invocationCallOrder[0]!,
    );
  });

  it("releases the native instance if connecting fails", async () => {
    vi.spyOn(DuckDBInstance.prototype, "connect").mockRejectedValueOnce(
      new Error("connect failed"),
    );
    const closeInstance = vi.spyOn(DuckDBInstance.prototype, "closeSync");
    await expect(AnalyticsDatabase.materialize(ontology, fixtures())).rejects.toThrow(
      "connect failed",
    );
    expect(closeInstance).toHaveBeenCalledOnce();
  });

  it("rejects unknown tables before allocating native resources", async () => {
    const directory = fixtures();
    writeFileSync(join(directory, "unknown.json"), "[]");
    const create = vi.spyOn(DuckDBInstance, "create");
    await expect(AnalyticsDatabase.materialize(ontology, directory)).rejects.toThrow(/no table/);
    expect(create).not.toHaveBeenCalled();
  });
});
