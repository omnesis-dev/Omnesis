// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { DEFAULT_PUSH_WAKE_RETRY_SETTINGS } from "@omnesis/config";
import { assertNever, createLogger, makeEvent } from "@omnesis/core";
import { selectPushTransport, type SelectedPushTransport } from "./select-transport.js";
import type { NotificationMessage } from "@omnesis/core/push";
import type { ApnsRegistration, DeviceId, DeviceRecord, FcmRegistration } from "@omnesis/types";
import type { WriteGate } from "../write-gate.js";
import type { ApnsClient } from "./transports/direct-apns.js";
import type { FcmClient } from "./transports/direct-fcm.js";
import type { RelayPushClient } from "./transports/relay.js";
import type { LeasedNotificationWake } from "./queue.js";

export const DEFAULT_NOTIFICATION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
export const DEFAULT_PUSH_WAKE_RETRY_POLICY = DEFAULT_PUSH_WAKE_RETRY_SETTINGS;
const log = createLogger("gateway:push:broadcast");

export interface PushWakeRetryPolicy {
  initialBackoffMs: number;
  maxBackoffMs: number;
  maxAttempts: number;
  leaseMs: number;
  batchSize: number;
}

export type PushDispatchResult =
  | { deviceId: DeviceId; transport: SelectedPushTransport["transport"]; ok: true }
  | {
      deviceId: DeviceId;
      transport: SelectedPushTransport["transport"];
      ok: false;
      reason: string;
      terminal?: true;
      retryAfterMs?: number;
    };

export interface PushBroadcasterOptions {
  queue: Pick<
    WriteGate,
    "enqueueNotification" | "leaseNotificationWakes" | "settleNotificationWake"
  >;
  listDevices: () => DeviceRecord[];
  apnsClient: Pick<ApnsClient, "send"> | null;
  fcmClient: Pick<FcmClient, "send"> | null;
  relayClient: Pick<RelayPushClient, "wake">;
  socket: {
    isConnected(deviceId: DeviceId): boolean;
    sendEventToDevice(deviceId: DeviceId, event: ReturnType<typeof makeEvent>): boolean;
  } | null;
  relayUrl?: string | (() => string);
  clearApnsRegistration?: (
    deviceId: DeviceId,
    expected: ApnsRegistration,
  ) => boolean | Promise<boolean>;
  clearFcmRegistration?: (
    deviceId: DeviceId,
    expected: FcmRegistration,
  ) => boolean | Promise<boolean>;
  now?: () => number;
  ttlMs?: number;
  wakeRetry?: Partial<PushWakeRetryPolicy> | (() => Partial<PushWakeRetryPolicy>);
  beforeWakeRetrySweep?: (now: number) => void | Promise<void>;
}

export interface NotificationPublisher {
  publish(
    message: NotificationMessage,
    targetDeviceIds?: readonly DeviceId[],
    options?: { expiresAt?: number },
  ): Promise<PushDispatchResult[]>;
  isAvailable?(device: DeviceRecord): boolean;
}

export interface DurableNotificationPublisher {
  retentionDeviceIds(targetDeviceIds?: readonly DeviceId[]): DeviceId[];
  wakeAuthorized(retainedDeviceIds: readonly DeviceId[]): Promise<PushDispatchResult[]>;
  isAvailable?(device: DeviceRecord): boolean;
}

/** Queue rendered content locally, then emit exactly one content-free wake per device. */
export class PushBroadcaster {
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(private readonly options: PushBroadcasterOptions) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? DEFAULT_NOTIFICATION_TTL_MS;
  }

  isAvailable(device: DeviceRecord): boolean {
    const selected = this.select(device);
    switch (selected.transport) {
      case "direct-apns":
        return this.options.apnsClient !== null;
      case "direct-fcm":
        return this.options.fcmClient !== null;
      case "relay":
      case "socket":
        return true;
      case "unavailable":
        return false;
      default:
        return assertNever(selected);
    }
  }

  async publish(
    message: NotificationMessage,
    targetDeviceIds?: readonly DeviceId[],
    options?: { expiresAt?: number },
  ): Promise<PushDispatchResult[]> {
    const targets = this.targets(targetDeviceIds);
    const createdAt = this.now();
    const enqueued = await this.options.queue.enqueueNotification({
      message,
      deviceIds: targets.map((device) => device.id),
      createdAt,
      expiresAt: Math.min(options?.expiresAt ?? Number.POSITIVE_INFINITY, createdAt + this.ttlMs),
    });
    const accepted = new Set(enqueued?.deviceIds ?? []);
    return await this.dispatchDueWakes([...accepted]);
  }

  retentionDeviceIds(targetDeviceIds?: readonly DeviceId[]): DeviceId[] {
    return this.targets(targetDeviceIds).map((device) => device.id);
  }

  async wakeAuthorized(retainedDeviceIds: readonly DeviceId[]): Promise<PushDispatchResult[]> {
    return await this.dispatchDueWakes(retainedDeviceIds);
  }

  /** Claim and dispatch a bounded batch of durable content-free wake work. */
  async retryDueWakes(): Promise<{ attempted: number; succeeded: number }> {
    try {
      await this.options.beforeWakeRetrySweep?.(this.now());
    } catch {
      log.warn("notification wake retry ledger reconciliation failed");
    }
    const results = await this.dispatchDueWakes();
    return { attempted: results.length, succeeded: results.filter((result) => result.ok).length };
  }

  private async dispatchDueWakes(deviceIds?: readonly DeviceId[]): Promise<PushDispatchResult[]> {
    if (deviceIds?.length === 0) return [];
    const wakeRetry = this.retryPolicy();
    const targetBatches = deviceIds
      ? Array.from({ length: Math.ceil(deviceIds.length / wakeRetry.batchSize) }, (_value, index) =>
          deviceIds.slice(index * wakeRetry.batchSize, (index + 1) * wakeRetry.batchSize),
        )
      : [undefined];
    const claims: LeasedNotificationWake[] = [];
    for (const targetBatch of targetBatches) {
      claims.push(
        ...(await this.options.queue.leaseNotificationWakes({
          now: this.now(),
          leaseMs: wakeRetry.leaseMs,
          limit: targetBatch?.length ?? wakeRetry.batchSize,
          maxAttempts: wakeRetry.maxAttempts,
          ...(targetBatch ? { deviceIds: targetBatch } : {}),
        })),
      );
    }
    return await Promise.all(claims.map((claim) => this.dispatchClaimedWake(claim)));
  }

  private async dispatchClaimedWake(claim: LeasedNotificationWake): Promise<PushDispatchResult> {
    const wakeRetry = this.retryPolicy();
    const device = this.options.listDevices().find((candidate) => candidate.id === claim.deviceId);
    const result = device
      ? await this.wake(device)
      : {
          deviceId: claim.deviceId,
          transport: "unavailable" as const,
          ok: false as const,
          reason: "device no longer exists",
          terminal: true as const,
        };
    const settledAt = this.now();
    if (result.ok) {
      await this.options.queue.settleNotificationWake({
        leaseToken: claim.leaseToken,
        now: settledAt,
        transport: result.transport,
        outcome: "sent",
      });
    } else if (result.terminal) {
      await this.options.queue.settleNotificationWake({
        leaseToken: claim.leaseToken,
        now: settledAt,
        transport: result.transport,
        outcome: "terminal",
        reason: this.safeFailureSummary(result),
      });
    } else {
      await this.options.queue.settleNotificationWake({
        leaseToken: claim.leaseToken,
        now: settledAt,
        transport: result.transport,
        outcome: "retry",
        reason: this.safeFailureSummary(result),
        nextAttemptAt:
          settledAt + Math.max(this.backoffMs(claim.attempt, wakeRetry), result.retryAfterMs ?? 0),
        maxAttempts: wakeRetry.maxAttempts,
      });
    }
    return result;
  }

  private retryPolicy(): PushWakeRetryPolicy {
    const configured =
      typeof this.options.wakeRetry === "function"
        ? this.options.wakeRetry()
        : this.options.wakeRetry;
    return { ...DEFAULT_PUSH_WAKE_RETRY_POLICY, ...configured };
  }

  private backoffMs(attempt: number, policy: PushWakeRetryPolicy): number {
    return Math.min(policy.initialBackoffMs * 2 ** Math.max(0, attempt - 1), policy.maxBackoffMs);
  }

  private safeFailureSummary(result: Extract<PushDispatchResult, { ok: false }>): string {
    switch (result.transport) {
      case "direct-apns":
      case "direct-fcm":
        return result.terminal ? "carrier rejected registration" : "carrier wake failed";
      case "relay":
        return result.terminal ? "relay rejected credential or request" : "relay wake failed";
      case "socket":
        return "socket wake failed";
      case "unavailable":
        return "push transport unavailable";
      default:
        return assertNever(result.transport);
    }
  }

  private targets(targetDeviceIds?: readonly DeviceId[]): DeviceRecord[] {
    return (
      this.options
        .listDevices()
        .filter((device) => device.kind === "ios" || device.kind === "android")
        // A revoked phone has its push registration cleared, but never target
        // it even if a registration were to linger.
        .filter((device) => !device.revokedAt)
        .filter(
          (device) =>
            device.notificationDeliveryHealth !== "not-determined" &&
            device.notificationDeliveryHealth !== "permission-denied" &&
            device.notificationDeliveryHealth !== "alerts-disabled",
        )
        .filter((device) => !targetDeviceIds || targetDeviceIds.includes(device.id))
    );
  }

  private async wake(device: DeviceRecord): Promise<PushDispatchResult> {
    const selected = this.select(device);
    try {
      switch (selected.transport) {
        case "socket":
          return this.options.socket?.sendEventToDevice(device.id, makeEvent("push.available", {}))
            ? { deviceId: device.id, transport: "socket", ok: true }
            : {
                deviceId: device.id,
                transport: "socket",
                ok: false,
                reason: "device socket disconnected before wake dispatch",
              };
        case "direct-apns": {
          if (!this.options.apnsClient)
            return this.unavailable(device.id, "APNs is not configured");
          const result = await this.options.apnsClient.send({
            deviceToken: selected.registration.deviceToken,
            environment: selected.registration.environment,
            bundleId: selected.registration.bundleId,
          });
          if (result.ok) return { deviceId: device.id, transport: "direct-apns", ok: true };
          const cleanup = result.unregistered
            ? await this.clearRejectedRegistration("APNs", device.id, selected.registration)
            : "not-needed";
          return {
            deviceId: device.id,
            transport: "direct-apns",
            ok: false,
            reason: result.reason,
            ...(result.unregistered && cleanup !== "changed" ? { terminal: true as const } : {}),
          };
        }
        case "direct-fcm": {
          if (!this.options.fcmClient) return this.unavailable(device.id, "FCM is not configured");
          const result = await this.options.fcmClient.send({
            registrationToken: selected.registration.registrationToken,
          });
          if (result.ok) return { deviceId: device.id, transport: "direct-fcm", ok: true };
          const cleanup = result.unregistered
            ? await this.clearRejectedRegistration("FCM", device.id, selected.registration)
            : "not-needed";
          return {
            deviceId: device.id,
            transport: "direct-fcm",
            ok: false,
            reason: result.reason,
            ...(result.unregistered && cleanup !== "changed" ? { terminal: true as const } : {}),
          };
        }
        case "relay": {
          const result = await this.options.relayClient.wake({
            relayUrl: selected.relayUrl,
            relayCredential: selected.credential,
          });
          const terminalStatus = [400, 401, 403, 410].includes(result.statusCode);
          const current = terminalStatus
            ? this.options.listDevices().find((candidate) => candidate.id === device.id)
            : undefined;
          const registrationChanged =
            current !== undefined &&
            (current.pushTransport !== "relay" ||
              current.relayUrl !== selected.relayUrl ||
              current.relayCredential !== selected.credential);
          return result.ok
            ? { deviceId: device.id, transport: "relay", ok: true }
            : {
                deviceId: device.id,
                transport: "relay",
                ok: false,
                reason: result.reason,
                ...(result.retryAfterMs === undefined ? {} : { retryAfterMs: result.retryAfterMs }),
                ...(terminalStatus && !registrationChanged ? { terminal: true as const } : {}),
              };
        }
        case "unavailable":
          return {
            deviceId: device.id,
            transport: "unavailable",
            ok: false,
            reason: selected.reason,
          };
        default:
          return assertNever(selected);
      }
    } catch (error) {
      return {
        deviceId: device.id,
        transport: selected.transport,
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private select(device: DeviceRecord): SelectedPushTransport {
    return selectPushTransport(device, {
      socketConnected: this.options.socket?.isConnected(device.id) ?? false,
      relayUrl:
        typeof this.options.relayUrl === "function"
          ? this.options.relayUrl()
          : this.options.relayUrl,
    });
  }

  private unavailable(deviceId: DeviceId, reason: string): PushDispatchResult {
    return { deviceId, transport: "unavailable", ok: false, reason };
  }

  private async clearRejectedRegistration(
    carrier: "APNs" | "FCM",
    deviceId: DeviceId,
    expected: ApnsRegistration | FcmRegistration,
  ): Promise<"cleared" | "changed" | "failed"> {
    try {
      const cleared =
        "deviceToken" in expected
          ? await this.options.clearApnsRegistration?.(deviceId, expected)
          : await this.options.clearFcmRegistration?.(deviceId, expected);
      if (cleared === undefined) return "failed";
      return cleared ? "cleared" : "changed";
    } catch {
      // Cleanup is best-effort. The carrier result remains terminal so a
      // transient database failure cannot create an endless retry loop.
      log.warn(`${carrier} rejected a push registration, but clearing it failed`);
      return "failed";
    }
  }
}
