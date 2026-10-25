// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createLogger } from "@omnesis/core";
import { resolveBrainSettings } from "../config.js";
import { createBriefsStorageTables } from "../storage/schema.js";
import { createKnowledgeTables, getKnowledgeClaims, saveKnowledgeNode } from "./storage.js";
import { createKnowledgeWorkTables } from "./work-schema.js";
import { KnowledgeService } from "./service.js";
import { directKnowledgeGate } from "./writer.js";
import { buildKnowledgeTools } from "./tools.js";
import type { ToolHandle } from "@omnesis/agent";
import type { KnowledgeNodeView } from "./node-view.js";

let db: Database.Database;
let tools: ToolHandle[];
const invocation = { sessionId: "view-session", messageId: "view-message" };
const markup =
  '<claim id="hours" refs="source:notice">The studio opens at nine on weekdays.</claim>';

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(
    "CREATE TABLE documents(id TEXT PRIMARY KEY,content TEXT,content_hash TEXT); INSERT INTO documents VALUES('notice','The studio opens at nine on weekdays.','v1')",
  );
  createBriefsStorageTables(db);
  createKnowledgeTables(db);
  createKnowledgeWorkTables(db);
  const service = new KnowledgeService({
    db,
    writeGate: directKnowledgeGate(db),
    getSettings: () => resolveBrainSettings(),
    clock: () => 10,
    log: createLogger("test:node-view"),
  });
  saveKnowledgeNode(
    db,
    {
      id: "studio",
      kind: "wiki",
      title: "Studio hours",
      markdown: markup,
      expectedRevision: 0,
      inputVersions: { "source:notice": "v1" },
      metadata: { importance: 0.4, lastReviewedAt: 5, reviewDecision: "defer" } as never,
    },
    1,
  );
  tools = buildKnowledgeTools(service, { runId: "run" });
});
afterEach(() => db.close());

const handle = (name: string) => tools.find((tool) => tool.name === name)!;
const fetchView = async () => {
  const result = (await handle("knowledge_fetch").invoke(
    { id: "studio", editing: true },
    invocation,
  )) as { kind: "structured"; data: KnowledgeNodeView };
  return result.data;
};
const saveIssues = (node: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
  const parsed = handle("knowledge_save").schema.safeParse({ node, ...extra });
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
};

it("returns a node whose editable fields knowledge_save accepts unchanged", async () => {
  const view = await fetchView();
  expect(view.claims).toEqual([
    {
      id: "hours",
      supportLogic: "all",
      attribution: null,
      modality: "observation",
      epistemicStatus: "asserted",
      validFrom: null,
      validUntil: null,
    },
  ]);
  expect(view.metadata).toEqual({ importance: 0.4 });
  expect(view.readOnly.review).toMatchObject({ lastReviewedAt: 5, reviewDecision: "defer" });
  expect(view.readOnly.claims[0]).toMatchObject({ id: "hours", refs: ["source:notice"] });

  const node = {
    id: view.id,
    kind: view.kind,
    title: view.title,
    markdown: view.markdown,
    expectedRevision: view.revision,
    claims: view.claims,
    metadata: view.metadata,
  };
  expect(saveIssues(node)).toEqual([]);
  expect(await handle("knowledge_save").invoke({ node }, invocation)).toMatchObject({
    kind: "structured",
    data: { node: { revision: 2 } },
  });
});

it("names where a read-only value belongs when a save echoes it back", async () => {
  const view = await fetchView();
  const base = {
    id: view.id,
    kind: view.kind,
    title: view.title,
    markdown: view.markdown,
    expectedRevision: view.revision,
  };

  const [refs] = saveIssues({
    ...base,
    claims: [{ ...view.claims[0], refs: view.readOnly.claims[0]!.refs }],
  });
  expect(refs).toContain('"refs" is read-only claim state');
  expect(refs).toContain("claims[].relations");

  const [reviewed] = saveIssues({ ...base, reviewedClaimIds: ["hours"] });
  expect(reviewed).toContain('"reviewedClaimIds" belongs at the top level beside node');

  const [review] = saveIssues({ ...base, metadata: { ...view.metadata, ...view.readOnly.review } });
  expect(review).toContain('"lastReviewedAt" is system-owned review state');
  expect(review).toContain(
    "importance, volatility, uncertainty, activity, nextReviewAt, checkpointAt",
  );

  const [unknown] = saveIssues({ ...base, colour: "blue" });
  expect(unknown).toBe('Unrecognized key: "colour" is not accepted here');
});

it("never lets an echoed verification attest a claim", async () => {
  const view = await fetchView();
  const before = getKnowledgeClaims(db, "studio")[0]!.verification;
  const issues = saveIssues({
    id: view.id,
    kind: view.kind,
    title: view.title,
    markdown: view.markdown,
    expectedRevision: view.revision,
    claims: [{ ...view.claims[0], verification: "verified" }],
  });
  expect(issues[0]).toContain('"verification" is read-only claim state');
  expect(getKnowledgeClaims(db, "studio")[0]!.verification).toBe(before);
});
