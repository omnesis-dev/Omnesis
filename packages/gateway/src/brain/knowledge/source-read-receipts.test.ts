// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { SOURCE_READ_PROGRESS_CHARS } from "./engine-frontier.js";
import { createKnowledgeTables } from "./schema.js";
import { withKnowledgeSourceReadReceipts } from "./source-read-receipts.js";
import type { ToolHandle } from "@omnesis/agent";
import type { ToolResult } from "@omnesis/core";

let db: Database.Database;
const body = "A complete source body with a final sentence.";
const context = { sessionId: "test", messageId: "test" };
const completion = { id: "source:doc", inputFingerprint: "fp", phases: [] };
beforeEach(() => {
  db = new Database(":memory:");
  db.exec("CREATE TABLE documents(id TEXT PRIMARY KEY,content TEXT,content_hash TEXT)");
  db.prepare("INSERT INTO documents VALUES('doc',?,'v1')").run(body);
  createKnowledgeTables(db);
});
afterEach(() => db.close());
function fixture(
  options: {
    truncated?: boolean;
    sourceRevision?: () => string;
    fetch?: () => Promise<ToolResult>;
    reference?: string;
    referenceResult?: ToolResult;
  } = {},
) {
  const settled = vi.fn(async (): Promise<ToolResult> => ({
    kind: "structured",
    resultType: "done",
    data: true,
  }));
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
                sourceRevision: options.sourceRevision?.(),
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
      async () =>
        options.referenceResult ?? {
          kind: "structured",
          resultType: "reference",
          data: {
            ref: options.reference ?? "source:doc",
            revision: "v1",
            text: options.reference ? body.slice(0, 8) : body,
          },
        },
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

it("refuses a completed body read after its metadata generation changes", async () => {
  const f = fixture({ truncated: false });
  await f.invoke("knowledge_next_frontier");
  db.prepare(
    "INSERT INTO knowledge_source_revisions(document_id,content_hash,deleted,updated_at,generation) VALUES('doc','v1',0,1,1)",
  ).run();
  expect(await f.invoke("knowledge_discovery_complete", completion)).toMatchObject({
    code: "source_read_required",
  });
  expect(f.settled).not.toHaveBeenCalled();
});

it.each([true, false])(
  "batch source read records only complete successful returned views: %s",
  async (returned) => {
    const f = fixture({
      referenceResult: {
        kind: "structured",
        resultType: "knowledge_reference",
        data: {
          items: returned
            ? [{ ok: true, value: { ref: "source:doc", revision: "v1", text: body } }]
            : [{ ok: false, ref: "source:doc", code: "reference_too_large" }],
          deferredRefs: returned ? [] : ["source:doc"],
        },
      },
    });
    await f.invoke("knowledge_next_frontier");
    await f.invoke("knowledge_reference", { refs: ["source:doc"] });
    expect(await f.invoke("knowledge_discovery_complete", completion)).toMatchObject(
      returned ? { kind: "structured" } : { kind: "error", code: "source_read_required" },
    );
    expect(f.settled).toHaveBeenCalledTimes(returned ? 1 : 0);
  },
);

function fetchedPage(offset: number, end: number, text = body): ToolResult {
  return {
    kind: "document.batch",
    items: [
      {
        kind: "document",
        ref: { documentId: "doc", sourceId: "fictional", sourceType: "fictional" },
        document: {
          id: "doc",
          content: text.slice(offset, end),
          contentRange: {
            offset,
            returnedCharacters: end - offset,
            totalCharacters: text.length,
            truncated: true,
          },
        },
      },
    ],
  };
}
it("accepts exact adjacent pages without requiring a second whole-document read", async () => {
  let result = fetchedPage(0, 12);
  const f = fixture({ fetch: async () => result });
  await f.invoke("knowledge_next_frontier");
  await f.invoke("fetch_many", { documents: [{ documentId: "doc", maxContentChars: 12 }] });
  expect(await f.invoke("knowledge_discovery_complete", completion)).toMatchObject({
    code: "source_read_required",
  });
  result = fetchedPage(12, body.length);
  await f.invoke("fetch_many", { documents: [{ documentId: "doc", contentOffset: 12 }] });
  expect(await f.invoke("knowledge_discovery_complete", completion)).toMatchObject({
    kind: "structured",
  });
  expect(f.settled).toHaveBeenCalledOnce();
});
it("merges out-of-order overlaps without counting repeated characters as missing coverage", async () => {
  let result = fetchedPage(12, body.length);
  const f = fixture({ fetch: async () => result });
  await f.invoke("knowledge_next_frontier");
  for (let i = 0; i < 3; i++) await f.invoke("fetch_many", { documents: [{ documentId: "doc" }] });
  expect(await f.invoke("knowledge_discovery_complete", completion)).toMatchObject({
    code: "source_read_required",
  });
  result = fetchedPage(0, 15);
  await f.invoke("fetch_many", { documents: [{ documentId: "doc" }] });
  expect(await f.invoke("knowledge_discovery_complete", completion)).toMatchObject({
    kind: "structured",
  });
});
it.each([
  "gap",
  "wrong-offset",
  "wrong-total",
  "wrong-length",
  "changed",
  "privacy-between",
  "privacy-during",
])("refuses incomplete or invalid page coverage: %s", async (mode) => {
  let result = fetchedPage(0, 12);
  let during = false;
  db.exec(
    "CREATE TABLE IF NOT EXISTS knowledge_decision_privacy(id INTEGER PRIMARY KEY,generation INTEGER NOT NULL); INSERT OR IGNORE INTO knowledge_decision_privacy VALUES(1,0)",
  );
  const f = fixture({
    fetch: async () => {
      if (during) db.exec("UPDATE knowledge_decision_privacy SET generation=generation+1");
      return result;
    },
  });
  await f.invoke("knowledge_next_frontier");
  await f.invoke("fetch_many", { documents: [{ documentId: "doc" }] });
  result = fetchedPage(mode === "gap" ? 13 : 12, body.length);
  if (result.kind !== "document.batch" || result.items[0]?.kind !== "document")
    throw Error("Fixture result");
  const range = result.items[0].document.contentRange as {
    offset: number;
    totalCharacters: number;
    returnedCharacters: number;
  };
  if (mode === "wrong-offset") range.offset = 11;
  if (mode === "wrong-total") range.totalCharacters++;
  if (mode === "wrong-length") range.returnedCharacters++;
  if (mode === "changed") db.exec("UPDATE documents SET content_hash='v2'");
  if (mode === "privacy-between")
    db.exec("UPDATE knowledge_decision_privacy SET generation=generation+1");
  if (mode === "privacy-during") during = true;
  await f.invoke("fetch_many", { documents: [{ documentId: "doc" }] });
  expect(await f.invoke("knowledge_discovery_complete", completion)).toMatchObject({
    code: "source_read_required",
  });
  expect(f.settled).not.toHaveBeenCalled();
});
it("does not carry full-read authority across privacy erasure even when body/version are restored", async () => {
  db.exec(
    "CREATE TABLE IF NOT EXISTS knowledge_decision_privacy(id INTEGER PRIMARY KEY,generation INTEGER NOT NULL); INSERT OR IGNORE INTO knowledge_decision_privacy VALUES(1,0)",
  );
  const f = fixture({ truncated: false });
  await f.invoke("knowledge_next_frontier");
  db.exec("UPDATE knowledge_decision_privacy SET generation=generation+1");
  expect(await f.invoke("knowledge_discovery_complete", completion)).toMatchObject({
    code: "source_read_required",
  });
});

it("uses UTF-16 offsets rather than Unicode code-point counts", async () => {
  const unicode = "A🧭 map\r\n café; end.";
  db.prepare("UPDATE documents SET content=?").run(unicode);
  let result = fetchedPage(0, 2, unicode);
  const f = fixture({ fetch: async () => result });
  await f.invoke("knowledge_next_frontier");
  await f.invoke("fetch_many", { documents: [{ documentId: "doc" }] });
  result = fetchedPage(2, unicode.length, unicode);
  await f.invoke("fetch_many", { documents: [{ documentId: "doc" }] });
  expect(await f.invoke("knowledge_discovery_complete", completion)).toMatchObject({
    kind: "structured",
  });
});
it("does not combine identical-body pages across a semantic source generation", async () => {
  let revision = "v1";
  let result = fetchedPage(0, 12);
  const f = fixture({ sourceRevision: () => revision, fetch: async () => result });
  await f.invoke("knowledge_next_frontier");
  await f.invoke("fetch_many", { documents: [{ documentId: "doc" }] });
  db.prepare(
    "INSERT INTO knowledge_source_revisions(document_id,content_hash,deleted,updated_at,generation) VALUES('doc','v1',0,1,2)",
  ).run();
  revision = "v1:knowledge:2";
  await f.invoke("knowledge_next_frontier");
  result = fetchedPage(12, body.length);
  await f.invoke("fetch_many", { documents: [{ documentId: "doc" }] });
  expect(await f.invoke("knowledge_discovery_complete", completion)).toMatchObject({
    code: "source_read_required",
  });
  result = fetchedPage(0, 12);
  await f.invoke("fetch_many", { documents: [{ documentId: "doc" }] });
  expect(await f.invoke("knowledge_discovery_complete", completion)).toMatchObject({
    kind: "structured",
  });
});

async function progress(f: ReturnType<typeof fixture>) {
  const result = await f.invoke("knowledge_next_frontier");
  if (result.kind !== "structured") throw new Error("Missing frontier");
  return z
    .object({
      items: z.array(
        z.object({
          sourceRead: z.object({
            status: z.string(),
            nextOffset: z.number().optional(),
          }),
        }),
      ),
    })
    .parse(result.data).items[0]!.sourceRead;
}
it("reports exact source read progress without treating deferred references as reads", async () => {
  let page = fetchedPage(0, 12);
  const f = fixture({
    fetch: async () => page,
    referenceResult: {
      kind: "structured",
      resultType: "reference",
      data: { items: [], deferredRefs: ["source:doc"] },
    },
  });
  expect(await progress(f)).toEqual({ status: "required", nextOffset: 0 });
  await f.invoke("knowledge_reference", { refs: ["source:doc"] });
  expect(await progress(f)).toEqual({ status: "required", nextOffset: 0 });
  await f.invoke("fetch_many", { documents: [{ documentId: "doc" }] });
  expect(await progress(f)).toEqual({ status: "partial", nextOffset: 12 });
  page = fetchedPage(12, body.length);
  await f.invoke("fetch_many", { documents: [{ documentId: "doc" }] });
  expect(await progress(f)).toEqual({ status: "complete" });
  db.prepare("UPDATE documents SET content_hash='v2' WHERE id='doc'").run();
  expect(await progress(f)).toEqual({ status: "unavailable" });
  db.prepare("DELETE FROM documents WHERE id='doc'").run();
  expect(await progress(f)).toEqual({ status: "unavailable" });
});
it("does not advertise whole read progress across privacy erasure", async () => {
  db.exec(
    "CREATE TABLE IF NOT EXISTS knowledge_decision_privacy(id INTEGER PRIMARY KEY,generation INTEGER NOT NULL); INSERT OR IGNORE INTO knowledge_decision_privacy VALUES(1,0)",
  );
  const f = fixture();
  await f.invoke("knowledge_reference");
  expect(await progress(f)).toEqual({ status: "complete" });
  db.exec("UPDATE knowledge_decision_privacy SET generation=generation+1");
  expect(await progress(f)).toEqual({ status: "required", nextOffset: 0 });
});

it("keeps read-progress overhead within the engine frontier reservation", () => {
  for (const status of ["required", "partial", "complete", "unavailable"])
    expect(
      JSON.stringify({ sourceRead: { status, nextOffset: Number.MAX_SAFE_INTEGER } }).length,
    ).toBeLessThanOrEqual(SOURCE_READ_PROGRESS_CHARS);
});
