// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLogger, type DecisionCapability } from "@omnesis/core";
import {
  createSourceInventoryTables,
  recordSourceInventoryDocument,
  recordSourceInventoryPage,
} from "../../data/repositories/SourceInventoryRepository.js";
import { createTemporalAnnotationTables } from "../../enrichment/temporal-annotations/storage.js";
import { resolveBrainSettings } from "../config.js";
import { createBriefsStorageTables } from "../storage/schema.js";
import { createKnowledgeTables } from "./schema.js";
import { createKnowledgeWorkTables } from "./work-schema.js";
import { directKnowledgeGate } from "./writer.js";
import { KnowledgeService } from "./service.js";
import { KnowledgeEngine, type KnowledgeEngineDeps } from "./engine.js";
import { advanceKnowledgeCascade, recordKnowledgeSourceChange } from "./storage.js";
import { hasKnowledgeWorkFromExcludedSources } from "./work.js";
import { KNOWLEDGE_DISCOVERY_POLICY } from "./discovery-policy.js";
import { listOrganizationAdmissions } from "./organization.js";

const log = createLogger("test:knowledge-excluded-sources");
const DAY = 86_400_000;
let db: Database.Database, engine: KnowledgeEngine;
let writeGate: ReturnType<typeof directKnowledgeGate>;
let now: number, serial: number;
let settings: ReturnType<typeof resolveBrainSettings>;

/** Historical admission open and generous, with `excludedSources` as given. */
function configure(excludedSources: string[], bootstrap = true) {
  settings = resolveBrainSettings({
    excludedSources,
    bootstrap: {
      enabled: bootstrap,
      batchSize: 20,
      maxRuns: 100,
      maxRunsPerDay: 100,
      backlogTarget: 50,
    },
    knowledge: { bootstrapBatchSize: 20 },
  });
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys=ON");
  db.exec(
    `CREATE TABLE documents(id TEXT PRIMARY KEY,source_id TEXT NOT NULL,content_hash TEXT NOT NULL,content TEXT NOT NULL,title TEXT NOT NULL,source_created_at TEXT,source_updated_at TEXT)`,
  );
  createBriefsStorageTables(db);
  createTemporalAnnotationTables(db);
  createKnowledgeTables(db);
  createKnowledgeWorkTables(db);
  now = Date.parse("2027-01-11T08:00:00Z");
  serial = 0;
  configure([], false);
  writeGate = directKnowledgeGate(db);
  const service = new KnowledgeService({
    db,
    writeGate,
    getSettings: () => settings,
    clock: () => now,
    log,
  });
  const decision: DecisionCapability = {
    modelId: "scripted",
    dispose() {},
    async decide(request) {
      return {
        model: "scripted",
        answers: Object.fromEntries(
          Object.keys(request.questions).map((key) => [
            key,
            { type: "score" as const, score: 1.8 },
          ]),
        ),
      };
    },
  };
  const deps = {
    db,
    writeGate,
    service,
    getSettings: () => settings,
    clock: () => now,
    log,
    idGen: () => String(++serial),
    decisions: { getDecision: () => decision, log, recordSpend: async () => {} },
  } satisfies KnowledgeEngineDeps;
  engine = new KnowledgeEngine(deps);
});
afterEach(() => db.close());

/** A source document arriving now (a live change) unless `history` backdates it. */
function source(id: string, sourceId: string, at = now) {
  db.prepare(`INSERT INTO documents VALUES(?,?,'v1','The workshop begins Friday.',?,?,?)`).run(
    id,
    sourceId,
    id,
    new Date(at).toISOString(),
    new Date(at).toISOString(),
  );
  recordKnowledgeSourceChange(db, { documentId: id, contentHash: "v1" }, now);
  advanceKnowledgeCascade(db, 100, now);
}

/** Persisted history: indexed before incremental intake, so no journal entry. */
function history(id: string, sourceId: string, ageDays: number) {
  source(id, sourceId, now - ageDays * DAY);
  db.prepare("DELETE FROM knowledge_changes WHERE entity_id=?").run(id);
}

function startHistoricalReview() {
  db.prepare("INSERT INTO cognition_engine_state(key,value) VALUES('bootstrap_started_at',?)").run(
    String(now),
  );
}

function work(): Array<{ subject_id: string; reason: string; status: string }> {
  return db
    .prepare<
      [],
      { subject_id: string; reason: string; status: string }
    >("SELECT subject_id,reason,status FROM knowledge_work WHERE subject_kind='source' ORDER BY subject_id")
    .all();
}

describe("brain.excludedSources admission", () => {
  it("acknowledges live changes from an excluded source without admitting work", async () => {
    configure(["codex"], false);
    source("assistant-session", "codex:local");
    source("assistant-other", "codex");
    source("mail", "gmail:maya@example.com");
    await engine.tick();
    expect(work().map((row) => row.subject_id)).toEqual(["mail"]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM knowledge_changes").get()).toEqual({ n: 0 });
  });

  it("matches a source type on its type component, never as a string prefix", async () => {
    configure(["codex"], false);
    source("other-type", "codex-archive:local");
    await engine.tick();
    expect(work().map((row) => row.subject_id)).toEqual(["other-type"]);
  });

  it("excludes exactly one source when the entry is a source id", async () => {
    configure(["github:jamie-lopez"], false);
    source("excluded-account", "github:jamie-lopez");
    source("sibling-account", "github:sarah-mendez");
    await engine.tick();
    expect(work().map((row) => row.subject_id)).toEqual(["sibling-account"]);
  });

  it("never admits an excluded source's history, and admits it once the exclusion is removed", async () => {
    configure(["codex"]);
    startHistoricalReview();
    history("old-session", "codex:local", 5);
    history("old-mail", "gmail:maya@example.com", 5);
    await engine.tick();
    await engine.tick();
    expect(work().map((row) => [row.subject_id, row.reason])).toEqual([["old-mail", "discovery"]]);
    configure([]);
    await engine.tick();
    expect(work().map((row) => row.subject_id)).toContain("old-session");
  });

  it("skips an excluded source's initial inventory", async () => {
    createSourceInventoryTables(db);
    configure(["codex"], false);
    const startedAt = "2027-01-11T08:00:00.000Z";
    for (const [id, sourceId, inventoryId] of [
      ["recent-session", "codex:local", "12345678-1234-4234-8234-123456789012"],
      ["recent-mail", "gmail:maya@example.com", "22345678-1234-4234-8234-123456789012"],
    ] as const) {
      const inventory = { id: inventoryId, startedAt };
      source(id, sourceId, now - DAY);
      recordSourceInventoryPage(db, sourceId, "", inventory, false, now);
      recordSourceInventoryDocument(db, {
        documentId: id,
        inventoryId: inventory.id,
        revision: "v1",
        now,
      });
    }
    await engine.tick();
    await engine.tick();
    expect(work().map((row) => row.subject_id)).toEqual(["recent-mail"]);
  });
});

describe("brain.excludedSources retirement", () => {
  async function enqueue(id: string, reason: "change" | "discovery") {
    await writeGate["knowledge.enqueue"](
      {
        id: `kw-${id}`,
        subjectId: id,
        subjectKind: "source",
        reason,
        inputRevision: "v1",
        tier: "routine",
        dueAt: now + DAY,
      },
      now,
    );
  }

  it("withdraws pending work already queued for a newly excluded source, whatever admitted it", async () => {
    history("queued-session", "codex:local", 3);
    history("queued-history", "codex:local", 40);
    history("queued-mail", "gmail:maya@example.com", 3);
    await enqueue("queued-session", "change");
    await enqueue("queued-history", "discovery");
    await enqueue("queued-mail", "change");
    configure(["codex"], false);
    expect(hasKnowledgeWorkFromExcludedSources(db, settings.excludedSources)).toBe(true);
    await engine.tick();
    expect(work().map((row) => row.subject_id)).toEqual(["queued-mail"]);
    expect(hasKnowledgeWorkFromExcludedSources(db, settings.excludedSources)).toBe(false);
    // Nothing was reviewed, so no coverage hides it once the exclusion is lifted.
    expect(db.prepare("SELECT COUNT(*) AS n FROM knowledge_discovery_coverage").get()).toEqual({
      n: 0,
    });
  });

  it("settles a batched item of a newly excluded source without offering it", async () => {
    source("session", "codex:local");
    source("mail", "gmail:maya@example.com");
    await engine.tick();
    const batches = db
      .prepare<
        [],
        { id: string; runId: string }
      >("SELECT id,run_id AS runId FROM knowledge_batches WHERE status IN ('pending','running')")
      .all();
    expect(batches.length).toBeGreaterThan(0);
    configure(["codex"], false);
    const offered: string[] = [];
    for (const batch of batches) {
      const view = await engine.next(batch.id, batch.runId);
      offered.push(...view.items.map((item) => item.id));
    }
    expect(offered).toContain("source:mail");
    expect(offered).not.toContain("source:session");
    expect(
      db
        .prepare("SELECT status FROM knowledge_frontier WHERE node_id='source:session'")
        .all()
        .map((row) => (row as { status: string }).status),
    ).toEqual(["unchanged"]);
  });
});

describe("brain.excludedSources organization revisits", () => {
  it("never revisits gated evidence from an excluded source", () => {
    history("gated-session", "codex:local", 3);
    history("gated-mail", "gmail:maya@example.com", 3);
    for (const id of ["gated-session", "gated-mail"])
      db.prepare(
        `INSERT INTO knowledge_discovery_coverage(subject_id,input_revision,phase,policy_version,status,reviewed_at)
         VALUES(?,'v1','organization',?,'gated',?)`,
      ).run(id, KNOWLEDGE_DISCOVERY_POLICY, now - 30 * DAY);
    const due = (excludedSources: string[]) =>
      listOrganizationAdmissions(db, { now, limit: 10, retryMs: DAY, excludedSources })
        .map((admission) => admission.id)
        .sort();
    expect(due([])).toEqual(["gated-mail", "gated-session"]);
    expect(due(["codex"])).toEqual(["gated-mail"]);
  });
});
