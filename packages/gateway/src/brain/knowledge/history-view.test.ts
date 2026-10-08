// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createLogger } from "@omnesis/core";
import { resolveBrainSettings } from "../config.js";
import { withGrantedMutationsOnly } from "../steward/runtime.js";
import { createKnowledgeTables, saveKnowledgeNode } from "./storage.js";
import { readKnowledgeHistory } from "./history-view.js";
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
});
afterEach(() => db.close());
function save(
  revision: number,
  markdown = '<claim id="date" refs="source:evidence">Workshop starts Friday.</claim>',
) {
  saveKnowledgeNode(
    db,
    {
      id: "workshop",
      kind: "wiki",
      title: "Workshop",
      expectedRevision: revision,
      markdown,
      inputVersions: markdown.includes("source:evidence") ? { "source:evidence": "v1" } : {},
    },
    revision + 10,
  );
}
it("paginates immutable historical summaries and reconstructs oversized markup exactly", () => {
  const original =
    '<claim id="date" refs="source:evidence">' +
    ("\u0001".repeat(6000) + "Useful historical context. 🌿 ").repeat(3) +
    "</claim>";
  save(0, original);
  db.prepare("UPDATE knowledge_revisions SET title=? WHERE node_id=\'workshop\'").run(
    "\u0002".repeat(1000),
  );
  for (let revision = 1; revision < 8; revision++) save(revision);
  const summaries: number[] = [];
  let beforeRevision: number | undefined;
  do {
    const result = readKnowledgeHistory(db, { id: "workshop", beforeRevision, limit: 3 });
    if (!("items" in result)) throw new Error("Expected revision summaries");
    expect(result.items.length).toBeLessThanOrEqual(3);
    expect(JSON.stringify(result).length).toBeLessThan(10000);
    summaries.push(...result.items.map((item) => item.revision));
    beforeRevision = result.nextBeforeRevision ?? undefined;
  } while (beforeRevision !== undefined);
  expect(summaries).toEqual([8, 7, 6, 5, 4, 3, 2, 1]);
  let restored = "";
  let offset: number | undefined = 0;
  do {
    const chunk = readKnowledgeHistory(db, { id: "workshop", revision: 1, offset });
    if (!("markdownChunk" in chunk)) throw new Error("Expected history chunk");
    expect(Buffer.byteLength(JSON.stringify(chunk))).toBeLessThanOrEqual(32768);
    expect(chunk.markdownChunk).not.toMatch(/[\uD800-\uDBFF]$/);
    expect(chunk.currentRevision).toBe(8);
    expect(chunk.warning).toContain("not current proof");
    expect(chunk.offset).toBe(restored.length);
    restored += chunk.markdownChunk;
    offset = chunk.nextOffset ?? undefined;
  } while (offset !== undefined);
  expect(restored).toBe(original);
  expect(() => readKnowledgeHistory(db, { id: "workshop", revision: 99 })).toThrow("unavailable");
  expect(() =>
    readKnowledgeHistory(db, { id: "workshop", revision: 1, offset: original.length + 1 }),
  ).toThrow("outside");
});
it("immediately fences old-only private ancestry before physical history cleanup", () => {
  save(0);
  save(1, '<claim id="other" refs="">Historical workshop notes.</claim>');
  expect(readKnowledgeHistory(db, { id: "workshop", revision: 1 })).toHaveProperty("markdownChunk");
  db.prepare(
    "INSERT INTO knowledge_source_revisions(document_id,content_hash,deleted,updated_at) VALUES('evidence','v1',1,20)",
  ).run();
  expect(db.prepare("SELECT COUNT(*) AS n FROM knowledge_revisions").get()).toEqual({ n: 2 });
  expect(() => readKnowledgeHistory(db, { id: "workshop" })).toThrow("unavailable");
  expect(() => readKnowledgeHistory(db, { id: "workshop", revision: 1 })).toThrow("unavailable");
});
it("keeps an emoji intact at the maximum character boundary", () => {
  const prefix = '<claim id="date" refs="source:evidence">';
  const original = prefix + "x".repeat(8191 - prefix.length) + "🌿</claim>";
  save(0, original);
  const first = readKnowledgeHistory(db, { id: "workshop", revision: 1 });
  if (!("markdownChunk" in first)) throw new Error("Expected history chunk");
  expect(first.nextOffset).toBe(8191);
  const second = readKnowledgeHistory(db, {
    id: "workshop",
    revision: 1,
    offset: first.nextOffset!,
  });
  if (!("markdownChunk" in second)) throw new Error("Expected history chunk");
  expect(second.markdownChunk.startsWith("🌿")).toBe(true);
  expect(first.markdownChunk + second.markdownChunk).toBe(original);
});
it("exposes a read-only history tool through the production maintenance grant filter", async () => {
  save(0);
  const service = new KnowledgeService({
    db,
    writeGate: directKnowledgeGate(db),
    getSettings: () => resolveBrainSettings(),
    clock: () => 30,
    log: createLogger("history-test"),
  });
  const tools = withGrantedMutationsOnly(
    buildKnowledgeTools(service, { runId: "run", scopedOwnersOnly: true }),
    {
      id: "run",
      kind: "synthesis",
      payload: { focus: "knowledge-maintenance", batchId: "batch" },
      payloadJson: JSON.stringify({ focus: "knowledge-maintenance", batchId: "batch" }),
      attempts: 1,
    },
  );
  const history = tools.find((tool) => tool.name === "knowledge_history")!;
  expect(history.mutates).toBe(false);
  expect(
    await history.invoke(
      { id: "workshop", revision: 1 },
      { sessionId: "session", messageId: "message" },
    ),
  ).toMatchObject({
    kind: "structured",
    data: { snapshotRevision: 1, format: "historical-markdown-chunk" },
  });
  expect(
    await history.invoke(
      { id: "workshop", limit: 6 },
      { sessionId: "session", messageId: "message" },
    ),
  ).toMatchObject({ kind: "error", code: "invalid_arguments" });
  expect(
    await history.invoke(
      { id: "workshop", revision: 1, beforeRevision: 2 },
      { sessionId: "session", messageId: "message" },
    ),
  ).toMatchObject({ kind: "error", code: "invalid_arguments" });
  expect(db.prepare("SELECT revision FROM knowledge_nodes WHERE id='workshop'").get()).toEqual({
    revision: 1,
  });
});
