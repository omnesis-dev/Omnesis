// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createLogger } from "@omnesis/core";
import { resolveBrainSettings } from "../config.js";
import { assertKnowledgeNavigation } from "./navigation.js";
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

it("uses identical errors for missing, wrong-kind and erased target IDs", async () => {
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
    "INSERT INTO knowledge_cascade_jobs(kind,target_kind,target_id,revision,created_at) VALUES('purge','node','wiki_reference','deleted',2)",
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

it("refuses a root summary using wiki support without navigation before paid verification", async () => {
  const verifier = vi.fn();
  service.deps.getEntailmentVerifier = verifier;
  const proposal = input("Workshop reference.", {
    id: "root_index",
    kind: "root",
    expectedRevision: 1,
    markdown: markup("Workshop reference.", "wiki:wiki_reference#claim:intro"),
    inputVersions: { "wiki:wiki_reference#claim:intro": 1 },
  });
  await expect(service.save(proposal)).rejects.toThrow(/no navigation/);
  expect(verifier).not.toHaveBeenCalled();
  expect(getKnowledgeNode(db, "root_index")!.revision).toBe(1);
  expect(() => saveKnowledgeNode(db, { ...proposal, enforceClaimPreservation: true }, 2)).toThrow(
    /no navigation/,
  );
});

it.each([
  "[Workshop](wiki:wiki_reference)",
  "[Workshop](wiki_reference#claim:intro)",
  "[Workshop](/portal/debug/cognition/knowledge/wiki_reference?kind=wiki)",
  "[Workshop][detail]\n\n[detail]: wiki:wiki_reference",
])("accepts selected supporting wiki navigation without requiring unrelated pages: %s", (text) => {
  const proposal = input(text, {
    id: "root_index",
    kind: "root",
    expectedRevision: 1,
    markdown: markup(text, "wiki:wiki_reference#claim:intro"),
    inputVersions: { "wiki:wiki_reference#claim:intro": 1 },
  });
  expect(() =>
    saveKnowledgeNode(db, { ...proposal, enforceClaimPreservation: true }, 2),
  ).not.toThrow();
});

it("does not count literal code as navigation or require context-only wiki links", async () => {
  const proposal = input("`[Workshop](wiki:wiki_reference)`", {
    id: "root_index",
    kind: "root",
    expectedRevision: 1,
    markdown: markup("`[Workshop](wiki:wiki_reference)`", "wiki:wiki_reference#claim:intro"),
    inputVersions: { "wiki:wiki_reference#claim:intro": 1 },
  });
  expect(() => saveKnowledgeNode(db, { ...proposal, enforceClaimPreservation: true }, 2)).toThrow(
    /no navigation/,
  );
  expect(() =>
    saveKnowledgeNode(
      db,
      {
        ...proposal,
        enforceClaimPreservation: true,
        claims: [{ id: "intro", relations: { "wiki:wiki_reference#claim:intro": "context" } }],
      },
      2,
    ),
  ).not.toThrow();
  // Omitted relation state inherits existing context, not a new supports edge.
  await expect(
    service.save({
      ...proposal,
      expectedRevision: 2,
      markdown: markup("Context was considered.", "wiki:wiki_reference#claim:intro"),
    }),
  ).resolves.toBeDefined();
});

it("preserves a legacy proof-only refresh but requires navigation for root orientation", () => {
  const proposal = input("Workshop reference.", {
    id: "root_index",
    kind: "root",
    expectedRevision: 1,
    markdown: markup("Workshop reference.", "wiki:wiki_reference#claim:intro"),
    inputVersions: { "wiki:wiki_reference#claim:intro": 1 },
  });
  const saved = saveKnowledgeNode(db, proposal, 2);
  expect(() =>
    assertKnowledgeNavigation(
      db,
      { ...proposal, expectedRevision: saved.node.revision },
      saved.node.plainText,
    ),
  ).not.toThrow();
  expect(() =>
    assertKnowledgeNavigation(
      db,
      {
        ...proposal,
        expectedRevision: saved.node.revision,
        maintenance: { batchId: "batch", runId: "run", inputFingerprint: "input" },
      },
      saved.node.plainText,
    ),
  ).toThrow(/no navigation/);
});

function linkedRoot(text = "[Workshop](wiki:wiki_reference)"): KnowledgeProposal {
  const saved = saveKnowledgeNode(
    db,
    input(text, { id: "root_index", kind: "root", expectedRevision: 1 }),
    2,
  );
  return input("Workshop context.", {
    id: "root_index",
    kind: "root",
    expectedRevision: saved.node.revision,
  });
}

it("requires deliberate root wiki navigation removal before paid work and at the writer", async () => {
  const proposal = linkedRoot();
  const verifier = vi.fn();
  service.deps.getEntailmentVerifier = verifier;
  await expect(service.save(proposal)).rejects.toThrow(/navigationRemovals/);
  expect(verifier).not.toHaveBeenCalled();
  expect(() => saveKnowledgeNode(db, { ...proposal, enforceClaimPreservation: true }, 3)).toThrow(
    /navigationRemovals/,
  );
  expect(getKnowledgeNode(db, "root_index")!.revision).toBe(2);
  await expect(
    service.save({
      ...proposal,
      navigationRemovals: [
        { targetId: "wiki_reference", reason: "Omitted from this compact orientation." },
      ],
    }),
  ).resolves.toHaveProperty("node.revision", 3);
});

it.each([
  "[Renamed](wiki_reference#claim:intro)",
  "[Portal](/portal/debug/cognition/knowledge/wiki_reference?kind=wiki)",
  '<claim id="child" refs="">[Nested](wiki:wiki_reference)</claim>',
])(
  "preserves root navigation identity across labels, aliases and nested claims: %s",
  async (text) => {
    const proposal = linkedRoot();
    await expect(service.save({ ...proposal, markdown: markup(text) })).resolves.toHaveProperty(
      "node.revision",
      3,
    );
  },
);

it.each(
  [
    [{ targetId: "wiki_unknown", reason: "Different topic." }],
    [{ targetId: "wiki_reference", reason: "" }],
    [{ targetId: "wiki_reference", reason: "x".repeat(1001) }],
    [
      { targetId: "wiki_reference", reason: "One." },
      { targetId: "wiki_reference", reason: "Two." },
    ],
  ].map((navigationRemovals) => ({ navigationRemovals })),
)("rejects invalid removal dispositions without mutation: %j", async ({ navigationRemovals }) => {
  const proposal = linkedRoot();
  await expect(service.save({ ...proposal, navigationRemovals })).rejects.toThrow(
    /distinct prior target/,
  );
  expect(getKnowledgeNode(db, "root_index")!.revision).toBe(2);
});

it("does not acknowledge retained links as removed or literal code as retained navigation", async () => {
  const proposal = linkedRoot();
  await expect(
    service.save({
      ...proposal,
      markdown: markup("[Kept](wiki:wiki_reference)"),
      navigationRemovals: [{ targetId: "wiki_reference", reason: "Not actually removed." }],
    }),
  ).rejects.toThrow(/distinct prior target/);
  await expect(
    service.save({
      ...proposal,
      markdown: markup("`[Example](wiki:wiki_reference)`"),
    }),
  ).rejects.toThrow(/navigationRemovals/);
});

it.each(["missing", "hidden", "withdrawn"])(
  "does not demand or disclose %s prior wiki targets",
  async (state) => {
    const proposal = linkedRoot();
    if (state === "missing")
      db.prepare("DELETE FROM knowledge_nodes WHERE id='wiki_reference'").run();
    if (state === "hidden")
      db.prepare("INSERT INTO knowledge_node_tombstones VALUES('wiki_reference',3)").run();
    if (state === "withdrawn")
      db.prepare("UPDATE knowledge_nodes SET fields_json=? WHERE id='wiki_reference'").run(
        JSON.stringify({ withdrawn: true }),
      );
    await expect(service.save(proposal)).resolves.toHaveProperty("node.revision", 3);
  },
);

it("protects the root revision and historical privacy before enumerating removed targets", async () => {
  const proposal = linkedRoot();
  await expect(service.save({ ...proposal, expectedRevision: 1 })).rejects.toMatchObject({
    code: "revision_conflict",
  });
  db.prepare("INSERT INTO knowledge_node_tombstones VALUES('root_index',3)").run();
  await expect(service.save(proposal)).rejects.toMatchObject({
    code: "reference_invalid",
    message: "Synthesis page is unavailable",
  });
});

it("rechecks target availability after verification instead of trusting a preflight exemption", async () => {
  const proposal = linkedRoot();
  db.prepare("UPDATE knowledge_nodes SET fields_json=? WHERE id='wiki_reference'").run(
    JSON.stringify({ withdrawn: true }),
  );
  service.deps.getEntailmentVerifier = async () => ({
    verify: async () => {
      db.prepare("UPDATE knowledge_nodes SET fields_json='{}' WHERE id='wiki_reference'").run();
      return { label: "entailment", probability: 1 };
    },
    dispose() {},
  });
  await expect(
    service.save({
      ...proposal,
      markdown: markup("Workshop reference.", "source:manual"),
      inputVersions: { "source:manual": "v1" },
    }),
  ).rejects.toThrow(/navigationRemovals/);
  expect(getKnowledgeNode(db, "root_index")!.revision).toBe(2);
});

it("allows a factual correction retaining independently useful navigation with current proof", async () => {
  const proposal = linkedRoot();
  service.deps.getEntailmentVerifier = async () => ({
    verify: async () => ({ label: "entailment", probability: 1 }),
    dispose() {},
  });
  const saved = await service.save({
    ...proposal,
    markdown: markup("Workshop reference. [Details](wiki:wiki_reference)", "source:manual"),
    inputVersions: { "source:manual": "v1" },
  });
  expect(saved.node.markdown).toContain("[Details](wiki:wiki_reference)");
  expect(
    db
      .prepare(
        "SELECT verification FROM knowledge_claims WHERE node_id='root_index' AND id='intro'",
      )
      .get(),
  ).toEqual({ verification: "verified" });
});

it("does not impose a navigation quota or extend removal protection to loop links or other pages", async () => {
  const proposal = linkedRoot("[Task](loop:loop_task)");
  await expect(service.save(proposal)).resolves.toHaveProperty("node.revision", 3);
  const wiki = saveKnowledgeNode(db, input("[Details](wiki:wiki_reference)"), 1);
  await expect(
    service.save(input("Workshop context.", { expectedRevision: wiki.node.revision })),
  ).resolves.toBeDefined();
  await expect(
    service.save(
      input("Context.", {
        id: "wiki_new",
        navigationRemovals: [{ targetId: "wiki_reference", reason: "No previous root." }],
      }),
    ),
  ).rejects.toThrow(/only to existing roots/);
});

it.each(["changed", "hidden"])(
  "does not let explicit navigation removal bypass %s source evidence",
  async (change) => {
    const proposal = linkedRoot();
    service.deps.getEntailmentVerifier = async () => ({
      verify: async () => {
        if (change === "changed")
          db.prepare("UPDATE documents SET content_hash='v2' WHERE id='manual'").run();
        else
          db.prepare(
            "INSERT INTO knowledge_source_revisions(document_id,content_hash,deleted,updated_at) VALUES('manual','v1',1,3)",
          ).run();
        return { label: "entailment", probability: 1 };
      },
      dispose() {},
    });
    await expect(
      service.save({
        ...proposal,
        markdown: markup("Workshop reference.", "source:manual"),
        inputVersions: { "source:manual": "v1" },
        navigationRemovals: [
          { targetId: "wiki_reference", reason: "Omitted from this orientation." },
        ],
      }),
    ).rejects.toThrow();
    expect(db.prepare("SELECT revision FROM knowledge_nodes WHERE id='root_index'").get()).toEqual({
      revision: 2,
    });
  },
);

it("bounds removal intent and refuses declarations on a new root", async () => {
  const proposal = linkedRoot();
  await expect(
    service.save({
      ...proposal,
      navigationRemovals: Array.from({ length: 129 }, () => ({
        targetId: "wiki_reference",
        reason: "Bounded edit.",
      })),
    }),
  ).rejects.toThrow(/at most 128/);
  expect(() =>
    assertKnowledgeNavigation(
      db,
      {
        ...proposal,
        id: "root_new",
        expectedRevision: 0,
        navigationRemovals: [{ targetId: "wiki_reference", reason: "No prior navigation." }],
      },
      "Workshop reference.",
    ),
  ).toThrow(/distinct prior target/);
});
