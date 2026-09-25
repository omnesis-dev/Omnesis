// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * E2E Advanced Tests — error handling, multi-account, dedup edge cases, etc.
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { E2EHarness } from "./harness.js";
import { mockDoc } from "./mock-source.js";
import { getDocumentCount, getSourceStats } from "./helpers.js";
import type { MockSource } from "./mock-source.js";

describe("E2E Advanced: Error handling", () => {
  let harness: E2EHarness;
  let goodSource: MockSource;
  let badSource: MockSource;

  beforeAll(async () => {
    harness = new E2EHarness();

    goodSource = harness.registerMockSource({
      sourceType: "mock-good",
      providerType: "mock-adv",
      accountId: "ok",
    });
    goodSource.setDocuments([mockDoc("good-1"), mockDoc("good-2")]);

    badSource = harness.registerMockSource({
      sourceType: "mock-bad",
      providerType: "mock-adv-bad",
      accountId: "err",
    });
    badSource.setError(new Error("Source failure"));

    await harness.start();
  }, 30000);

  afterAll(async () => {
    await harness.destroy();
  }, 15000);

  test("source error sets status to error with message", async () => {
    const badSourceId = "mock-bad:err";

    // Start watching for the next sync completion BEFORE triggering, so the
    // listener is registered before the sync starts (and we don't race).
    const completed = harness.waitForSyncComplete(badSourceId, 10000);
    harness.triggerSync(badSourceId);
    await completed;

    const status = harness.getStatus().statuses.find((s) => s.sourceId === badSourceId);
    expect(status?.state).toBe("error");
    expect(String(status?.lastError ?? "")).toContain("Source failure");
  }, 15000);

  test("one source error does not block other sources", async () => {
    const goodSourceId = "mock-good:ok";

    // The good source should still sync fine
    await harness.triggerSyncAndWait(goodSourceId);

    const count = await getDocumentCount(harness.gatewayUrl, harness.apiKey, goodSourceId);
    expect(count).toBe(2);
  }, 30000);
});

describe("E2E Advanced: Multi-account", () => {
  let harness: E2EHarness;
  let sourceAlice: MockSource;
  let sourceBob: MockSource;

  beforeAll(async () => {
    harness = new E2EHarness();

    sourceAlice = harness.registerMockSource({
      sourceType: "mock-notes",
      providerType: "mock-multi",
      accountId: "alice",
    });
    sourceAlice.setDocuments([mockDoc("alice-1"), mockDoc("alice-2")]);

    sourceBob = harness.registerMockSource({
      sourceType: "mock-notes",
      providerType: "mock-multi",
      accountId: "bob",
    });
    sourceBob.setDocuments([mockDoc("bob-1"), mockDoc("bob-2"), mockDoc("bob-3")]);

    await harness.start();
  }, 30000);

  afterAll(async () => {
    await harness.destroy();
  }, 15000);

  test("same source type, different accounts sync independently", async () => {
    await harness.triggerSyncAndWait("mock-notes:alice");
    await harness.triggerSyncAndWait("mock-notes:bob");

    const aliceCount = await getDocumentCount(
      harness.gatewayUrl,
      harness.apiKey,
      "mock-notes:alice",
    );
    const bobCount = await getDocumentCount(harness.gatewayUrl, harness.apiKey, "mock-notes:bob");

    expect(aliceCount).toBe(2);
    expect(bobCount).toBe(3);
  }, 30000);

  test("docs have correct source_id per account", async () => {
    const aliceStats = await getSourceStats(harness.gatewayUrl, harness.apiKey, "mock-notes:alice");
    const bobStats = await getSourceStats(harness.gatewayUrl, harness.apiKey, "mock-notes:bob");

    expect(aliceStats.documentCount).toBe(2);
    expect(bobStats.documentCount).toBe(3);
  });
});

describe("E2E Advanced: Dedup edge cases", () => {
  let harness: E2EHarness;
  let source: MockSource;
  const sourceId = "mock-dedup:test";

  beforeAll(async () => {
    harness = new E2EHarness();

    source = harness.registerMockSource({
      sourceType: "mock-dedup",
      providerType: "mock-dedup-provider",
      accountId: "test",
    });

    await harness.start();
  }, 30000);

  afterAll(async () => {
    await harness.destroy();
  }, 15000);

  test("same externalId + same contentHash = no update", async () => {
    source.setDocuments([
      mockDoc("dup-1", { contentHash: "same-hash", content: "original content" }),
    ]);
    await harness.triggerSyncAndWait(sourceId);

    let count = await getDocumentCount(harness.gatewayUrl, harness.apiKey, sourceId);
    expect(count).toBe(1);

    // Sync again with same content hash
    source.setDocuments([
      mockDoc("dup-1", { contentHash: "same-hash", content: "original content" }),
    ]);
    await harness.triggerSyncAndWait(sourceId);

    count = await getDocumentCount(harness.gatewayUrl, harness.apiKey, sourceId);
    expect(count).toBe(1); // Still 1
  }, 30000);

  test("same externalId + different contentHash = content updated", async () => {
    // Change content hash
    source.setDocuments([
      mockDoc("dup-1", { contentHash: "new-hash", content: "updated content" }),
    ]);
    await harness.triggerSyncAndWait(sourceId);

    const count = await getDocumentCount(harness.gatewayUrl, harness.apiKey, sourceId);
    expect(count).toBe(1); // Still 1 doc, but content updated
  }, 30000);

  test("document deletion via deletedExternalIds", async () => {
    // Add two documents
    source.setDocuments([
      mockDoc("del-1", { contentHash: "del-hash-1" }),
      mockDoc("del-2", { contentHash: "del-hash-2" }),
    ]);
    await harness.triggerSyncAndWait(sourceId);

    let count = await getDocumentCount(harness.gatewayUrl, harness.apiKey, sourceId);
    // dup-1 from previous test + del-1, del-2
    expect(count).toBe(3);

    // Now sync with del-1 deleted
    source.setDocuments([mockDoc("del-2", { contentHash: "del-hash-2" })]);
    source.setDeletedIds(["del-1"]);
    await harness.triggerSyncAndWait(sourceId);

    count = await getDocumentCount(harness.gatewayUrl, harness.apiKey, sourceId);
    // dup-1 + del-2 (del-1 deleted)
    expect(count).toBe(2);
  }, 30000);
});

describe("E2E Advanced: Push events", () => {
  let harness: E2EHarness;
  let source: MockSource;
  const sourceId = "mock-push:test";

  beforeAll(async () => {
    harness = new E2EHarness();

    source = harness.registerMockSource({
      sourceType: "mock-push",
      providerType: "mock-push-provider",
      accountId: "test",
    });
    source.enablePush();
    source.setDocuments([mockDoc("push-1")]);

    await harness.start();
  }, 30000);

  afterAll(async () => {
    await harness.destroy();
  }, 15000);

  test("push event triggers sync after debounce", async () => {
    source.emitPushEvent();

    // The engine debounces push events (3s). Wait for sync to complete.
    await harness.waitForSyncComplete(sourceId, 15000);

    const count = await getDocumentCount(harness.gatewayUrl, harness.apiKey, sourceId);
    expect(count).toBe(1);
  }, 20000);
});

describe("E2E Advanced: Stats endpoint", () => {
  let harness: E2EHarness;
  let source: MockSource;
  const sourceId = "mock-stats:test";

  beforeAll(async () => {
    harness = new E2EHarness();

    source = harness.registerMockSource({
      sourceType: "mock-stats",
      providerType: "mock-stats-provider",
      accountId: "test",
    });
    source.setDocuments([
      mockDoc("stat-1", {
        sourceCreatedAt: "2025-01-15T10:00:00Z",
        sourceUpdatedAt: "2025-01-15T10:00:00Z",
      }),
      mockDoc("stat-2", {
        sourceCreatedAt: "2025-06-20T14:00:00Z",
        sourceUpdatedAt: "2025-06-20T14:00:00Z",
      }),
    ]);

    await harness.start();
  }, 30000);

  afterAll(async () => {
    await harness.destroy();
  }, 15000);

  test("GET /documents/stats returns correct counts and date range", async () => {
    await harness.triggerSyncAndWait(sourceId);

    const stats = await getSourceStats(harness.gatewayUrl, harness.apiKey, sourceId);
    expect(stats.documentCount).toBe(2);
    expect(stats.earliestSourceDate).not.toBeNull();
    expect(stats.latestSourceDate).not.toBeNull();
    expect(stats.dataSizeBytes).toBeGreaterThan(0);
  }, 30000);
});
