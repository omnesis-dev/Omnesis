// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { authorizeMcpClient, type AuthorizedMcpClient } from "./mcp-oauth-helper.js";
import { SyntheticE2EHarness } from "./synth-harness.js";

/**
 * The mention layer of `temporal_query` end to end on a stable gateway: the
 * date recognizer's background drip scans the synthetic corpus, and a Direct
 * client reads the dates written in document text back through the generally
 * available tool.
 */
describe("temporal query mentions — synthetic-corpus gateway", () => {
  let harness: SyntheticE2EHarness;

  beforeAll(async () => {
    harness = new SyntheticE2EHarness({ gatewayMode: "stable", universe: "default" });
    await harness.start();
    await harness.syncAllSources();
  }, 180_000);

  afterAll(async () => {
    await harness.destroy();
  }, 15_000);

  test("reads date mentions from document text through temporal_query without experimental mode", async () => {
    const authorized = await oauthClient({
      principalName: "Mention retrieval assistant",
      grantName: "Mention retrieval access",
      credentialLabel: "Fictional mention desktop",
      capabilities: ["direct"],
    });
    try {
      // The recognizer runs as a background drip on the stable gateway; wait
      // until it has scanned the whole synthetic corpus.
      const deadline = Date.now() + 90_000;
      for (;;) {
        const probe = await authorized.client.callTool({
          name: "temporal_query",
          arguments: { from: "2025-01-01", to: "2025-01-02", origins: ["mention"], limit: 1 },
        });
        expect(probe.isError).not.toBe(true);
        const pending = (
          probe.structuredContent as {
            data: { coverage: { mentions?: { pendingDocuments: number } } };
          }
        ).data.coverage.mentions?.pendingDocuments;
        expect(pending).toBeTypeOf("number");
        if (pending === 0) break;
        if (Date.now() > deadline)
          throw new Error(`Date extraction still has ${pending} documents pending`);
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      const db = new Database(harness.getDbPath(), { readonly: true });
      let expected: { document_id: string; mention_start_day: string; matched_text: string };
      try {
        const row = db
          .prepare<[], { document_id: string; mention_start_day: string; matched_text: string }>(
            // A mention the layer shows: from the corpus, and the latest
            // message of its thread to name those days.
            `SELECT x.document_id, x.mention_start_day, x.matched_text
               FROM document_extracted_dates x JOIN documents d ON d.id = x.document_id
              WHERE x.mention_start_day IS NOT NULL
                AND d.source_id NOT IN ('omnesis-chat', 'open-loops')
                AND (x.thread_key IS NULL OR NOT EXISTS (
                  SELECT 1 FROM document_extracted_dates y JOIN documents dy ON dy.id = y.document_id
                   WHERE y.thread_key = x.thread_key
                     AND y.mention_start_day = x.mention_start_day
                     AND y.mention_end_day = x.mention_end_day
                     AND y.document_id <> x.document_id
                     AND (dy.source_created_at > d.source_created_at
                          OR (dy.source_created_at = d.source_created_at AND dy.id > d.id))))
              ORDER BY x.mention_start_day, x.id LIMIT 1`,
          )
          .get();
        if (!row) throw new Error("The synthetic corpus yielded no indexable date mention");
        // The earliest start day in the corpus: no mention can reach this
        // window by its end alone, so every item starts on it.
        expected = row;
      } finally {
        db.close();
      }

      type MentionItem = {
        origin: string;
        start: string;
        mention?: { documentId: string; text: string };
      };
      const found: MentionItem[] = [];
      let cursor: string | undefined;
      do {
        const page = await authorized.client.callTool({
          name: "temporal_query",
          arguments: {
            from: expected.mention_start_day,
            timeZone: "UTC",
            origins: ["mention"],
            limit: 100,
            ...(cursor ? { cursor } : {}),
          },
        });
        expect(page.isError).not.toBe(true);
        const data = (
          page.structuredContent as { data: { items: MentionItem[]; nextCursor?: string } }
        ).data;
        found.push(...data.items);
        cursor = data.nextCursor;
      } while (cursor);

      expect(found.every((item) => item.origin === "mention")).toBe(true);
      expect(
        found.every((item) => item.start === `${expected.mention_start_day}T00:00:00.000Z`),
      ).toBe(true);
      expect(found.map((item) => item.mention?.documentId)).toContain(expected.document_id);

      // Omitting `origins` reads every layer, mentions included; naming the
      // other two leaves them out.
      const defaults = await authorized.client.callTool({
        name: "temporal_query",
        arguments: { from: expected.mention_start_day, timeZone: "UTC", limit: 100 },
      });
      expect(
        (defaults.structuredContent as { data: { items: MentionItem[] } }).data.items.some(
          (item) => item.origin === "mention",
        ),
      ).toBe(true);
      const named = await authorized.client.callTool({
        name: "temporal_query",
        arguments: {
          from: expected.mention_start_day,
          timeZone: "UTC",
          origins: ["projection", "annotation"],
          limit: 100,
        },
      });
      expect(
        (named.structuredContent as { data: { items: MentionItem[] } }).data.items.some(
          (item) => item.origin === "mention",
        ),
      ).toBe(false);
    } finally {
      await closeAuthorized(authorized);
    }
  }, 150_000);

  function oauthClient(
    input: Parameters<typeof authorizeMcpClient>[1],
  ): Promise<AuthorizedMcpClient> {
    return authorizeMcpClient({ gatewayUrl: harness.gatewayUrl, apiKey: harness.apiKey }, input);
  }
});

async function closeAuthorized(authorized: AuthorizedMcpClient): Promise<void> {
  const outcomes = await Promise.allSettled([
    authorized.client.close(),
    authorized.transport.close(),
  ]);
  expect(outcomes.filter((outcome) => outcome.status === "rejected")).toEqual([]);
}
