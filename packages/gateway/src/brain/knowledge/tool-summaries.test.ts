// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import { AGENT_TOOL_CARDS, createLogger } from "@omnesis/core";
import { summarizeToolArgs } from "@omnesis/agent";
import { resolveBrainSettings } from "../config.js";
import { createKnowledgeTables, saveKnowledgeNode } from "./storage.js";
import { KnowledgeService } from "./service.js";
import { buildKnowledgeTools } from "./tools.js";
import { directKnowledgeGate } from "./writer.js";

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.exec(
    "CREATE TABLE documents(id TEXT PRIMARY KEY,content TEXT,content_hash TEXT); INSERT INTO documents VALUES('evidence','Workshop starts Friday.','v1')",
  );
  createKnowledgeTables(db);
  saveKnowledgeNode(
    db,
    {
      id: "candidate_workshop",
      kind: "wiki",
      title: "Pottery workshop",
      expectedRevision: 0,
      markdown: '<claim id="date" refs="source:evidence">Workshop starts Friday.</claim>',
      inputVersions: { "source:evidence": "v1" },
    },
    10,
  );
});
afterEach(() => db.close());

function tools() {
  const service = new KnowledgeService({
    db,
    writeGate: directKnowledgeGate(db),
    getSettings: () => resolveBrainSettings(),
    clock: () => 30,
    log: createLogger("summary-test"),
  });
  return buildKnowledgeTools(service, { runId: "run" });
}
const summary = (name: string, args: unknown) =>
  summarizeToolArgs(
    tools().find((tool) => tool.name === name),
    args,
  );

it("names a page by its title, by bare id or wiki link", () => {
  expect(summary("knowledge_fetch", { id: "candidate_workshop" })).toBe("Pottery workshop");
  expect(summary("knowledge_fetch", { id: "wiki:candidate_workshop", editing: true })).toBe(
    "Pottery workshop",
  );
  expect(summary("knowledge_history", { id: "candidate_workshop" })).toBe("Pottery workshop");
  expect(summary("knowledge_links", { id: "candidate_workshop" })).toBe("Pottery workshop");
});

it("shows nothing rather than an id for a page that does not exist", () => {
  expect(summary("knowledge_fetch", { id: "candidate_missing" })).toBe("");
});

it("every interactive wiki tool has a decided transcript card", () => {
  for (const tool of tools()) expect(AGENT_TOOL_CARDS[tool.name], tool.name).toBeDefined();
});

it("never falls back to the raw arguments", () => {
  for (const tool of tools()) expect(tool.summarize, tool.name).toBeTypeOf("function");
  expect(summary("knowledge_list", { kind: "doc_annotation" })).toBe("doc annotation");
  expect(summary("knowledge_reference", { refs: ["a", "b"] })).toBe("2 references");
  expect(
    summary("knowledge_evidence", {
      documentId: "evidence",
      contentHash: "v1",
      quote: "Workshop   starts\nFriday.",
    }),
  ).toBe("Workshop starts Friday.");
});
