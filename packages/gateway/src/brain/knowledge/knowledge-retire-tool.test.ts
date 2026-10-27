// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveBrainSettings } from "../config.js";
import { createBriefsStorageTables } from "../storage/schema.js";
import { mutatingToolsFor } from "../cognition/authority.js";
import { COGNITIVE_WORKFLOW_IDS } from "../cognition/workflows.js";
import {
  createKnowledgeTables,
  getKnowledgeClaims,
  getKnowledgeNode,
  listKnowledgeNodeRevisions,
  recordKnowledgeSourceDeletion,
  saveKnowledgeNode,
} from "./storage.js";
import { createKnowledgeWorkTables } from "./work-schema.js";
import { KnowledgeService } from "./service.js";
import { buildKnowledgeTools, KNOWLEDGE_MUTATING_TOOLS } from "./tools.js";
import { directKnowledgeGate } from "./writer.js";
import type { Logger, ToolResult } from "@omnesis/core";
import type { ToolHandle } from "@omnesis/agent";

const invocation = { sessionId: "synthetic-session", messageId: "synthetic-message" };
const REASON = "Both sources behind this page were deleted and nothing current covers the subject.";

let db: Database.Database;
let lines: string[];
let service: KnowledgeService;

function recordingLogger(): Logger {
  const logger: Logger = {
    debug: () => {},
    info: (message) => lines.push(message),
    warn: () => {},
    error: () => {},
    child: () => logger,
  };
  return logger;
}

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(
    `CREATE TABLE documents(id TEXT PRIMARY KEY,content TEXT,content_hash TEXT);
     INSERT INTO documents VALUES
       ('doc-a','The garden runs three raised beds.','va'),
       ('doc-b','The annual plot fee is 25 credits.','vb')`,
  );
  createBriefsStorageTables(db);
  createKnowledgeTables(db);
  createKnowledgeWorkTables(db);
  lines = [];
  service = new KnowledgeService({
    db,
    writeGate: directKnowledgeGate(db),
    getSettings: () => resolveBrainSettings(),
    clock: () => 10,
    log: recordingLogger(),
  });
  saveKnowledgeNode(
    db,
    {
      id: "garden",
      kind: "wiki",
      title: "Community garden",
      expectedRevision: 0,
      markdown:
        '<claim id="beds" refs="source:doc-a">The garden runs three raised beds.</claim>\n<claim id="fee" refs="source:doc-b">The annual plot fee is 25 credits.</claim>',
      inputVersions: { "source:doc-a": "va", "source:doc-b": "vb" },
    },
    5,
  );
  saveKnowledgeNode(
    db,
    {
      id: "digest",
      kind: "wiki",
      title: "Neighbourhood digest",
      expectedRevision: 0,
      markdown:
        '<claim id="garden" refs="wiki:garden#claim:beds">The garden has raised beds.</claim>',
      inputVersions: { "wiki:garden#claim:beds": 1 },
    },
    5,
  );
  saveKnowledgeNode(
    db,
    {
      id: "overview",
      kind: "root",
      title: "Overview",
      expectedRevision: 0,
      markdown: '<claim id="intro" refs="source:doc-a">A garden with raised beds.</claim>',
      inputVersions: { "source:doc-a": "va" },
    },
    5,
  );
});
afterEach(() => db.close());

function tools(): ToolHandle[] {
  return buildKnowledgeTools(service, { runId: "run" });
}
async function call(entries: ToolHandle[], name: string, args: unknown): Promise<ToolResult> {
  return entries.find((tool) => tool.name === name)!.invoke(args, invocation);
}
async function editingRead(entries: ToolHandle[], id: string) {
  expect(await call(entries, "knowledge_fetch", { id, editing: true })).toMatchObject({
    kind: "structured",
  });
}

describe("knowledge_retire", () => {
  it("retires a reviewed page with its reason, keeps its history and marks its readers for review", async () => {
    recordKnowledgeSourceDeletion(db, "doc-a", 6);
    recordKnowledgeSourceDeletion(db, "doc-b", 6);
    const page = getKnowledgeNode(db, "garden")!;
    expect(page.validity).toBe("stale");
    const entries = tools();
    await editingRead(entries, "garden");
    const result = await call(entries, "knowledge_retire", {
      id: "garden",
      expectedRevision: page.revision,
      reason: REASON,
    });
    expect(result).toMatchObject({
      kind: "structured",
      resultType: "knowledge_retire",
      data: { id: "garden", revision: page.revision + 1, retired: true },
    });

    const row = db
      .prepare<[], { fields_json: string; markdown: string }>(
        "SELECT fields_json,markdown FROM knowledge_nodes WHERE id='garden'",
      )
      .get()!;
    expect(JSON.parse(row.fields_json)).toEqual({
      withdrawn: true,
      withdrawnAt: 10,
      retirementReason: REASON,
    });
    // Nothing is deleted: the page and every earlier revision stay on record.
    expect(row.markdown).toBe(page.markdown);
    const history = listKnowledgeNodeRevisions(db, "garden");
    expect(history.map((revision) => revision.revision)).toEqual(
      Array.from({ length: page.revision + 1 }, (_, index) => page.revision + 1 - index),
    );
    expect(history[0]).toMatchObject({
      canonicalFields: { retirementReason: REASON },
      diff: { changedFieldKeys: ["withdrawn", "withdrawnAt", "retirementReason"] },
    });

    // It stays on record as withdrawn and cannot be cited or edited.
    expect(getKnowledgeNode(db, "garden")?.canonicalFields.withdrawn).toBe(true);
    expect(() => service.reference("wiki:garden#claim:fee")).toThrow("is unavailable");
    expect(
      await call(entries, "knowledge_edit", {
        node: { id: "garden", expectedRevision: page.revision + 1, edits: [] },
      }),
    ).toMatchObject({ kind: "error" });

    expect(getKnowledgeNode(db, "digest")?.validity).toBe("stale");
    expect(getKnowledgeClaims(db, "digest")[0]?.verification).toBe("stale");
    expect(lines).toContain(
      `Wiki retired via knowledge_retire on garden: r${page.revision}→r${page.revision + 1}`,
    );
  });

  it("refuses a page this run has not read for editing at that revision", async () => {
    const entries = tools();
    const unread = await call(entries, "knowledge_retire", {
      id: "garden",
      expectedRevision: 1,
      reason: REASON,
    });
    expect(unread).toMatchObject({ kind: "error", code: "revision_conflict" });
    await editingRead(entries, "garden");
    expect(
      await call(entries, "knowledge_retire", {
        id: "garden",
        expectedRevision: 2,
        reason: REASON,
      }),
    ).toMatchObject({ kind: "error", code: "revision_conflict" });
    // The page changed after the read: the writer refuses the stale retirement.
    saveKnowledgeNode(
      db,
      {
        id: "garden",
        kind: "wiki",
        title: "Community garden plots",
        expectedRevision: 1,
        markdown: getKnowledgeNode(db, "garden")!.markdown,
        inputVersions: { "source:doc-a": "va", "source:doc-b": "vb" },
      },
      7,
    );
    expect(
      await call(entries, "knowledge_retire", {
        id: "garden",
        expectedRevision: 1,
        reason: REASON,
      }),
    ).toMatchObject({ kind: "error", code: "revision_conflict" });
    expect(getKnowledgeNode(db, "garden")?.canonicalFields.withdrawn).toBeUndefined();
    expect(lines).toContain("Wiki retirement refused on garden (revision_conflict)");
  });

  it("never retires the root", async () => {
    const entries = tools();
    await editingRead(entries, "overview");
    expect(
      await call(entries, "knowledge_retire", {
        id: "overview",
        expectedRevision: 1,
        reason: REASON,
      }),
    ).toMatchObject({
      kind: "error",
      code: "claim_invalid",
      message: expect.stringContaining("root"),
    });
    expect(getKnowledgeNode(db, "overview")?.canonicalFields.withdrawn).toBeUndefined();
  });

  it("requires a specific reason and refuses an already retired page", async () => {
    const entries = tools();
    await editingRead(entries, "garden");
    for (const reason of ["", "   ", "x".repeat(1001)])
      expect(
        await call(entries, "knowledge_retire", { id: "garden", expectedRevision: 1, reason }),
      ).toMatchObject({ kind: "error", code: "invalid_arguments" });
    expect(
      await call(entries, "knowledge_retire", {
        id: "garden",
        expectedRevision: 1,
        reason: REASON,
        force: true,
      }),
    ).toMatchObject({ kind: "error", code: "invalid_arguments" });
    expect(
      await call(entries, "knowledge_retire", {
        id: "garden",
        expectedRevision: 1,
        reason: REASON,
      }),
    ).toMatchObject({ kind: "structured" });
    expect(
      await call(entries, "knowledge_retire", {
        id: "garden",
        expectedRevision: 2,
        reason: REASON,
      }),
    ).toMatchObject({ kind: "error" });
  });
});

describe("knowledge_retire authority", () => {
  it("is granted exactly where knowledge_save is, and never to owner-scoped runs or conversations", () => {
    for (const workflow of COGNITIVE_WORKFLOW_IDS) {
      const granted = mutatingToolsFor(workflow);
      expect(granted.has("knowledge_retire"), workflow).toBe(granted.has("knowledge_save"));
    }
    const scoped = buildKnowledgeTools(service, { runId: "run", scopedOwnersOnly: true });
    expect(scoped.map((tool) => tool.name)).not.toContain("knowledge_retire");
    expect(tools().find((tool) => tool.name === "knowledge_retire")?.mutates).toBe(true);
    expect(KNOWLEDGE_MUTATING_TOOLS.has("knowledge_retire")).toBe(true);
  });
});
