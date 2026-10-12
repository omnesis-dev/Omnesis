// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createLogger } from "@omnesis/core";
import { resolveBrainSettings } from "../config.js";
import { createKnowledgeTables } from "./storage.js";
import { directKnowledgeGate } from "./writer.js";
import { KnowledgeService } from "./service.js";
import { buildKnowledgeTools } from "./tools.js";
import { referenceProofFeedback, savedProofFeedback } from "./proof-feedback.js";
import { KNOWLEDGE_REFERENCE_BATCH_BYTES, readKnowledgeReferenceBatch } from "./reference-batch.js";

let db: Database.Database;
let service: KnowledgeService;
const verify = vi.fn(async () => ({ label: "entailment" as const, probability: 1 }));
beforeEach(() => {
  verify.mockClear();
  db = new Database(":memory:");
  db.exec(
    "CREATE TABLE documents(id TEXT PRIMARY KEY,content TEXT,content_hash TEXT); INSERT INTO documents VALUES('source_a','The workshop begins Friday.','v1')",
  );
  createKnowledgeTables(db);
  service = new KnowledgeService({
    db,
    writeGate: directKnowledgeGate(db),
    getSettings: () => resolveBrainSettings(),
    getEntailmentVerifier: async () => ({ verify, dispose() {} }),
    clock: () => 100,
    log: createLogger("proof-feedback-test"),
  });
});
afterEach(() => db.close());
const savePage = (
  markdown = '<claim id="date" refs="source:source_a">The workshop begins Friday.</claim>',
) =>
  service.save({
    id: "page",
    kind: "wiki",
    title: "Workshop record",
    markdown,
    expectedRevision: 0,
    inputVersions: { "source:source_a": "v1" },
  });

it("reports accepted mixed proof through real tools without promoting whole-node support", async () => {
  await savePage();
  verify.mockClear();
  const tools = buildKnowledgeTools(service, { runId: "run" });
  const invocation = { sessionId: "session", messageId: "message" };
  const reference = tools.find((tool) => tool.name === "knowledge_reference")!;
  const batch = await reference.invoke(
    { refs: ["wiki:page", "wiki:page#claim:date", "source:source_a"] },
    invocation,
  );
  expect(batch).toMatchObject({
    kind: "structured",
    data: {
      items: [
        {
          ok: true,
          value: { ref: "wiki:page", verified: false, supportUsage: "orientation_only" },
        },
        { ok: true, value: { ref: "wiki:page#claim:date", verified: true } },
        { ok: true, value: { ref: "source:source_a", verified: true } },
      ],
    },
  });
  const save = tools.find((tool) => tool.name === "knowledge_save")!;
  const result = await save.invoke(
    {
      node: {
        id: "root",
        kind: "root",
        title: "Workshop overview",
        expectedRevision: 0,
        markdown:
          '<claim id="direct" refs="source:source_a">The workshop begins Friday.</claim>\n<claim id="derived" refs="wiki:page">The workshop begins Friday. [Workshop record](wiki:page)</claim>',
      },
    },
    invocation,
  );
  expect(result.kind, JSON.stringify(result)).toBe("structured");
  expect(result).toMatchObject({
    kind: "structured",
    data: {
      node: { id: "root", revision: 1 },
      verificationSummary: {
        status: "available",
        acceptedRevision: 1,
        truncated: false,
        claims: [
          { id: "derived", storedVerification: "unverified" },
          { id: "direct", storedVerification: "verified" },
        ],
      },
    },
  });
  expect(verify).toHaveBeenCalledTimes(1);
  expect(service.reference("wiki:root#claim:derived").verified).toBe(false);
  expect(service.reference("wiki:root#claim:direct").verified).toBe(true);
});

it("reports stored unverified without inventing an outage or semantic-negative reason", async () => {
  verify.mockRejectedValueOnce(new Error("Private provider detail"));
  const accepted = await savePage();
  const result = savedProofFeedback(db, accepted.node);
  expect(result).toMatchObject({
    status: "available",
    claims: [{ id: "date", storedVerification: "unverified" }],
  });
  expect(JSON.stringify(result)).not.toContain("Private provider detail");
  expect(result).not.toHaveProperty("reason");
});

it.each(["revision", "deleted", "withdrawn", "source_changed", "source_hidden"])(
  "does not attach claims after %s drift",
  async (change) => {
    const accepted = await savePage();
    if (change === "revision")
      db.exec("UPDATE knowledge_nodes SET revision=revision+1 WHERE id='page'");
    if (change === "deleted") db.exec("DELETE FROM knowledge_nodes WHERE id='page'");
    if (change === "withdrawn")
      db.exec("UPDATE knowledge_nodes SET fields_json='{\"withdrawn\":true}' WHERE id='page'");
    if (change === "source_changed")
      db.exec(
        "UPDATE documents SET content_hash='v2',content='A different record.' WHERE id='source_a'",
      );
    if (change === "source_hidden")
      db.exec(
        "INSERT INTO knowledge_source_revisions(document_id,content_hash,deleted,updated_at) VALUES('source_a','v1',1,101) ON CONFLICT(document_id) DO UPDATE SET deleted=1",
      );
    const result = savedProofFeedback(db, accepted.node);
    expect(result).toMatchObject({ status: "unavailable", acceptedRevision: 1 });
    expect(result).not.toHaveProperty("claims");
  },
);

it("caps returned claim states explicitly without returning their prose", async () => {
  const accepted = await savePage(
    Array.from(
      { length: 65 },
      (_, i) =>
        `<claim id="c${String(i).padStart(2, "0")}" refs="">Unqualified statement ${i}.</claim>`,
    ).join("\n"),
  );
  const result = savedProofFeedback(db, accepted.node);
  expect(result).toMatchObject({ status: "available", truncated: true });
  if (result.status !== "available") throw new Error("Expected readable accepted revision");
  expect(result.claims).toHaveLength(64);
  expect(JSON.stringify(result)).not.toContain("Unqualified statement");
});

it.each(["wiki", "loop", "annotation", "brief"])(
  "hints whole %s views without changing their authority",
  (kind) => {
    const view = {
      ref: `${kind}:item`,
      text: "Orientation",
      revision: 2,
      stale: false,
      verified: false,
    };
    expect(referenceProofFeedback(view)).toMatchObject({
      ...view,
      supportUsage: "orientation_only",
    });
    expect(referenceProofFeedback({ ...view, ref: `${kind}:item#claim:part` })).not.toHaveProperty(
      "supportUsage",
    );
  },
);

it("leaves source and tracked-field views unchanged and counts hints in batch fitting", () => {
  const view = {
    ref: "source:item",
    text: "Evidence",
    revision: "v1",
    stale: false,
    verified: true,
  };
  expect(referenceProofFeedback(view)).toBe(view);
  const field = { ...view, ref: "loop:item#field:state" };
  expect(referenceProofFeedback(field)).toBe(field);
  const result = readKnowledgeReferenceBatch(["wiki:first", "wiki:second"], (ref) =>
    referenceProofFeedback({ ...view, ref, text: "x".repeat(33_000), verified: false }),
  );
  expect(result.items).toHaveLength(1);
  expect(result.deferredRefs).toEqual(["wiki:second"]);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
    KNOWLEDGE_REFERENCE_BATCH_BYTES,
  );
});
