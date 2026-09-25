// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, test, vi } from "vitest";
import { DeviceId, type DeviceRecord } from "@omnesis/types";
import { APNS_WAKE_JSON, FCM_WAKE_DATA } from "@omnesis/core/push";
import { sendAgentAnswerPush } from "../agent/answer-push.js";
import { ConversationNotifier } from "../agent/conversation-notifier.js";
import { sendDigestPush } from "../brain/digest-push.js";
import { PrivacyApprovalNotifier } from "../privacy/approval-notifier.js";
import { NotifyRunner } from "../watch/notify-runner.js";
import { PushBroadcaster } from "./broadcast.js";
import { NeedsAuthNotifier } from "./producers/needs-auth.js";
import {
  claimNotification,
  createNotificationQueueTables,
  enqueueNotification,
  leaseNotificationWakes,
  settleNotificationWake,
} from "./queue.js";
import { ApnsClient } from "./transports/direct-apns.js";
import { FcmClient } from "./transports/direct-fcm.js";
import type { NotificationMessage } from "@omnesis/core/push";
import type { ApnsTransport } from "./transports/apns-http2.js";
import type { ApnsWake } from "./transports/apns-types.js";

const databases: Database.Database[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));

function id(n: number) {
  return DeviceId(`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`);
}

function makeDb(deviceIds: readonly DeviceId[]): Database.Database {
  const db = new Database(":memory:");
  databases.push(db);
  db.pragma("foreign_keys = ON");
  db.exec("CREATE TABLE devices (id TEXT PRIMARY KEY)");
  const insert = db.prepare("INSERT INTO devices (id) VALUES (?)");
  for (const deviceId of deviceIds) insert.run(deviceId);
  createNotificationQueueTables(db);
  return db;
}

function notificationQueue(db: Database.Database) {
  return {
    enqueueNotification: async (input: Parameters<typeof enqueueNotification>[1]) =>
      enqueueNotification(db, input),
    leaseNotificationWakes: async (input: Parameters<typeof leaseNotificationWakes>[1]) =>
      leaseNotificationWakes(db, input),
    settleNotificationWake: async (input: Parameters<typeof settleNotificationWake>[1]) =>
      settleNotificationWake(db, input),
  };
}

function device(deviceId: DeviceId, patch: Partial<DeviceRecord>): DeviceRecord {
  return {
    id: deviceId,
    name: `Fictional phone ${deviceId.slice(-1)}`,
    kind: "ios",
    capabilities: {},
    pairedAt: 1,
    lastSeenAt: null,
    revokedAt: null,
    installId: null,
    version: null,
    versionSeenAt: null,
    protocolVersion: null,
    desiredVersion: null,
    updateState: null,
    updateDetail: null,
    updateStateAt: null,
    selfEmails: [],
    selfPhones: [],
    accessLevelId: null,
    apnsRegistration: null,
    fcmRegistration: null,
    pushTransport: null,
    relayUrl: null,
    relayCredential: null,
    notificationDeliveryHealth: "healthy",
    notificationDeliveryHealthUpdatedAt: 1,
    ...patch,
  };
}

describe("PushBroadcaster", () => {
  test("caps a notification row at a producer-specific expiry", async () => {
    const enqueueNotification = vi.fn(async () => ({
      notificationId: "notification-1",
      deliveryIds: [],
      deviceIds: [],
    }));
    const broadcaster = new PushBroadcaster({
      queue: {
        enqueueNotification,
        leaseNotificationWakes: vi.fn(async () => []),
        settleNotificationWake: vi.fn(),
      },
      listDevices: () => [],
      apnsClient: null,
      fcmClient: null,
      relayClient: { wake: vi.fn() },
      socket: null,
      now: () => 1_000,
      ttlMs: 10_000,
    });

    await broadcaster.publish(
      {
        kind: "access-authorization",
        title: "Access request waiting",
        body: "Enter the displayed code in Omnesis.",
        data: {},
        collapseId: "access:authorization",
      },
      undefined,
      { expiresAt: 1_500 },
    );

    expect(enqueueNotification).toHaveBeenCalledWith(
      expect.objectContaining({ createdAt: 1_000, expiresAt: 1_500 }),
    );
  });

  test("effective availability includes the live carrier client", () => {
    const apnsDevice = device(id(7), {
      pushTransport: "direct-apns",
      apnsRegistration: {
        deviceToken: "a".repeat(64),
        environment: "production",
        bundleId: "dev.example.ios",
        updatedAt: 1,
      },
    });
    const broadcaster = new PushBroadcaster({
      queue: {
        enqueueNotification: vi.fn(),
        leaseNotificationWakes: vi.fn(),
        settleNotificationWake: vi.fn(),
      },
      listDevices: () => [apnsDevice],
      apnsClient: null,
      fcmClient: null,
      relayClient: { wake: vi.fn() },
      socket: null,
    });

    expect(broadcaster.isAvailable(apnsDevice)).toBe(false);
  });

  test("reads per-device relay consent for every wake", async () => {
    const relayDeviceId = id(8);
    const db = makeDb([relayDeviceId]);
    let relayConsent: DeviceRecord["relayConsent"] = null;
    let relayUrl = "https://relay.example";
    const relayWake = vi.fn(async () => ({ ok: true as const, statusCode: 202 as const }));
    const broadcaster = new PushBroadcaster({
      queue: notificationQueue(db),
      listDevices: () => [
        device(relayDeviceId, {
          pushTransport: "relay",
          relayUrl: "https://relay.example",
          relayCredential: "relay-credential",
          relayConsent,
        }),
      ],
      apnsClient: null,
      fcmClient: null,
      relayClient: { wake: relayWake },
      socket: null,
      relayUrl: () => relayUrl,
      now: () => 900,
    });
    const message: NotificationMessage = {
      kind: "brief",
      title: "Fictional brief",
      body: "An invented summary is ready.",
      data: { briefId: "brief-relay-switch" },
      collapseId: "brief:relay-switch",
    };

    await expect(broadcaster.publish(message)).resolves.toEqual([
      expect.objectContaining({ transport: "unavailable", ok: false }),
    ]);
    expect(relayWake).not.toHaveBeenCalled();

    relayConsent = { appId: "dev.omnesis.ios", grantedAt: 1 };
    await expect(broadcaster.publish(message)).resolves.toEqual([
      expect.objectContaining({ transport: "relay", ok: true }),
    ]);
    expect(relayWake).toHaveBeenCalledTimes(1);

    relayUrl = "https://relay-new.example";
    await expect(broadcaster.publish(message)).resolves.toEqual([
      expect.objectContaining({ transport: "unavailable", ok: false }),
    ]);
    expect(relayWake).toHaveBeenCalledTimes(1);
  });

  test("one fan-out reaches mixed APNs, FCM, relay, socket, and unavailable devices", async () => {
    const deviceIds = [id(1), id(2), id(3), id(4), id(5)];
    const devices = [
      device(deviceIds[0]!, {
        pushTransport: "direct-apns",
        apnsRegistration: {
          deviceToken: "a".repeat(64),
          environment: "production",
          bundleId: "dev.example.ios",
          updatedAt: 1,
        },
      }),
      device(deviceIds[1]!, {
        kind: "android",
        pushTransport: "direct-fcm",
        fcmRegistration: { registrationToken: "fcm-token", updatedAt: 1 },
      }),
      device(deviceIds[2]!, {
        pushTransport: "relay",
        relayUrl: "https://relay.example",
        relayCredential: "relay-credential",
        relayConsent: { appId: "dev.omnesis.ios", grantedAt: 1 },
      }),
      device(deviceIds[3]!, { pushTransport: "socket" }),
      device(deviceIds[4]!, {}),
    ];
    const db = makeDb(deviceIds);
    const apnsSend = vi.fn(async (_wake: ApnsWake) => ({
      ok: true as const,
      statusCode: 200 as const,
      apnsId: null,
    }));
    const fcmSend = vi.fn(async () => ({ ok: true as const, name: null }));
    const relayWake = vi.fn(async () => ({ ok: true as const, statusCode: 202 as const }));
    const socketSend = vi.fn((_deviceId: DeviceId, _event: unknown) => true);
    const broadcaster = new PushBroadcaster({
      queue: notificationQueue(db),
      listDevices: () => devices,
      apnsClient: { send: apnsSend },
      fcmClient: { send: fcmSend },
      relayClient: { wake: relayWake },
      socket: {
        isConnected: (deviceId) => deviceId === deviceIds[3],
        sendEventToDevice: socketSend,
      },
      now: () => 1_000,
    });

    const results = await broadcaster.publish({
      kind: "brief",
      title: "Morning brief",
      body: "A fictional summary is ready.",
      data: { briefId: "brief-example" },
      collapseId: "brief",
    });

    expect(results.map((result) => [result.transport, result.ok])).toEqual([
      ["direct-apns", true],
      ["direct-fcm", true],
      ["relay", true],
      ["socket", true],
      ["unavailable", false],
    ]);
    expect(apnsSend).toHaveBeenCalledWith({
      deviceToken: "a".repeat(64),
      environment: "production",
      bundleId: "dev.example.ios",
    });
    expect(fcmSend).toHaveBeenCalledWith({ registrationToken: "fcm-token" });
    expect(relayWake).toHaveBeenCalledWith({
      relayUrl: "https://relay.example",
      relayCredential: "relay-credential",
    });
    expect(socketSend.mock.calls[0]?.[1]).toMatchObject({
      type: "push.available",
      payload: {},
    });
    for (const deviceId of deviceIds) {
      expect(claimNotification(db, { deviceId, now: 1_001 })?.title).toBe("Morning brief");
    }
  });

  test("every production producer yields identical content-free APNs and FCM bytes", async () => {
    const iosId = id(6);
    const androidId = id(9);
    const db = makeDb([iosId, androidId]);
    const ios = device(iosId, {
      pushTransport: "direct-apns",
      apnsRegistration: {
        deviceToken: "b".repeat(64),
        environment: "sandbox",
        bundleId: "dev.example.ios",
        updatedAt: 1,
      },
    });
    const android = device(androidId, {
      kind: "android",
      pushTransport: "direct-fcm",
      fcmRegistration: { registrationToken: "fcm-byte-token", updatedAt: 1 },
    });
    const tempDir = mkdtempSync(join(tmpdir(), "omnesis-carrier-bytes-"));
    const apnsKeyPath = join(tempDir, "AuthKey_Fictional.p8");
    writeFileSync(
      apnsKeyPath,
      generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({
        format: "pem",
        type: "pkcs8",
      }),
    );
    const serviceAccountPath = join(tempDir, "fictional-service-account.json");
    writeFileSync(
      serviceAccountPath,
      JSON.stringify({
        client_email: "push-sender@example.com",
        private_key: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
          format: "pem",
          type: "pkcs8",
        }),
        project_id: "fictional-project",
        token_uri: "https://oauth.example.com/token",
      }),
    );
    const apnsBodies: string[] = [];
    const apnsTransport: ApnsTransport = {
      request: async (request) => {
        apnsBodies.push(request.body);
        return { statusCode: 200, headers: {}, body: "" };
      },
      dispose: async () => undefined,
    };
    const fcmBodies: string[] = [];
    const fcmFetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
      if (String(input).includes("oauth.example.com")) {
        return Response.json({ access_token: "fictional-access-token", expires_in: 3_600 });
      }
      fcmBodies.push(String(init?.body));
      return Response.json({ name: "projects/fictional/messages/1" });
    };
    const apnsClient = new ApnsClient({
      config: {
        keyPath: apnsKeyPath,
        keyId: "ABCDE12345",
        teamId: "TEAM123456",
        bundleId: "dev.example.ios",
        environment: "production",
      },
      transport: apnsTransport,
    });
    const fcmClient = new FcmClient({
      config: { serviceAccountPath },
      fetchFn: fcmFetch,
      now: () => 2_000,
    });
    let clock = 2_000;
    const broadcaster = new PushBroadcaster({
      queue: notificationQueue(db),
      listDevices: () => [ios, android],
      apnsClient,
      fcmClient,
      relayClient: { wake: vi.fn() },
      socket: null,
      now: () => clock++,
    });
    try {
      await sendAgentAnswerPush(
        { publisher: broadcaster },
        { conversationId: "conversation-answer", answer: "A fictional answer." },
      );
      await new ConversationNotifier(broadcaster).notify({
        conversationId: "conversation-update",
        title: "Conversation update",
        body: "A fictional message arrived.",
      });
      await sendDigestPush(
        { publisher: broadcaster },
        { id: "brief-fictional", title: "Fictional brief", description: "Invented summary." },
        "2099-01-01",
      );
      await new NotifyRunner(broadcaster).run({
        watchId: "watch-fictional",
        watchName: "Fictional watch",
        firingKey: "firing-fictional",
        title: "Watch fired",
        body: "An invented condition matched.",
      });
      await new NeedsAuthNotifier({
        publisher: broadcaster,
        reserve: async () => "reservation",
        retain: async (_reservation, message, deviceIds) => {
          const retained = enqueueNotification(db, {
            message,
            deviceIds,
            createdAt: clock++,
            expiresAt: clock + 1_000,
          });
          return retained?.deviceIds ?? [];
        },
        release: async () => undefined,
        recover: async () => undefined,
        deviceName: () => "Fictional collector",
      }).notify({
        sourceId: "source-fictional",
        deviceId: id(9),
      });
      await new PrivacyApprovalNotifier(broadcaster).notify("approval-fictional");

      expect(apnsBodies).toEqual(Array(6).fill(APNS_WAKE_JSON));
      const exactFcmBytes = JSON.stringify({
        message: {
          token: "fcm-byte-token",
          data: FCM_WAKE_DATA,
          android: { priority: "high" },
        },
      });
      expect(fcmBodies).toEqual(Array(6).fill(exactFcmBytes));
      const carrierBytes = [...apnsBodies, ...fcmBodies].join("\n");
      for (const privateText of [
        "A fictional answer.",
        "A fictional message arrived.",
        "Invented summary.",
        "An invented condition matched.",
        "source-fictional",
        "approval-fictional",
      ]) {
        expect(carrierBytes).not.toContain(privateText);
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("retains content but does not contact a carrier for unclaimed registrations", async () => {
    const iosId = id(7);
    const androidId = id(8);
    const db = makeDb([iosId, androidId]);
    const apnsSend = vi.fn();
    const fcmSend = vi.fn();
    const broadcaster = new PushBroadcaster({
      queue: notificationQueue(db),
      listDevices: () => [
        device(iosId, {
          apnsRegistration: {
            deviceToken: "c".repeat(64),
            environment: "production",
            bundleId: "dev.example.ios",
            updatedAt: 1,
          },
        }),
        device(androidId, {
          kind: "android",
          fcmRegistration: { registrationToken: "fcm-token", updatedAt: 1 },
        }),
      ],
      apnsClient: { send: apnsSend },
      fcmClient: { send: fcmSend },
      relayClient: { wake: vi.fn() },
      socket: null,
      now: () => 3_000,
    });

    const result = await broadcaster.publish({
      kind: "agent-answer",
      title: "Fictional answer",
      body: "An invented answer is ready.",
      data: { conversationId: "conversation-fictional" },
      collapseId: "conversation:fictional",
    });

    expect(result).toEqual([
      expect.objectContaining({ deviceId: iosId, transport: "unavailable", ok: false }),
      expect.objectContaining({ deviceId: androidId, transport: "unavailable", ok: false }),
    ]);
    expect(apnsSend).not.toHaveBeenCalled();
    expect(fcmSend).not.toHaveBeenCalled();
    expect(claimNotification(db, { deviceId: iosId, now: 3_001 })?.title).toBe("Fictional answer");
    expect(claimNotification(db, { deviceId: androidId, now: 3_001 })?.title).toBe(
      "Fictional answer",
    );
  });
});
