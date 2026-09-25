// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * E2E Pipeline Tests — validates the core sync pipeline:
 * source → collector → gateway DB → HTTP APIs
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { E2EHarness } from "./harness.js";
import { mockDoc } from "./mock-source.js";
import { getDocumentCount, getSourceStats, getSyncState } from "./helpers.js";
import type { MockSource } from "./mock-source.js";

describe("E2E Pipeline", () => {
  let harness: E2EHarness;
  let source: MockSource;
  const sourceId = "mock-notes:alice";

  beforeAll(async () => {
    harness = new E2EHarness();

    source = harness.registerMockSource({
      sourceType: "mock-notes",
      providerType: "mock-provider",
      accountId: "alice",
      unitName: "notes",
    });

    // Set up 2 pages of documents
    source.setDocuments(
      [mockDoc("note-1"), mockDoc("note-2"), mockDoc("note-3")],
      [mockDoc("note-4"), mockDoc("note-5")],
    );

    await harness.start();
  }, 30000);

  afterAll(async () => {
    await harness.destroy();
  }, 15000);

  test("single source syncs documents to gateway", async () => {
    await harness.triggerSyncAndWait(sourceId);

    const count = await getDocumentCount(harness.gatewayUrl, harness.apiKey, sourceId);
    expect(count).toBe(5);
  }, 30000);

  test("multi-page sync fetches all pages", async () => {
    // Already synced in previous test — both pages should be in the DB
    const count = await getDocumentCount(harness.gatewayUrl, harness.apiKey, sourceId);
    expect(count).toBe(5);
  });

  test("sync persists cursor in gateway", async () => {
    const state = (await getSyncState(harness.gatewayUrl, harness.apiKey, sourceId)) as {
      sourceId: string;
      cursor: unknown;
      lastSyncedAt: string;
    } | null;
    expect(state).not.toBeNull();
    expect(state!.cursor).toBeDefined();
    expect(state!.lastSyncedAt).toBeDefined();
  });

  test("documents have correct fields via stats endpoint", async () => {
    const stats = await getSourceStats(harness.gatewayUrl, harness.apiKey, sourceId);
    expect(stats.documentCount).toBe(5);
    expect(stats.dataSizeBytes).toBeGreaterThan(0);
  });

  test("content hash deduplication — same content not duplicated", async () => {
    // Trigger another sync with the same documents
    await harness.triggerSyncAndWait(sourceId);

    const count = await getDocumentCount(harness.gatewayUrl, harness.apiKey, sourceId);
    // Still 5 — no duplicates
    expect(count).toBe(5);
  }, 30000);

  test("incremental sync receives existing cursor", async () => {
    // The source's sync history should show the cursor from the previous sync
    const lastCall = source.syncHistory[source.syncHistory.length - 1];
    expect(lastCall.cursor).not.toBeNull();
  });

  test("empty sync produces no documents for unknown source", async () => {
    const count = await getDocumentCount(
      harness.gatewayUrl,
      harness.apiKey,
      "nonexistent-source:nobody",
    );
    expect(count).toBe(0);
  });
});
