// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test, vi } from "vitest";

import { makeCommand } from "@omnesis/core";
import { SCOPE_ADMIN, SCOPE_READ, SCOPE_WRITE_ALL } from "@omnesis/types";
import { SyncStatusRegistry } from "../../sync-status.js";
import { WsEventHandler } from "./WsEventHandler.js";
import type { AgentService } from "../../agent/service.js";
import type { AuthFlowRegistry } from "../../auth-flows.js";
import type { WriteGate } from "../../write-gate.js";
import type { DeviceConnection } from "../../ws.js";

const DEVICE_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" as DeviceConnection["deviceId"];
const stubAuthFlows = {} as AuthFlowRegistry;
const stubDb = {} as ConstructorParameters<typeof WsEventHandler>[0]["db"];
const stubWriteGate = {} as WriteGate;

function conn(scopes: DeviceConnection["scopes"]): DeviceConnection {
  return { deviceId: DEVICE_ID, scopes };
}

function fakeAgentService() {
  const createSession = vi.fn(async (callerId: string) => ({
    sessionId: "session-1",
    model: "test-model",
    backend: "test-backend",
    messageCount: 0,
    title: "",
    busy: false,
    messages: [],
    callerId,
  }));
  const sendMessage = vi.fn(() => ({ messageId: "msg-1", userMessageId: "user-msg-1" }));
  const cancelSession = vi.fn(() => ({ ok: true as const }));
  return {
    service: { createSession, sendMessage, cancelSession } as unknown as AgentService,
    createSession,
    sendMessage,
    cancelSession,
  };
}

function makeHandler(agentService: AgentService): WsEventHandler {
  return new WsEventHandler({
    db: stubDb,
    writeGate: stubWriteGate,
    syncStatus: new SyncStatusRegistry(),
    authFlows: stubAuthFlows,
    agentService,
  });
}

describe("WsEventHandler — agent command authorization", () => {
  test.each([
    ["agent.session.create", {}],
    ["agent.message.send", { sessionId: "session-1", text: "hello" }],
    ["agent.session.cancel", { sessionId: "session-1" }],
  ] as const)("%s rejects non-admin device scopes", async (type, payload) => {
    const agent = fakeAgentService();
    const handler = makeHandler(agent.service);

    await expect(
      handler.handleCommand(conn([SCOPE_READ, SCOPE_WRITE_ALL]), makeCommand(type, payload)),
    ).rejects.toThrow("agent commands require admin scope");

    expect(agent.createSession).not.toHaveBeenCalled();
    expect(agent.sendMessage).not.toHaveBeenCalled();
    expect(agent.cancelSession).not.toHaveBeenCalled();
  });

  test("admin device scope may create an agent session", async () => {
    const agent = fakeAgentService();
    const handler = makeHandler(agent.service);

    const result = await handler.handleCommand(
      conn([SCOPE_ADMIN]),
      makeCommand("agent.session.create", {}),
    );

    // And says who it is for. This transport is the operator's own device; a
    // session opened with no audience falls to the narrowest one, which hides
    // every watch on the install from their phone.
    expect(agent.createSession).toHaveBeenCalledWith(`device:${DEVICE_ID}`, {
      caller: { kind: "operator" },
    });
    expect(result).toMatchObject({ sessionId: "session-1", model: "test-model" });
  });

  test("admin device scope may send and cancel messages", async () => {
    const agent = fakeAgentService();
    const handler = makeHandler(agent.service);
    const adminConn = conn([SCOPE_ADMIN]);

    await handler.handleCommand(
      adminConn,
      makeCommand("agent.message.send", { sessionId: "session-1", text: "hello" }),
    );
    await handler.handleCommand(
      adminConn,
      makeCommand("agent.session.cancel", { sessionId: "session-1" }),
    );

    expect(agent.sendMessage).toHaveBeenCalledWith(`device:${DEVICE_ID}`, "session-1", "hello");
    expect(agent.cancelSession).toHaveBeenCalledWith(`device:${DEVICE_ID}`, "session-1");
  });
});
