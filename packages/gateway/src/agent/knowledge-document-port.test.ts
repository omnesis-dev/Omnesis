// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  createFetchDocumentTool,
  buildBuiltinTools,
  serializeToolResultForModel,
  type ToolContext,
} from "@omnesis/agent";
import { toolResultSchema } from "@omnesis/core";
import { createDatabase } from "../db.js";
import { createCorpusAuthorization } from "../access/corpus-authorization.js";
import { saveKnowledgeNode } from "../brain/knowledge/storage.js";
import { KNOWLEDGE_PROVIDER_ID, KNOWLEDGE_SOURCE_ID } from "../brain/knowledge/source-meta.js";
import { buildKnowledgeDocumentInput } from "../brain/knowledge/mirror.js";
import { createGatewayDocumentPort } from "./ports.js";
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
) {
  const node = saveKnowledgeNode(
    db,
    {
      id,
      kind: "wiki",
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
      claims: [{ id: "opening", excerpt: "The observatory opens Saturday.", truncated: false }],
      items: [
        {
          claimId: "opening",
          ref: "source:evidence",
          documentId: "evidence",
          relation: "supports",
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
      provenance: { items: [expect.objectContaining({ documentId: "evidence", stale: true })] },
    },
  });
});
