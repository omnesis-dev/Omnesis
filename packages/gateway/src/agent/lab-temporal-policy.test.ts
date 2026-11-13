// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createLabTable, setLabFlag } from "../lab/store.js";
import { withTaskTemporalPolicy } from "./lab-temporal-policy.js";
import type { TemporalItem, TemporalQueryResult } from "@omnesis/core";

let db: Database.Database;
beforeEach(() => {
  vi.stubEnv("OMNESIS_EXPERIMENTAL", "1");
  db = new Database(":memory:");
  createLabTable(db);
  db.exec(`CREATE TABLE documents(id TEXT PRIMARY KEY,source_id TEXT,external_id TEXT);
    CREATE TABLE knowledge_nodes(id TEXT PRIMARY KEY,kind TEXT);
    INSERT INTO documents VALUES ('task','open-loops','task'),('source','files:test','source');`);
});
afterEach(() => {
  db.close();
  vi.unstubAllEnvs();
});

it("retains stored temporal evidence without the Brain while removing disabled task references", async () => {
  const item: TemporalItem = {
    id: "annotation",
    origin: "annotation",
    start: "2026-01-01T00:00:00Z",
    endExclusive: "2026-01-02T00:00:00Z",
    precision: "day",
    allDay: true,
    label: "An invented project date",
    kind: "event",
    modality: "asserted",
    status: "active",
    annotation: {
      documentIds: ["task", "source"],
      personIds: [],
      loopIds: ["task"],
      projectionIds: [],
      createdByRun: "run",
      revision: 1,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    },
  };
  const result: TemporalQueryResult = {
    type: "temporal.results",
    window: { start: item.start, endExclusive: item.endExclusive, timeZone: "UTC" },
    items: [item],
    summary: { anchored: 1, spanning: 0 },
    coverage: { projectionSources: [], specialistSources: [], annotations: { selective: true } },
    truncated: false,
  };
  const port = withTaskTemporalPolicy({ query: async () => result }, db);
  const input = { from: "2026-01-01", to: "2026-01-02", timeZone: "UTC" };
  const hidden = await port.query(input);
  expect(hidden.items[0]?.annotation?.loopIds).toEqual([]);
  expect(hidden.items[0]?.annotation?.documentIds).toEqual(["source"]);
  expect(hidden.items[0]?.label).toBe(item.label);
  setLabFlag(db, "tasks", true);
  expect(await port.query(input)).toBe(result);
});
