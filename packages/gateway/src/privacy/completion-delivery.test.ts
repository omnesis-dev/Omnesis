// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { createLogger, type WsRequestPayload } from "@omnesis/core";
import { SCOPE_SUBSCRIPTIONS_RECEIVE, type DeviceId, type Scope } from "@omnesis/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDevice,
  getDevice,
  updateDeviceCapabilities,
} from "../data/repositories/DeviceRepository.js";
import { runSchemaSetup } from "../data/schema.js";
import { directWriteGate } from "../write-gate.js";
import {
  AnswerCompletionDeliveryService,
  type AnswerCompletionTransport,
} from "./completion-delivery.js";

describe("AnswerCompletionDeliveryService", () => {
  let db: Database.Database;
  let deviceId: DeviceId;
  let now: number;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runSchemaSetup(db);
    deviceId = createDevice(db, {
      name: "Fictional agent integration",
      kind: "agent",
      capabilities: {
        agentIntegration: {
          harness: "openclaw",
          deliveryProtocolMin: 3,
          deliveryProtocolMax: 4,
          maxConcurrentRuns: 1,
        },
      },
    }).id;
    now = 1_000;
    db.prepare(
      "INSERT INTO answer_workflows (id, owner_id, name, purpose, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("wf_completion", `device:${deviceId}`, "Fictional completion", "", now, now + 10_000);
    db.prepare(
      "INSERT INTO answer_conversations (id, workflow_id, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run("conv_completion", "wf_completion", `device:${deviceId}`, now, now);
  });

  afterEach(() => db.close());

  function queue(status: "released" | "denied" = "released"): void {
    db.prepare(
      `INSERT INTO answer_tasks
         (id, workflow_id, conversation_id, owner_id, client_request_id, request_fingerprint,
          question, status, approval_id, created_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "task_completion",
      "wf_completion",
      "conv_completion",
      `device:${deviceId}`,
      "request_completion",
      "fingerprint_completion",
      "A fictional question",
      status,
      "approval_completion",
      now,
      now,
    );
    db.prepare(
      `INSERT INTO answer_completion_deliveries
         (id, task_id, integration_device_id, native_conversation_id, status, next_attempt_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
    ).run("delivery_completion", "task_completion", deviceId, "native-fictional", now, now, now);
  }

  function service(send: AnswerCompletionTransport["sendCommand"], connected = true) {
    return new AnswerCompletionDeliveryService({
      writeGate: directWriteGate(db),
      transport: { isConnected: vi.fn(() => connected), sendCommand: vi.fn(send) },
      getDevice: (id) => getDevice(db, id),
      log: createLogger("gateway:test:completion-delivery"),
      now: () => now,
    });
  }

  it("delivers a task-identity wake only after the receiver has prepared it", async () => {
    queue();
    const commands: Array<{
      type: string;
      payload:
        | WsRequestPayload<"answer-completion.prepare">
        | WsRequestPayload<"answer-completion.commit">;
      scope: Scope | undefined;
    }> = [];
    const delivery = service((_deviceId, type, payload, _timeout, scope) => {
      commands.push({ type, payload, scope });
      if (type === "answer-completion.prepare") {
        return { status: "prepared", preparedAt: now, duplicate: false };
      }
      return {
        status: "accepted",
        acceptedAt: now + 1,
        localRunId: "run-fictional",
        duplicate: false,
      };
    });

    await expect(delivery.drainOnce()).resolves.toBe(1);
    expect(commands.map((command) => command.type)).toEqual([
      "answer-completion.prepare",
      "answer-completion.commit",
    ]);
    expect(commands.every((command) => command.scope === SCOPE_SUBSCRIPTIONS_RECEIVE)).toBe(true);
    const prepare = commands[0]!.payload as WsRequestPayload<"answer-completion.prepare">;
    expect(prepare).toMatchObject({
      taskId: "task_completion",
      nativeConversationId: "native-fictional",
    });
    expect(
      db
        .prepare("SELECT status, local_run_id FROM answer_completion_deliveries WHERE id = ?")
        .get("delivery_completion"),
    ).toEqual({ status: "delivered", local_run_id: "run-fictional" });
  });

  it.each(["prepare", "stale", "commit"] as const)(
    "keeps the task-only completion retry-safe after a %s failure",
    async (failure) => {
      queue();
      const delivery = service((_deviceId, type, payload) => {
        if (type === "answer-completion.prepare") {
          if (failure === "prepare") throw new Error("injected prepare failure");
          if (failure === "stale") {
            db.prepare(
              "UPDATE answer_completion_deliveries SET claim_id = 'different-claim' WHERE id = ?",
            ).run("delivery_completion");
          }
          return { status: "prepared", preparedAt: now, duplicate: false };
        }
        if (failure === "commit") throw new Error("injected commit failure");
        return {
          status: "accepted",
          acceptedAt: now + 1,
          localRunId: "run-fictional",
          duplicate: false,
        };
      });

      await expect(delivery.drainOnce()).resolves.toBe(1);

      expect(
        db
          .prepare("SELECT status FROM answer_completion_deliveries WHERE id = ?")
          .get("delivery_completion"),
      ).toEqual({ status: failure === "stale" ? "claimed" : "retry" });
    },
  );

  it("backs off offline delivery across hours instead of abandoning it after seconds", async () => {
    queue();
    const send = vi.fn();
    const delivery = service(send, false);
    for (let attempt = 0; attempt < 9; attempt += 1) {
      await delivery.drainOnce();
      now = db
        .prepare<
          { next_attempt_at: number },
          []
        >("SELECT next_attempt_at FROM answer_completion_deliveries WHERE id = 'delivery_completion'")
        .get()!.next_attempt_at;
    }
    expect(
      db
        .prepare("SELECT status, attempts FROM answer_completion_deliveries WHERE id = ?")
        .get("delivery_completion"),
    ).toEqual({ status: "retry", attempts: 9 });
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps a completed answer queued while its integration is offline", async () => {
    queue("denied");
    const send = vi.fn();
    await expect(service(send, false).drainOnce()).resolves.toBe(1);
    expect(send).not.toHaveBeenCalled();
    expect(
      db
        .prepare(
          "SELECT status, attempts, last_error FROM answer_completion_deliveries WHERE id = ?",
        )
        .get("delivery_completion"),
    ).toEqual({ status: "retry", attempts: 1, last_error: "integration offline" });
  });

  it("keeps a completion queued while the integration still speaks protocol v3", async () => {
    queue();
    updateDeviceCapabilities(db, deviceId, {
      agentIntegration: {
        harness: "openclaw",
        deliveryProtocolMin: 3,
        deliveryProtocolMax: 3,
        maxConcurrentRuns: 1,
      },
    });
    const send = vi.fn();
    await expect(service(send).drainOnce()).resolves.toBe(1);
    expect(send).not.toHaveBeenCalled();
    expect(
      db
        .prepare(
          "SELECT status, attempts, last_error FROM answer_completion_deliveries WHERE id = ?",
        )
        .get("delivery_completion"),
    ).toEqual({
      status: "retry",
      attempts: 1,
      last_error: "integration does not support answer completion delivery",
    });
  });
});
