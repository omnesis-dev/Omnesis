// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createLogger } from "@omnesis/core";
import { resolveBrainSettings } from "../config.js";
import { KnowledgeService, type KnowledgeProposal } from "./service.js";
import { createKnowledgeTables, getKnowledgeNode, saveKnowledgeNode } from "./storage.js";
import { directKnowledgeGate } from "./writer.js";

let db: Database.Database, service: KnowledgeService;
const markup = (text: string, refs = "") => `<claim id="intro" refs="${refs}">\n${text}\n</claim>`;
const input = (text: string, extra: Partial<KnowledgeProposal> = {}): KnowledgeProposal => ({
  id: "wiki_overview",
  kind: "wiki",
  title: "Workshop overview",
  expectedRevision: 0,
  markdown: markup(text),
  inputVersions: {},
  ...extra,
});
beforeEach(() => {
  db = new Database(":memory:");
  db.exec(
    "CREATE TABLE documents(id TEXT PRIMARY KEY,content TEXT,content_hash TEXT); INSERT INTO documents VALUES('manual','Workshop reference.','v1')",
  );
  createKnowledgeTables(db);
  service = new KnowledgeService({
    db,
    writeGate: directKnowledgeGate(db),
    clock: () => 10,
    getSettings: () => resolveBrainSettings(),
    log: createLogger("navigation-test"),
  });
  for (const [id, kind] of [
    ["wiki_reference", "wiki"],
    ["loop_task", "loop"],
    ["root_index", "root"],
  ] as const)
    saveKnowledgeNode(
      db,
      {
        ...input("Workshop reference.", { id, kind }),
        markdown: markup("Workshop reference.", "source:manual"),
        inputVersions: { "source:manual": "v1" },
      },
      1,
    );
});
afterEach(() => db.close());

it.each(["wiki", "root"] as const)(
  "accepts valid typed, bare, portal and reference-style navigation on %s",
  async (kind) => {
    const text = [
      "[Page](wiki:wiki_reference) [Task](loop:loop_task#field:status)",
      "[Bare page](wiki_reference#claim:intro) [Bare task](loop_task) [Root](root_index)",
      "[Portal](/portal/debug/cognition/knowledge/wiki_reference?claim=intro)",
      "[Task portal](/portal/debug/cognition/knowledge/loop_task?kind=loop)",
      "[Reference style][page]",
      "",
      "[page]: wiki:wiki_reference#claim:intro",
    ].join("\n");
    const proposal = input(
      text,
      kind === "root" ? { id: "root_index", kind, expectedRevision: 1 } : {},
    );
    const result = await service.save(proposal);
    expect(result.node.markdown).toBe(proposal.markdown);
  },
);

it.each([
  "[Missing](wiki:wiki_missing)",
  "[Missing](loop_missing)",
  "[Wrong kind](loop:wiki_reference)",
  "[Wrong kind](wiki:loop_task)",
  "[Wrong portal kind](/portal/debug/cognition/knowledge/wiki_reference?kind=loop)",
  "[Missing portal](/portal/debug/cognition/knowledge/wiki_missing)",
  "[Missing][target]\n\n[target]: loop:loop_missing",
])("rejects unavailable newly introduced navigation: %s", async (text) => {
  const verify = vi.fn();
  service.deps.getEntailmentVerifier = verify;
  await expect(service.save(input(text))).rejects.toMatchObject({ code: "reference_invalid" });
  expect(verify).not.toHaveBeenCalled();
  expect(getKnowledgeNode(db, "wiki_overview")).toBeNull();
});

it("uses identical errors for missing, wrong-kind and privacy-hidden target IDs", async () => {
  const proposal = input("[Reference](wiki:wiki_reference)");
  const message = async () => {
    try {
      await service.save(proposal);
      throw new Error("Expected refusal");
    } catch (error) {
      expect(error).toMatchObject({ code: "reference_invalid" });
      return (error as Error).message;
    }
  };
  db.prepare("UPDATE knowledge_nodes SET kind='loop' WHERE id='wiki_reference'").run();
  const wrong = await message();
  db.prepare("UPDATE knowledge_nodes SET kind='wiki' WHERE id='wiki_reference'").run();
  db.prepare(
    "INSERT INTO knowledge_source_revisions(document_id,content_hash,deleted,updated_at) VALUES('manual','v1',1,2)",
  ).run();
  expect(await message()).toBe(wrong);
  db.prepare("DELETE FROM knowledge_nodes WHERE id='wiki_reference'").run();
  expect(await message()).toBe(wrong);
  expect(wrong).not.toContain("Workshop reference");
});

it("ignores code examples, plain identifiers, external URLs and ordinary relative links", async () => {
  const text = [
    "`[Example](wiki:wiki_missing)`",
    "```md",
    "[Example](loop_missing)",
    "```",
    "wiki_missing loop_missing",
    "[External](https://example.org/wiki_missing)",
    "[External typed lookalike](https://example.org/wiki:wiki_missing)",
    "[Relative](notes/wiki_missing) [Anchor](#section)",
    "[Unused reference]: wiki:wiki_missing",
  ].join("\n\n");
  await expect(service.save(input(text))).resolves.toHaveProperty("node.id", "wiki_overview");
});

it("allows unrelated repairs of unchanged legacy dangling targets but rejects changing them", async () => {
  saveKnowledgeNode(db, input("Earlier context. [Legacy](loop_missing)"), 1);
  await expect(
    service.save(input("Revised context. [Renamed](loop:loop_missing)", { expectedRevision: 1 })),
  ).resolves.toHaveProperty("node.revision", 2);
  await expect(
    service.save(input("Revised context. [Other](loop_other)", { expectedRevision: 2 })),
  ).rejects.toMatchObject({ code: "reference_invalid" });
  expect(getKnowledgeNode(db, "wiki_overview")!.revision).toBe(2);
});

it.each(["delete", "hide", "kind"])(
  "rechecks navigation inside the writer after an asynchronous %s",
  async (change) => {
    service.deps.getEntailmentVerifier = async () => ({
      verify: async () => {
        if (change === "delete")
          db.prepare("DELETE FROM knowledge_nodes WHERE id='wiki_reference'").run();
        if (change === "hide")
          db.prepare(
            "INSERT INTO knowledge_node_tombstones(id,deleted_at) VALUES('wiki_reference',2)",
          ).run();
        if (change === "kind")
          db.prepare("UPDATE knowledge_nodes SET kind='loop' WHERE id='wiki_reference'").run();
        return { label: "entailment", probability: 1 };
      },
      dispose() {},
    });
    await expect(
      service.save(
        input("unused", {
          markdown: markup("[Reference](wiki:wiki_reference)", "source:manual"),
          inputVersions: { "source:manual": "v1" },
        }),
      ),
    ).rejects.toMatchObject({ code: "reference_invalid" });
    expect(getKnowledgeNode(db, "wiki_overview")).toBeNull();
    expect(
      db
        .prepare("SELECT COUNT(*) AS n FROM knowledge_revisions WHERE node_id='wiki_overview'")
        .get(),
    ).toEqual({ n: 0 });
  },
);

it("does not impose the model-navigation check on internal storage maintenance", () => {
  expect(saveKnowledgeNode(db, input("[Legacy](wiki_missing)"), 1).node.revision).toBe(1);
});
