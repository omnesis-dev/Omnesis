// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  createFetchDocumentTool,
  CitationReads,
  buildBuiltinTools,
  serializeToolResultForModel,
  type ToolContext,
  type ChatBackend,
  type TurnInput,
} from "@omnesis/agent";
import { createLogger, toolResultSchema } from "@omnesis/core";
import { renderConversation } from "../sources/omnesis-chat/render.js";
import { renderedCitationsToInputs } from "../sources/omnesis-chat/upsert.js";
import { upsertConversationCitations } from "../sources/omnesis-chat/citation-writer.js";
import { createDatabase } from "../db.js";
import { createCorpusAuthorization } from "../access/corpus-authorization.js";
import { isKnowledgeDocumentReadable } from "../brain/knowledge/retrieval-fence.js";
import { captureKnowledgeRootContext } from "../brain/knowledge/root-context.js";
import { getKnowledgeNode } from "../brain/knowledge/storage-read.js";
import { saveKnowledgeNode } from "../brain/knowledge/storage.js";
import { CONTEXTUAL_VERIFIER } from "../brain/knowledge/claim-context.js";
import { KNOWLEDGE_PROVIDER_ID, KNOWLEDGE_SOURCE_ID } from "../brain/knowledge/source-meta.js";
import { buildKnowledgeDocumentInput } from "../brain/knowledge/mirror.js";
import { KnowledgeService } from "../brain/knowledge/service.js";
import { buildKnowledgeTools } from "../brain/knowledge/tools.js";
import { directKnowledgeGate } from "../brain/knowledge/writer.js";
import { resolveBrainSettings } from "../brain/config.js";
import { createGatewayLoopReadPort } from "../brain/interactive-loop-port.js";
import { createOpenLoop, updateOpenLoop } from "../brain/storage/open-loops.js";
import { advanceKnowledgeOwnerSync } from "../brain/knowledge/owner-sync.js";
import { convertKnowledgeOwner } from "../brain/knowledge/owner-adapters.js";
import { SyncStatusRegistry } from "../sync-status.js";
import { adaptInteractiveKnowledgeReads } from "./interactive-knowledge-read.js";
import { createGatewayDocumentPort } from "./ports.js";
import { createAgentService, type AgentServiceDeps } from "./agent-lifecycle.js";
import { FsConversationStore } from "./conversation-store.js";
import type { AgentEvent } from "@omnesis/core";
import type Database from "better-sqlite3";

let db: Database.Database;
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "knowledge-reader-"));
  db = createDatabase(join(directory, "test.db"));
  document("evidence", "notes", "The observatory opens Saturday.");
});
afterEach(() => {
  db.close();
  rmSync(directory, { recursive: true, force: true });
});
function document(id: string, source: string, text: string, metadata = {}, externalId = id) {
  db.prepare(
    `INSERT INTO documents(id,provider_id,source_id,external_id,title,content,content_hash,metadata,source_created_at,source_updated_at,ingested_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?, '2026-01-01','2026-01-01','2026-01-01','2026-01-01')`,
  ).run(
    id,
    source === KNOWLEDGE_SOURCE_ID ? KNOWLEDGE_PROVIDER_ID : "test",
    source,
    externalId,
    id,
    text,
    "v1",
    JSON.stringify(metadata),
  );
}
function page(
  id: string,
  markdown = '<claim id="opening" refs="source:evidence">The observatory opens Saturday.</claim>',
  kind: "wiki" | "root" = "wiki",
) {
  const node = saveKnowledgeNode(
    db,
    {
      id,
      kind,
      title: id,
      markdown,
      expectedRevision: 0,
      inputVersions: { "source:evidence": "v1" },
    },
    10,
  ).node;
  const projection = buildKnowledgeDocumentInput(node);
  document(`projection-${id}`, projection.sourceId, projection.content, projection.metadata, id);
}
function link(child: string, parent: string) {
  db.prepare("INSERT INTO knowledge_links VALUES(?,?,'part_of')").run(child, parent);
}
const context: ToolContext = {
  sessionId: "knowledge-reader-session",
  messageId: "knowledge-reader-message",
  abortSignal: new AbortController().signal,
};

it("resolves wiki aliases through real tools and preserves separated pointers in model serialization", async () => {
  page("overview");
  page("detail");
  link("detail", "overview");
  const port = createGatewayDocumentPort(db);
  const single = createFetchDocumentTool({ port });
  expect(single.description).toContain("wiki:<pageId>");
  const result = toolResultSchema.parse(
    await single.invoke({ documentId: "wiki:overview" }, context),
  );
  const serialized = JSON.parse(serializeToolResultForModel(result));
  expect(serialized.document.id).toBe("projection-overview");
  expect(serialized.document.knowledgeContext).toMatchObject({
    revision: 1,
    validity: "current",
    provenance: {
      claims: [
        {
          id: "opening",
          excerpt: "The observatory opens Saturday.",
          truncated: false,
          verification: "unverified",
          verificationScope: null,
          modality: "observation",
          epistemicStatus: "asserted",
          supportLogic: "all",
        },
      ],
      items: [
        {
          claimId: "opening",
          ref: "source:evidence",
          documentId: "evidence",
          relation: "supports",
          title: "evidence",
          sourceCreatedAt: "2026-01-01",
          sourceUpdatedAt: "2026-01-01",
          observedVersion: "v1",
          currentVersion: "v1",
        },
      ],
      truncated: false,
    },
    navigation: {
      items: [{ direction: "incoming", relationship: "part_of", documentId: "projection-detail" }],
      truncated: false,
    },
  });
  const batch = buildBuiltinTools({
    ports: {
      document: port,
      search: { search: async () => ({ query: "", durationMs: 0, results: [] }) },
    },
  }).find((tool) => tool.name === "fetch_many")!;
  expect(batch.description).toContain("wiki:<pageId>");
  const batchResult = toolResultSchema.parse(
    await batch.invoke(
      { documents: [{ documentId: "wiki:overview" }, { documentId: "evidence" }] },
      context,
    ),
  );
  expect(serializeToolResultForModel(batchResult)).toContain('"knowledgeContext"');
  expect(await port.fetch("projection-detail")).not.toBeNull();
  expect(await port.fetch("evidence")).not.toBeNull();
  const plain = createFetchDocumentTool({ port: { fetch: async () => null } });
  expect(plain.description).not.toContain("wiki:<pageId>");
});

it("withholds wiki aliases and mirror IDs while retaining original document reads", async () => {
  page("overview");
  const port = createGatewayDocumentPort(db, undefined, { knowledgeReads: false });
  expect(port.supportsKnowledgeAliases).toBe(false);
  expect(port.knowledgePageRef?.("projection-overview")).toBeNull();
  expect(await port.fetch("wiki:overview")).toBeNull();
  expect(await port.fetch("projection-overview")).toBeNull();
  const original = await port.fetch("evidence");
  expect(original?.document.content).toBe("The observatory opens Saturday.");
  expect(original?.document.knowledgeContext).toBeUndefined();
  // Turning reads off does not delete the stored page.
  expect(await createGatewayDocumentPort(db).fetch("wiki:overview")).not.toBeNull();
});

it("omits root orientation, page directory and named-page notes from fresh answering sessions", async () => {
  page("overview");
  page(
    "orientation",
    '<claim id="opening" refs="source:evidence">Root orientation sentinel.</claim>',
    "root",
  );
  for (const knowledgeReads of [true, false]) {
    let prompt = "";
    let finish!: () => void;
    const ended = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const backend: ChatBackend = {
      name: "recording",
      model: "recording",
      async *runTurn(input: TurnInput): AsyncIterable<AgentEvent> {
        prompt = input.systemPrompt;
        yield {
          type: "agent.message.start",
          payload: { sessionId: input.sessionId, messageId: input.messageId, role: "assistant" },
        };
        yield {
          type: "agent.message.end",
          payload: {
            sessionId: input.sessionId,
            messageId: input.messageId,
            stopReason: "end_turn",
          },
        };
      },
    };
    const deps: AgentServiceDeps = {
      db,
      knowledgeReads,
      searchPipeline: { agentSearchV2Enabled: false } as AgentServiceDeps["searchPipeline"],
      syncStatus: new SyncStatusRegistry(),
      analyticsDb: { getCatalog: async () => [] } as unknown as AgentServiceDeps["analyticsDb"],
      writeGate: {
        recordCognitionSpend: async () => {},
      } as unknown as AgentServiceDeps["writeGate"],
      wsServer: {
        broadcast: (event: AgentEvent) => {
          if (event.type === "agent.message.end") finish();
        },
      } as unknown as AgentServiceDeps["wsServer"],
      conversationStore: new FsConversationStore(join(directory, knowledgeReads ? "on" : "off")),
      isApnsConfigured: () => false,
      getWatchAuthoring: () => null,
      watchFirings: () => [],
      watchFiringCount: () => 0,
      getOmnesisChatRuntime: () => undefined,
    };
    const service = createAgentService(deps, () => backend, { depthCap: 2, concurrencyCap: 2 });
    try {
      const { sessionId } = await service.createSession("device:test");
      service.sendMessage("device:test", sessionId, "What does overview say?");
      await ended;
      expect(prompt.includes("Root orientation sentinel")).toBe(knowledgeReads);
      expect(prompt.includes("wiki:overview")).toBe(knowledgeReads);
    } finally {
      await service.dispose();
    }
  }
});

it("refuses missing, malformed, obsolete and privacy-hidden aliases just like document IDs", async () => {
  page("overview");
  const port = createGatewayDocumentPort(db);
  for (const id of ["wiki:absent", "wiki:overview#claim:opening", "wiki:../overview"])
    expect(await port.fetch(id)).toBeNull();
  db.prepare("UPDATE knowledge_nodes SET revision=revision+1 WHERE id='overview'").run();
  expect(await port.fetch("wiki:overview")).toBeNull();
  expect(await port.fetch("projection-overview")).toBeNull();
  db.prepare("UPDATE knowledge_nodes SET revision=revision-1 WHERE id='overview'").run();
  db.prepare("UPDATE knowledge_source_revisions SET deleted=1 WHERE document_id='evidence'").run();
  expect(await port.fetch("wiki:overview")).toBeNull();
  expect(await port.fetch("projection-overview")).toBeNull();
});

it("does not expose withdrawn, stale-projection or missing navigation targets", async () => {
  page("overview");
  page("hidden");
  page("outdated");
  page("missing");
  link("hidden", "overview");
  link("outdated", "overview");
  link("missing", "overview");
  db.prepare(
    "UPDATE knowledge_nodes SET fields_json='{\"withdrawn\":true}' WHERE id='hidden'",
  ).run();
  db.prepare("UPDATE knowledge_nodes SET revision=2 WHERE id='outdated'").run();
  db.prepare("DELETE FROM documents WHERE id='projection-missing'").run();
  const result = await createGatewayDocumentPort(db).fetch("wiki:overview");
  expect(result).not.toBeNull();
  expect(JSON.stringify(result)).not.toContain("projection-hidden");
  expect(JSON.stringify(result)).not.toContain("projection-outdated");
  expect(JSON.stringify(result)).not.toContain("projection-missing");
});

it("keeps corpus authorization and read-size limits effective for aliases", async () => {
  page("overview");
  const exact = buildKnowledgeDocumentInput(getKnowledgeNode(db, "overview")!);
  db.prepare(
    "UPDATE documents SET title=?,content_hash=?,source_created_at=? WHERE id='projection-overview'",
  ).run(exact.title, exact.contentHash, exact.sourceCreatedAt);
  db.exec("UPDATE documents SET content_hash='v2' WHERE id='evidence'");
  expect(await createGatewayDocumentPort(db).fetch("wiki:overview")).not.toBeNull();
  const authorization = createCorpusAuthorization(
    {
      principalId: "reader",
      grantId: "grant",
      grantRevision: 1,
      credentialId: "credential",
      accessTokenId: "token",
    },
    [
      {
        capability: "direct",
        sourceMode: "allowlist",
        sourceIds: ["notes"],
        releaseMode: null,
        policyFamilyId: null,
        policyRevision: null,
        privacyPolicy: null,
      },
    ],
    "direct",
  )!;
  const restricted = createGatewayDocumentPort(db, undefined, undefined, authorization);
  expect(await restricted.fetch("wiki:overview")).toBeNull();
  expect(await restricted.fetch("projection-overview")).toBeNull();
  await expect(
    createGatewayDocumentPort(db, undefined, { maxStoredDocumentBytes: 1 }).fetch("wiki:overview"),
  ).rejects.toThrow("read-size limit");
});

it("bounds inspected pointers and deduplicates claim excerpts independently from references", async () => {
  const refs = ["source:evidence"];
  for (let i = 0; i < 35; i++) {
    document(`source${i}`, "notes", "The observatory opens Saturday.");
    refs.push(`source:source${i}`);
  }
  const inputVersions = Object.fromEntries(refs.map((ref) => [ref, "v1"]));
  const node = saveKnowledgeNode(
    db,
    {
      id: "overview",
      kind: "wiki",
      title: "Overview",
      markdown: `<claim id="opening" refs="${refs.join(" ")}">The observatory opens Saturday.</claim>`,
      expectedRevision: 0,
      inputVersions,
    },
    10,
  ).node;
  const projection = buildKnowledgeDocumentInput(node);
  document(
    "projection-overview",
    projection.sourceId,
    projection.content,
    projection.metadata,
    node.id,
  );
  for (let i = 0; i < 18; i++) {
    page(`detail${i}`);
    link(`detail${i}`, "overview");
  }
  const result = await createGatewayDocumentPort(db).fetch("wiki:overview");
  const body = result?.document as {
    knowledgeContext: {
      provenance: { claims: unknown[]; items: unknown[]; truncated: boolean };
      navigation: { items: unknown[]; truncated: boolean };
    };
  };
  expect(body.knowledgeContext.provenance.claims).toHaveLength(1);
  expect(body.knowledgeContext.provenance.items).toHaveLength(32);
  expect(body.knowledgeContext.provenance.truncated).toBe(true);
  expect(body.knowledgeContext.navigation.items).toHaveLength(16);
  expect(body.knowledgeContext.navigation.truncated).toBe(true);
});

it("marks provenance stale when its observed source version changed even though the source remains readable", async () => {
  page("overview");
  db.prepare(
    "UPDATE documents SET content_hash='v2',content='The observatory opens Sunday.' WHERE id='evidence'",
  ).run();
  // The ordinary mirror worker reprojects the dynamically stale page status.
  db.prepare(
    "UPDATE documents SET metadata=json_set(metadata,'$.extra.knowledgeValidity','stale') WHERE id='projection-overview'",
  ).run();
  const result = await createGatewayDocumentPort(db).fetch("wiki:overview");
  expect(result?.document).toMatchObject({
    knowledgeContext: {
      validity: "stale",
      provenance: {
        items: [
          expect.objectContaining({
            documentId: "evidence",
            stale: true,
            observedVersion: "v1",
            currentVersion: "v2:knowledge:1",
          }),
        ],
      },
    },
  });
});

function projectedLoop(id: string, docs = ["evidence"], reconcile = false) {
  createOpenLoop(
    db,
    {
      id,
      createdByRun: "test-run",
      title: "Prepare observatory visit",
      description: "The observatory opens Saturday.",
      confidence: 0.8,
      importance: 0.6,
      docs,
    },
    10,
  );
  if (reconcile) advanceKnowledgeOwnerSync(db, 10, 11, id);
  const node = convertKnowledgeOwner(db, "loop", id, 11).node;
  const projection = buildKnowledgeDocumentInput(node);
  document(`projection-${id}`, projection.sourceId, projection.content, projection.metadata, id);
}

it("preserves bounded joint provenance through loop tool protocol and model serialization", async () => {
  const docs = ["evidence"];
  for (let i = 0; i < 35; i++) {
    const id = `visit-source-${i}`;
    document(id, "notes", "The observatory opens Saturday.");
    docs.push(id);
  }
  projectedLoop("visit", docs);
  const tool = buildBuiltinTools({
    experimental: true,
    ports: {
      loopRead: createGatewayLoopReadPort(db),
      search: { search: async () => ({ query: "", durationMs: 0, results: [] }) },
      document: createGatewayDocumentPort(db),
    },
  }).find((candidate) => candidate.name === "fetch_loop")!;
  const result = toolResultSchema.parse(await tool.invoke({ loopId: "visit" }, context));
  const serialized = JSON.parse(serializeToolResultForModel(result));
  const provenance = serialized.loop.knowledgeContext.provenance;
  expect(provenance.items).toHaveLength(32);
  expect(provenance.claims).toHaveLength(1);
  expect(provenance.truncated).toBe(true);
  expect(provenance.items[0]).toMatchObject({
    claimId: "legacy",
    documentId: "evidence",
    title: "evidence",
    observedVersion: "v1",
    currentVersion: "v1",
    sourceCreatedAt: "2026-01-01",
  });
  expect(serialized.loop.knowledgeContext.guidance).toContain(
    "References sharing a claimId support that claim together under its supportLogic",
  );
});

it("omits loop provenance when its projection is missing or obsolete and refuses erased owners", async () => {
  projectedLoop("visit");
  const port = createGatewayLoopReadPort(db);
  expect((await port.fetch("visit"))?.knowledgeContext).toBeDefined();
  db.prepare(
    "UPDATE documents SET metadata=json_set(metadata,'$.extra.knowledgeRevision',0) WHERE id='projection-visit'",
  ).run();
  expect((await port.fetch("visit"))?.knowledgeContext).toBeUndefined();
  db.prepare("DELETE FROM documents WHERE id='projection-visit'").run();
  expect((await port.fetch("visit"))?.knowledgeContext).toBeUndefined();
  // A deleted source leaves the loop readable for review; erasing the owner hides it.
  db.prepare("UPDATE knowledge_source_revisions SET deleted=1 WHERE document_id='evidence'").run();
  expect(await port.fetch("visit")).not.toBeNull();
  db.prepare(
    "INSERT INTO knowledge_cascade_jobs(kind,target_kind,target_id,revision,created_at) VALUES('purge','node','visit','deleted',20)",
  ).run();
  expect(await port.fetch("visit")).toBeNull();
});

it("retains current and observed source versions in a readable stale loop projection", async () => {
  projectedLoop("visit");
  db.prepare("UPDATE documents SET content_hash='v2' WHERE id='evidence'").run();
  db.prepare(
    "UPDATE documents SET metadata=json_set(metadata,'$.extra.knowledgeValidity','stale') WHERE id='projection-visit'",
  ).run();
  expect((await createGatewayLoopReadPort(db).fetch("visit"))?.knowledgeContext).toMatchObject({
    validity: "stale",
    provenance: {
      items: [
        expect.objectContaining({
          documentId: "evidence",
          observedVersion: "v1",
          currentVersion: "v2:knowledge:1",
          stale: true,
        }),
      ],
    },
  });
});

it.each(["done", "dismissed"] as const)(
  "keeps terminal %s owners behind the same erasure fence",
  async (state) => {
    projectedLoop("visit");
    updateOpenLoop(db, "visit", { state }, 12);
    const port = createGatewayLoopReadPort(db);
    expect(await port.fetch("visit")).toMatchObject({ state });
    db.prepare(
      "INSERT INTO knowledge_cascade_jobs(kind,target_kind,target_id,revision,created_at) VALUES('purge','node','visit','deleted',20)",
    ).run();
    expect(await port.fetch("visit")).toBeNull();
  },
);

it("exposes bounded semantic claim states without promoting literal proof to contextual proof", async () => {
  page("overview");
  db.prepare(
    "UPDATE knowledge_claims SET verification='verified',verifier='entailment-verifier',modality='reported',epistemic_status='disputed',attribution=?,valid_from=10,valid_until=20 WHERE node_id='overview'",
  ).run("A".repeat(500));
  const port = createGatewayDocumentPort(db);
  const read = async () =>
    (await port.fetch("wiki:overview"))?.document as {
      knowledgeContext: { provenance: { claims: unknown[] } };
    };
  expect((await read()).knowledgeContext.provenance.claims).toEqual([
    expect.objectContaining({
      verification: "verified",
      verificationScope: "claim_text",
      modality: "reported",
      epistemicStatus: "disputed",
      supportLogic: "all",
      attribution: "A".repeat(300),
      validFrom: 10,
      validUntil: 20,
    }),
  ]);
  db.prepare(
    "UPDATE knowledge_claims SET verifier='contextual-entailment-verifier-v1' WHERE node_id='overview'",
  ).run();
  expect((await read()).knowledgeContext.provenance.claims[0]).toMatchObject({
    verificationScope: "claim_text",
  });
  db.prepare("UPDATE knowledge_claims SET verifier=? WHERE node_id='overview'").run(
    CONTEXTUAL_VERIFIER,
  );
  expect((await read()).knowledgeContext.provenance.claims[0]).toMatchObject({
    verificationScope: "page_context",
  });
});

it("retains unsupported reference-free claim states instead of silently dropping them", async () => {
  const node = saveKnowledgeNode(
    db,
    {
      id: "question",
      kind: "wiki",
      title: "Planning question",
      markdown: '<claim id="unknown" refs="">When will the observatory reopen?</claim>',
      expectedRevision: 0,
      claims: [{ id: "unknown", modality: "question", epistemicStatus: "unsupported" }],
      inputVersions: {},
    },
    10,
  ).node;
  const projection = buildKnowledgeDocumentInput(node);
  document(
    "projection-question",
    projection.sourceId,
    projection.content,
    projection.metadata,
    node.id,
  );
  const result = await createGatewayDocumentPort(db).fetch("wiki:question");
  expect(result?.document).toMatchObject({
    knowledgeContext: {
      provenance: {
        claims: [
          expect.objectContaining({
            id: "unknown",
            verification: "unverified",
            verificationScope: null,
            modality: "question",
            epistemicStatus: "unsupported",
          }),
        ],
        items: [],
      },
    },
  });
});

it("exports complete qualified current support without promoting unverified ancestors", async () => {
  page(
    "qualified",
    '# Instrument calibration\n<claim id="parent" refs="source:evidence">The observatory opens Saturday. <claim id="child" refs="source:evidence">It opens Saturday.</claim></claim>',
  );
  db.prepare(
    "UPDATE knowledge_claims SET verification='verified',verifier=? WHERE node_id='qualified'",
  ).run(CONTEXTUAL_VERIFIER);
  const port = createGatewayDocumentPort(db);
  const first = await port.fetch("wiki:qualified");
  const context = (
    first!.document as {
      knowledgeContext: { guidance: string; verifiedSupport: Array<{ ref: string; text: string }> };
    }
  ).knowledgeContext;
  expect(context.guidance).toContain("This is a summary Omnesis wrote, not a source.");
  expect(context.guidance).toContain(
    "provenance.items gives the documentId (with matching claimId) each rests on; read those with fetch_many",
  );
  expect(context.guidance).toContain("verifiedSupport lists statements individually checked");
  expect(context.guidance).toContain("other prose is orientation");
  expect(context.guidance).toContain("Navigation links are for finding related pages, not support");
  expect(context.guidance).toContain("check later evidence when currentness matters");
  expect(context.guidance).toContain("when a record was created or changed");
  expect(context.guidance).toContain("when it was written or maintained");
  expect(context.guidance).toContain("not that every statement still describes today");
  expect(context.guidance).not.toContain("Source dates describe source events");
  const child = context.verifiedSupport.find((item) => item.ref.endsWith("#claim:child"));
  expect(JSON.parse(JSON.parse(child!.text).statement)).toMatchObject({
    claim: "It opens Saturday.",
    context: { pageTitle: "qualified", sectionPaths: [["Instrument calibration"]] },
  });
  expect(JSON.parse(JSON.parse(child!.text).statement).context.enclosingClaims).toHaveLength(1);
  db.prepare(
    "UPDATE knowledge_claims SET verification='unverified' WHERE node_id='qualified' AND id='parent'",
  ).run();
  const second = await port.fetch("wiki:qualified");
  expect(second!.readSnapshot?.version).not.toBe(first!.readSnapshot?.version);
  expect(
    (second!.document as { knowledgeContext: { verifiedSupport: unknown[] } }).knowledgeContext
      .verifiedSupport,
  ).toEqual([]);
});

it.each([
  ["wiki", "overview"],
  ["wiki", "wiki:overview"],
  ["root", "overview"],
  ["root", "wiki:overview"],
] as const)("adapts %s read %s through the real projection and privacy fence", async (kind, id) => {
  page("overview", undefined, kind);
  const documentPort = createGatewayDocumentPort(db);
  const reads = new CitationReads();
  const tools = buildBuiltinTools({
    citationReads: reads,
    ports: {
      document: documentPort,
      search: {
        search: async () => {
          throw new Error("Search is not used");
        },
      },
    },
  });
  const service = new KnowledgeService({
    db,
    writeGate: directKnowledgeGate(db),
    getSettings: () => resolveBrainSettings(),
    getEntailmentVerifier: () => Promise.resolve(null),
    clock: () => 100,
    log: createLogger("knowledge-read-test"),
  });
  const canonical = buildKnowledgeTools(service, { runId: "interactive-read-test" }).filter(
    (tool) => tool.name === "knowledge_fetch",
  );
  const [tool] = adaptInteractiveKnowledgeReads(
    canonical,
    tools,
    documentPort.supportsKnowledgeAliases === true,
  );
  const result = await tool!.invoke({ id }, context);
  expect(result).toMatchObject({
    kind: "document.batch",
    items: [{ kind: "document", ref: { documentId: "projection-overview" } }],
  });
  expect(reads.snapshot(context).map((row) => row.documentId)).toEqual(["projection-overview"]);
  if (result.kind !== "document.batch" || result.items[0]?.kind !== "document")
    throw new Error("Expected an authorized projection read");
  expect(result.items[0].document).toMatchObject({
    knowledgeContext: { verifiedSupport: [] },
  });
  const annotate = tools.find((tool) => tool.name === "annotate_many")!;
  expect(
    await annotate.invoke(
      {
        annotations: [
          { documentId: "projection-overview", quote: "The observatory opens Saturday." },
        ],
      },
      context,
    ),
  ).toMatchObject({
    kind: "annotate.batch",
    items: [{ kind: "annotate.recorded", documentId: "projection-overview" }],
  });

  expect(await tool!.invoke({ id: "evidence" }, context)).toMatchObject({
    kind: "error",
    code: "knowledge_read_unavailable",
  });
  db.prepare("UPDATE knowledge_source_revisions SET deleted=1 WHERE document_id='evidence'").run();
  const nextContext = { ...context, messageId: "after-removal" };
  expect(await tool!.invoke({ id }, nextContext)).toMatchObject({
    kind: "error",
    code: "knowledge_read_unavailable",
  });
  expect(reads.snapshot(nextContext)).toEqual([]);
});

it("binds full-page authority independently of a proof-preserving maintenance projection", async () => {
  page("stable");
  db.prepare("UPDATE documents SET title='stable' WHERE id='projection-stable'").run();
  const port = createGatewayDocumentPort(db);
  const before = await port.fetch("wiki:stable");
  const authority = before!.readSnapshot!.fullPageAuthorityVersion;
  expect(authority).toBeTypeOf("string");
  const saved = saveKnowledgeNode(
    db,
    {
      id: "stable",
      kind: "wiki",
      title: "stable",
      expectedRevision: 1,
      markdown:
        '<claim id="opening" refs="source:evidence">The observatory opens Saturday.</claim>',
      inputVersions: { "source:evidence": "v1" },
    },
    20,
  ).node;
  const projection = buildKnowledgeDocumentInput(saved);
  db.prepare(
    "UPDATE documents SET content=?,content_hash=?,metadata=?,updated_at=? WHERE id=?",
  ).run(
    projection.content,
    projection.contentHash,
    JSON.stringify(projection.metadata),
    "2026-01-02",
    "projection-stable",
  );
  const after = await port.fetch("wiki:stable");
  expect(after!.readSnapshot!.version).not.toBe(before!.readSnapshot!.version);
  expect(after!.readSnapshot!.fullPageAuthorityVersion).toBe(authority);
});

it.each(["fact", "proof", "relation", "source", "privacy", "projection"])(
  "does not preserve full-page authority after a %s change",
  async (change) => {
    page("guarded");
    db.prepare("UPDATE documents SET title='guarded' WHERE id='projection-guarded'").run();
    const port = createGatewayDocumentPort(db);
    const before = await port.fetch("wiki:guarded");
    expect(before!.readSnapshot!.fullPageAuthorityVersion).toBeTypeOf("string");
    if (change === "projection")
      db.exec(
        "UPDATE documents SET content=content || ' Unobserved assertion.' WHERE id='projection-guarded'",
      );
    if (change === "fact")
      db.exec(
        "UPDATE knowledge_nodes SET plain_text='A different observation.',meaning_revision=meaning_revision+1 WHERE id='guarded'",
      );
    if (change === "proof")
      db.exec(
        "UPDATE knowledge_claims SET verification='verified',verifier='different-policy' WHERE node_id='guarded'",
      );
    if (change === "relation")
      db.exec("UPDATE knowledge_dependencies SET relation='context' WHERE node_id='guarded'");
    if (change === "source")
      db.exec(
        "UPDATE documents SET content='Changed source',content_hash='new' WHERE id='evidence'",
      );
    if (change === "privacy") db.exec("DELETE FROM documents WHERE id='evidence'");
    const after = await port.fetch("wiki:guarded");
    expect(after?.readSnapshot?.fullPageAuthorityVersion).not.toBe(
      before!.readSnapshot!.fullPageAuthorityVersion,
    );
  },
);

it("retains only independent current claims in a readable stale page and root", async () => {
  document("changing", "notes", "The kiln inspection is planned for Monday.");
  const node = saveKnowledgeNode(
    db,
    {
      id: "partial-root",
      kind: "root",
      title: "Workshop overview",
      expectedRevision: 0,
      markdown:
        '<claim id="steady" refs="source:evidence">The observatory opens Saturday.</claim>\n<claim id="changing" refs="source:changing">The kiln inspection is planned for Monday.</claim>',
      inputVersions: { "source:evidence": "v1", "source:changing": "v1" },
    },
    10,
  ).node;
  db.prepare("UPDATE knowledge_claims SET verification='verified',verifier=? WHERE node_id=?").run(
    CONTEXTUAL_VERIFIER,
    node.id,
  );
  const mirror = buildKnowledgeDocumentInput(node);
  document("partial-mirror", mirror.sourceId, mirror.content, mirror.metadata, node.id);
  db.prepare(
    "UPDATE documents SET title=?,content_hash=?,source_created_at=? WHERE id='partial-mirror'",
  ).run(mirror.title, mirror.contentHash, mirror.sourceCreatedAt);
  const port = createGatewayDocumentPort(db);
  const before = await port.fetch("wiki:partial-root");
  db.prepare(
    "UPDATE documents SET content_hash='v2',content='The kiln inspection was cancelled.' WHERE id='changing'",
  ).run();
  // Search/index exposure stays strict while the direct read uses an exact,
  // source-owned effective projection at the same physical revision.
  expect(isKnowledgeDocumentReadable(db, "partial-mirror")).toBe(false);
  const lagged = await port.fetch("wiki:partial-root");
  expect((lagged!.document as { content: string }).content).toContain("revision 1; stale.");
  expect(lagged!.readSnapshot!.fullPageAuthorityVersion).toBeUndefined();
  expect(await port.fetch("partial-mirror")).toEqual(lagged);
  const stale = buildKnowledgeDocumentInput(getKnowledgeNode(db, node.id)!);
  db.prepare(
    "UPDATE documents SET title=?,content=?,content_hash=?,metadata=? WHERE id='partial-mirror'",
  ).run(stale.title, stale.content, stale.contentHash, JSON.stringify(stale.metadata));
  const after = await port.fetch("wiki:partial-root");
  const overlay = (
    after!.document as {
      knowledgeContext: {
        validity: string;
        verifiedSupport: Array<{ ref: string }>;
        supportCoverage: { partial: boolean };
      };
    }
  ).knowledgeContext;
  expect(overlay.validity).toBe("stale");
  expect(overlay.verifiedSupport.map((x) => x.ref)).toEqual(["wiki:partial-root#claim:steady"]);
  expect(overlay.supportCoverage.partial).toBe(true);
  expect(after!.readSnapshot!.version).not.toBe(before!.readSnapshot!.version);
  expect(after!.readSnapshot!.fullPageAuthorityVersion).toBeUndefined();
  const captured = captureKnowledgeRootContext(db);
  expect(captured.support).toHaveLength(1);
  expect(captured.support[0]!.text).toContain("observatory");
  // Deleting the sibling's source is a change like an edit: the page stays
  // readable and the independent claim keeps its support.
  db.prepare("DELETE FROM documents WHERE id='changing'").run();
  expect(await port.fetch("wiki:partial-root")).not.toBeNull();
  expect(captureKnowledgeRootContext(db).support.map((item) => item.text)).toEqual([
    expect.stringContaining("observatory"),
  ]);
});

it("bounds partial qualified support and never upgrades an obsolete contextual policy", async () => {
  page(
    "bounded",
    Array.from(
      { length: 17 },
      (_, i) => `<claim id="c${i}" refs="source:evidence">The observatory opens Saturday.</claim>`,
    ).join("\n"),
  );
  db.prepare(
    "UPDATE knowledge_claims SET verification='verified',verifier=? WHERE node_id='bounded'",
  ).run(CONTEXTUAL_VERIFIER);
  const port = createGatewayDocumentPort(db);
  const first = await port.fetch("wiki:bounded");
  const data = (
    first!.document as {
      knowledgeContext: { verifiedSupport: unknown[]; supportCoverage: { truncated: boolean } };
    }
  ).knowledgeContext;
  expect(data.verifiedSupport).toHaveLength(16);
  expect(data.supportCoverage.truncated).toBe(true);
  db.prepare(
    "UPDATE knowledge_claims SET verifier='contextual-entailment-verifier-v1' WHERE node_id='bounded'",
  ).run();
  const next = await port.fetch("wiki:bounded");
  expect(
    (next!.document as { knowledgeContext: { verifiedSupport: unknown[] } }).knowledgeContext
      .verifiedSupport,
  ).toEqual([]);
  expect(next!.readSnapshot!.version).not.toBe(first!.readSnapshot!.version);
});

it.each(["body", "title", "hash", "metadata", "created", "revision", "withdrawn"])(
  "refuses %s corruption or unavailability rather than repairing a mirror",
  async (change) => {
    page("fenced");
    const node = getKnowledgeNode(db, "fenced")!;
    const projection = buildKnowledgeDocumentInput(node);
    db.prepare(
      "UPDATE documents SET title=?,content_hash=?,source_created_at=? WHERE id='projection-fenced'",
    ).run(projection.title, projection.contentHash, projection.sourceCreatedAt);
    db.exec("UPDATE documents SET content_hash='v2' WHERE id='evidence'");
    if (change === "body")
      db.exec("UPDATE documents SET content='Corrupt prose' WHERE id='projection-fenced'");
    if (change === "title")
      db.exec("UPDATE documents SET title='Wrong title' WHERE id='projection-fenced'");
    if (change === "hash")
      db.exec("UPDATE documents SET content_hash='wrong' WHERE id='projection-fenced'");
    if (change === "metadata")
      db.exec(
        "UPDATE documents SET metadata=json_set(metadata,'$.extra.unexpected',1) WHERE id='projection-fenced'",
      );
    if (change === "created")
      db.exec("UPDATE documents SET source_created_at='2030-01-01' WHERE id='projection-fenced'");
    if (change === "revision")
      db.exec(
        "UPDATE documents SET metadata=json_set(metadata,'$.extra.knowledgeRevision',2) WHERE id='projection-fenced'",
      );
    if (change === "withdrawn")
      db.exec(
        "UPDATE knowledge_nodes SET fields_json=json_set(fields_json,'$.withdrawn',1) WHERE id='fenced'",
      );
    expect(await createGatewayDocumentPort(db).fetch("projection-fenced")).toBeNull();
    expect(await createGatewayDocumentPort(db).fetch("wiki:fenced")).toBeNull();
  },
);

it("uses exact emitted offsets without upgrading earlier reads across freshness transitions", async () => {
  page("offsets");
  const initial = buildKnowledgeDocumentInput(getKnowledgeNode(db, "offsets")!);
  db.prepare(
    "UPDATE documents SET title=?,content_hash=?,source_created_at=? WHERE id='projection-offsets'",
  ).run(initial.title, initial.contentHash, initial.sourceCreatedAt);
  const port = createGatewayDocumentPort(db);
  const reads = new CitationReads();
  const before = (await port.fetch("wiki:offsets"))!;
  reads.record(context, before, true);
  db.exec("UPDATE knowledge_nodes SET validity='stale' WHERE id='offsets'");
  const stale = (await port.fetch("wiki:offsets"))!;
  expect(reads.resolve(context, stale)).toBeNull();
  const body = (stale.document as { content: string }).content;
  const quote = "The observatory opens Saturday.";
  const offset = body.indexOf(quote);
  const tool = createFetchDocumentTool({ port, citationReads: reads });
  const part = await tool.invoke(
    { documentId: "wiki:offsets", contentOffset: offset, maxContentChars: quote.length },
    context,
  );
  expect(JSON.stringify(part)).toContain(quote);
  expect(reads.resolve(context, stale, quote)).toEqual({ quote });
  expect(reads.resolve(context, stale)).toBeNull();
  expect(reads.snapshot(context)[0]!.fullPageAuthorityVersion).toBeUndefined();
  // A stored stale mirror may subsequently be current at the same revision.
  const staleProjection = buildKnowledgeDocumentInput(getKnowledgeNode(db, "offsets")!);
  db.prepare(
    "UPDATE documents SET content=?,content_hash=?,metadata=? WHERE id='projection-offsets'",
  ).run(
    staleProjection.content,
    staleProjection.contentHash,
    JSON.stringify(staleProjection.metadata),
  );
  db.exec("UPDATE knowledge_nodes SET validity='current' WHERE id='offsets'");
  const storedBytes = (
    db
      .prepare(
        "SELECT length(CAST(content AS BLOB))+length(CAST(metadata AS BLOB))+length(CAST(title AS BLOB)) size FROM documents WHERE id='projection-offsets'",
      )
      .get() as { size: number }
  ).size;
  await expect(
    createGatewayDocumentPort(db, undefined, { maxStoredDocumentBytes: storedBytes }).fetch(
      "wiki:offsets",
    ),
  ).rejects.toThrow("read-size limit");
  const restored = (await port.fetch("projection-offsets"))!;
  expect(restored.readSnapshot!.fullPageAuthorityVersion).toBeDefined();
  expect(reads.resolve(context, restored, quote)).toBeNull();
  reads.record(context, restored, false, { offset: 0, length: 5 });
  expect(reads.snapshot(context)[0]!.fullPageAuthorityVersion).toBeUndefined();
  reads.record(context, restored, true);
  expect(reads.resolve(context, restored)).toEqual({});
});

it("persists an authorized alias citation as a canonical conversation edge", async () => {
  page("observatory-guide");
  document("conversation", "omnesis-chat", "Observatory discussion");
  // A background-run port: a citation needs a read of the cited page first.
  const port = createGatewayDocumentPort(db, undefined, { requireCitationRead: true });
  const tools = buildBuiltinTools({
    ports: {
      document: port,
      search: {
        search: async () => {
          throw new Error("Search is not used");
        },
      },
    },
  });
  const fetch = tools.find((t) => t.name === "fetch_many")!;
  const annotate = tools.find((t) => t.name === "annotate_many")!;
  const args = { annotations: [{ documentId: "wiki:observatory-guide" }] };
  expect(await annotate.invoke(args, context)).toMatchObject({
    kind: "annotate.batch",
    items: [{ kind: "error", code: "citation_read_required" }],
  });
  await fetch.invoke({ documents: [{ documentId: "wiki:observatory-guide" }] }, context);
  const result = await annotate.invoke(args, context);
  expect(result).toMatchObject({
    kind: "annotate.batch",
    items: [
      {
        kind: "annotate.recorded",
        documentId: "projection-observatory-guide",
        ref: { documentId: "projection-observatory-guide" },
      },
    ],
  });
  const rendered = renderConversation({
    id: "session",
    callerId: "test",
    model: "scripted",
    backend: "replay",
    createdAt: "2027-02-01T00:00:00Z",
    updatedAt: "2027-02-01T00:00:00Z",
    title: "Observatory",
    pinned: false,
    messages: [{ role: "user", parts: [{ kind: "tool_result", toolCallId: "citation", result }] }],
  });
  expect(
    upsertConversationCitations(db, "conversation", renderedCitationsToInputs(rendered.citations)),
  ).toEqual({ removed: 0, inserted: 1 });
  expect(
    db.prepare("SELECT target_doc_id FROM document_links WHERE source_doc_id='conversation'").all(),
  ).toEqual([{ target_doc_id: "projection-observatory-guide" }]);
  db.prepare("UPDATE knowledge_source_revisions SET deleted=1 WHERE document_id='evidence'").run();
  expect(await annotate.invoke(args, context)).toMatchObject({
    kind: "annotate.batch",
    items: [{ kind: "error", code: "document_not_found" }],
  });
});

it("exposes qualified loop assertions through the real fetch tool without promoting tracking state", async () => {
  projectedLoop("qualified-loop", ["evidence"], true);
  db.prepare(
    "UPDATE knowledge_dependencies SET relation='supports' WHERE node_id='qualified-loop'",
  ).run();
  db.prepare(
    "UPDATE knowledge_claims SET verification='verified',verifier=?,modality='observation',attribution='Observatory notice',valid_from=10,valid_until=20 WHERE node_id=?",
  ).run(CONTEXTUAL_VERIFIER, "qualified-loop");
  const tool = buildBuiltinTools({
    experimental: true,
    ports: {
      loopRead: createGatewayLoopReadPort(db),
      search: { search: async () => ({ query: "", durationMs: 0, results: [] }) },
      document: createGatewayDocumentPort(db),
    },
  }).find((entry) => entry.name === "fetch_loop")!;
  const result = toolResultSchema.parse(await tool.invoke({ loopId: "qualified-loop" }, context));
  const serialized = JSON.parse(serializeToolResultForModel(result));
  const support = serialized.loop.knowledgeContext.verifiedSupport;
  expect(support).toHaveLength(1);
  expect(support[0].ref).toBe("loop:qualified-loop#claim:legacy");
  expect(JSON.parse(support[0].text)).toEqual({
    statement: "The observatory opens Saturday.",
    semantics: {
      epistemicStatus: "asserted",
      modality: "observation",
      attribution: "Observatory notice",
      validFrom: 10,
      validUntil: 20,
    },
  });
  expect(JSON.parse(support[0].interpretationContext)).toMatchObject({
    pageTitle: "Prepare observatory visit",
    outcome: { text: "The observatory opens Saturday." },
  });
  expect(support[0].text).not.toContain('"state":"open"');
  expect(support[0].text).not.toContain("Prepare observatory visit");
  expect(serialized.loop.state).toBe("open");
});

it.each([
  "literal",
  "unverified",
  "inferred",
  "changed-source",
  "deleted-source",
  "missing-owner",
  "withdrawn",
])("excludes %s loop proof from qualified support", async (mode) => {
  projectedLoop("excluded-loop", ["evidence"], true);
  db.prepare(
    "UPDATE knowledge_dependencies SET relation='supports' WHERE node_id='excluded-loop'",
  ).run();
  db.prepare("UPDATE knowledge_claims SET verification='verified',verifier=? WHERE node_id=?").run(
    CONTEXTUAL_VERIFIER,
    "excluded-loop",
  );
  expect(
    (await createGatewayLoopReadPort(db).fetch("excluded-loop"))?.knowledgeContext?.verifiedSupport,
  ).toHaveLength(1);
  if (mode === "literal")
    db.prepare("UPDATE knowledge_claims SET verifier='entailment-verifier'").run();
  if (mode === "unverified")
    db.prepare("UPDATE knowledge_claims SET verification='unverified'").run();
  if (mode === "inferred")
    db.prepare("UPDATE knowledge_claims SET epistemic_status='inferred'").run();
  if (mode === "changed-source")
    db.prepare("UPDATE documents SET content_hash='v2' WHERE id='evidence'").run();
  if (mode === "deleted-source")
    db.prepare(
      "UPDATE knowledge_source_revisions SET deleted=1 WHERE document_id='evidence'",
    ).run();
  if (mode === "missing-owner") db.prepare("DELETE FROM open_loops WHERE id='excluded-loop'").run();
  if (mode === "withdrawn")
    db.prepare(
      "UPDATE knowledge_nodes SET fields_json=json_set(fields_json,'$.withdrawn',json('true')) WHERE id='excluded-loop'",
    ).run();
  const result = await createGatewayLoopReadPort(db).fetch("excluded-loop");
  expect(result?.knowledgeContext?.verifiedSupport ?? []).toEqual([]);
});

// A puppet of the interactive agent answering "when does the observatory
// open?": it reads the maintained page, then follows the claim it uses to the
// source document named in what the model actually sees, and answers from that.
it("lets an interactive wiki read be followed to the source behind a claim", async () => {
  page("overview");
  const documentPort = createGatewayDocumentPort(db);
  const reads = new CitationReads();
  const tools = buildBuiltinTools({
    citationReads: reads,
    ports: {
      document: documentPort,
      search: {
        search: async () => {
          throw new Error("Search is not used");
        },
      },
    },
  });
  const service = new KnowledgeService({
    db,
    writeGate: directKnowledgeGate(db),
    getSettings: () => resolveBrainSettings(),
    getEntailmentVerifier: () => Promise.resolve(null),
    clock: () => 100,
    log: createLogger("knowledge-trail-test"),
  });
  const [knowledgeFetch] = adaptInteractiveKnowledgeReads(
    buildKnowledgeTools(service, { runId: "interactive-trail-test" }).filter(
      (tool) => tool.name === "knowledge_fetch",
    ),
    tools,
    documentPort.supportsKnowledgeAliases === true,
  );
  const fetchMany = tools.find((tool) => tool.name === "fetch_many")!;

  const pageRead = JSON.parse(
    serializeToolResultForModel(await knowledgeFetch!.invoke({ id: "wiki:overview" }, context)),
  );
  const provenance = pageRead.items[0].document.knowledgeContext.provenance;
  const claim = provenance.claims.find((c: { excerpt: string }) =>
    c.excerpt.includes("opens Saturday"),
  );
  const sources = provenance.items
    .filter((item: { claimId: string }) => item.claimId === claim.id)
    .map((item: { documentId: string }) => ({ documentId: item.documentId }));
  expect(sources).toEqual([{ documentId: "evidence" }]);

  const sourceRead = JSON.parse(
    serializeToolResultForModel(await fetchMany.invoke({ documents: sources }, context)),
  );
  expect(sourceRead.items[0].document).toMatchObject({
    id: "evidence",
    content: "The observatory opens Saturday.",
  });
  expect(reads.snapshot(context).map((row) => row.documentId)).toEqual([
    "projection-overview",
    "evidence",
  ]);
});

// Search returns a maintained page under its projection's document id; the
// interactive read must open the page from that id, and only a page.
it("opens a maintained page from its search hit's document id, and nothing else", async () => {
  page("overview");
  const documentPort = createGatewayDocumentPort(db);
  const reads = new CitationReads();
  const tools = buildBuiltinTools({
    citationReads: reads,
    ports: {
      document: documentPort,
      search: {
        search: async () => {
          throw new Error("Search is not used");
        },
      },
    },
  });
  const service = new KnowledgeService({
    db,
    writeGate: directKnowledgeGate(db),
    getSettings: () => resolveBrainSettings(),
    getEntailmentVerifier: () => Promise.resolve(null),
    clock: () => 100,
    log: createLogger("knowledge-hit-test"),
  });
  const canonical = buildKnowledgeTools(service, { runId: "interactive-hit-test" }).filter(
    (tool) => tool.name === "knowledge_fetch",
  );
  const [tool] = adaptInteractiveKnowledgeReads(
    canonical,
    tools,
    documentPort.supportsKnowledgeAliases === true,
    documentPort.knowledgePageRef?.bind(documentPort),
  );
  expect(tool!.summarize?.({ id: "projection-overview" })).toBe("overview");
  expect(await tool!.invoke({ id: "projection-overview" }, context)).toMatchObject({
    kind: "document.batch",
    items: [{ kind: "document", ref: { documentId: "projection-overview" } }],
  });
  const other = { ...context, messageId: "non-page" };
  expect(await tool!.invoke({ id: "evidence" }, other)).toMatchObject({
    kind: "error",
    code: "knowledge_read_unavailable",
  });
  expect(reads.snapshot(other)).toEqual([]);
  expect(documentPort.knowledgePageRef?.("evidence")).toBeNull();
  expect(documentPort.knowledgePageRef?.("projection-overview")).toBe("wiki:overview");
});
