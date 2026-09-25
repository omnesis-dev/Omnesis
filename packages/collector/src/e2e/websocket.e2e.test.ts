// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * E2E WebSocket Tests — validates real-time events emitted by the gateway
 * when the collector ingests documents.
 *
 * The collector's legacy `:7601/ws` server is gone; the only
 * WebSocket surface is the gateway's `/device/ws`. Tests authenticate with
 * the bootstrap admin token on the upgrade request and listen for
 * `documents.upserted` broadcasts which fire whenever the in-process
 * collector posts to /documents.
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { PROTOCOL_VERSION } from "@omnesis/core";
import { E2EHarness } from "./harness.js";
import { mockDoc } from "./mock-source.js";
import { waitForOpen, waitForClose, waitForMessage, waitForMessageMatching } from "./helpers.js";
import type { MockSource } from "./mock-source.js";

let harness: E2EHarness;
let source: MockSource;

beforeAll(async () => {
  harness = new E2EHarness();

  source = harness.registerMockSource({
    sourceType: "mock-chat",
    providerType: "mock-messaging",
    accountId: "ws-test",
    unitName: "messages",
  });
  source.setDocuments([mockDoc("msg-1"), mockDoc("msg-2")], [mockDoc("msg-3")]);

  await harness.start();
}, 30000);

afterAll(async () => {
  await harness.destroy();
}, 15000);

describe("E2E WebSocket", () => {
  const sourceId = "mock-chat:ws-test";

  test("gateway WS: documents.upserted event when sync produces docs", async () => {
    await harness.waitForSourceNotSyncing(sourceId);
    source.clearError();
    source.setDocuments([mockDoc("msg-1"), mockDoc("msg-2")], [mockDoc("msg-3")]);

    const ws = harness.connectGatewayWs();
    await waitForOpen(ws);

    // Complete the device WS protocol handshake.
    const helloId = crypto.randomUUID();
    ws.send(
      JSON.stringify({
        kind: "command",
        id: helloId,
        type: "hello",
        payload: { protocolVersion: PROTOCOL_VERSION },
      }),
    );
    const helloRes = await waitForMessage<{ kind: string; ok: boolean; correlationId: string }>(ws);
    expect(helloRes.ok).toBe(true);

    const upsertPromise = waitForMessageMatching<{
      kind: string;
      type: string;
      payload: { sourceId: string; count: number };
    }>(ws, (msg) => msg.kind === "event" && msg.type === "documents.upserted", 15000);

    harness.triggerSync(sourceId);

    const event = await upsertPromise;
    expect(event.payload.sourceId).toBe(sourceId);
    expect(event.payload.count).toBeGreaterThan(0);

    ws.close();
    await waitForClose(ws);
  }, 25000);
});
