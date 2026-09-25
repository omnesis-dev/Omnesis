// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  SCOPE_SUBSCRIPTIONS_RECEIVE,
  type DeviceId,
  type DeviceRecord,
  type Scope,
} from "@omnesis/types";
import { AGENT_INTEGRATION_DELIVERY_PROTOCOL_VERSION } from "../subscriptions/delivery.js";
import type { Logger, WsRequestPayload, WsResponsePayload } from "@omnesis/core";
import type { WriteGate } from "../write-gate.js";

const COMPLETION_DELIVERY_MAX_ATTEMPTS = 100;
const COMPLETION_DELIVERY_MAX_BACKOFF_MS = 15 * 60_000;

export interface AnswerCompletionTransport {
  isConnected(deviceId: DeviceId, scope: Scope): boolean;
  sendCommand<K extends "answer-completion.prepare" | "answer-completion.commit">(
    deviceId: DeviceId,
    type: K,
    payload: WsRequestPayload<K>,
    timeoutMs?: number,
    scope?: Scope,
  ): Promise<WsResponsePayload<K>>;
}

/** Drains terminal Answer notifications with the same two-phase boundary as subscription wakes. */
export class AnswerCompletionDeliveryService {
  constructor(
    private readonly deps: {
      writeGate: WriteGate;
      transport: AnswerCompletionTransport;
      getDevice: (id: DeviceId) => DeviceRecord | null;
      log: Logger;
      now?: () => number;
    },
  ) {}
  async drainOnce(): Promise<number> {
    const now = this.deps.now?.() ?? Date.now();
    const deliveries = await this.deps.writeGate.claimAnswerCompletionDeliveries({
      now,
      limit: 16,
      leaseMs: 60_000,
      // Exponential retry capped at 15 minutes keeps an offline agent's
      // completion available for roughly one day rather than abandoning it
      // during the approval window.
      maxAttempts: COMPLETION_DELIVERY_MAX_ATTEMPTS,
    });
    for (const delivery of deliveries) await this.deliver(delivery, now);
    return deliveries.length;
  }
  private async deliver(
    delivery: Awaited<ReturnType<WriteGate["claimAnswerCompletionDeliveries"]>>[number],
    now: number,
  ): Promise<void> {
    const deviceId = delivery.integrationDeviceId as DeviceId;
    const device = this.deps.getDevice(deviceId);
    const capability = device?.capabilities.agentIntegration;
    if (
      !device ||
      device.kind !== "agent" ||
      !capability ||
      // Protocol v4 is the identifier-only shape. Older versions expected
      // bearer material and must not receive a frame they would misinterpret.
      capability.deliveryProtocolMin > AGENT_INTEGRATION_DELIVERY_PROTOCOL_VERSION ||
      capability.deliveryProtocolMax < AGENT_INTEGRATION_DELIVERY_PROTOCOL_VERSION
    ) {
      await this.retry(delivery, now, "integration does not support answer completion delivery");
      return;
    }
    if (!this.deps.transport.isConnected(deviceId, SCOPE_SUBSCRIPTIONS_RECEIVE)) {
      await this.retry(delivery, now, "integration offline");
      return;
    }
    try {
      await this.deps.transport.sendCommand(
        deviceId,
        "answer-completion.prepare",
        {
          protocolVersion: AGENT_INTEGRATION_DELIVERY_PROTOCOL_VERSION,
          deliveryId: delivery.id,
          taskId: delivery.taskId,
          nativeConversationId: delivery.nativeConversationId,
        },
        30_000,
        SCOPE_SUBSCRIPTIONS_RECEIVE,
      );
      if (
        !(await this.deps.writeGate.authorizeAnswerCompletionDelivery({
          deliveryId: delivery.id,
          claimId: delivery.claimId,
          now: this.deps.now?.() ?? Date.now(),
        }))
      ) {
        await this.retry(delivery, now, "completion delivery became stale");
        return;
      }
      const accepted = await this.deps.transport.sendCommand(
        deviceId,
        "answer-completion.commit",
        {
          protocolVersion: AGENT_INTEGRATION_DELIVERY_PROTOCOL_VERSION,
          deliveryId: delivery.id,
        },
        30_000,
        SCOPE_SUBSCRIPTIONS_RECEIVE,
      );
      await this.deps.writeGate.settleAnswerCompletionDelivery({
        deliveryId: delivery.id,
        claimId: delivery.claimId,
        now: this.deps.now?.() ?? Date.now(),
        outcome: {
          kind: "delivered",
          acceptedAt: accepted.acceptedAt,
          localRunId: accepted.localRunId,
        },
      });
    } catch (error) {
      await this.retry(delivery, now, error instanceof Error ? error.message : String(error));
    }
  }
  private async retry(
    delivery: Awaited<ReturnType<WriteGate["claimAnswerCompletionDeliveries"]>>[number],
    now: number,
    error: string,
  ): Promise<void> {
    await this.deps.writeGate.settleAnswerCompletionDelivery({
      deliveryId: delivery.id,
      claimId: delivery.claimId,
      now,
      outcome: {
        kind: "retry",
        nextAttemptAt: now + completionDeliveryBackoffMs(delivery.attempt),
        error,
      },
    });
  }
}

export function completionDeliveryBackoffMs(attempt: number): number {
  const exponent = Math.max(0, Math.min(17, Math.floor(attempt) - 1));
  return Math.min(COMPLETION_DELIVERY_MAX_BACKOFF_MS, 5_000 * 2 ** exponent);
}
