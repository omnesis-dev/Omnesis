// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createLogger } from "@omnesis/core";
import { createAnnotationStorageTables } from "../storage/annotations.js";
import { createBriefsStorageTables } from "../storage/schema.js";
import { resolveBrainSettings } from "../config.js";
import {
  findRelatedKnowledge,
  knowledgeMirrorSearch,
  relatedPageReviewQueue,
  withRelatedPageHints,
  type KnowledgeMirrorSearch,
} from "./related-knowledge.js";
import { KNOWLEDGE_SOURCE_ID } from "./source-meta.js";
import { KnowledgeService } from "./service.js";
import { createKnowledgeTables, getKnowledgeNode } from "./storage.js";
import { buildKnowledgeTools } from "./tools.js";
import { directKnowledgeGate } from "./writer.js";
import type { SearchPort, ToolHandle } from "@omnesis/agent";

const log = createLogger("related-knowledge-test");
const context = { sessionId: "session", messageId: "message" };
const BROCHURE = "The brochure lists a service charge of £3,200 per quarter for Flat 2.";
const CORRECTION =
  "On 4 March the letting agent confirmed the service charge for Flat 2 is £800 per quarter, £3,200 annually; the brochure's statement that £3,200 was payable per quarter was an error.";
const PAGE_CLAIM = "Flat 2 carries a service charge of £3,200 per quarter.";

let db: Database.Database;
let service: KnowledgeService;
beforeEach(() => {
  db = new Database(":memory:");
  db.exec(
    "CREATE TABLE documents(id TEXT PRIMARY KEY,content TEXT,content_hash TEXT,source_id TEXT,external_id TEXT)",
  );
  db.prepare("INSERT INTO documents(id,content,content_hash) VALUES('brochure',?,'v1')").run(
    BROCHURE,
  );
  db.prepare(
    "INSERT INTO documents(id,content,content_hash) VALUES('agent-email','Correction email.','v1')",
  ).run();
  createBriefsStorageTables(db);
  createAnnotationStorageTables(db);
  createKnowledgeTables(db);
  service = new KnowledgeService({
    db,
    writeGate: directKnowledgeGate(db),
    getSettings: () => resolveBrainSettings(),
    clock: () => 10,
    log,
  });
  // The correction is recorded on a different document than the brochure.
  db.prepare(
    "INSERT INTO doc_annotations(id,doc_id,claim_type,claim_text,evidence_doc_id,evidence_quote,confidence,created_by_run,created_at) VALUES('correction','agent-email','running-cost',?,'agent-email','Correction email.',0.8,'fixture',1)",
  ).run(CORRECTION);
  node("correction", "doc_annotation", "Running cost", CORRECTION, { subjectId: "agent-email" });
  node("garden", "wiki", "Garden", "Tulip bulbs go in the ground before the first frost.");
});
afterEach(() => db.close());

function node(
  id: string,
  kind: string,
  title: string,
  text: string,
  fields: Record<string, unknown> = {},
) {
  db.prepare(
    "INSERT INTO knowledge_nodes(id,kind,owner_id,title,markdown,plain_text,revision,meaning_revision,meaning_hash,validity,metadata_json,fields_json,created_at,updated_at) VALUES(?,?,NULL,?,?,?,1,1,'hash','current','{}',?,1,10)",
  ).run(id, kind, title, text, text, JSON.stringify(fields));
}

async function savePage(text = PAGE_CLAIM) {
  await service.save({
    id: "flat",
    kind: "wiki",
    title: "Flat 2",
    markdown: `<claim id="charge" refs="source:brochure">${text}</claim>`,
    expectedRevision: 0,
    inputVersions: { "source:brochure": "v1" },
  });
}

function tools(search: KnowledgeMirrorSearch) {
  const all = buildKnowledgeTools(service, { runId: "run", relatedKnowledge: search });
  return (name: string) => all.find((entry) => entry.name === name)!;
}

function edit(text: string, reviewedClaimIds?: string[]) {
  return {
    node: {
      id: "flat",
      kind: "wiki",
      title: "Flat 2",
      markdown: `<claim id="charge" refs="source:brochure">${text}</claim>`,
      expectedRevision: getKnowledgeNode(db, "flat")!.revision,
      inputVersions: { "source:brochure": "v1" },
    },
    ...(reviewedClaimIds ? { reviewedClaimIds } : {}),
  };
}

it("shows a page save the current correction its changed claim repeats, once per page", async () => {
  await savePage("Flat 2 is a two-bedroom flat.");
  const search = vi.fn<KnowledgeMirrorSearch>(async () => ["garden", "correction", "flat"]);
  const save = tools(search)("knowledge_save");

  const refused = await save.invoke(edit(PAGE_CLAIM), context);
  expect(refused).toMatchObject({ kind: "error", code: "claim_invalid" });
  const message = (refused as { message: string }).message;
  expect(message).toContain("annotation:correction");
  expect(message).toContain("was an error");
  // A neighbour sharing no specific terms, and the page itself, are not shown.
  expect(message).not.toContain("garden");
  expect(message).not.toContain("wiki:flat");
  expect(search.mock.calls[0]![0]).toContain("quarter");
  expect(getKnowledgeNode(db, "flat")!.plainText).not.toContain("£3,200");

  const corrected = "Flat 2 carries a service charge of £800 per quarter (£3,200 annually).";
  expect(await save.invoke(edit(corrected), context)).toMatchObject({ kind: "structured" });
  expect(getKnowledgeNode(db, "flat")!.plainText).toBe(corrected);
});

it("does not stop a save after the run has read the related record", async () => {
  await savePage("Flat 2 is a two-bedroom flat.");
  const tool = tools(async () => ["correction"]);
  expect(await tool("knowledge_fetch").invoke({ id: "correction" }, context)).toMatchObject({
    kind: "structured",
  });
  expect(await tool("knowledge_save").invoke(edit(PAGE_CLAIM), context)).toMatchObject({
    kind: "structured",
  });
});

it("checks reviewed claims but leaves untouched ones and pages that cite the record alone", async () => {
  await savePage();
  const search = vi.fn<KnowledgeMirrorSearch>(async () => ["correction"]);
  const save = tools(search)("knowledge_save");
  expect(await save.invoke(edit(PAGE_CLAIM), context)).toMatchObject({ kind: "structured" });
  expect(search).not.toHaveBeenCalled();

  expect(await save.invoke(edit(PAGE_CLAIM, ["charge"]), context)).toMatchObject({
    kind: "error",
    code: "claim_invalid",
  });

  const citing = tools(search)("knowledge_save");
  const markdown = `<claim id="charge" refs="source:brochure annotation:correction">${PAGE_CLAIM}</claim>`;
  const base = edit(PAGE_CLAIM).node;
  const result = await citing.invoke(
    {
      node: {
        ...base,
        markdown,
        inputVersions: {
          ...base.inputVersions,
          "annotation:correction": service.reference("annotation:correction").revision,
        },
      },
      reviewedClaimIds: ["charge"],
    },
    context,
  );
  expect(result).toMatchObject({ kind: "structured" });
});

it("does not show a run the annotation it wrote itself", async () => {
  await savePage("Flat 2 is a two-bedroom flat.");
  db.prepare("UPDATE doc_annotations SET created_by_run='run' WHERE id='correction'").run();
  const save = tools(async () => ["correction"])("knowledge_save");
  expect(await save.invoke(edit(PAGE_CLAIM), context)).toMatchObject({ kind: "structured" });
});

it("does not show records resting only on the draft's own evidence, or pages this run saved", async () => {
  await savePage("Flat 2 is a two-bedroom flat.");
  // An annotation about the brochure itself carries nothing the brochure does not.
  db.prepare(
    "INSERT INTO doc_annotations(id,doc_id,claim_type,claim_text,evidence_doc_id,evidence_quote,confidence,created_by_run,created_at) VALUES('brochure-note','brochure','running-cost',?,'brochure','The brochure lists',0.8,'fixture',1)",
  ).run(BROCHURE);
  node("brochure-note", "doc_annotation", "Brochure", BROCHURE, { subjectId: "brochure" });
  // The sibling page rests on the correction's own document; the flat page
  // on the brochure.
  let hits = ["correction"];
  const search = vi.fn<KnowledgeMirrorSearch>(async () => hits);
  const tool = tools(search);
  await service.save({
    id: "sibling",
    kind: "wiki",
    title: "Flat 2 costs",
    markdown: `<claim id="cost" refs="source:agent-email">${PAGE_CLAIM}</claim>`,
    expectedRevision: 0,
    inputVersions: { "source:agent-email": "v1" },
  });
  const sibling = getKnowledgeNode(db, "sibling")!;
  expect(
    await tool("knowledge_save").invoke(
      {
        node: {
          id: "sibling",
          kind: "wiki",
          title: sibling.title,
          markdown: `<claim id="cost" refs="source:agent-email">${PAGE_CLAIM} Paid quarterly.</claim>`,
          expectedRevision: sibling.revision,
          inputVersions: { "source:agent-email": "v1" },
        },
      },
      context,
    ),
  ).toMatchObject({ kind: "structured" });
  hits = ["brochure-note", "sibling"];
  expect(await tool("knowledge_save").invoke(edit(PAGE_CLAIM), context)).toMatchObject({
    kind: "structured",
  });
  expect(search).toHaveBeenCalled();
});

it("never checks the root orientation", async () => {
  const search = vi.fn<KnowledgeMirrorSearch>(async () => ["correction"]);
  await service.save({
    id: "root",
    kind: "root",
    title: "Current context",
    markdown: `<claim id="date" refs="source:brochure">${PAGE_CLAIM}</claim>`,
    expectedRevision: 0,
    inputVersions: { "source:brochure": "v1" },
  });
  const root = getKnowledgeNode(db, "root")!;
  expect(
    await tools(search)("knowledge_save").invoke(
      {
        node: {
          id: "root",
          kind: "root",
          ownerId: null,
          title: root.title,
          markdown: `<claim id="date" refs="source:brochure">${PAGE_CLAIM} Again.</claim>`,
          expectedRevision: root.revision,
          inputVersions: { "source:brochure": "v1" },
        },
      },
      context,
    ),
  ).toMatchObject({ kind: "structured" });
  expect(search).not.toHaveBeenCalled();
});

it("does not save when the run is aborted during the check", async () => {
  await savePage("Flat 2 is a two-bedroom flat.");
  const controller = new AbortController();
  const save = tools(async () => {
    controller.abort();
    throw new Error("aborted");
  })("knowledge_save");
  await expect(
    save.invoke(edit(PAGE_CLAIM), { ...context, abortSignal: controller.signal }),
  ).rejects.toThrow();
  expect(getKnowledgeNode(db, "flat")!.plainText).not.toContain("£3,200");
});

it("saves without the check when retrieval fails", async () => {
  await savePage("Flat 2 is a two-bedroom flat.");
  const save = tools(async () => {
    throw new Error("search unavailable");
  })("knowledge_save");
  expect(await save.invoke(edit(PAGE_CLAIM), context)).toMatchObject({ kind: "structured" });
});

it("skips retired annotations", async () => {
  db.prepare("UPDATE doc_annotations SET superseded_by='newer' WHERE id='correction'").run();
  expect(
    await findRelatedKnowledge(
      db,
      async () => ["correction"],
      [{ key: "charge", text: PAGE_CLAIM }],
      {
        kinds: new Set(["doc_annotation"]),
        exclude: new Set(),
        limit: 5,
      },
    ),
  ).toEqual([]);
});

function annotationWrite(
  resultType: string,
  name = "annotate_durable",
  id: unknown = "correction",
): ToolHandle {
  return {
    name,
    description: "",
    schema: {} as ToolHandle["schema"],
    mutates: true,
    invoke: async () => ({ kind: "structured", resultType, data: { id } }),
  };
}
function hints(search: KnowledgeMirrorSearch, discoveryTargets = true) {
  const queued: string[] = [];
  const wrap = (tool: ToolHandle) =>
    withRelatedPageHints(
      db,
      {
        search,
        queueReview: async (id) => {
          queued.push(id);
        },
        discoveryTargets,
        log,
      },
      [tool],
    )[0]!;
  return { wrap, queued };
}

it("queues and names the pages an annotation write may correct, except pages already citing it", async () => {
  await savePage();
  const { wrap, queued } = hints(async () => ["flat", "garden"]);
  const hinted = wrap(annotationWrite("annotation.created"));
  const result = await hinted.invoke({}, context);
  expect(result).toMatchObject({
    kind: "structured",
    data: {
      id: "correction",
      pagesToReconcile: [{ id: "flat", ref: "wiki:flat#claim:charge" }],
      pagesToReconcileGuidance: expect.stringContaining("targets"),
    },
  });
  expect((result as { data: { pagesToReconcile: unknown[] } }).data.pagesToReconcile).toHaveLength(
    1,
  );
  expect(queued).toEqual(["flat"]);

  expect(await wrap(annotationWrite("annotation.refused")).invoke({}, context)).not.toHaveProperty(
    "data.pagesToReconcile",
  );
  expect(
    await wrap(annotationWrite("annotation.created", "annotate_durable", 7)).invoke({}, context),
  ).not.toHaveProperty("data.pagesToReconcile");

  await service.save({
    id: "flat",
    kind: "wiki",
    title: "Flat 2",
    markdown: `<claim id="charge" refs="source:brochure annotation:correction">${PAGE_CLAIM}</claim>`,
    expectedRevision: getKnowledgeNode(db, "flat")!.revision,
    inputVersions: {
      "source:brochure": "v1",
      "annotation:correction": service.reference("annotation:correction").revision,
    },
  });
  expect(await hinted.invoke({}, context)).not.toHaveProperty("data.pagesToReconcile");
  expect(queued).toEqual(["flat"]);
});

it("covers revisions, and only suggests discovery targets where a run can set them", async () => {
  await savePage();
  const { wrap, queued } = hints(async () => ["flat"], false);
  const result = await wrap(annotationWrite("annotation.revised", "annotation_revise")).invoke(
    {},
    context,
  );
  expect(result).toMatchObject({ data: { pagesToReconcile: [{ id: "flat" }] } });
  expect(
    (result as { data: { pagesToReconcileGuidance: string } }).data.pagesToReconcileGuidance,
  ).not.toContain("targets");
  expect(queued).toEqual(["flat"]);
});

it("returns the write unchanged when the related-page lookup fails", async () => {
  await savePage();
  const { wrap, queued } = hints(async () => {
    throw new Error("search unavailable");
  });
  expect(await wrap(annotationWrite("annotation.created")).invoke({}, context)).toEqual({
    kind: "structured",
    resultType: "annotation.created",
    data: { id: "correction" },
  });
  expect(queued).toEqual([]);
});

it("brings a related page's review forward through the ordinary review schedule", async () => {
  await savePage();
  await relatedPageReviewQueue(service)("flat");
  expect(getKnowledgeNode(db, "flat")!.metadata).toMatchObject({
    nextReviewAt: 10,
    reviewDecision: "defer",
    reviewReason: "related_knowledge_changed",
  });
  await expect(relatedPageReviewQueue(service)("missing")).resolves.toBeUndefined();
});

it("maps knowledge mirror hits to their nodes and searches only the mirrors", async () => {
  db.prepare(
    "INSERT INTO documents(id,content,content_hash,source_id,external_id) VALUES('mirror-1','x','v1',?,'correction')",
  ).run(KNOWLEDGE_SOURCE_ID);
  db.prepare(
    "INSERT INTO documents(id,content,content_hash,source_id,external_id) VALUES('mail-1','x','v1','gmail','correction-lookalike')",
  ).run();
  const port: SearchPort = {
    search: vi.fn(async (input) => ({
      query: input.query,
      durationMs: 1,
      results: [{ documentId: "mail-1" }, { documentId: "mirror-1" }, { documentId: "mirror-1" }],
    })) as unknown as SearchPort["search"],
  };
  expect(await knowledgeMirrorSearch(db, port)("service charge", 5)).toEqual(["correction"]);
  expect(port.search).toHaveBeenCalledWith(
    { query: "service charge", limit: 5, filters: { documentTypes: ["knowledge"] } },
    undefined,
  );
});
