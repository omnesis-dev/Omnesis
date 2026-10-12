// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createLogger } from "@omnesis/core";
import { createDecisionPayloadTables } from "../decision-payload.js";
import { resolveBrainSettings } from "../config.js";
import { createKnowledgeTables, getKnowledgeNode } from "./storage.js";
import { directKnowledgeGate } from "./writer.js";
import { KnowledgeService } from "./service.js";
import { WikiValueCheck } from "./wiki-value-check.js";
import type { CheckRecord } from "../record-check/check.js";

let db: Database.Database;
let service: KnowledgeService;
const proposal = () => ({
  id: "observatory",
  kind: "wiki" as const,
  title: "Observatory access",
  expectedRevision: 0,
  markdown:
    '<claim id="access" refs="source:route source:hours">The eastern path is usable only before dusk.</claim>',
  inputVersions: { "source:route": "r1", "source:hours": "h1" },
});
beforeEach(() => {
  db = new Database(":memory:");
  db.exec(
    "CREATE TABLE documents(id TEXT PRIMARY KEY,content TEXT,content_hash TEXT); INSERT INTO documents VALUES('route','Use the eastern path.','r1'),('hours','The eastern gate shuts at dusk.','h1')",
  );
  createKnowledgeTables(db);
  createDecisionPayloadTables(db);
  service = new KnowledgeService({
    db,
    writeGate: directKnowledgeGate(db),
    getSettings: () => resolveBrainSettings(),
    getEntailmentVerifier: async () => null,
    clock: () => 100,
    log: createLogger("wiki-value-test"),
  });
});
afterEach(() => db.close());
it("assesses the actual draft and current references, memoizing only the exact enforced snapshot", async () => {
  let policy = "policy1";
  const check = Object.assign(
    vi.fn<CheckRecord>(async () => ({
      save: true as const,
      assessment: { policy, decisionId: "d" },
    })),
    { policyKey: () => policy },
  );
  const gate = new WikiValueCheck(service, check);
  await gate.assess(proposal());
  await gate.assess(proposal());
  expect(check).toHaveBeenCalledTimes(1);
  expect(check.mock.calls[0]?.[0]).toMatchObject({
    record: { type: "wiki", text: "The eastern path is usable only before dusk." },
    wikiContext: {
      title: "Observatory access",
      references: [
        { ref: "source:route", text: "Use the eastern path." },
        { ref: "source:hours", text: "The eastern gate shuts at dusk." },
      ],
    },
  });
  policy = "policy2";
  await gate.assess(proposal());
  expect(check).toHaveBeenCalledTimes(2);
  db.exec("UPDATE documents SET content_hash='r2' WHERE id='route'");
  await expect(gate.assess(proposal())).rejects.toThrow("Stale dependency version");
  expect(check).toHaveBeenCalledTimes(2);
});
it("refuses without mutating the page, and remembers a refused snapshot without paying again", async () => {
  const check = vi.fn<CheckRecord>(async () => ({
    save: false as const,
    decisionId: "d",
    score: 0.1,
    threshold: 0.81,
  }));
  const gate = new WikiValueCheck(service, check);
  await expect(gate.assess(proposal())).rejects.toThrow("Wiki not saved");
  await expect(gate.assess(proposal())).rejects.toThrow("unpublished or deferred");
  expect(check).toHaveBeenCalledTimes(1);
  expect(getKnowledgeNode(db, "observatory")).toBeNull();
});
it("skips root and unchanged prose proof refresh, but checks changed title or body", async () => {
  const prior = await service.save(proposal());
  const check = vi.fn<CheckRecord>(async () => ({ save: true as const }));
  const gate = new WikiValueCheck(service, check);
  await gate.assess({ ...proposal(), kind: "root" });
  await gate.assess({ ...proposal(), expectedRevision: prior.node.revision });
  expect(check).not.toHaveBeenCalled();
  await gate.assess({
    ...proposal(),
    expectedRevision: prior.node.revision,
    title: "Observatory entrance",
  });
  expect(check).toHaveBeenCalledTimes(1);
});
it("does not memoize fail-open/off/shadow decisions or send partial oversized drafts for judgement", async () => {
  const check: CheckRecord = vi.fn<CheckRecord>(async () => ({ save: true as const }));
  const gate = new WikiValueCheck(service, check);
  await gate.assess(proposal());
  await gate.assess(proposal());
  expect(check).toHaveBeenCalledTimes(2);
  await gate.assess({ ...proposal(), markdown: "x".repeat(24_001) });
  expect(vi.mocked(check).mock.calls[2]?.[0].wikiContext).toBeUndefined();
  expect(vi.mocked(check).mock.calls[2]?.[0].record.text).toHaveLength(24_000);
});
