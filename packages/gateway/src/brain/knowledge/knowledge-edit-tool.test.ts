// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveBrainSettings } from "../config.js";
import { createBriefsStorageTables } from "../storage/schema.js";
import { mutatingToolsFor } from "../cognition/authority.js";
import { COGNITIVE_WORKFLOW_IDS } from "../cognition/workflows.js";
import { getKnowledgeDependencies } from "./storage-read.js";
import {
  createKnowledgeTables,
  getKnowledgeClaims,
  getKnowledgeNode,
  saveKnowledgeNode,
} from "./storage.js";
import { createKnowledgeWorkTables } from "./work-schema.js";
import { KnowledgeService } from "./service.js";
import { buildKnowledgeTools } from "./tools.js";
import { directKnowledgeGate } from "./writer.js";
import type { Logger, ToolResult } from "@omnesis/core";
import type { ToolHandle } from "@omnesis/agent";

const invocation = { sessionId: "synthetic-session", messageId: "synthetic-message" };
const PAGE = [
  '<claim id="overview" refs="source:doc-a">',
  "The community garden runs raised beds and a seed library.",
  "</claim>",
  "",
  '<claim id="beds" refs="source:doc-a">',
  "## Beds",
  "",
  "Three raised beds sit along the south fence.",
  "</claim>",
  "",
  '<claim id="costs" refs="source:doc-b">',
  "## Costs",
  "",
  "The annual plot fee is 25 credits.",
  "</claim>",
  "",
  '<claim id="seeds" refs="source:doc-c">',
  "## Seed library",
  "",
  "Members may borrow two packets a month.",
  "</claim>",
  "",
].join("\n");
const VERSIONS = { "source:doc-a": "va", "source:doc-b": "vb", "source:doc-c": "vc" };

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

function seed(id = "garden", markdown = PAGE, kind: "wiki" | "root" = "wiki") {
  saveKnowledgeNode(
    db,
    { id, kind, title: "Community garden", expectedRevision: 0, markdown, inputVersions: VERSIONS },
    5,
  );
}

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(
    `CREATE TABLE documents(id TEXT PRIMARY KEY,content TEXT,content_hash TEXT);
     INSERT INTO documents VALUES
       ('doc-a','The garden runs three raised beds along the south fence.','va'),
       ('doc-b','The annual plot fee is 25 credits.','vb'),
       ('doc-c','Members may borrow two packets a month.','vc'),
       ('doc-d','From next season the plot fee is 30 credits.','vd')`,
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
  seed();
});
afterEach(() => db.close());

function tools(runId = "run"): ToolHandle[] {
  return buildKnowledgeTools(service, { runId });
}
async function call(entries: ToolHandle[], name: string, args: unknown): Promise<ToolResult> {
  return entries.find((tool) => tool.name === name)!.invoke(args, invocation);
}
/** An edited claim's evidence needs a read in the run, exactly as for knowledge_save. */
async function readEvidence(entries: ToolHandle[], ref: string) {
  expect(await call(entries, "knowledge_reference", { ref })).toMatchObject({ kind: "structured" });
}
async function editingRead(entries: ToolHandle[], id = "garden") {
  expect(await call(entries, "knowledge_fetch", { id, editing: true })).toMatchObject({
    kind: "structured",
  });
}
const sectionOf = (markdown: string, from: string, to?: string) =>
  markdown.slice(markdown.indexOf(from), to ? markdown.indexOf(to) : undefined);

describe("knowledge_edit", () => {
  it("rewrites one section and keeps every other byte, claim and dependency version", async () => {
    const entries = tools();
    await editingRead(entries);
    await readEvidence(entries, "source:doc-a");
    const before = getKnowledgeClaims(db, "garden");
    const result = await call(entries, "knowledge_edit", {
      node: {
        id: "garden",
        expectedRevision: 1,
        edits: [
          {
            op: "replace_text",
            old: "Three raised beds",
            new: "Three raised beds, each 2 metres long,",
          },
        ],
      },
    });
    expect(result).toMatchObject({
      kind: "structured",
      resultType: "knowledge_edit",
      data: {
        node: { id: "garden", kind: "wiki", title: "Community garden", revision: 2 },
        edit: {
          changedSections: ["## Beds"],
          charsBefore: PAGE.length,
          charsAfter: PAGE.length + ", each 2 metres long,".length,
        },
        verificationSummary: { acceptedRevision: 2 },
      },
    });
    if (result.kind !== "structured") throw new Error("expected a receipt");
    const receipt = result.data as { node: Record<string, unknown> };
    expect(receipt.node).not.toHaveProperty("markdown");
    expect(receipt.node).not.toHaveProperty("plainText");
    const stored = getKnowledgeNode(db, "garden")!;
    expect(stored.markdown).toBe(
      PAGE.replace("Three raised beds", "Three raised beds, each 2 metres long,"),
    );
    for (const [from, to] of [
      ['<claim id="overview"', '<claim id="beds"'],
      ['<claim id="costs"', '<claim id="seeds"'],
      ['<claim id="seeds"', undefined],
    ] as const)
      expect(sectionOf(stored.markdown, from, to)).toBe(sectionOf(PAGE, from, to));
    const after = getKnowledgeClaims(db, "garden");
    expect(after.map((claim) => claim.id)).toEqual(before.map((claim) => claim.id));
    // Only the edited claim changed meaning; later claims merely shifted offsets.
    for (const { start: _start, end: _end, ...claim } of after.filter(
      (claim) => claim.id !== "beds",
    )) {
      const { start: _s, end: _e, ...prior } = before.find((prior) => prior.id === claim.id)!;
      expect(claim).toEqual(prior);
    }
    expect(
      Object.fromEntries(
        getKnowledgeDependencies(db, "garden").map((dep) => [dep.ref, dep.inputVersion]),
      ),
    ).toEqual(VERSIONS);
    expect(lines).toContain(
      `Wiki write via knowledge_edit[replace_text] on garden: r1→r2, ${PAGE.length}→${stored.markdown.length} chars`,
    );
  });

  it("produces exactly what the equivalent knowledge_save would", async () => {
    seed("garden-copy");
    const replacement =
      '<claim id="costs" refs="source:doc-b">\n## Costs\n\nThe annual plot fee is 25 credits, payable in spring.\n</claim>';
    const edited = tools("edit-run");
    await editingRead(edited);
    await readEvidence(edited, "source:doc-b");
    expect(
      await call(edited, "knowledge_edit", {
        node: {
          id: "garden",
          expectedRevision: 1,
          edits: [{ op: "replace_section", heading: "Costs", markdown: replacement }],
        },
        reviewedClaimIds: ["costs"],
      }),
    ).toMatchObject({ kind: "structured" });
    const saved = tools("save-run");
    await editingRead(saved, "garden-copy");
    await readEvidence(saved, "source:doc-b");
    const full =
      sectionOf(PAGE, "", '<claim id="costs"') +
      replacement +
      "\n\n" +
      sectionOf(PAGE, '<claim id="seeds"');
    expect(
      await call(saved, "knowledge_save", {
        node: {
          id: "garden-copy",
          kind: "wiki",
          title: "Community garden",
          expectedRevision: 1,
          markdown: full,
        },
        reviewedClaimIds: ["costs"],
      }),
    ).toMatchObject({ kind: "structured" });
    const strip = (id: string) => {
      const { id: _id, createdAt: _c, updatedAt: _u, ...node } = getKnowledgeNode(db, id)!;
      return {
        node,
        claims: getKnowledgeClaims(db, id).map(({ nodeId: _n, ...claim }) => claim),
        dependencies: getKnowledgeDependencies(db, id).map(({ nodeId: _n, ...dep }) => dep),
      };
    };
    expect(strip("garden")).toEqual(strip("garden-copy"));
    expect(lines).toContain(
      `Wiki write via knowledge_save on garden-copy: r1→r2, ${PAGE.length}→${full.length} chars`,
    );
  });

  it("records review of an unchanged page with no edits, as an unchanged knowledge_save would", async () => {
    seed("garden-copy");
    const edited = tools("edit-run");
    await editingRead(edited);
    expect(
      await call(edited, "knowledge_edit", {
        node: { id: "garden", expectedRevision: 1, edits: [] },
        reviewedClaimIds: ["costs"],
      }),
    ).toMatchObject({
      kind: "structured",
      data: { node: { revision: 2 }, edit: { changedSections: [], charsBefore: PAGE.length } },
    });
    const saved = tools("save-run");
    await editingRead(saved, "garden-copy");
    expect(
      await call(saved, "knowledge_save", {
        node: {
          id: "garden-copy",
          kind: "wiki",
          title: "Community garden",
          expectedRevision: 1,
          markdown: PAGE,
        },
        reviewedClaimIds: ["costs"],
      }),
    ).toMatchObject({ kind: "structured" });
    const strip = (id: string) => {
      const { id: _id, createdAt: _c, updatedAt: _u, ...node } = getKnowledgeNode(db, id)!;
      return {
        node,
        claims: getKnowledgeClaims(db, id).map(({ nodeId: _n, ...claim }) => claim),
        dependencies: getKnowledgeDependencies(db, id).map(({ nodeId: _n, ...dep }) => dep),
      };
    };
    expect(getKnowledgeNode(db, "garden")!.markdown).toBe(PAGE);
    expect(strip("garden")).toEqual(strip("garden-copy"));
    expect(lines).toContain(
      `Wiki write via knowledge_edit[unchanged] on garden: r1→r2, ${PAGE.length}→${PAGE.length} chars`,
    );
  });

  it("refuses a removed claim without claimRemovals exactly as knowledge_save does", async () => {
    const entries = tools();
    await editingRead(entries);
    const edit = await call(entries, "knowledge_edit", {
      node: {
        id: "garden",
        expectedRevision: 1,
        edits: [{ op: "delete_section", heading: "Costs" }],
      },
    });
    const save = await call(entries, "knowledge_save", {
      node: {
        id: "garden",
        kind: "wiki",
        title: "Community garden",
        expectedRevision: 1,
        markdown: PAGE.replace(sectionOf(PAGE, '<claim id="costs"', '<claim id="seeds"'), ""),
      },
    });
    expect(edit).toMatchObject({
      kind: "error",
      code: "claim_invalid",
      message: expect.stringContaining(
        'omits existing claims without explicit removal intent: ["costs"]',
      ),
    });
    // The same refusal, plus the note that the run's read still stands.
    expect(edit).toEqual({
      ...save,
      message: `${(save as { message: string }).message} Nothing was saved, and this run's editing read of revision 1 is still the current page: any retry edits it at the same expectedRevision without fetching the page again.`,
    });
    expect(getKnowledgeNode(db, "garden")!.revision).toBe(1);
    expect(lines).toContain("Wiki edit refused on garden (claim_invalid): delete_section");

    expect(
      await call(entries, "knowledge_edit", {
        node: {
          id: "garden",
          expectedRevision: 1,
          edits: [{ op: "delete_section", heading: "Costs" }],
          claimRemovals: [{ id: "costs", reason: "The plot fee moved to the membership page." }],
        },
      }),
    ).toMatchObject({ kind: "structured", data: { node: { revision: 2 } } });
    expect(getKnowledgeClaims(db, "garden").map((claim) => claim.id)).toEqual([
      "overview",
      "beds",
      "seeds",
    ]);
    const diff = db
      .prepare<[], { diff_json: string }>(
        "SELECT diff_json FROM knowledge_revisions WHERE node_id='garden' AND revision=2",
      )
      .get()!;
    expect(JSON.parse(diff.diff_json).claimRemovals).toEqual([
      { id: "costs", reason: "The plot fee moved to the membership page." },
    ]);
  });

  it("needs a read or an explicit version for a newly cited reference", async () => {
    const entries = tools();
    await editingRead(entries);
    const args = {
      node: {
        id: "garden",
        expectedRevision: 1,
        edits: [
          {
            op: "replace_section",
            heading: "Costs",
            markdown:
              '<claim id="costs" refs="source:doc-b source:doc-d">\n## Costs\n\nThe annual plot fee is 25 credits, rising to 30 credits next season.\n</claim>',
          },
        ],
      },
    };
    // The edited claim re-cites its existing evidence, which needs a read too.
    await readEvidence(entries, "source:doc-b");
    // The refusal says the run's read still stands, so a retry needs no refetch.
    expect(await call(entries, "knowledge_edit", args)).toMatchObject({
      kind: "error",
      code: "revision_conflict",
      message: expect.stringMatching(
        /Missing dependency version for "source:doc-d".*editing read of revision 1 is still the current page/s,
      ),
    });
    expect(getKnowledgeNode(db, "garden")!.revision).toBe(1);
    expect(
      await call(entries, "knowledge_edit", {
        node: { ...args.node, inputVersions: { "source:doc-d": "stale" } },
      }),
    ).toMatchObject({ kind: "error", code: "revision_conflict" });
    expect(await call(entries, "knowledge_reference", { ref: "source:doc-d" })).toMatchObject({
      kind: "structured",
    });
    expect(await call(entries, "knowledge_edit", args)).toMatchObject({
      kind: "structured",
      data: { node: { revision: 2 } },
    });
    expect(
      getKnowledgeDependencies(db, "garden").find((dep) => dep.ref === "source:doc-d")
        ?.inputVersion,
    ).toBe("vd");
  });

  it("edits only the revision this run read with editing:true", async () => {
    const entries = tools();
    const edit = {
      node: {
        id: "garden",
        expectedRevision: 1,
        edits: [{ op: "replace_text", old: "25 credits", new: "26 credits" }],
      },
    };
    const unread = await call(entries, "knowledge_edit", edit);
    expect(unread).toMatchObject({
      kind: "error",
      code: "revision_conflict",
      message: expect.stringContaining("knowledge_fetch({id, editing:true})"),
    });
    expect(JSON.stringify(unread)).not.toContain("still the current page");
    // A reading fetch strips claim tags; it is not an editing read.
    await call(entries, "knowledge_fetch", { id: "garden" });
    expect(await call(entries, "knowledge_edit", edit)).toMatchObject({
      kind: "error",
      code: "revision_conflict",
    });

    await editingRead(entries);
    await readEvidence(entries, "source:doc-b");
    // Another writer moves the page on after this run's read.
    const other = tools("other-run");
    await editingRead(other);
    await readEvidence(other, "source:doc-c");
    expect(
      await call(other, "knowledge_edit", {
        node: {
          ...edit.node,
          edits: [{ op: "replace_text", old: "two packets", new: "three packets" }],
        },
      }),
    ).toMatchObject({ kind: "structured", data: { node: { revision: 2 } } });
    // The page moved on, so the refusal must not vouch for the stale read.
    const stale = await call(entries, "knowledge_edit", edit);
    expect(stale).toMatchObject({ kind: "error", code: "revision_conflict" });
    expect(JSON.stringify(stale)).not.toContain("still the current page");
    expect(
      await call(entries, "knowledge_edit", { node: { ...edit.node, expectedRevision: 2 } }),
    ).toMatchObject({
      kind: "error",
      code: "revision_conflict",
      message: expect.stringContaining("latest editing read is revision 1"),
    });
    await editingRead(entries);
    expect(
      await call(entries, "knowledge_edit", { node: { ...edit.node, expectedRevision: 2 } }),
    ).toMatchObject({ kind: "structured", data: { node: { revision: 3 } } });
    expect(getKnowledgeNode(db, "garden")!.markdown).toBe(
      PAGE.replace("two packets", "three packets").replace("25 credits", "26 credits"),
    );
  });

  it("returns locating errors as tool errors without saving", async () => {
    const entries = tools();
    await editingRead(entries);
    expect(
      await call(entries, "knowledge_edit", {
        node: {
          id: "garden",
          expectedRevision: 1,
          edits: [
            { op: "replace_text", old: "25 credits", new: "30 credits" },
            { op: "replace_section", heading: "Fees", markdown: "## Fees\n\nx" },
          ],
        },
      }),
    ).toMatchObject({
      kind: "error",
      code: "edit_target_not_found",
      message: expect.stringContaining(
        'edits[1] (replace_section): no heading matches "Fees". Available headings: ## Beds | ## Costs | ## Seed library',
      ),
    });
    expect(
      await call(entries, "knowledge_edit", {
        node: {
          id: "garden",
          expectedRevision: 1,
          edits: [{ op: "replace_text", old: "</claim>", new: "</claim>\n" }],
        },
      }),
    ).toMatchObject({
      kind: "error",
      code: "edit_target_ambiguous",
      message: expect.stringContaining("occurs 4 times"),
    });
    expect(getKnowledgeNode(db, "garden")!.revision).toBe(1);
    expect(lines).toEqual([
      "Wiki edit refused on garden (edit_target_not_found): replace_text,replace_section",
      "Wiki edit refused on garden (edit_target_ambiguous): replace_text",
    ]);
  });

  it("checks the edited page's claim markup like a full replacement", async () => {
    const entries = tools();
    await editingRead(entries);
    expect(
      await call(entries, "knowledge_edit", {
        node: {
          id: "garden",
          expectedRevision: 1,
          edits: [
            { op: "insert_section", at: "end", markdown: "## Tools\n\nA shed holds the tools." },
          ],
        },
      }),
    ).toMatchObject({
      kind: "error",
      code: "claim_invalid",
      message: expect.stringContaining("must be inside a claim tag"),
    });
    expect(
      await call(entries, "knowledge_edit", {
        node: {
          id: "garden",
          expectedRevision: 1,
          edits: [
            {
              op: "insert_section",
              after: "Costs",
              markdown:
                '<claim id="hours" refs="">\n## Opening hours\n\nThe gate hours are not yet known.\n</claim>',
            },
          ],
          claims: [{ id: "hours", epistemicStatus: "unsupported", modality: "question" }],
        },
      }),
    ).toMatchObject({
      kind: "structured",
      data: { edit: { changedSections: ["## Opening hours"] } },
    });
    const stored = getKnowledgeNode(db, "garden")!.markdown;
    expect(stored.indexOf("## Opening hours")).toBeGreaterThan(stored.indexOf("## Costs"));
    expect(stored.indexOf("## Opening hours")).toBeLessThan(stored.indexOf("## Seed library"));
    expect(getKnowledgeClaims(db, "garden").find((claim) => claim.id === "hours")).toMatchObject({
      epistemicStatus: "unsupported",
      modality: "question",
    });
  });

  it("keeps the title unless one is given, and edits a root page", async () => {
    seed(
      "root",
      '<claim id="intro" refs="source:doc-a">The garden has raised beds.</claim>',
      "root",
    );
    const entries = tools();
    await editingRead(entries, "root");
    await readEvidence(entries, "source:doc-a");
    expect(
      await call(entries, "knowledge_edit", {
        node: {
          id: "root",
          expectedRevision: 1,
          title: "Home",
          edits: [{ op: "replace_text", old: "has raised beds", new: "has three raised beds" }],
        },
      }),
    ).toMatchObject({
      kind: "structured",
      data: { node: { kind: "root", title: "Home", revision: 2 } },
    });
  });

  it("works under a maintenance run fence and its wiki read receipts", async () => {
    db.prepare(
      "INSERT INTO knowledge_batches(id,run_id,creation_fingerprint,tier,status,created_at,updated_at) VALUES('batch','batch','batch','routine','running',1,1)",
    ).run();
    const entries = buildKnowledgeTools(service, {
      runId: "batch",
      batchId: "batch",
      parallel: true,
    });
    await editingRead(entries);
    await readEvidence(entries, "source:doc-b");
    expect(
      await call(entries, "knowledge_edit", {
        node: {
          id: "garden",
          expectedRevision: 1,
          edits: [{ op: "replace_text", old: "25 credits", new: "27 credits" }],
        },
      }),
    ).toMatchObject({ kind: "structured", data: { node: { revision: 2 } } });
    db.prepare("UPDATE knowledge_batches SET status='completed' WHERE id='batch'").run();
    await editingRead(entries);
    expect(
      await call(entries, "knowledge_edit", {
        node: {
          id: "garden",
          expectedRevision: 2,
          edits: [{ op: "replace_text", old: "27 credits", new: "28 credits" }],
        },
      }),
    ).toMatchObject({ kind: "error" });
    expect(getKnowledgeNode(db, "garden")!.revision).toBe(2);
  });

  it("is a strict schema: markdown and kind belong to knowledge_save", async () => {
    const entries = tools();
    await editingRead(entries);
    for (const node of [
      { id: "garden", expectedRevision: 1, markdown: PAGE, edits: [] },
      {
        id: "garden",
        expectedRevision: 1,
        kind: "wiki",
        edits: [{ op: "delete_section", heading: "Costs" }],
      },
      { id: "garden", expectedRevision: 1, edits: [{ op: "rename_section", heading: "Costs" }] },
    ])
      expect(await call(entries, "knowledge_edit", { node })).toMatchObject({
        kind: "error",
        code: "invalid_arguments",
      });
    expect(
      await call(entries, "knowledge_edit", {
        candidateId: "candidate",
        node: {
          id: "garden",
          expectedRevision: 1,
          edits: [{ op: "delete_section", heading: "Costs" }],
        },
      }),
    ).toMatchObject({ kind: "error", code: "invalid_arguments" });
  });
});

describe("knowledge_edit authority", () => {
  it("is granted exactly where knowledge_save is, and never to owner-scoped runs", () => {
    for (const workflow of COGNITIVE_WORKFLOW_IDS) {
      const granted = mutatingToolsFor(workflow);
      expect(granted.has("knowledge_edit"), workflow).toBe(granted.has("knowledge_save"));
    }
    const scoped = buildKnowledgeTools(service, { runId: "run", scopedOwnersOnly: true });
    expect(scoped.map((tool) => tool.name)).not.toContain("knowledge_edit");
    expect(tools().find((tool) => tool.name === "knowledge_edit")?.mutates).toBe(true);
  });

  it("steers partial changes away from full replacement in the tool descriptions", () => {
    const entries = tools();
    const save = entries.find((tool) => tool.name === "knowledge_save")!.description;
    const edit = entries.find((tool) => tool.name === "knowledge_edit")!.description;
    expect(save).toContain("To change part of an existing wiki or root page, use knowledge_edit");
    expect(edit).toContain("Use knowledge_save only to create a page or to restructure most of it");
    expect(edit).toContain("node.claimRemovals");
  });
});
