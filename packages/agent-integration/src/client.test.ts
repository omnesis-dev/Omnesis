// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { EventEmitter } from "node:events";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  AgentIntegrationClient,
  defaultIntegrationCapability,
  type AgentIntegrationClientOptions,
  type WebSocketFactory,
} from "./client.js";
import { DurableIntegrationInbox } from "./inbox.js";
import {
  AGENT_INTEGRATION_PROTOCOL_MIN_VERSION,
  AGENT_INTEGRATION_PROTOCOL_VERSION,
} from "./protocol.js";
import type { ClientOptions, RawData } from "ws";

class FakeSocket extends EventEmitter {
  readyState = 1;
  sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.emit("close");
  }

  open(): void {
    this.emit("open");
  }

  message(value: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(value)) as RawData);
  }
}

const inboxes: DurableIntegrationInbox[] = [];

function delivery(id = "adl_fictional_1") {
  return {
    protocolVersion: AGENT_INTEGRATION_PROTOCOL_VERSION,
    deliveryId: id,
    firingId: "trf_fictional_1",
    subscriptionId: "sub_fictional_1",
    workflowHandle: "wf_fictional_1",
    reaction: { instruction: "Review the fictional Studio Northstar update." },
    answer: {
      token: "omn_firing_example",
      expiresAt: 1_900_000_000_000,
      endpoint: "/subscriptions/firings/trf_fictional_1/answer",
    },
    outcome: {
      token: "omn_outcome_example",
      expiresAt: 1_950_000_000_000,
      endpoint: "/subscriptions/firings/trf_fictional_1/outcome",
    },
  };
}

function answerCompletion(id = "acdl_fictional_1") {
  return {
    protocolVersion: AGENT_INTEGRATION_PROTOCOL_VERSION,
    deliveryId: id,
    taskId: "task_fictional_1",
    nativeConversationId: "native_fictional_1",
  };
}

function setup(maxConcurrentRuns = 2, starterOverride?: AgentIntegrationClientOptions["starter"]) {
  const sockets: FakeSocket[] = [];
  const factory: WebSocketFactory = (_url: string, _protocol: string, _options: ClientOptions) => {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  };
  const inbox = new DurableIntegrationInbox(":memory:");
  inboxes.push(inbox);
  let starts = 0;
  const client = new AgentIntegrationClient({
    gatewayUrl: "http://127.0.0.1:7600",
    deliveryToken: "omn_delivery_example",
    capability: defaultIntegrationCapability("openclaw", maxConcurrentRuns),
    inbox,
    starter: async (input) => {
      starts += 1;
      if (starterOverride) return starterOverride(input);
      const { delivery: wake, binding } = input;
      return {
        localRunId: `run-${wake.deliveryId}`,
        nativeSessionId: binding?.nativeSessionId ?? `session-${wake.workflowHandle}`,
      };
    },
    webSocketFactory: factory,
    reconnectInitialMs: 10,
    reconnectMaxMs: 20,
    now: () => 1_800_000_000_000,
  });
  return { client, sockets, starts: () => starts };
}

function authenticate(socket: FakeSocket): void {
  socket.open();
  const hello = JSON.parse(socket.sent[0]) as { id: string };
  socket.message({
    kind: "response",
    correlationId: hello.id,
    ok: true,
    result: {
      deviceId: "device-fictional",
      scopes: ["subscriptions:receive"],
      deviceName: "Fictional OpenClaw",
      deviceKind: "agent",
      protocolVersion: 1,
    },
  });
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(async () => {
  vi.useRealTimers();
  for (const inbox of inboxes.splice(0)) inbox.close();
});

describe("AgentIntegrationClient", () => {
  test("persists a completion prepare and starts it only on commit", async () => {
    const sockets: FakeSocket[] = [];
    const inbox = new DurableIntegrationInbox(":memory:");
    inboxes.push(inbox);
    const starter = vi.fn().mockResolvedValue(undefined);
    const client = new AgentIntegrationClient({
      gatewayUrl: "http://127.0.0.1:7600",
      deliveryToken: "omn_delivery_example",
      capability: defaultIntegrationCapability("openclaw"),
      inbox,
      starter: async ({ delivery: wake }) => ({
        localRunId: `run-${wake.deliveryId}`,
        nativeSessionId: "fictional-native-session",
      }),
      completionStarter: starter,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      now: () => 1_800_000_000_000,
    });
    client.start();
    const socket = sockets[0]!;
    authenticate(socket);
    const wake = answerCompletion();
    socket.message({
      kind: "command",
      id: "completion-prepare",
      type: "answer-completion.prepare",
      payload: wake,
    });
    await flush();
    expect(starter).not.toHaveBeenCalled();
    expect(inbox.getAnswerCompletionState(wake.deliveryId)).toBe("prepared");
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
      correlationId: "completion-prepare",
      ok: true,
      result: { status: "prepared", duplicate: false },
    });
    socket.message({
      kind: "command",
      id: "completion-commit",
      type: "answer-completion.commit",
      payload: { protocolVersion: AGENT_INTEGRATION_PROTOCOL_VERSION, deliveryId: wake.deliveryId },
    });
    await flush();
    expect(starter).toHaveBeenCalledWith(wake);
    expect(inbox.getAnswerCompletionState(wake.deliveryId)).toBe("accepted");
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
      correlationId: "completion-commit",
      ok: true,
      result: { status: "accepted", localRunId: wake.deliveryId },
    });
    await client.stop();
  });

  test("a completion cancellation tombstone rejects a delayed prepare", async () => {
    const { client, sockets } = setup();
    client.start();
    const socket = sockets[0]!;
    authenticate(socket);
    const wake = answerCompletion("acdl_tombstone");
    socket.message({
      kind: "command",
      id: "completion-cancel",
      type: "answer-completion.cancel",
      payload: { protocolVersion: AGENT_INTEGRATION_PROTOCOL_VERSION, deliveryId: wake.deliveryId },
    });
    await flush();
    socket.message({
      kind: "command",
      id: "completion-late-prepare",
      type: "answer-completion.prepare",
      payload: wake,
    });
    await flush();
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
      correlationId: "completion-late-prepare",
      ok: false,
      error: { code: "cancelled" },
    });
    await client.stop();
  });

  test("requires a strict protocol-v1 hello response before accepting deliveries", async () => {
    const { client, sockets, starts } = setup();
    client.start();
    const socket = sockets[0];
    socket.open();
    const hello = JSON.parse(socket.sent[0]) as {
      id: string;
      payload: {
        protocolVersion: number;
        capabilities: {
          agentIntegration: { deliveryProtocolMin: number; deliveryProtocolMax: number };
        };
      };
    };
    expect(hello.payload.protocolVersion).toBe(1);
    expect(hello.payload.capabilities.agentIntegration).toMatchObject({
      deliveryProtocolMin: 3,
      deliveryProtocolMax: 4,
      watchPrivacyPolicyVersion: 1,
    });

    socket.message({
      kind: "command",
      id: "prepare-before-hello",
      type: "subscription.prepare",
      payload: delivery(),
    });
    await flush();
    expect(starts()).toBe(0);
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
      correlationId: "prepare-before-hello",
      ok: false,
      error: { code: "not_authenticated" },
    });

    socket.message({
      kind: "response",
      correlationId: hello.id,
      ok: true,
      result: {
        deviceId: "device-fictional",
        scopes: ["subscriptions:receive"],
        deviceName: "Fictional OpenClaw",
        deviceKind: "agent",
        protocolVersion: 2,
      },
    });
    await flush();
    expect(client.getState()).toBe("disconnected");
    await client.stop();
  });

  test("closes on a correlated hello response with missing trusted fields", async () => {
    const { client, sockets } = setup();
    client.start();
    const socket = sockets[0];
    socket.open();
    const hello = JSON.parse(socket.sent[0]) as { id: string };
    socket.message({
      kind: "response",
      correlationId: hello.id,
      ok: true,
      result: {},
    });
    await flush();
    expect(client.getState()).toBe("disconnected");
    await client.stop();
  });

  test("advertises the integration contract and accepts only after durable start", async () => {
    const { client, sockets, starts } = setup();
    client.start();
    const socket = sockets[0];
    authenticate(socket);
    socket.message({
      kind: "command",
      id: "cmd-prepare",
      type: "subscription.prepare",
      payload: delivery(),
    });
    await flush();
    expect(starts()).toBe(0);
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
      correlationId: "cmd-prepare",
      ok: true,
      result: { status: "prepared", duplicate: false },
    });
    socket.message({
      kind: "command",
      id: "cmd-commit",
      type: "subscription.commit",
      payload: {
        protocolVersion: AGENT_INTEGRATION_PROTOCOL_VERSION,
        deliveryId: delivery().deliveryId,
      },
    });
    await flush();
    expect(starts()).toBe(1);
    const response = JSON.parse(socket.sent.at(-1)!) as Record<string, unknown>;
    expect(response).toMatchObject({
      kind: "response",
      correlationId: "cmd-commit",
      ok: true,
      result: { status: "accepted", duplicate: false },
    });
    await client.stop();
  });

  test("runs a wake from a gateway that predates bindings and outcomes", async () => {
    const { client, sockets, starts } = setup();
    client.start();
    const socket = sockets[0];
    authenticate(socket);
    const { outcome: _outcome, ...legacy } = delivery("adl_legacy_1");
    const wake = { ...legacy, protocolVersion: AGENT_INTEGRATION_PROTOCOL_MIN_VERSION };
    socket.message({
      kind: "command",
      id: "legacy-prepare",
      type: "subscription.prepare",
      payload: wake,
    });
    await flush();
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
      correlationId: "legacy-prepare",
      ok: true,
      result: { status: "prepared" },
    });
    socket.message({
      kind: "command",
      id: "legacy-commit",
      type: "subscription.commit",
      // The control frame keeps whichever version the gateway negotiated,
      // which for such a gateway is the older one.
      payload: {
        protocolVersion: AGENT_INTEGRATION_PROTOCOL_MIN_VERSION,
        deliveryId: wake.deliveryId,
      },
    });
    await flush();
    expect(starts()).toBe(1);
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
      correlationId: "legacy-commit",
      ok: true,
      result: { status: "accepted" },
    });
    await client.stop();
  });

  test("replay returns the same run identity with duplicate=true", async () => {
    const { client, sockets, starts } = setup();
    client.start();
    const socket = sockets[0];
    authenticate(socket);
    const prepare = {
      kind: "command",
      id: "prepare-1",
      type: "subscription.prepare",
      payload: delivery(),
    };
    const commit = {
      kind: "command",
      id: "commit-1",
      type: "subscription.commit",
      payload: {
        protocolVersion: AGENT_INTEGRATION_PROTOCOL_VERSION,
        deliveryId: delivery().deliveryId,
      },
    };
    socket.message(prepare);
    await flush();
    socket.message(commit);
    await flush();
    const first = JSON.parse(socket.sent.at(-1)!) as {
      result: { localRunId: string };
    };
    socket.message({ ...prepare, id: "prepare-2" });
    await flush();
    socket.message({ ...commit, id: "commit-2" });
    await flush();
    const second = JSON.parse(socket.sent.at(-1)!) as {
      result: { localRunId: string; duplicate: boolean };
    };
    expect(starts()).toBe(1);
    expect(second.result.localRunId).toBe(first.result.localRunId);
    expect(second.result.duplicate).toBe(true);
    await client.stop();
  });

  test("reports a native start with an unknowable outcome as terminal ambiguity", async () => {
    const { client, sockets, starts } = setup(2, () => {
      throw new Error("fictional harness acknowledgement was lost");
    });
    client.start();
    const socket = sockets[0];
    authenticate(socket);
    const wake = delivery("adl_ambiguous");
    socket.message({
      kind: "command",
      id: "prepare-ambiguous",
      type: "subscription.prepare",
      payload: wake,
    });
    await flush();
    const commit = {
      kind: "command",
      id: "commit-ambiguous-first",
      type: "subscription.commit",
      payload: {
        protocolVersion: AGENT_INTEGRATION_PROTOCOL_VERSION,
        deliveryId: wake.deliveryId,
      },
    };
    socket.message(commit);
    await flush();
    expect(starts()).toBe(1);
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
      correlationId: "commit-ambiguous-first",
      ok: false,
      error: { code: "ambiguous_start" },
    });

    socket.message({ ...commit, id: "commit-ambiguous-replay" });
    await flush();
    expect(starts()).toBe(1);
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
      correlationId: "commit-ambiguous-replay",
      ok: false,
      error: { code: "ambiguous_start" },
    });
    await client.stop();
  });

  test("forbidden wake fields and expired answer authority fail before execution", async () => {
    const { client, sockets, starts } = setup();
    client.start();
    const socket = sockets[0];
    authenticate(socket);
    socket.message({
      kind: "command",
      id: "cmd-private",
      type: "subscription.prepare",
      payload: { ...delivery(), title: "Private fictional title" },
    });
    socket.message({
      kind: "command",
      id: "cmd-expired",
      type: "subscription.prepare",
      payload: {
        ...delivery("adl_expired"),
        answer: {
          token: "x",
          expiresAt: 1,
          endpoint: "/subscriptions/firings/trf_fictional_1/answer",
        },
      },
    });
    await flush();
    expect(starts()).toBe(0);
    expect(socket.sent.some((frame) => frame.includes("invalid_payload"))).toBe(true);
    expect(socket.sent.some((frame) => frame.includes('"expired"'))).toBe(true);
    await client.stop();
  });

  test("a cancellation tombstone prevents a prepared wake from committing", async () => {
    const { client, sockets, starts } = setup();
    client.start();
    const socket = sockets[0];
    authenticate(socket);
    const wake = delivery("adl_cancelled");
    socket.message({
      kind: "command",
      id: "prepare-cancelled",
      type: "subscription.prepare",
      payload: wake,
    });
    await flush();
    socket.message({
      kind: "command",
      id: "cancel-prepared",
      type: "subscription.cancel",
      payload: {
        protocolVersion: AGENT_INTEGRATION_PROTOCOL_VERSION,
        deliveryId: wake.deliveryId,
      },
    });
    await flush();
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
      correlationId: "cancel-prepared",
      ok: true,
      result: { status: "cancelled" },
    });
    socket.message({
      kind: "command",
      id: "commit-cancelled",
      type: "subscription.commit",
      payload: {
        protocolVersion: AGENT_INTEGRATION_PROTOCOL_VERSION,
        deliveryId: wake.deliveryId,
      },
    });
    await flush();
    expect(starts()).toBe(0);
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({
      correlationId: "commit-cancelled",
      ok: false,
      error: { code: "cancelled" },
    });
    await client.stop();
  });

  test("stop cancels reconnect and closes the active socket", async () => {
    vi.useFakeTimers();
    const { client, sockets } = setup();
    client.start();
    sockets[0].open();
    sockets[0].close();
    expect(client.getState()).toBe("disconnected");
    await client.stop();
    await vi.advanceTimersByTimeAsync(100);
    expect(sockets).toHaveLength(1);
    expect(client.getState()).toBe("stopped");
  });

  test("stop waits for a delivery already being durably accepted", async () => {
    let releaseStart!: () => void;
    let markStarted!: () => void;
    const startReleased = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const startEntered = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const { client, sockets } = setup(2, async ({ delivery: wake }) => {
      markStarted();
      await startReleased;
      return {
        localRunId: `run-${wake.deliveryId}`,
        nativeSessionId: `session-${wake.workflowHandle}`,
      };
    });
    client.start();
    const socket = sockets[0];
    authenticate(socket);
    socket.message({
      kind: "command",
      id: "prepare-stop",
      type: "subscription.prepare",
      payload: delivery(),
    });
    await flush();
    socket.message({
      kind: "command",
      id: "commit-stop",
      type: "subscription.commit",
      payload: {
        protocolVersion: AGENT_INTEGRATION_PROTOCOL_VERSION,
        deliveryId: delivery().deliveryId,
      },
    });
    await startEntered;

    let stopped = false;
    const stopping = client.stop().then(() => {
      stopped = true;
    });
    await flush();
    expect(stopped).toBe(false);

    releaseStart();
    await stopping;
    expect(stopped).toBe(true);
  });

  // The gateway's heartbeat period. The client's liveness budget is a small
  // multiple of it, so these tests drive the socket at the real cadence rather
  // than at a number copied from the client.
  const HEARTBEAT_MS = 30_000;

  function heartbeat(socket: FakeSocket, at: number): void {
    socket.message({ kind: "event", type: "ping", payload: { t: at } });
  }

  test("keeps a connection alive on heartbeats alone", async () => {
    vi.useFakeTimers();
    const { client, sockets } = setup();
    client.start();
    authenticate(sockets[0]);
    expect(client.getState()).toBe("ready");

    // Ten minutes of an idle but healthy link: nothing but the gateway's
    // heartbeat arrives, and the watchdog must never fire on it.
    for (let beat = 1; beat <= 20; beat += 1) {
      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
      heartbeat(sockets[0], beat);
    }

    expect(sockets).toHaveLength(1);
    expect(client.getState()).toBe("ready");
    await client.stop();
  });

  test("drops a socket that goes silent and reconnects", async () => {
    vi.useFakeTimers();
    const { client, sockets } = setup();
    client.start();
    authenticate(sockets[0]);
    expect(client.getState()).toBe("ready");

    // A half-open socket: the link is gone but the socket emits neither close
    // nor error, so only the absence of heartbeats reveals it.
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    expect(sockets.length).toBeGreaterThan(1);
    expect(client.getState()).not.toBe("ready");
    await client.stop();
  });

  test("reconnects when the hello is never answered", async () => {
    vi.useFakeTimers();
    const { client, sockets } = setup();
    client.start();
    sockets[0].open();
    expect(client.getState()).toBe("authenticating");

    // Heartbeats keep arriving, so a deadline reset by inbound traffic would
    // never expire; the handshake is bounded independently of them.
    for (let beat = 1; beat <= 10; beat += 1) {
      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
      heartbeat(sockets[0], beat);
    }

    expect(sockets.length).toBeGreaterThan(1);
    expect(client.getState()).not.toBe("authenticating");
    await client.stop();
  });

  test("an error that is not followed by a close still reconnects", async () => {
    vi.useFakeTimers();
    const { client, sockets } = setup();
    client.start();
    sockets[0].open();
    sockets[0].emit("error", new Error("fictional transport failure"));

    await vi.advanceTimersByTimeAsync(100);

    expect(sockets.length).toBeGreaterThan(1);
    await client.stop();
  });

  test("a successful hello resets the reconnect backoff", async () => {
    vi.useFakeTimers();
    const { client, sockets } = setup();
    client.start();
    authenticate(sockets[0]);
    sockets[0].close();

    await vi.advanceTimersByTimeAsync(9);
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(sockets).toHaveLength(2);

    authenticate(sockets[1]);
    sockets[1].close();

    // The second hello reset the backoff, so this attempt waits the initial
    // delay again rather than the doubled one.
    await vi.advanceTimersByTimeAsync(9);
    expect(sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2);
    expect(sockets).toHaveLength(3);
    await client.stop();
  });

  test("stop leaves no liveness timer behind", async () => {
    vi.useFakeTimers();
    const { client, sockets } = setup();
    client.start();
    authenticate(sockets[0]);
    await client.stop();

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(sockets).toHaveLength(1);
    expect(client.getState()).toBe("stopped");
  });
});
