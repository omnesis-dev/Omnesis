// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { createLogger } from "@omnesis/core";
import { createDecisionPayloadTables } from "../decision-payload.js";
import { createBriefsStorageTables } from "../storage/schema.js";
import { createOpenLoop, getOpenLoop } from "../storage/open-loops.js";
import { captureOutcomeWriteFence } from "../storage/outcome-write-fence.js";
import { outcomeProposal } from "../record-check/outcome-context.js";
import { RECORD_CHECK_RUBRIC_VERSION } from "../record-check/rubric.js";
import { resolveBrainSettings } from "../config.js";
import { createKnowledgeTables } from "./schema.js";
import { createKnowledgeWorkTables } from "./work-schema.js";
import { directKnowledgeGate } from "./writer.js";
import { KnowledgeService } from "./service.js";
import { convertKnowledgeOwner } from "./owner-adapters.js";
import { checkKnowledgeOutcome } from "./outcome-check.js";
import {
  makeOutcomeAssessment,
  persistOutcomeAssessment,
  readOutcomeAssessment,
} from "./outcome-assessment.js";
import { purgeKnowledgeBySource } from "./storage-invalidation.js";
import type { KnowledgeRunFence } from "./run-fence.js";

let db: Database.Database, service: KnowledgeService, now: number;
beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys=ON");
  db.exec(
    "CREATE TABLE documents(id TEXT PRIMARY KEY,content TEXT,content_hash TEXT); INSERT INTO documents VALUES('source','Calibrate the tide sensor before the survey.','s1')",
  );
  createBriefsStorageTables(db);
  createKnowledgeTables(db);
  createKnowledgeWorkTables(db);
  createDecisionPayloadTables(db);
  now = 100;
  service = new KnowledgeService({
    db,
    writeGate: directKnowledgeGate(db),
    clock: () => now,
    getSettings: () => resolveBrainSettings(),
    log: createLogger("outcome-review-test"),
  });
  createOpenLoop(
    db,
    {
      id: "task",
      title: "Sensor calibration",
      description: "Calibrate the tide sensor before the survey.",
      createdByRun: "run",
      docs: ["source"],
      importance: 0.4,
      confidence: 0.8,
    },
    1,
  );
  convertKnowledgeOwner(db, "loop", "task", 1);
});
afterEach(() => db.close());
const pass = () => ({
  save: true as const,
  assessment: { policy: RECORD_CHECK_RUBRIC_VERSION, decisionId: "decision" },
});
function proposal() {
  const node = service.fetch("task", true)!;
  return {
    id: node.id,
    kind: "loop" as const,
    ownerId: "task",
    title: node.title,
    markdown: node.markdown,
    expectedRevision: node.revision,
    inputVersions: { "source:source": "s1" },
  };
}
function oldApproval(policy = "obsolete-policy") {
  const fence = captureOutcomeWriteFence(db, "task", ["source"]);
  const receipt = makeOutcomeAssessment(
    policy,
    outcomeProposal(getOpenLoop(db, "task")!),
    fence.sources,
    "previous",
    null,
  );
  db.transaction(() => persistOutcomeAssessment(db, "task", receipt, fence.sources, 1))();
}
it("rechecks an unchanged old-policy outcome once and commits the accepted receipt atomically", async () => {
  oldApproval();
  const check = vi.fn(async () => pass());
  const input = proposal();
  const fence = await checkKnowledgeOutcome(service, check, input);
  expect(check).toHaveBeenCalledOnce();
  expect(
    db.prepare("SELECT policy FROM knowledge_outcome_assessments WHERE status='pass'").get(),
  ).toEqual({ policy: "obsolete-policy" });
  await service.save(input, undefined, undefined, fence);
  expect(readOutcomeAssessment(db, "task", fence!.assessment!.fingerprint)?.status).toBe("pass");
  await checkKnowledgeOutcome(service, check, proposal());
  expect(check).toHaveBeenCalledOnce();
});
it("requires one fresh assessment per explicit review batch, then reuses it within that batch", async () => {
  oldApproval(RECORD_CHECK_RUBRIC_VERSION);
  db.exec(
    "INSERT INTO knowledge_work(id,subject_kind,subject_id,input_revision,input_changed_at,reason,tier,due_at,status,batch_id,created_at,updated_at) VALUES('review','node','task','1',1,'review','routine',0,'batched','batch',1,1)",
  );
  const run = { batchId: "batch", runId: "run" } as KnowledgeRunFence;
  const check = vi.fn(async () => pass());
  const input = proposal();
  const fence = await checkKnowledgeOutcome(service, check, input, undefined, run);
  await service.save(input, undefined, undefined, fence);
  await checkKnowledgeOutcome(service, check, proposal(), undefined, run);
  expect(check).toHaveBeenCalledOnce();
  db.prepare("UPDATE knowledge_work SET batch_id='next'").run();
  await checkKnowledgeOutcome(service, check, proposal(), undefined, {
    batchId: "next",
    runId: "run",
  } as KnowledgeRunFence);
  expect(check).toHaveBeenCalledTimes(2);
});
it.each(["refused", "unavailable"])(
  "bounds repeated %s assessments without recording a pass",
  async (mode) => {
    const check = vi.fn(async () =>
      mode === "refused"
        ? { save: false as const, decisionId: "refusal", score: 0, threshold: 1 }
        : { save: true as const },
    );
    await expect(checkKnowledgeOutcome(service, check, proposal())).rejects.toThrow();
    await expect(checkKnowledgeOutcome(service, check, proposal())).rejects.toThrow();
    expect(check).toHaveBeenCalledOnce();
    expect(
      db
        .prepare("SELECT COUNT(*) AS count FROM knowledge_outcome_assessments WHERE status='pass'")
        .get(),
    ).toEqual({ count: 0 });
    now += resolveBrainSettings().knowledge.soonDelayMs + 60_000;
    await expect(checkKnowledgeOutcome(service, check, proposal())).rejects.toThrow();
    expect(check).toHaveBeenCalledTimes(2);
  },
);
it("does not reuse an approval after evidence changes, and refuses commit if the source changes during judgment", async () => {
  oldApproval(RECORD_CHECK_RUBRIC_VERSION);
  db.prepare("UPDATE documents SET content_hash='s2'").run();
  const check = vi.fn(async () => {
    db.prepare("UPDATE documents SET content_hash='s3'").run();
    return pass();
  });
  const input = { ...proposal(), inputVersions: { "source:source": "s2" } };
  const fence = await checkKnowledgeOutcome(service, check, input);
  expect(check).toHaveBeenCalledOnce();
  await expect(service.save(input, undefined, undefined, fence)).rejects.toThrow();
  expect(readOutcomeAssessment(db, "task", fence!.assessment!.fingerprint)).toBeUndefined();
});
it.each(["source-delete", "source-purge", "owner-delete"])(
  "erases assessment fingerprints on %s",
  (operation) => {
    oldApproval();
    if (operation === "source-delete") db.prepare("DELETE FROM documents WHERE id='source'").run();
    if (operation === "source-purge") purgeKnowledgeBySource(db, "source", now);
    if (operation === "owner-delete") db.prepare("DELETE FROM open_loops WHERE id='task'").run();
    expect(db.prepare("SELECT COUNT(*) AS count FROM knowledge_outcome_assessments").get()).toEqual(
      { count: 0 },
    );
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM knowledge_outcome_assessment_sources").get(),
    ).toEqual({ count: 0 });
  },
);

it("invalidates cached approval when the judged actor's self role changes", async () => {
  db.exec(
    "CREATE TABLE people(id TEXT PRIMARY KEY,is_self INTEGER); INSERT INTO people VALUES('actor',1); UPDATE open_loops SET actors_json='[\"actor\"]' WHERE id='task'",
  );
  const check = vi.fn(async () => pass());
  const first = proposal();
  await service.save(
    first,
    undefined,
    undefined,
    await checkKnowledgeOutcome(service, check, first),
  );
  await checkKnowledgeOutcome(service, check, proposal());
  expect(check).toHaveBeenCalledOnce();
  db.prepare("UPDATE people SET is_self=0 WHERE id='actor'").run();
  await checkKnowledgeOutcome(service, check, proposal());
  expect(check).toHaveBeenCalledTimes(2);
});

it("refuses a pass if the actor self role changes during judgment", async () => {
  db.exec(
    "CREATE TABLE people(id TEXT PRIMARY KEY,is_self INTEGER); INSERT INTO people VALUES('actor',1); UPDATE open_loops SET actors_json='[\"actor\"]' WHERE id='task'",
  );
  const check = vi.fn(async () => {
    db.prepare("UPDATE people SET is_self=0 WHERE id='actor'").run();
    return pass();
  });
  const input = proposal();
  const fence = await checkKnowledgeOutcome(service, check, input);
  await expect(service.save(input, undefined, undefined, fence)).rejects.toThrow(
    "Outcome or supporting context changed",
  );
  expect(db.prepare("SELECT COUNT(*) AS n FROM knowledge_outcome_assessments").get()).toEqual({
    n: 0,
  });
});

it("refuses a brief-typed fence attached to a loop save", async () => {
  const input = proposal();
  const fence = captureOutcomeWriteFence(db, "task", ["source"]);
  fence.kind = "brief";
  await expect(service.save(input, undefined, undefined, fence)).rejects.toThrow(
    "Outcome or supporting context changed",
  );
});

it("binds the selected evidence packet as well as the complete source-version fence", () => {
  const proposed = outcomeProposal(getOpenLoop(db, "task")!);
  const sources = Array.from({ length: 9 }, (_, i) => ({ id: `source-${i}`, hash: `v-${i}` }));
  const first = sources.slice(0, 8).map((source) => source.id);
  const changed = ["source-8", ...first.slice(0, 7)];
  const receipt = (ids: readonly string[]) =>
    makeOutcomeAssessment("policy", proposed, sources, "decision", null, [], ids);
  expect(receipt(first).fingerprint).not.toBe(receipt(changed).fingerprint);
  expect(receipt(first).fingerprint).not.toBe(receipt([...first].reverse()).fingerprint);
  expect(receipt(first).fingerprint).toBe(receipt([...first]).fingerprint);
});

it("keeps generic knowledge schema usable without canonical loop tables", () => {
  const standalone = new Database(":memory:");
  try {
    standalone.pragma("foreign_keys=ON");
    createKnowledgeTables(standalone);
    expect(() =>
      standalone
        .prepare("DELETE FROM knowledge_outcome_assessments WHERE owner_id=?")
        .run("absent"),
    ).not.toThrow();
  } finally {
    standalone.close();
  }
});
