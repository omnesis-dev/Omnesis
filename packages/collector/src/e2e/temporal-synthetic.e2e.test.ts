// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { authorizeMcpClient } from "./mcp-oauth-helper.js";
import { SyntheticE2EHarness } from "./synth-harness.js";

/** Real synthetic-mode boot, source sync and local date recognizer; no model or table insert. */
describe("synthetic gateway keeps both production temporal layers", () => {
  let harness: SyntheticE2EHarness;
  beforeAll(async () => {
    harness = new SyntheticE2EHarness({ gatewayMode: "synthetic", universe: "default" });
    await harness.start();
    await harness.syncAllSources();
    // No structured temporal fields: this date exists only inside the body.
    // Its document timestamp is deliberately a different month.
    await harness.pushDocument({
      sourceId: "apple-notes:john.smith@icloud.example",
      providerId: "apple:john.smith@icloud.example",
      externalId: "body-only-temporal-proof",
      title: "Workshop note",
      content: "Our pottery workshop is on September 1, 2025. Bring the clay tools.",
      documentType: "note",
      sourceCreatedAt: "2025-08-01T12:00:00Z",
      sourceUpdatedAt: "2025-08-01T12:00:00Z",
    });
  }, 180_000);
  afterAll(async () => harness?.destroy(), 30_000);

  test("Direct temporal_query returns a synced calendar projection and a parsed body mention", async () => {
    const authorized = await authorizeMcpClient(
      { gatewayUrl: harness.gatewayUrl, apiKey: harness.apiKey },
      {
        principalName: "Synthetic temporal assistant",
        grantName: "Synthetic temporal read access",
        credentialLabel: "Fictional temporal client",
        capabilities: ["direct"],
      },
    );
    type Item = {
      origin: string;
      label?: string;
      start: string;
      mention?: { documentId: string; text: string };
    };
    try {
      const tools = await authorized.client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain("temporal_query");
      const deadline = Date.now() + 90_000;
      let items: Item[] = [];
      for (;;) {
        const result = await authorized.client.callTool({
          name: "temporal_query",
          arguments: { from: "2025-09-01", to: "2025-09-02", timeZone: "UTC", limit: 100 },
        });
        expect(result.isError).not.toBe(true);
        items = (result.structuredContent as { data: { items: Item[] } }).data.items;
        const mention = items.find(
          (item) => item.origin === "mention" && item.mention?.text === "September 1, 2025",
        );
        if (mention) break;
        if (Date.now() > deadline)
          throw new Error("Synthetic-mode local date parser did not index the body-only date");
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      expect(items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            origin: "projection",
            label: "Q3 planning kickoff",
            start: "2025-09-01T17:00:00.000Z",
          }),
          expect.objectContaining({
            origin: "mention",
            start: "2025-09-01T00:00:00.000Z",
            mention: expect.objectContaining({ text: "September 1, 2025" }),
          }),
        ]),
      );
      const mention = items.find(
        (item) => item.origin === "mention" && item.mention?.text === "September 1, 2025",
      )!;
      expect(mention.mention?.documentId).toBeTruthy();
      // The quoted mention is a retrieval lead; source data remains readable
      // through the same external-agent grant, without an agent-model turn.
      const fetched = await authorized.client.callTool({
        name: "fetch_many",
        arguments: { documents: [{ documentId: mention.mention!.documentId }] },
      });
      expect(fetched.isError, JSON.stringify(fetched.structuredContent)).not.toBe(true);
      expect(JSON.stringify(fetched.structuredContent)).toContain(
        "Our pottery workshop is on September 1, 2025",
      );
    } finally {
      await authorized.client.close();
      await authorized.transport.close();
    }
  }, 150_000);
});
