// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createLogger, type DecisionCapability } from "@omnesis/core";
import { createTemporalAnnotationTables } from "../../enrichment/temporal-annotations/storage.js";
import { resolveBrainSettings } from "../config.js";
import { createBriefsStorageTables } from "../storage/schema.js";
import {
  claimDueCognitionRuns,
  COGNITION_RUN_STALE_MS,
  DEFAULT_COGNITION_RUN_MAX_ATTEMPTS,
} from "../storage/run-queue.js";
import { createKnowledgeTables } from "./schema.js";
import { createKnowledgeWorkTables } from "./work-schema.js";
import { createKnowledgeDecisionTable } from "./decision-storage.js";
import { directKnowledgeGate } from "./writer.js";
import { KnowledgeService } from "./service.js";
import { KnowledgeQueryService } from "./query-service.js";
import { KnowledgeEngine, type KnowledgeEngineDeps } from "./engine.js";
import { listKnowledgeDiscoveryBacklog } from "./discovery.js";
import { enqueueKnowledgeWork, reserveKnowledgeRegion } from "./work.js";
import { advanceKnowledgeCascade, recordKnowledgeSourceChange } from "./storage.js";

let db: Database.Database, engine: KnowledgeEngine, service: KnowledgeService;
let now: number, serial: number;
/** Runs the drainer is executing right now, as its activity registry reports them. */
const inFlight = new Set<string>();
const settings = resolveBrainSettings({
  bootstrap: { enabled: false },
  knowledge: {
    soonDelay: "1m",
    retryBackoff: "2h",
    retryBackoffCap: "3h",
    maxFailedAttempts: 3,
  },
});
const log = createLogger("test:knowledge-retry");
const HOUR = 3_600_000;

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
  createKnowledgeDecisionTable(db);
  now = Date.parse("2027-01-11T08:00:00Z");
  serial = 0;
  inFlight.clear();
  const writeGate = directKnowledgeGate(db);
  service = new KnowledgeService({
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
          Object.keys(request.questions).map((key) => [key, { type: "score" as const, score: 2 }]),
        ),
      };
    },
  };
  engine = new KnowledgeEngine({
    db,
    writeGate,
    service,
    getSettings: () => settings,
    clock: () => now,
    log,
    idGen: () => String(++serial),
    isRunActive: (runId) => inFlight.has(runId),
    decisions: { getDecision: () => decision, log, recordSpend: async () => {} },
  } satisfies KnowledgeEngineDeps);
});
afterEach(() => db.close());

function source(id: string, hash = "v1") {
  db.prepare(
    `INSERT INTO documents VALUES(?,'fictional',?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET content_hash=excluded.content_hash,content=excluded.content`,
  ).run(
    id,
    hash,
    `Workshop note ${id} ${hash}.`,
    id,
    new Date(now).toISOString(),
    new Date(now).toISOString(),
  );
  recordKnowledgeSourceChange(db, { documentId: id, contentHash: hash }, now);
  advanceKnowledgeCascade(db, 100, now);
}
async function sharedPage(ids: string[]) {
  return service.save({
    id: "workshop",
    kind: "wiki",
    title: "Workshop",
    markdown: ids
      .map((id) => `<claim id="${id}" refs="source:${id}">Workshop note ${id}.</claim>`)
      .join("\n"),
    expectedRevision: 0,
    inputVersions: Object.fromEntries(
      ids.map((id) => [`source:${id}`, service.reference(`source:${id}`).revision]),
    ),
  });
}
function activeBatch(subjectId: string) {
  return db
    .prepare<[string], { id: string; runId: string; seeds: number }>(
      `SELECT b.id,b.run_id AS runId,(SELECT COUNT(*) FROM knowledge_work s WHERE s.batch_id=b.id) AS seeds
      FROM knowledge_batches b JOIN knowledge_work w ON w.batch_id=b.id
      WHERE w.subject_id=? AND b.status IN ('pending','running') ORDER BY b.created_at DESC,b.id DESC LIMIT 1`,
    )
    .get(subjectId);
}
function work(subjectId: string) {
  return db
    .prepare<
      [string],
      { status: string; failures: number; dueAt: number; lastError: string | null; rev: string }
    >(
      `SELECT status,failures,due_at AS dueAt,last_error AS lastError,input_revision AS rev FROM knowledge_work
      WHERE subject_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1`,
    )
    .get(subjectId)!;
}
/** Offer the batch, settle the named sources, then let its run fail terminally. */
async function failAttempt(batch: { id: string; runId: string }, settle: string[] = []) {
  const frontier = await engine.next(batch.id, batch.runId);
  for (const item of frontier.items)
    if (item.source && settle.includes(item.source.id))
      await engine.completeSource(batch.id, batch.runId, item.id, item.inputFingerprint, false, [
        "interpretation",
        "organization",
      ]);
  db.prepare("UPDATE cognition_runs SET status='failed' WHERE id=?").run(batch.runId);
  await engine.tick();
}

/** Settle every offered item with the engine's own write paths. */
async function finish(batch: { id: string; runId: string }) {
  for (let pass = 0; pass < 8; pass++) {
    const frontier = await engine.next(batch.id, batch.runId);
    if (frontier.done) return;
    for (const item of frontier.items) {
      if (item.source) {
        await engine.completeSource(batch.id, batch.runId, item.id, item.inputFingerprint, false, [
          "interpretation",
          "organization",
        ]);
        continue;
      }
      const node = service.fetch(item.id, true)!;
      await engine.saveNode(
        batch.id,
        batch.runId,
        item.id,
        item.inputFingerprint,
        {
          id: item.id,
          kind: node.kind,
          title: node.title,
          markdown: node.markdown,
          expectedRevision: node.revision,
          inputVersions: Object.fromEntries(
            Object.entries(item.inputVersions).filter(([key]) => key.startsWith("source:")),
          ),
        },
        item.pendingClaimIds,
      );
    }
  }
  throw new Error(`batch ${batch.id} did not finish`);
}

it("keeps settled seeds, isolates and backs off the unfinished one, parks it, and un-parks on a new revision", async () => {
  source("steady");
  source("stubborn");
  await sharedPage(["steady", "stubborn"]);
  await engine.tick();
  const shared = activeBatch("steady")!;
  expect(activeBatch("stubborn")!.id).toBe(shared.id);
  expect(shared.seeds).toBe(2);

  await failAttempt(shared, ["steady"]);
  // The settled seed's progress is durable; only the offered, unfinished one retries.
  expect(work("steady").status).toBe("completed");
  expect(work("stubborn")).toMatchObject({ status: "pending", failures: 1, dueAt: now + 2 * HOUR });
  // The page the settled source expanded to is its own obligation now. It was
  // never offered, so it is not charged, and it finishes on its own.
  expect(work("workshop")).toMatchObject({ status: "pending", failures: 0, dueAt: now + 60_000 });
  const failedAt = now;
  now += 60_000;
  await engine.tick();
  const page = activeBatch("workshop")!;
  expect(page.seeds).toBe(1);
  await finish(page);
  expect(work("workshop").status).toBe("completed");

  // The retry waits out its backoff, then runs alone.
  now = failedAt + 2 * HOUR - 1;
  await engine.tick();
  expect(activeBatch("stubborn")).toBeUndefined();
  now += 1;
  await engine.tick();
  const retry = activeBatch("stubborn")!;
  expect(retry.seeds).toBe(1);
  await failAttempt(retry);
  // The doubled delay is capped.
  expect(work("stubborn")).toMatchObject({ status: "pending", failures: 2, dueAt: now + 3 * HOUR });

  now += 3 * HOUR;
  await engine.tick();
  await failAttempt(activeBatch("stubborn")!);
  expect(work("stubborn")).toMatchObject({ status: "deferred", failures: 3, lastError: "parked" });
  const [parked] = new KnowledgeQueryService(db).status().parked;
  expect(parked).toMatchObject({
    subjectKind: "source",
    reason: "change",
    count: 1,
    maxFailures: 3,
  });
  expect(
    new KnowledgeQueryService(db)
      .pendingWork({ reason: "change", tier: parked!.tier, readiness: "parked" })
      .items.map((item) => item.nodeId),
  ).toEqual(["source:stubborn"]);
  // Nothing re-admits the parked revision: not the planner, intake or an explicit enqueue.
  expect(
    listKnowledgeDiscoveryBacklog(db, { phase: "organization", limit: 10, now }).map(
      (doc) => doc.id,
    ),
  ).not.toContain("stubborn");
  expect(
    enqueueKnowledgeWork(
      db,
      {
        id: "again",
        subjectId: "stubborn",
        subjectKind: "source",
        reason: "change",
        inputRevision: "v1",
        tier: "immediate",
        dueAt: now,
      },
      now,
    ),
  ).toMatchObject({ status: "deferred", lastError: "parked" });
  now += 24 * HOUR;
  await engine.tick();
  expect(activeBatch("stubborn")).toBeUndefined();

  // A new revision is ordinary fresh work.
  source("stubborn", "v2");
  await engine.tick();
  expect(work("stubborn")).toMatchObject({ rev: expect.stringMatching(/^v2/), failures: 0 });
  expect(new KnowledgeQueryService(db).status().parked).toEqual([]);
  now += settings.knowledge.routineDelayMs;
  await engine.tick();
  expect(activeBatch("stubborn")).toBeDefined();
});

it("never adopts a backed-off retry into a fresh batch over the same region", async () => {
  source("steady");
  source("stubborn");
  await sharedPage(["steady", "stubborn"]);
  await engine.tick();
  await failAttempt(activeBatch("steady")!, ["steady"]);
  expect(work("stubborn")).toMatchObject({ status: "pending", failures: 1 });
  // A new revision of a sibling reopens the shared region while the retry backs off.
  source("steady", "v2");
  await engine.tick();
  const fresh = activeBatch("steady")!;
  await engine.next(fresh.id, fresh.runId);
  expect(
    db
      .prepare<[string], { subject_id: string }>(
        "SELECT subject_id FROM knowledge_work WHERE batch_id=? ORDER BY subject_id",
      )
      .all(fresh.id)
      .map((row) => row.subject_id),
  ).not.toContain("stubborn");
  expect(work("stubborn")).toMatchObject({ status: "pending", failures: 1 });
});

it("charges no failure for work a failed batch never offered, nor for a batch abandoned without a failed run", async () => {
  source("first");
  source("second");
  await sharedPage(["first", "second"]);
  await engine.tick();
  const batch = activeBatch("first")!;
  db.prepare("UPDATE cognition_runs SET status='failed' WHERE id=?").run(batch.runId);
  await engine.tick();
  expect(work("first")).toMatchObject({ status: "pending", failures: 0 });
  expect(work("second")).toMatchObject({ status: "pending", failures: 0 });

  now += HOUR;
  await engine.tick();
  const next = activeBatch("first")!;
  await engine.next(next.id, next.runId);
  db.prepare("UPDATE cognition_runs SET status='completed' WHERE id=?").run(next.runId);
  await engine.tick();
  expect(work("first")).toMatchObject({ status: "pending", failures: 0 });
});

it("does not schedule a review for a page whose review is parked at its revision", async () => {
  source("evidence");
  await sharedPage(["evidence"]);
  const page = db
    .prepare<[], { revision: number }>("SELECT revision FROM knowledge_nodes WHERE id='workshop'")
    .get()!;
  db.prepare(
    "UPDATE knowledge_nodes SET metadata_json=json_set(metadata_json,'$.nextReviewAt',1) WHERE id='workshop'",
  ).run();
  db.prepare(
    `INSERT INTO knowledge_work(id,subject_id,subject_kind,reason,input_revision,input_changed_at,tier,due_at,created_at,updated_at,status,failures,last_error)
    VALUES('parked-review','workshop','node','review',?,1,'routine',1,1,1,'deferred',3,'parked')`,
  ).run(String(page.revision));
  await engine.tick();
  expect(
    db
      .prepare(
        "SELECT COUNT(*) AS count FROM knowledge_work WHERE subject_id='workshop' AND reason='review' AND status IN ('pending','batched')",
      )
      .get(),
  ).toEqual({ count: 0 });
});

it("completes sources whose shared target page was left unfinished, and keeps that page out of later batches while it retries alone", async () => {
  source("one");
  source("two");
  await sharedPage(["one", "two"]);
  await engine.tick();
  const shared = activeBatch("one")!;
  expect(shared.seeds).toBe(2);
  for (const item of (await engine.next(shared.id, shared.runId)).items)
    await engine.completeSource(
      shared.id,
      shared.runId,
      item.id,
      item.inputFingerprint,
      false,
      ["interpretation", "organization"],
      ["workshop"],
    );
  // The page both sources selected is offered; the model leaves it unfinished.
  const offered = (await engine.next(shared.id, shared.runId)).items.map((item) => item.id);
  expect(offered).toContain("workshop");
  db.prepare("UPDATE cognition_runs SET status='failed' WHERE id=?").run(shared.runId);
  await engine.tick();
  expect(work("one").status).toBe("completed");
  expect(work("two").status).toBe("completed");
  expect(work("workshop")).toMatchObject({ status: "pending", failures: 1 });

  // New evidence selecting the same page settles without the page re-entering
  // its batch; the page's own isolated retry still owes the repair.
  source("three");
  await engine.tick();
  const fresh = activeBatch("three")!;
  expect(fresh.seeds).toBe(1);
  const item = (await engine.next(fresh.id, fresh.runId)).items.find((entry) => entry.source)!;
  await engine.completeSource(
    fresh.id,
    fresh.runId,
    item.id,
    item.inputFingerprint,
    false,
    ["interpretation", "organization"],
    ["workshop"],
  );
  expect(await engine.next(fresh.id, fresh.runId)).toMatchObject({ done: true });
  expect(work("workshop")).toMatchObject({ status: "pending", failures: 1 });
});

it("offers a retry inputs not yet offered before ones an earlier attempt left", async () => {
  const ids = Array.from({ length: 9 }, (_, index) => `note-${index}`);
  for (const id of ids) source(id);
  await sharedPage(ids);
  await engine.tick();
  const batch = activeBatch("note-0")!;
  expect(batch.seeds).toBe(9);
  const first = (await engine.next(batch.id, batch.runId)).items.map((item) => item.id);
  expect(first).toHaveLength(8);
  // Within one attempt the order is stable; a retry turns to the unreached input.
  expect((await engine.next(batch.id, batch.runId)).items.map((item) => item.id)).toEqual(first);
  db.prepare("UPDATE cognition_runs SET attempts=2 WHERE id=?").run(batch.runId);
  const second = (await engine.next(batch.id, batch.runId)).items.map((item) => item.id);
  const missed = ids.map((id) => `source:${id}`).find((id) => !first.includes(id))!;
  expect(second[0]).toBe(missed);
});

/** Claim the batch's run for every attempt it has, each one dying before it settles. */
async function crashEveryAttempt(subjectId: string) {
  await engine.tick();
  const batch = activeBatch(subjectId)!;
  await engine.next(batch.id, batch.runId);
  for (let attempt = 0; attempt < DEFAULT_COGNITION_RUN_MAX_ATTEMPTS; attempt++)
    expect(claimDueCognitionRuns(db, { now }).map((run) => run.id)).toEqual([batch.runId]);
  expect(claimDueCognitionRuns(db, { now })).toEqual([]);
  const region = db
    .prepare<[string], { nodeId: string }>(
      "SELECT node_id AS nodeId FROM knowledge_batch_regions WHERE batch_id=?",
    )
    .all(batch.id)
    .map((row) => row.nodeId);
  expect(region.length).toBeGreaterThan(0);
  return { ...batch, region, lastAttemptAt: now };
}
/** Whether another batch could reserve these nodes now. */
function regionFree(nodeIds: string[]): boolean {
  db.prepare(
    `INSERT OR IGNORE INTO knowledge_batches(id,run_id,creation_fingerprint,tier,status,created_at,updated_at)
    VALUES('probe','probe-run','probe','routine','pending',?,?)`,
  ).run(now, now);
  try {
    reserveKnowledgeRegion(db, "probe", nodeIds);
    return true;
  } catch {
    return false;
  } finally {
    db.prepare("DELETE FROM knowledge_batch_regions WHERE batch_id='probe'").run();
  }
}
function runStatus(runId: string) {
  return db
    .prepare<[string], { status: string }>("SELECT status FROM cognition_runs WHERE id=?")
    .get(runId)?.status;
}

it("frees the region of a maintenance run that died on every attempt, charging its work once", async () => {
  source("lost");
  const dead = await crashEveryAttempt("lost");
  expect(regionFree(dead.region)).toBe(false);

  now = dead.lastAttemptAt + COGNITION_RUN_STALE_MS;
  await engine.tick();
  expect(db.prepare("SELECT status FROM knowledge_batches WHERE id=?").get(dead.id)).toEqual({
    status: "abandoned",
  });
  expect(runStatus(dead.runId)).toBe("failed");
  expect(claimDueCognitionRuns(db, { now })).toEqual([]);
  expect(work("lost")).toMatchObject({ status: "pending", failures: 1, dueAt: now + 2 * HOUR });
  expect(regionFree(dead.region)).toBe(true);
  // A later pass finds nothing more to settle.
  await engine.tick();
  expect(work("lost")).toMatchObject({ status: "pending", failures: 1 });
});

it("never abandons a last attempt that may still be running", async () => {
  source("slow");
  const last = await crashEveryAttempt("slow");
  // Claimed recently: the attempt may still be in flight.
  now = last.lastAttemptAt + COGNITION_RUN_STALE_MS - 1;
  await engine.tick();
  expect(activeBatch("slow")?.id).toBe(last.id);
  expect(runStatus(last.runId)).toBe("pending");
  // Claimed long ago but still executing: it is not dead either.
  inFlight.add(last.runId);
  now += HOUR;
  await engine.tick();
  expect(activeBatch("slow")?.id).toBe(last.id);
  expect(runStatus(last.runId)).toBe("pending");
  expect(regionFree(last.region)).toBe(false);
  // Once it stops without settling, it is.
  inFlight.delete(last.runId);
  await engine.tick();
  expect(activeBatch("slow")).toBeUndefined();
  expect(runStatus(last.runId)).toBe("failed");
  expect(regionFree(last.region)).toBe(true);
});
