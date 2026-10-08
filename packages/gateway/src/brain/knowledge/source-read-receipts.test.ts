// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { createKnowledgeTables } from "./schema.js";
import { withKnowledgeSourceReadReceipts } from "./source-read-receipts.js";
import type { ToolHandle } from "@omnesis/agent";
import type { ToolResult } from "@omnesis/core";

let db: Database.Database;
const body = "A complete source body with a final sentence.";
const context = { sessionId: "test", messageId: "test" };
const completion = { id: "source:doc", inputFingerprint: "fp" };
beforeEach(() => {
  db = new Database(":memory:");
  db.exec("CREATE TABLE documents(id TEXT PRIMARY KEY,content TEXT,content_hash TEXT)");
  db.prepare("INSERT INTO documents VALUES('doc',?,'v1')").run(body);
  createKnowledgeTables(db);
});
afterEach(() => db.close());
function fixture(
  options: { truncated?: boolean; fetch?: () => Promise<ToolResult>; reference?: string } = {},
) {
  const settled = vi.fn(
    async (): Promise<ToolResult> => ({ kind: "structured", resultType: "done", data: true }),
  );
  const definitions: Array<[string, ToolHandle["invoke"]]> = [
    [
      "knowledge_next_frontier",
      async () => ({
        kind: "structured",
        resultType: "frontier",
        data: {
          items: [
            {
              ...completion,
              source: {
                id: "doc",
                contentHash: "v1",
                content: options.truncated === false ? body : body.slice(0, 8),
                contentTruncated: options.truncated !== false,
              },
            },
          ],
        },
      }),
    ],
    ["fetch_many", options.fetch ?? (async () => fetched(body))],
    [
      "knowledge_reference",
      async () => ({
        kind: "structured",
        resultType: "reference",
        data: {
          ref: options.reference ?? "source:doc",
          revision: "v1",
          text: options.reference ? body.slice(0, 8) : body,
        },
      }),
    ],
    ["knowledge_discovery_complete", settled],
  ];
  const tools = withKnowledgeSourceReadReceipts(
    db,
    definitions.map(([name, invoke]) => ({ name, description: name, schema: z.unknown(), invoke })),
  );
  return {
    settled,
    invoke: (name: string, args: unknown = {}) =>
      tools.find((t) => t.name === name)!.invoke(args, context),
  };
}
function fetched(content: string): ToolResult {
  return {
    kind: "document.batch",
    items: [
      {
        kind: "document",
        ref: { documentId: "doc", sourceId: "fictional", sourceType: "fictional" },
        document: { id: "doc", content },
      },
    ],
  };
}
it("refuses truncated interpretation until a full actual fetch, without invoking completion", async () => {
  const f = fixture();
  await f.invoke("knowledge_next_frontier");
  expect(await f.invoke("knowledge_discovery_complete", completion)).toMatchObject({
    kind: "error",
    code: "source_read_required",
    message: expect.stringContaining('"doc"'),
  });
  expect(f.settled).not.toHaveBeenCalled();
  await f.invoke("fetch_many", { documents: [{ documentId: "doc" }] });
  expect(await f.invoke("knowledge_discovery_complete", completion)).toMatchObject({
    kind: "structured",
  });
  expect(f.settled).toHaveBeenCalledOnce();
});
it.each(["offer", "reference"])("accepts a complete %s at the offered generation", async (read) => {
  const f = fixture({ truncated: read !== "offer" });
  await f.invoke("knowledge_next_frontier");
  if (read === "reference") await f.invoke("knowledge_reference", { ref: "source:doc" });
  expect(await f.invoke("knowledge_discovery_complete", completion)).toMatchObject({
    kind: "structured",
  });
});
it.each(["partial", "failed", "changed", "withdrawn", "unrequested"])(
  "does not bless a %s fetch",
  async (mode) => {
    const f = fixture({
      fetch: async () => {
        if (mode === "failed") return { kind: "error", code: "not_found", message: "Missing" };
        if (mode === "changed") db.prepare("UPDATE documents SET content_hash='v2'").run();
        if (mode === "withdrawn")
          db.prepare(
            "INSERT INTO knowledge_source_revisions(document_id,content_hash,deleted,updated_at) VALUES('doc','v1',1,1)",
          ).run();
        return fetched(mode === "partial" ? body.slice(0, 8) : body);
      },
    });
    await f.invoke("knowledge_next_frontier");
    await f.invoke("fetch_many", {
      documents: [{ documentId: mode === "unrequested" ? "other" : "doc" }],
    });
    expect(await f.invoke("knowledge_discovery_complete", completion)).toMatchObject({
      code: "source_read_required",
    });
    expect(f.settled).not.toHaveBeenCalled();
  },
);
it("does not count a selected evidence passage as reading the whole source", async () => {
  const f = fixture({ reference: "source:doc#evidence:excerpt" });
  await f.invoke("knowledge_next_frontier");
  await f.invoke("knowledge_reference", { ref: "source:doc#evidence:excerpt" });
  expect(await f.invoke("knowledge_discovery_complete", completion)).toMatchObject({
    code: "source_read_required",
  });
});
it("requires its own offered snapshot and does not inherit predecessor read receipts", async () => {
  const predecessor = fixture({ truncated: false });
  await predecessor.invoke("knowledge_next_frontier");
  const successor = fixture();
  expect(await successor.invoke("knowledge_discovery_complete", completion)).toMatchObject({
    code: "revision_conflict",
  });
  await successor.invoke("knowledge_next_frontier");
  expect(await successor.invoke("knowledge_discovery_complete", completion)).toMatchObject({
    code: "source_read_required",
  });
});

it.each([
  { id: "source:other", inputFingerprint: "fp" },
  { id: "source:doc", inputFingerprint: "old-fingerprint" },
])(
  "rejects unoffered completion $id/$inputFingerprint before suggesting a source read",
  async (input) => {
    const f = fixture();
    await f.invoke("knowledge_next_frontier");
    // Even a valid full read cannot grant authority to a different ID/fingerprint.
    await f.invoke("fetch_many", { documents: [{ documentId: "doc" }] });
    const result = await f.invoke("knowledge_discovery_complete", input);
    expect(result).toMatchObject({
      kind: "error",
      code: "revision_conflict",
      message: expect.stringContaining("copy its exact offered id and inputFingerprint"),
    });
    expect(result).not.toMatchObject({ code: "source_read_required" });
    expect(f.settled).not.toHaveBeenCalled();
    expect(await f.invoke("knowledge_discovery_complete", completion)).toMatchObject({
      kind: "structured",
    });
    expect(f.settled).toHaveBeenCalledOnce();
  },
);
