// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { authorizeMcpClient, type AuthorizedMcpClient } from "./mcp-oauth-helper.js";
import { SyntheticE2EHarness } from "./synth-harness.js";

const CHAT_TYPES = ["whatsapp-messages", "apple-imessage"] as const;
type Sample = { id: string; externalId: string; expected: "selected" | "other" | "unknown" };

describe("per-source scopes over MCP with a synthetic corpus", () => {
  let harness: SyntheticE2EHarness;
  let baseline: AuthorizedMcpClient;
  const sources = new Map<string, { id: string; samples: Sample[] }>();

  beforeAll(async () => {
    harness = new SyntheticE2EHarness({
      gatewayMode: "synthetic-experimental",
      universe: "e2e-minimal",
      agentBackend: "replay",
    });
    await harness.start();
    baseline = await authorizeMcpClient(harness, {
      principalName: "Existing synthetic client",
      grantName: "Whole corpus",
      credentialLabel: "Unfiltered connection",
      capabilities: ["direct"],
    });
    for (const type of CHAT_TYPES) {
      const sourceId = harness.getSourceIds().find((id) => id.startsWith(`${type}:`));
      if (!sourceId) throw new Error(`Missing synthetic source ${type}`);
      await harness.triggerSyncAndWait(sourceId);
      const reader = new Database(harness.getDbPath(), { readonly: true });
      let providerId: string;
      try {
        const row = reader
          .prepare<[string], { provider_id: string }>(
            "SELECT provider_id FROM documents WHERE source_id=? LIMIT 1",
          )
          .get(sourceId);
        if (!row) throw new Error(`Synthetic source ${type} produced no documents`);
        providerId = row.provider_id;
      } finally {
        reader.close();
      }
      const samples: Sample[] = [];
      await harness.pushDocuments([
        ...(["selected", "other"] as const).flatMap((kind) => [
          {
            sourceId,
            providerId,
            externalId: `scopefixture-${kind}`,
            title: `scopefixture ${type} ${kind}`,
            content: `scopefixture invented ${kind} conversation`,
            documentType: "conversation",
            metadata: {
              extra: {
                conversationId: `scopefixture-${kind}`,
                chatId: `scopefixture-${kind}`,
                chatName: `Fictional ${kind}`,
              },
            },
          },
          {
            sourceId,
            providerId,
            externalId: `scopefixture-${kind}/att/sample`,
            title: `scopefixture ${kind} attachment`,
            content: `scopefixture invented ${kind} attachment`,
            documentType: "attachment",
            metadata: {
              extra: { parentExternalId: `scopefixture-${kind}`, mimeType: "text/plain" },
            },
          },
        ]),
        {
          sourceId,
          providerId,
          externalId: "scopefixture-unknown",
          title: "scopefixture unknown",
          content: "scopefixture invented unknown conversation",
          documentType: "conversation",
          metadata: {},
        },
      ]);
      const db = new Database(harness.getDbPath(), { readonly: true });
      try {
        for (const row of db
          .prepare<[string], { id: string; external_id: string }>(
            "SELECT id,external_id FROM documents WHERE source_id=? AND external_id LIKE 'scopefixture-%'",
          )
          .all(sourceId))
          samples.push({
            id: row.id,
            externalId: row.external_id,
            expected: row.external_id.startsWith("scopefixture-selected")
              ? "selected"
              : row.external_id.startsWith("scopefixture-other")
                ? "other"
                : "unknown",
          });
      } finally {
        db.close();
      }
      expect(samples).toHaveLength(5);
      sources.set(type, { id: sourceId, samples });
    }
    for (let attempt = 0; attempt < 20; attempt++) {
      await harness.gatewayJson("/admin/background/run/backfill.scopeFacts", { method: "POST" });
      const db = new Database(harness.getDbPath(), { readonly: true });
      let ready: boolean;
      try {
        ready = [...sources.values()].every((source) =>
          db
            .prepare("SELECT 1 FROM scope_fact_backfill WHERE source_id=? AND ready=1")
            .get(source.id),
        );
      } finally {
        db.close();
      }
      if (ready) break;
      if (attempt === 19) throw new Error("Scope fact backfill did not finish");
    }
    await harness.reindexMissing();
    await harness.refreshSearchSnapshot();
  }, 180_000);

  afterAll(async () => {
    await baseline?.client.close();
    await baseline?.transport.close();
    await harness?.destroy();
  });

  for (const type of CHAT_TYPES) {
    test.each(["share", "hide"] as const)(
      `${type}: %s list controls search, fetch and attachments`,
      async (action) => {
        const source = sources.get(type)!;
        const client = await authorizeMcpClient(harness, {
          principalName: `Synthetic ${type} ${action}`,
          grantName: "Filtered conversations",
          credentialLabel: "Scoped connection",
          capabilities: ["direct"],
          rules: [
            {
              capability: "direct",
              sources: { mode: "all", sourceIds: [] },
              scopePolicies: [
                {
                  sourceId: source.id,
                  audience: { accessLevel: "new", capability: "direct" },
                  rules: [
                    { action, match: [{ kind: "conversation", id: "scopefixture-selected" }] },
                  ],
                  otherwise: action === "share" ? "hide" : "share",
                },
              ],
            },
          ],
        });
        try {
          const allowed = source.samples.filter(
            (sample) => sample.expected === (action === "share" ? "selected" : "other"),
          );
          const denied = source.samples.filter((sample) => !allowed.includes(sample));
          let search = "";
          for (let attempt = 0; attempt < 80; attempt++) {
            await harness.refreshSearchSnapshot();
            const response = await client.client.callTool({
              name: "search_many",
              arguments: {
                queries: [
                  { query: "scopefixture", filters: { sourceIds: [source.id] }, limit: 20 },
                ],
              },
            });
            expect(response.isError).not.toBe(true);
            search = JSON.stringify(response.structuredContent);
            if (allowed.every((sample) => search.includes(sample.id))) break;
            await new Promise((resolve) => setTimeout(resolve, 200));
          }
          for (const sample of allowed) expect(search).toContain(sample.id);
          for (const sample of denied) expect(search).not.toContain(sample.id);
          for (const sample of source.samples) {
            const result = await client.client.callTool({
              name: "fetch_many",
              arguments: { documents: [{ documentId: sample.id }] },
            });
            expect(result.isError).not.toBe(true);
            expect(result.structuredContent).toMatchObject({
              items: [{ kind: allowed.includes(sample) ? "document" : "error" }],
            });
            const original = await baseline.client.callTool({
              name: "fetch_many",
              arguments: { documents: [{ documentId: sample.id }] },
            });
            expect(original.structuredContent).toMatchObject({ items: [{ kind: "document" }] });
          }
        } finally {
          await client.client.close();
          await client.transport.close();
        }
      },
      90_000,
    );
  }
});
