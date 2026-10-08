// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createLogger } from "@omnesis/core";
import { serializeToolResultForModel, type ToolHandle } from "@omnesis/agent";
import { resolveBrainSettings } from "../config.js";
import { createBriefsStorageTables } from "../storage/schema.js";
import { createKnowledgeTables, getKnowledgeNode, saveKnowledgeNode } from "./storage.js";
import { createKnowledgeWorkTables } from "./work-schema.js";
import { KnowledgeService } from "./service.js";
import { directKnowledgeGate } from "./writer.js";
import { buildKnowledgeTools } from "./tools.js";
import { KnowledgeDependencyReceipts } from "./dependency-receipts.js";

let db: Database.Database;
let service: KnowledgeService;
let tools: ToolHandle[];
const invocation = { sessionId: "receipt-session", messageId: "receipt-message" };
const markup = '<claim id="shelves" refs="source:manual">The cabinet has three shelves.</claim>';
const proposal = {
  id: "cabinet",
  kind: "wiki" as const,
  title: "Cabinet",
  markdown: markup,
  expectedRevision: 1,
};

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(
    "CREATE TABLE documents(id TEXT PRIMARY KEY,content TEXT,content_hash TEXT); INSERT INTO documents VALUES('manual','The cabinet has three shelves. Blue labels mark the upper shelf.','v1')",
  );
  createBriefsStorageTables(db);
  createKnowledgeTables(db);
  createKnowledgeWorkTables(db);
  service = new KnowledgeService({
    db,
    writeGate: directKnowledgeGate(db),
    getSettings: () => resolveBrainSettings(),
    clock: () => 10,
    log: createLogger("test:dependency-receipts"),
  });
  saveKnowledgeNode(
    db,
    { ...proposal, expectedRevision: 0, inputVersions: { "source:manual": "v1" } },
    1,
  );
  tools = buildKnowledgeTools(service, { runId: "run" });
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});
const call = (name: string, args: unknown, entries = tools) =>
  entries.find((tool) => tool.name === name)!.invoke(args, invocation);
const fetchEditing = () => call("knowledge_fetch", { id: "cabinet", editing: true });

it("inherits unchanged claims from a transaction-consistent editing read without copying source hashes", async () => {
  const original = service.fetch.bind(service);
  vi.spyOn(service, "fetch").mockImplementation((...args) => {
    expect(db.inTransaction).toBe(true);
    return original(...args);
  });
  await fetchEditing();
  expect(await call("knowledge_save", { node: proposal })).toMatchObject({
    kind: "structured",
    data: { node: { revision: 2 } },
  });
  // A successful write alone does not grant a replacement baseline.
  expect(
    await call("knowledge_save", { node: { ...proposal, expectedRevision: 2 } }),
  ).toMatchObject({ kind: "error", code: "revision_conflict" });
});

it.each(["normal", "list", "history", "another-run"])(
  "does not inherit from %s reads",
  async (mode) => {
    if (mode === "normal") await call("knowledge_fetch", { id: "cabinet" });
    if (mode === "list") await call("knowledge_list", { kind: "wiki" });
    if (mode === "history") await call("knowledge_history", { id: "cabinet", revision: 1 });
    if (mode === "another-run") {
      await fetchEditing();
      tools = buildKnowledgeTools(service, { runId: "successor" });
    }
    expect(await call("knowledge_save", { node: proposal })).toMatchObject({
      kind: "error",
      code: "revision_conflict",
      message: expect.stringContaining('Missing dependency version for "source:manual"'),
    });
  },
);

it("requires a read for a new use of a ref even when an unchanged claim uses the same ref", async () => {
  await fetchEditing();
  const changed = {
    ...proposal,
    markdown:
      markup + '<claim id="labels" refs="source:manual">Blue labels mark the upper shelf.</claim>',
  };
  expect(await call("knowledge_save", { node: changed })).toMatchObject({
    kind: "error",
    code: "revision_conflict",
  });
  expect(await call("knowledge_reference", { ref: "source:manual" })).toMatchObject({
    kind: "structured",
  });
  expect(await call("knowledge_save", { node: changed })).toMatchObject({
    kind: "structured",
    data: { node: { revision: 2 } },
  });
});

it("does not replace an explicit stale override with a newer reference receipt", async () => {
  await fetchEditing();
  await call("knowledge_reference", { ref: "source:manual" });
  expect(
    await call("knowledge_save", {
      node: { ...proposal, inputVersions: { "source:manual": "stale" } },
    }),
  ).toMatchObject({
    kind: "error",
    code: "revision_conflict",
    message: expect.stringContaining("Stale dependency version"),
  });
  expect(getKnowledgeNode(db, "cabinet")?.revision).toBe(1);
});

it.each(["baseline", "reference", "verifier"])(
  "refuses source changes after the %s read boundary",
  async (boundary) => {
    await fetchEditing();
    if (boundary === "reference") await call("knowledge_reference", { ref: "source:manual" });
    if (boundary === "verifier")
      service.deps.getEntailmentVerifier = async () => ({
        async verify() {
          db.exec("UPDATE documents SET content_hash='v2' WHERE id='manual'");
          return { label: "entailment" as const, probability: 1 };
        },
        dispose() {},
      });
    else db.exec("UPDATE documents SET content_hash='v2' WHERE id='manual'");
    expect(await call("knowledge_save", { node: proposal })).toMatchObject({
      kind: "error",
      code: "revision_conflict",
    });
    expect(getKnowledgeNode(db, "cabinet")?.revision).toBe(1);
  },
);

it("does not inherit after moving unchanged text under a new ancestor", async () => {
  await fetchEditing();
  const nested = '<claim id="scope" refs="">' + markup + "</claim>";
  expect(await call("knowledge_save", { node: { ...proposal, markdown: nested } })).toMatchObject({
    kind: "error",
    code: "revision_conflict",
  });
});

it.each([
  { modality: "reported" },
  { epistemicStatus: "unsupported" },
  { supportLogic: "any" },
  { attribution: "A fictional archivist" },
  { validFrom: 1 },
  { validUntil: 2 },
  { relations: { "source:manual": "context" } },
])("requires evidence read when effective claim state changes: %j", async (state) => {
  await fetchEditing();
  expect(
    await call("knowledge_save", { node: { ...proposal, claims: [{ id: "shelves", ...state }] } }),
  ).toMatchObject({ kind: "error", code: "revision_conflict" });
});

it("treats explicit default semantic state like the baseline while keeping explicit null clearing distinct", async () => {
  await fetchEditing();
  expect(
    await call("knowledge_save", {
      node: {
        ...proposal,
        claims: [
          {
            id: "shelves",
            modality: "observation",
            attribution: null,
            validFrom: null,
            validUntil: null,
            supportLogic: "all",
            epistemicStatus: "asserted",
          },
        ],
      },
    }),
  ).toMatchObject({ kind: "structured" });
  saveKnowledgeNode(
    db,
    {
      ...proposal,
      expectedRevision: 2,
      inputVersions: { "source:manual": "v1" },
      claims: [{ id: "shelves", attribution: "A fictional archivist" }],
    },
    12,
  );
  await fetchEditing();
  expect(
    await call("knowledge_save", {
      node: { ...proposal, expectedRevision: 3, claims: [{ id: "shelves", attribution: null }] },
    }),
  ).toMatchObject({ kind: "error", code: "revision_conflict" });
});

it("does not trust guessed node revisions or privacy-hidden baselines", async () => {
  await fetchEditing();
  saveKnowledgeNode(
    db,
    {
      ...proposal,
      expectedRevision: 1,
      inputVersions: { "source:manual": "v1" },
      title: "Updated cabinet",
    },
    12,
  );
  expect(
    await call("knowledge_save", { node: { ...proposal, expectedRevision: 2 } }),
  ).toMatchObject({ kind: "error", code: "revision_conflict" });
  db.exec("INSERT INTO knowledge_node_tombstones(id,deleted_at) VALUES('cabinet',13)");
  expect(await fetchEditing()).toMatchObject({ kind: "structured", data: null });
  expect(await call("knowledge_save", { node: proposal })).toMatchObject({
    kind: "error",
    code: "reference_invalid",
  });
});

it("evicts bounded receipt data rather than inventing versions", () => {
  const snapshot = service.editingSnapshot("cabinet")!;
  const receipts = new KnowledgeDependencyReceipts({
    snapshots: 1,
    snapshotBytes: 100_000,
    references: 1,
  });
  receipts.rememberEditing(snapshot);
  expect(receipts.complete(proposal).inputVersions).toEqual({ "source:manual": "v1" });
  receipts.rememberEditing({ ...snapshot, node: { ...snapshot.node, id: "second" } });
  expect(receipts.complete(proposal).inputVersions).toEqual({});
  receipts.rememberReference(service.reference("source:manual"));
  receipts.rememberReference({ ...service.reference("source:manual"), ref: "source:second" });
  expect(receipts.complete(proposal).inputVersions).toEqual({});
  const tooSmall = new KnowledgeDependencyReceipts({
    snapshots: 1,
    snapshotBytes: 1,
    references: 1,
  });
  tooSmall.rememberEditing(snapshot);
  expect(tooSmall.complete(proposal).inputVersions).toEqual({});
});

it("delivers a large editing snapshot intact through model serialization and inherits its many versions", async () => {
  const versions: Record<string, string> = {};
  const sections = Array.from({ length: 70 }, (_, index) => {
    const id = `shelf_${index}`;
    const text =
      `Shelf ${index} carries label ${index}. ` + "Archive reference information. ".repeat(12);
    db.prepare("INSERT INTO documents VALUES(?,?,?)").run(id, text, "v1");
    versions[`source:${id}`] = "v1";
    return `<claim id="s${index}" refs="source:${id}">${text}</claim>`;
  }).join("\n");
  saveKnowledgeNode(
    db,
    {
      ...proposal,
      id: "archive",
      expectedRevision: 0,
      markdown: sections,
      inputVersions: versions,
    },
    2,
  );
  const read = await call("knowledge_fetch", { id: "archive", editing: true });
  const delivered = JSON.parse(serializeToolResultForModel(read));
  expect(delivered).toEqual(read);
  expect(delivered.data.markdown).toBe(sections);
  expect(sections.length).toBeGreaterThan(24_000);
  expect(
    await call("knowledge_save", { node: { ...proposal, id: "archive", markdown: sections } }),
  ).toMatchObject({ kind: "structured", data: { node: { revision: 2 } } });
});

it("keeps explicit inputVersions mandatory for scoped canonical tools", () => {
  const scoped = buildKnowledgeTools(service, { runId: "scoped", scopedOwnersOnly: true });
  expect(
    scoped
      .find((tool) => tool.name === "loop_synthesis_save")!
      .schema.safeParse({ id: "loop", title: "Loop", markdown: markup, expectedRevision: 1 })
      .success,
  ).toBe(false);
});

it("rejects partial editing snapshots and does not promote failed reference reads", async () => {
  const snapshot = service.editingSnapshot("cabinet")!;
  const receipts = new KnowledgeDependencyReceipts();
  receipts.rememberEditing({
    ...snapshot,
    node: { ...snapshot.node, contentTruncated: true },
  } as typeof snapshot);
  expect(receipts.complete(proposal).inputVersions).toEqual({});
  expect(await call("knowledge_reference", { ref: "source:absent" })).toMatchObject({
    kind: "error",
  });
  expect(await call("knowledge_save", { node: proposal })).toMatchObject({
    kind: "error",
    code: "revision_conflict",
  });
});

it("captures reference text and version inside the same transaction", async () => {
  const original = service.reference.bind(service);
  vi.spyOn(service, "reference").mockImplementation((ref) => {
    expect(db.inTransaction).toBe(true);
    return original(ref);
  });
  expect(await call("knowledge_reference", { ref: "source:manual" })).toMatchObject({
    kind: "structured",
    data: { revision: "v1" },
  });
});

it("requires a fresh ref when ancestor semantics change above an unchanged leaf", async () => {
  const nested = '<claim id="scope" refs="">' + markup + "</claim>";
  saveKnowledgeNode(
    db,
    {
      ...proposal,
      expectedRevision: 1,
      markdown: nested,
      inputVersions: { "source:manual": "v1" },
    },
    2,
  );
  await fetchEditing();
  expect(
    await call("knowledge_save", {
      node: {
        ...proposal,
        expectedRevision: 2,
        markdown: nested,
        claims: [{ id: "scope", modality: "reported" }],
      },
    }),
  ).toMatchObject({ kind: "error", code: "revision_conflict" });
});

it("does not inherit after an explicit empty relation map changes prior context to default support", async () => {
  saveKnowledgeNode(
    db,
    {
      ...proposal,
      expectedRevision: 1,
      inputVersions: { "source:manual": "v1" },
      claims: [{ id: "shelves", relations: { "source:manual": "context" } }],
    },
    2,
  );
  await fetchEditing();
  expect(
    await call("knowledge_save", {
      node: { ...proposal, expectedRevision: 2, claims: [{ id: "shelves", relations: {} }] },
    }),
  ).toMatchObject({ kind: "error", code: "revision_conflict" });
});
