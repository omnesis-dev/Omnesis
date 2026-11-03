// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The entry points outside the scheduler, HTTP and WebSocket dispatch that
 * mark their main-thread work: a stub inside the code path records what the
 * stall watchdog would sample there, and a simulated one-second stall holding
 * that sample is reported under the entry point's name. Most paths are driven
 * through their public surface; the conversation write and the source sweep
 * are reached through their private methods, with the work beneath them
 * stubbed.
 *
 * All fixture data is invented.
 */

import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { makeCommand, PROTOCOL_VERSION, type AgentEvent } from "@omnesis/core";
import { SCOPE_READ, type DeviceId } from "@omnesis/types";
import {
  AgentSession,
  setActivityMarker,
  type ChatBackend,
  type ToolHandle,
  type TurnInput,
} from "@omnesis/agent";
import { EventBus } from "../events.js";
import { KeyedDebouncedRunner } from "../keyed-debounced-runner.js";
import { Scheduler } from "../scheduler/scheduler.js";
import { MainTaskRunner } from "../scheduler/runners/main.js";
import { runActivityName } from "../brain/run-drainer.js";
import { COGNITION_RUN_KINDS } from "../brain/storage/types.js";
import { PushBroadcaster } from "../push/broadcast.js";
import { DeviceWsServer } from "../ws.js";
import { createDatabase } from "../db.js";
import { createDevice } from "../data/repositories/DeviceRepository.js";
import { createToken } from "../data/repositories/TokenRepository.js";
import { directWriteGate } from "../write-gate.js";
import { AgentService } from "../agent/service.js";
import { SourceService } from "../http/services/SourceService.js";
import { captureActivity, nameStall } from "./stall-test-utils.js";
import { withActivity } from "./main-activity.js";
import type { ActivitySample } from "./stall-protocol.js";
import type { PeriodicTask } from "../scheduler/types.js";

beforeAll(() => setActivityMarker(withActivity));
afterAll(() => setActivityMarker(null));

describe("the event bus", () => {
  it("names a stall in a handler by the event", () => {
    const bus = new EventBus();
    let seen: ActivitySample | undefined;
    bus.on("document.deleted", () => {
      seen = captureActivity();
    });
    bus.emit("document.deleted", { id: "d-1" } as never);
    expect(nameStall(seen!).inner).toBe("bus document.deleted");
  });
});

describe("the periodic scheduler", () => {
  it("names a stall in a task's isIdle by the task, outside its run", async () => {
    const scheduler = new Scheduler({ enablePreemption: false });
    scheduler.registerRunner(new MainTaskRunner({ concurrency: 1 }));
    await scheduler.start();
    const seen = Promise.withResolvers<ActivitySample>();
    const task: PeriodicTask<undefined, number> = {
      name: "fixture.periodicTask",
      runner: "main",
      priority: "background",
      periodMs: 60_000,
      startDelayMs: 0,
      initialArgs: undefined,
      run: () => Promise.resolve({ kind: "done", value: 1 }),
      isIdle: () => {
        seen.resolve(captureActivity());
        return true;
      },
    };
    scheduler.schedule(task);
    try {
      expect(nameStall(await seen.promise).inner).toBe("fixture.periodicTask");
    } finally {
      await scheduler.dispose();
    }
  });
});

describe("a keyed debounced runner", () => {
  it("names a stall in a run by its activity, never its key", async () => {
    const seen = Promise.withResolvers<ActivitySample>();
    const runner = new KeyedDebouncedRunner({
      activity: "fixture.debouncedUpsert",
      debounceMs: 0,
      run: () => {
        seen.resolve(captureActivity());
        return Promise.resolve();
      },
    });
    runner.enqueue("conversation-fixture-key");
    expect(nameStall(await seen.promise).inner).toBe("fixture.debouncedUpsert");
    runner.dispose();
  });
});

describe("an agent session", () => {
  it("names a stall in a tool call, in a subscriber and in the turn's continuations", async () => {
    let inTool: ActivitySample | undefined;
    let inBackend: ActivitySample | undefined;
    let inSubscriber: ActivitySample | undefined;
    const tool: ToolHandle = {
      name: "fixture_lookup",
      description: "synthetic lookup",
      schema: z.object({}),
      invoke: () => {
        inTool = captureActivity();
        return Promise.resolve({ kind: "text", text: "found" } as never);
      },
    };
    const backend: ChatBackend = {
      name: "scripted",
      model: "scripted",
      async *runTurn(input: TurnInput): AsyncIterable<AgentEvent> {
        await Promise.resolve();
        inBackend = captureActivity();
        await input.tools[0]!.invoke({}, {} as never);
        yield {
          type: "agent.text.delta",
          payload: { sessionId: input.sessionId, messageId: input.messageId, delta: "done" },
        };
        yield {
          type: "agent.message.end",
          payload: {
            sessionId: input.sessionId,
            messageId: input.messageId,
            stopReason: "end_turn",
          },
        };
      },
    };
    const session = new AgentSession({
      sessionId: "S",
      backend,
      tools: [tool],
      systemPrompt: "test",
      idGen: () => randomUUID(),
    });
    session.subscribe((event) => {
      if (event.type === "agent.text.delta") inSubscriber = captureActivity();
    });

    await session.send("look it up").completion;

    expect(nameStall(inTool!).inner).toBe("agent.tool fixture_lookup");
    expect(nameStall(inSubscriber!).inner).toBe("agent.event");
    // After an await nothing is executing under a mark; the turn is what is
    // in flight.
    const continuation = nameStall(inBackend!);
    expect(continuation.inner).toBeNull();
    expect(continuation.inFlight).toContain("agent.turn");
  });
});

describe("the Brain's run activity name", () => {
  // The drainer running a run under this name is pinned in run-drainer.test.ts.
  it("is the run's kind, and generic for a kind that is not one", () => {
    const kind = COGNITION_RUN_KINDS[0]!;
    expect(runActivityName(kind)).toBe(`brain.run ${kind}`);
    expect(runActivityName("not-a-run-kind")).toBe("brain.run (other)");
  });
});

describe("push delivery", () => {
  it("names a stall while a claimed wake is dispatched", async () => {
    let seen: ActivitySample | undefined;
    const broadcaster = new PushBroadcaster({
      queue: {
        enqueueNotification: vi.fn(),
        leaseNotificationWakes: vi.fn(async () => [
          {
            deliveryId: "delivery-1",
            deviceId: "device-1" as DeviceId,
            leaseToken: "lease-1",
            attempt: 1,
            expiresAt: 10_000,
          },
        ]),
        settleNotificationWake: vi.fn(),
      },
      listDevices: () => {
        seen = captureActivity();
        return [];
      },
      apnsClient: null,
      fcmClient: null,
      relayClient: { wake: vi.fn() },
      socket: null,
      now: () => 1_000,
    } as never);
    await broadcaster.retryDueWakes();
    expect(nameStall(seen!).inner).toBe("push.dispatch");
  });
});

describe("the device WebSocket server", () => {
  it("names a stall in its heartbeat and in a closing connection", async () => {
    const dbPath = `/tmp/omnesis-test-${randomUUID()}.db`;
    const db = createDatabase(dbPath);
    let inHeartbeat: ActivitySample | undefined;
    let inClose: ActivitySample | undefined;
    const srv = new DeviceWsServer({
      db,
      writeGate: directWriteGate(db),
      authTimeoutMs: 60_000,
      heartbeatIntervalMs: 25,
      onDeviceDisconnected: () => {
        inClose = captureActivity();
      },
    });
    try {
      const device = createDevice(db, { name: "fixture-phone", kind: "ios" });
      const { id: tokenId } = createToken(db, device.id, [SCOPE_READ]);
      const ws = { send: () => {}, close: () => {} };
      srv.onOpen(
        ws,
        "fixture-client",
        { tokenId, deviceId: device.id, scopes: [SCOPE_READ] },
        {
          ping: () => {
            inHeartbeat ??= captureActivity();
            srv.onPong(ws);
          },
          terminate: () => {},
        },
      );
      srv.onMessage(
        ws,
        JSON.stringify(makeCommand("hello", { protocolVersion: PROTOCOL_VERSION })),
      );
      await vi.waitFor(() => expect(srv.isConnected(device.id)).toBe(true));
      srv.start();
      await vi.waitFor(() => expect(inHeartbeat).toBeDefined(), { timeout: 5_000 });
      srv.onClose(ws);

      expect(nameStall(inHeartbeat!).inner).toBe("ws.heartbeat");
      expect(nameStall(inClose!).inner).toBe("ws.close");
    } finally {
      srv.stop();
      db.close();
      for (const suffix of ["", "-wal", "-shm"]) {
        if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
      }
    }
  });
});

describe("detached service work", () => {
  it("names a stall while a conversation is written", async () => {
    let seen: ActivitySample | undefined;
    const persist = (
      AgentService.prototype as unknown as {
        persistConversation: (this: unknown, ...args: unknown[]) => Promise<void>;
      }
    ).persistConversation;
    await persist.call({
      writeConversation: () => {
        seen = captureActivity();
        return Promise.resolve();
      },
    });
    expect(nameStall(seen!).inner).toBe("agent.persistConversation");
  });

  it("names a stall in a removed source's sweep", async () => {
    let seen: ActivitySample | undefined;
    const sweep = (
      SourceService.prototype as unknown as {
        sweepRemovedSource: (this: unknown, id: string) => Promise<void>;
      }
    ).sweepRemovedSource;
    await sweep.call(
      {
        sweeping: new Set<string>(),
        runSweep: () => {
          seen = captureActivity();
          return Promise.resolve();
        },
      },
      "source-1",
    );
    expect(nameStall(seen!).inner).toBe("sources.sweepRemoved");
  });
});
