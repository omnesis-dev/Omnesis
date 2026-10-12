// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createBriefsStorageTables } from "../storage/schema.js";
import { resolveBrainSettings } from "../config.js";
import { createKnowledgeTables } from "./schema.js";
import { createKnowledgeWorkTables } from "./work-schema.js";
import { enqueueKnowledgeWork } from "./work.js";
import { readKnowledgeBootstrapStatus } from "./bootstrap-status.js";

let db: Database.Database;
const now = Date.parse("2027-01-12T12:00:00Z");
const brain = resolveBrainSettings({ bootstrap: { enabled: true, maxRuns: 3, maxRunsPerDay: 2 } });
const settings = { ...brain.bootstrap, knowledge: true, recencyWindowMs: brain.recencyWindowMs };
beforeEach(() => {
  db = new Database(":memory:");
  db.exec("CREATE TABLE documents(id TEXT PRIMARY KEY,content_hash TEXT,content TEXT)");
  createBriefsStorageTables(db);
  createKnowledgeTables(db);
  createKnowledgeWorkTables(db);
});
afterEach(() => db.close());

it("reports operator consent and live discovery independently of legacy progress", () => {
  db.prepare(
    "INSERT INTO cognition_engine_state(key,value) VALUES('bootstrap_total_enqueued','99999')",
  ).run();
  const unstarted = readKnowledgeBootstrapStatus(db, settings, now, brain.budget);
  expect(unstarted).toMatchObject({
    mode: "knowledge",
    state: "unstarted",
    startedAt: null,
    admission: { total: 0 },
    corpusCompletion: "not-measured",
    liveDiscoveryIndependent: true,
  });
  db.prepare("INSERT INTO cognition_engine_state(key,value) VALUES('bootstrap_started_at',?)").run(
    String(now),
  );
  expect(readKnowledgeBootstrapStatus(db, settings, now).state).toBe("running");
  expect(readKnowledgeBootstrapStatus(db, { ...settings, enabled: false }, now).state).toBe("off");
});

it("counts discovery work admissions, excludes reactive work, and applies actual backstops", () => {
  db.prepare("INSERT INTO cognition_engine_state(key,value) VALUES('bootstrap_started_at',?)").run(
    String(now),
  );
  for (const [id, reason] of [
    ["a", "discovery"],
    ["b", "upgrade"],
    ["c", "change"],
  ] as const) {
    db.prepare("INSERT INTO documents VALUES(?,'v1','Fictional context')").run(id);
    enqueueKnowledgeWork(
      db,
      {
        id,
        subjectId: id,
        subjectKind: "source",
        reason,
        inputRevision: "v1",
        tier: "routine",
        dueAt: now + 1000,
      },
      now,
    );
  }
  const status = readKnowledgeBootstrapStatus(db, settings, now);
  expect(status).toMatchObject({
    state: "waiting",
    admission: {
      unit: "source-revision-work-items",
      total: 2,
      today: 2,
      pending: 2,
      remainingToday: 0,
      remainingLifetime: 1,
    },
  });
  expect(readKnowledgeBootstrapStatus(db, { ...settings, maxRuns: 2 }, now).state).toBe("parked");
  expect(status.batches).toEqual([]);
  expect(status.revisionCoverage).toEqual([]);
});

it("projects only an active provider breaker, independently of admission", () => {
  const insert = db.prepare("INSERT INTO cognition_engine_state(key,value) VALUES(?,?)");
  insert.run("provider_breaker_open_until", String(now + 60_000));
  insert.run("provider_breaker_failures", "3");
  insert.run("provider_breaker_error", "Synthetic backend unavailable");
  expect(readKnowledgeBootstrapStatus(db, settings, now).providerOutage).toEqual({
    openUntil: now + 60_000,
    consecutiveFailures: 3,
    lastError: "Synthetic backend unavailable",
  });
  expect(readKnowledgeBootstrapStatus(db, settings, now + 60_000).providerOutage).toBeNull();
});

it("does not refund admission backstops when private source work is erased", () => {
  db.prepare("INSERT INTO cognition_engine_state(key,value) VALUES('bootstrap_started_at',?)").run(
    String(now),
  );
  db.exec("INSERT INTO documents VALUES('private','v1','Fictional history')");
  enqueueKnowledgeWork(
    db,
    {
      id: "history",
      subjectId: "private",
      subjectKind: "source",
      reason: "discovery",
      inputRevision: "v1",
      tier: "routine",
      dueAt: now,
    },
    now,
  );
  db.exec("DELETE FROM knowledge_work; DELETE FROM documents");
  expect(readKnowledgeBootstrapStatus(db, { ...settings, maxRuns: 1 }, now)).toMatchObject({
    state: "parked",
    admission: { total: 1, today: 1, pending: 0, remainingLifetime: 0 },
  });
});
