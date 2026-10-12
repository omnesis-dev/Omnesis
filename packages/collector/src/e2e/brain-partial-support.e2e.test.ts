// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";
import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { ProviderId, SourceId } from "@omnesis/types";
import { saveKnowledgeNode } from "../../../gateway/src/brain/knowledge/storage.js";
import { getKnowledgeNode } from "../../../gateway/src/brain/knowledge/storage-read.js";
import { buildKnowledgeDocumentInput } from "../../../gateway/src/brain/knowledge/mirror.js";
import { CONTEXTUAL_VERIFIER } from "../../../gateway/src/brain/knowledge/claim-context.js";
import { upsertDocuments } from "../../../gateway/src/data/repositories/DocumentRepository.js";
import { startOpenAiServer, type OpenAiServerHandle } from "./brain-bench/openai-server.js";
import { SyntheticE2EHarness } from "./synth-harness.js";

let harness: SyntheticE2EHarness | undefined;
let model: OpenAiServerHandle | undefined;
afterEach(async () => {
  await harness?.destroy();
  await model?.close();
}, 60_000);

it("returns surviving qualified support and exact citations through a real gateway stale-page read", async () => {
  let results: Array<Record<string, unknown>> = [];
  model = await startOpenAiServer({
    modelId: "scripted-partial-page",
    respond(messages) {
      results = messages.filter((m) => m.role === "tool").map((m) => JSON.parse(m.content ?? "{}"));
      if (results.length === 0)
        return {
          kind: "tool",
          name: "fetch_many",
          args: { documents: [{ documentId: "wiki:observatory-overview" }] },
        };
      if (results.length === 1)
        return {
          kind: "tool",
          name: "annotate_many",
          args: {
            annotations: [
              { documentId: "wiki:observatory-overview", quote: "The west dome opens Saturday." },
            ],
          },
        };
      return { kind: "text", text: "Scripted read complete." };
    },
  });
  harness = new SyntheticE2EHarness({
    gatewayMode: "stable",
    universe: "e2e-minimal",
    extraInference: {
      backends: { fixture: { type: "http", url: model.url } },
      assignments: { agent: `fixture/${model.modelId}` },
    },
  });
  await harness.start();
  const db = new Database(harness.getDbPath());
  db.pragma("busy_timeout=10000");
  try {
    db.transaction(() => {
      for (const [id, text] of [
        ["steady-original", "The west dome opens Saturday."],
        ["changing-original", "The lens inspection is planned Monday."],
      ] as const) {
        upsertDocuments(db, [
          {
            providerId: ProviderId("fixture"),
            sourceId: SourceId("fixture"),
            externalId: id,
            title: id,
            content: text,
            contentHash: "v1",
            sourceCreatedAt: "2025-04-01T00:00:00Z",
            sourceUpdatedAt: "2025-04-01T00:00:00Z",
            metadata: {},
          },
        ]);
      }
      const id = (external: string) =>
        (
          db
            .prepare("SELECT id FROM documents WHERE source_id='fixture' AND external_id=?")
            .get(external) as { id: string }
        ).id;
      const steady = id("steady-original"),
        changing = id("changing-original");
      const node = saveKnowledgeNode(
        db,
        {
          id: "observatory-overview",
          kind: "wiki",
          title: "Observatory overview",
          expectedRevision: 0,
          markdown: `<claim id="steady" refs="source:${steady}">The west dome opens Saturday.</claim>\n<claim id="changing" refs="source:${changing}">The lens inspection is planned Monday.</claim>`,
          inputVersions: { [`source:${steady}`]: "v1", [`source:${changing}`]: "v1" },
        },
        Date.now(),
      ).node;
      // Arrange persisted proof state; the model seam only exercises retrieval and citation protocol.
      db.prepare(
        "UPDATE knowledge_claims SET verification='verified',verifier=? WHERE node_id=?",
      ).run(CONTEXTUAL_VERIFIER, node.id);
      // Leave the exact same-revision mirror at its prior current validity.
      upsertDocuments(db, [buildKnowledgeDocumentInput(getKnowledgeNode(db, node.id)!)]);
      db.prepare(
        "UPDATE documents SET content_hash='v2',content='The lens inspection was cancelled.' WHERE id=?",
      ).run(changing);
    }).immediate();
  } finally {
    db.close();
  }
  const { sessionId } = await harness.gatewayJson<{ sessionId: string }>("/agent/sessions", {
    method: "POST",
    body: "{}",
  });
  await harness.gatewayJson(`/agent/sessions/${sessionId}/messages`, {
    method: "POST",
    body: JSON.stringify({ text: "Read the maintained observatory overview." }),
  });
  await expect.poll(() => results.length, { timeout: 30_000, interval: 100 }).toBe(2);
  const batch = results[0] as {
    kind: string;
    items: Array<{
      kind: string;
      document: {
        knowledgeContext: {
          validity: string;
          verifiedSupport: Array<{ ref: string }>;
          supportCoverage: { partial: boolean };
        };
      };
    }>;
  };
  expect(batch.kind).toBe("document.batch");
  expect(batch.items[0]!.document.knowledgeContext).toMatchObject({
    validity: "stale",
    supportCoverage: { partial: true },
  });
  expect(batch.items[0]!.document.knowledgeContext.verifiedSupport.map((x) => x.ref)).toEqual([
    "wiki:observatory-overview#claim:steady",
  ]);
  expect(JSON.stringify(results[1])).toContain('"kind":"annotate.recorded"');
  expect(JSON.stringify(results[1])).toContain("The west dome opens Saturday.");
}, 90_000);
