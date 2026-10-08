// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createLogger } from "@omnesis/core";
import { createDatabase } from "../../db.js";
import { resolveBrainSettings } from "../config.js";
import { KnowledgeEngine } from "./engine.js";
import { KnowledgeService } from "./service.js";
import { directKnowledgeGate } from "./writer.js";
import { knowledgeHash } from "./storage-validation.js";
import { KNOWLEDGE_DISCOVERY_POLICY, recordKnowledgeCoverage } from "./discovery.js";

let db: ReturnType<typeof createDatabase>;
let engine: KnowledgeEngine;
let gate: ReturnType<typeof directKnowledgeGate>;
const now = 100;
const versions = { "source:input": "v1" };
const fingerprint = knowledgeHash(versions);
beforeEach(() => {
  db = createDatabase(":memory:");
  db.exec(`INSERT INTO documents(id,provider_id,source_id,external_id,title,content,content_hash,metadata,source_created_at,source_updated_at,ingested_at,updated_at)
    VALUES('input','fictional','fictional','input','Workshop','The workshop is on Friday.','v1','{}','2027-01-01','2027-01-01','2027-01-01','2027-01-01');
    INSERT INTO knowledge_batches(id,run_id,creation_fingerprint,tier,status,created_at,updated_at)
    VALUES('batch','run','fp','immediate','running',1,1);
    INSERT INTO knowledge_batch_regions VALUES('batch','source:input');`);
  db.prepare(
    `INSERT INTO knowledge_frontier(batch_id,node_id,input_fingerprint,input_versions_json,depth,status)
    VALUES('batch','source:input',?,?,0,'offered')`,
  ).run(fingerprint, JSON.stringify(versions));
  gate = directKnowledgeGate(db);
  const settings = resolveBrainSettings();
  const log = createLogger("test:source-completion");
  const deps = { db, writeGate: gate, getSettings: () => settings, clock: () => now, log };
  const service = new KnowledgeService(deps);
  engine = new KnowledgeEngine({
    ...deps,
    service,
    decisions: { log, recordSpend: async () => {} },
  });
});
afterEach(() => db.close());

function prior(phase: "interpretation" | "organization") {
  recordKnowledgeCoverage(
    db,
    {
      subjectId: "input",
      inputRevision: "v1",
      phase,
      policyVersion: KNOWLEDGE_DISCOVERY_POLICY,
      status: "considered",
    },
    50,
  );
}
function status() {
  return db.prepare("SELECT status FROM knowledge_frontier WHERE batch_id='batch'").get();
}

it("refuses partial terminal completion before targets, coverage, or frontier writes", async () => {
  const targets = vi.spyOn(gate, "knowledge.discoveryTargets");
  const settle = vi.spyOn(gate, "knowledge.settleFrontier");
  await expect(
    engine.completeSource(
      "batch",
      "run",
      "source:input",
      fingerprint,
      false,
      ["interpretation"],
      ["unavailable-target"],
    ),
  ).rejects.toMatchObject({
    code: "claim_invalid",
    message: expect.stringContaining("organization still requires review"),
  });
  expect(targets).not.toHaveBeenCalled();
  expect(settle).not.toHaveBeenCalled();
  expect(status()).toEqual({ status: "offered" });
  expect(db.prepare("SELECT COUNT(*) AS n FROM knowledge_discovery_coverage").get()).toEqual({
    n: 0,
  });
});

it("combines prior current coverage with supplied work without granting conversion", async () => {
  prior("interpretation");
  await engine.completeSource("batch", "run", "source:input", fingerprint, false, ["organization"]);
  expect(status()).toEqual({ status: "changed" });
  expect(
    db.prepare("SELECT phase,reviewed_at FROM knowledge_discovery_coverage ORDER BY phase").all(),
  ).toEqual([
    { phase: "interpretation", reviewed_at: 50 },
    { phase: "organization", reviewed_at: now },
  ]);
});

it("default and gated completion satisfy both required phases", async () => {
  await engine.completeSource("batch", "run", "source:input", fingerprint, true);
  expect(status()).toEqual({ status: "skipped" });
  expect(
    db.prepare("SELECT phase,status FROM knowledge_discovery_coverage ORDER BY phase").all(),
  ).toEqual([
    { phase: "interpretation", status: "gated" },
    { phase: "organization", status: "gated" },
  ]);
});

it.each(["failed", "deferred", "expired", "old-revision", "old-policy"])(
  "does not count %s coverage toward completion",
  async (kind) => {
    prior("organization");
    if (kind === "failed" || kind === "deferred")
      db.prepare("UPDATE knowledge_discovery_coverage SET status=?").run(kind);
    if (kind === "expired") db.exec("UPDATE knowledge_discovery_coverage SET reconsider_at=100");
    if (kind === "old-revision")
      db.exec("UPDATE knowledge_discovery_coverage SET input_revision='v0'");
    if (kind === "old-policy")
      db.exec("UPDATE knowledge_discovery_coverage SET policy_version='old'");
    await expect(
      engine.completeSource("batch", "run", "source:input", fingerprint, false, ["interpretation"]),
    ).rejects.toMatchObject({ code: "claim_invalid" });
    expect(status()).toEqual({ status: "offered" });
  },
);

it("rechecks prior phase coverage atomically at the writer commit", async () => {
  prior("interpretation");
  const settle = gate["knowledge.settleFrontier"];
  vi.spyOn(gate, "knowledge.settleFrontier").mockImplementation(async (...args) => {
    db.exec("UPDATE knowledge_discovery_coverage SET status='failed' WHERE phase='interpretation'");
    return settle(...args);
  });
  await expect(
    engine.completeSource("batch", "run", "source:input", fingerprint, false, ["organization"]),
  ).rejects.toMatchObject({ code: "claim_invalid" });
  expect(status()).toEqual({ status: "offered" });
  expect(db.prepare("SELECT phase,status FROM knowledge_discovery_coverage").all()).toEqual([
    { phase: "interpretation", status: "failed" },
  ]);
});
