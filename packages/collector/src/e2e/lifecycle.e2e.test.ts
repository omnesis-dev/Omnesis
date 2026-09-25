// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * E2E Lifecycle Tests — validates source add/disable/enable/remove against
 * the gateway-driven harness (no more `:7601` collector status server).
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { E2EHarness } from "./harness.js";
import { mockDoc } from "./mock-source.js";
import { getDocumentCount } from "./helpers.js";
import type { MockSource } from "./mock-source.js";

let harness: E2EHarness;
let source: MockSource;

beforeAll(async () => {
  harness = new E2EHarness();

  source = harness.registerMockSource({
    sourceType: "mock-emails",
    providerType: "mock-mail",
    accountId: "user@test.com",
    unitName: "emails",
  });
  source.setDocuments([mockDoc("email-1"), mockDoc("email-2"), mockDoc("email-3")]);

  await harness.start();
}, 30000);

afterAll(async () => {
  await harness.destroy();
}, 15000);

describe("E2E Lifecycle", () => {
  const sourceId = "mock-emails:user@test.com";

  test("gateway /health returns ok", async () => {
    const res = await fetch(`${harness.gatewayUrl}/health`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { status: string };
    expect(data.status).toBe("ok");
  });

  test("harness.getStatus() returns source statuses", () => {
    const data = harness.getStatus();
    expect(data.statuses).toBeInstanceOf(Array);
    expect(data.statuses.length).toBeGreaterThan(0);
    expect(data.timestamp).toBeDefined();

    const status = data.statuses.find((s) => s.sourceId === sourceId);
    expect(status).toBeDefined();
  });

  test("triggerSyncAndWait drives a sync to completion and docs land in gateway", async () => {
    await harness.triggerSyncAndWait(sourceId);

    const count = await getDocumentCount(harness.gatewayUrl, harness.apiKey, sourceId);
    expect(count).toBe(3);
  }, 30000);

  test("triggerSync('all') triggers all sources", () => {
    const result = harness.triggerSync("all");
    expect(result.triggered.length).toBeGreaterThan(0);
  });

  test("disableSource stops syncing", async () => {
    await harness.disableSource(sourceId);

    const status = harness.getStatus().statuses.find((s) => s.sourceId === sourceId);
    expect(status?.state).toBe("disabled");
  });

  test("enableSource resumes syncing", async () => {
    await harness.enableSource(sourceId);

    const deadline = Date.now() + 5000;
    let state: string | undefined;
    while (Date.now() < deadline) {
      state = harness.getStatus().statuses.find((s) => s.sourceId === sourceId)?.state;
      if (state !== "disabled") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(state).not.toBe("disabled");
  });

  test("resync clears data and re-syncs", async () => {
    await harness.triggerSyncAndWait(sourceId);
    let count = await getDocumentCount(harness.gatewayUrl, harness.apiKey, sourceId);
    expect(count).toBeGreaterThan(0);

    const result = await harness.resync(sourceId);
    expect(result.deleted).toBeGreaterThan(0);

    count = await getDocumentCount(harness.gatewayUrl, harness.apiKey, sourceId);
    expect(count).toBe(3);
  }, 30000);

  test("resync throws for unknown source", async () => {
    await expect(harness.resync("nonexistent-source")).rejects.toThrow(/not found/);
  });

  test("removeSource deletes data and unregisters", async () => {
    await harness.triggerSyncAndWait(sourceId);
    let count = await getDocumentCount(harness.gatewayUrl, harness.apiKey, sourceId);
    expect(count).toBeGreaterThan(0);

    const result = await harness.removeSource(sourceId);
    expect(result.deleted).toBeGreaterThan(0);

    count = await getDocumentCount(harness.gatewayUrl, harness.apiKey, sourceId);
    expect(count).toBe(0);
  }, 30000);
});
