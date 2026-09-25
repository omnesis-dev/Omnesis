// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, describe, expect, test, vi } from "vitest";
import { DeviceId, type DeviceRecord } from "@omnesis/types";
import { DEFAULT_PUSH_WAKE_RETRY_POLICY, PushBroadcaster } from "./broadcast.js";
import {
  allWatchNotificationWakeOutcomes,
  claimNotification,
  confirmNotification,
  createNotificationQueueTables,
  enqueueNotification,
  leaseNotificationWakes,
  settleNotificationWake,
  watchNotificationWakeOutcomes,
} from "./queue.js";

const databases: Database.Database[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));

const deviceId = DeviceId("00000000-0000-4000-8000-000000000301");

function setupDb(): Database.Database {
  const db = new Database(":memory:");
  databases.push(db);
  db.pragma("foreign_keys = ON");
  db.exec("CREATE TABLE devices (id TEXT PRIMARY KEY)");
  db.prepare("INSERT INTO devices (id) VALUES (?)").run(deviceId);
  createNotificationQueueTables(db);
  return db;
}

function phone(): DeviceRecord {
  return {
    id: deviceId,
    name: "Fictional retry phone",
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
    apnsRegistration: {
      deviceToken: "a".repeat(64),
      environment: "production",
      bundleId: "dev.example.ios",
      updatedAt: 1,
    },
    fcmRegistration: null,
    pushTransport: "direct-apns",
    relayUrl: null,
    relayCredential: null,
    notificationDeliveryHealth: "healthy",
    notificationDeliveryHealthUpdatedAt: 1,
  };
}

function queue(db: Database.Database) {
  return {
    enqueueNotification: async (input: Parameters<typeof enqueueNotification>[1]) =>
      enqueueNotification(db, input),
    leaseNotificationWakes: async (input: Parameters<typeof leaseNotificationWakes>[1]) =>
      leaseNotificationWakes(db, input),
    settleNotificationWake: async (input: Parameters<typeof settleNotificationWake>[1]) =>
      settleNotificationWake(db, input),
  };
}

describe("durable notification wake retry", () => {
  test("the default policy keeps retrying transient failures for at least one hour", async () => {
    const db = setupDb();
    const startedAt = 1_000;
    let now = startedAt;
    const send = vi.fn(() => Promise.reject(new Error("fictional maintenance outage")));
    const broadcaster = new PushBroadcaster({
      queue: queue(db),
      listDevices: () => [phone()],
      apnsClient: { send },
      fcmClient: null,
      relayClient: { wake: vi.fn() },
      socket: null,
      now: () => now,
    });

    await broadcaster.publish({
      kind: "brief",
      title: "Fictional maintenance brief",
      body: "An invented update is ready.",
      data: { briefId: "brief-maintenance-fictional" },
      collapseId: "brief:maintenance-fictional",
    });

    for (
      let completedAttempts = 1;
      completedAttempts < DEFAULT_PUSH_WAKE_RETRY_POLICY.maxAttempts;
      completedAttempts += 1
    ) {
      const delayMs = Math.min(
        DEFAULT_PUSH_WAKE_RETRY_POLICY.initialBackoffMs * 2 ** (completedAttempts - 1),
        DEFAULT_PUSH_WAKE_RETRY_POLICY.maxBackoffMs,
      );
      now += delayMs;
      await expect(broadcaster.retryDueWakes()).resolves.toEqual({ attempted: 1, succeeded: 0 });
    }

    expect(now - startedAt).toBe(60 * 60_000 + 15_000);
    expect(send).toHaveBeenCalledTimes(DEFAULT_PUSH_WAKE_RETRY_POLICY.maxAttempts);
    expect(
      db
        .prepare<
          [],
          { wake_state: string; wake_attempt_count: number }
        >("SELECT wake_state, wake_attempt_count FROM notification_deliveries")
        .get(),
    ).toEqual({
      wake_state: "exhausted",
      wake_attempt_count: DEFAULT_PUSH_WAKE_RETRY_POLICY.maxAttempts,
    });
  });

  test("fails twice, succeeds on the third wake, and content is claimed exactly once", async () => {
    const db = setupDb();
    let now = 1_000;
    let attempts = 0;
    const send = vi.fn(async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("fictional carrier outage");
      return { ok: true as const, statusCode: 200 as const, apnsId: null };
    });
    const broadcaster = new PushBroadcaster({
      queue: queue(db),
      listDevices: () => [phone()],
      apnsClient: { send },
      fcmClient: null,
      relayClient: { wake: vi.fn() },
      socket: null,
      now: () => now,
      ttlMs: 10_000,
      wakeRetry: {
        initialBackoffMs: 100,
        maxBackoffMs: 1_000,
        maxAttempts: 5,
        leaseMs: 50,
        batchSize: 10,
      },
    });

    await broadcaster.publish({
      kind: "watch",
      title: "Fictional retry watch",
      body: "An invented update is ready.",
      data: {
        watchId: "watch-retry-fictional",
        firingKey: "watch-retry-fictional:7",
        firingId: "fictional-full-firing-id",
      },
      collapseId: "watch:retry-fictional",
    });
    expect(send).toHaveBeenCalledTimes(1);

    now = 1_099;
    await expect(broadcaster.retryDueWakes()).resolves.toEqual({ attempted: 0, succeeded: 0 });
    now = 1_100;
    await expect(broadcaster.retryDueWakes()).resolves.toEqual({ attempted: 1, succeeded: 0 });
    now = 1_300;
    await expect(broadcaster.retryDueWakes()).resolves.toEqual({ attempted: 1, succeeded: 1 });

    expect(send).toHaveBeenCalledTimes(3);
    expect(
      db
        .prepare<
          [],
          { wake_state: string; wake_attempt_count: number; wake_last_error: string | null }
        >("SELECT wake_state, wake_attempt_count, wake_last_error FROM notification_deliveries")
        .get(),
    ).toEqual({ wake_state: "sent", wake_attempt_count: 3, wake_last_error: null });
    expect(watchNotificationWakeOutcomes(db, "watch-retry-fictional", now)).toEqual(
      new Map([
        [
          "fictional-full-firing-id",
          {
            watchId: "watch-retry-fictional",
            firingKey: "watch-retry-fictional:7",
            firingId: "fictional-full-firing-id",
            attempted: 3,
            delivered: 1,
            outstanding: 0,
            failed: 0,
          },
        ],
      ]),
    );
    expect(allWatchNotificationWakeOutcomes(db, now).get("watch-retry-fictional")).toEqual(
      watchNotificationWakeOutcomes(db, "watch-retry-fictional", now),
    );

    const claimed = claimNotification(db, { deviceId, now: 1_301 });
    expect(claimed?.title).toBe("Fictional retry watch");
    expect(confirmNotification(db, { deviceId, deliveryId: claimed!.id, now: 1_302 })).toBe(true);
    expect(claimNotification(db, { deviceId, now: 1_303 })).toBeNull();
  });

  test("an invalid carrier registration is terminal and is not retried", async () => {
    const db = setupDb();
    let now = 2_000;
    const send = vi.fn(async () => ({
      ok: false as const,
      statusCode: 410,
      reason: "Unregistered",
      rawBody: "",
      unregistered: true,
    }));
    const broadcaster = new PushBroadcaster({
      queue: queue(db),
      listDevices: () => [phone()],
      apnsClient: { send },
      fcmClient: null,
      relayClient: { wake: vi.fn() },
      socket: null,
      clearApnsRegistration: vi.fn(async () => {
        throw new Error("fictional writer outage");
      }),
      now: () => now,
      wakeRetry: { initialBackoffMs: 10, maxBackoffMs: 10, maxAttempts: 3 },
    });

    await broadcaster.publish({
      kind: "brief",
      title: "Fictional terminal brief",
      body: "An invented update is ready.",
      data: { briefId: "brief-terminal-fictional" },
      collapseId: "brief:terminal-fictional",
    });
    now += 1_000;
    await expect(broadcaster.retryDueWakes()).resolves.toEqual({ attempted: 0, succeeded: 0 });
    expect(send).toHaveBeenCalledOnce();
    expect(
      db
        .prepare<
          [],
          { wake_state: string; wake_last_error: string }
        >("SELECT wake_state, wake_last_error FROM notification_deliveries")
        .get(),
    ).toEqual({ wake_state: "terminal", wake_last_error: "carrier rejected registration" });
  });

  test("the production lease outlives an in-flight carrier dispatch", async () => {
    const db = setupDb();
    let now = 10_000;
    let finishSend: ((result: { ok: true; statusCode: 200; apnsId: null }) => void) | undefined;
    const send = vi.fn(
      () =>
        new Promise<{ ok: true; statusCode: 200; apnsId: null }>((resolve) => {
          finishSend = resolve;
        }),
    );
    const broadcaster = new PushBroadcaster({
      queue: queue(db),
      listDevices: () => [phone()],
      apnsClient: { send },
      fcmClient: null,
      relayClient: { wake: vi.fn() },
      socket: null,
      now: () => now,
    });

    const publishing = broadcaster.publish({
      kind: "brief",
      title: "Fictional in-flight brief",
      body: "An invented update is ready.",
      data: { briefId: "brief-in-flight-fictional" },
      collapseId: "brief:in-flight-fictional",
    });
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());

    // FCM's two bounded requests can approach 30 seconds end-to-end. The
    // 60-second production lease prevents a scheduler tick from duplicating it.
    now += 31_000;
    await expect(broadcaster.retryDueWakes()).resolves.toEqual({ attempted: 0, succeeded: 0 });
    expect(send).toHaveBeenCalledOnce();

    finishSend!({ ok: true, statusCode: 200, apnsId: null });
    await publishing;
  });

  test("a token rotated during an unregistered response is retried on the new token", async () => {
    const db = setupDb();
    let now = 20_000;
    let current = phone();
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false as const,
        statusCode: 410,
        reason: "Unregistered",
        rawBody: "",
        unregistered: true,
      })
      .mockResolvedValueOnce({ ok: true as const, statusCode: 200 as const, apnsId: null });
    const broadcaster = new PushBroadcaster({
      queue: queue(db),
      listDevices: () => [current],
      apnsClient: { send },
      fcmClient: null,
      relayClient: { wake: vi.fn() },
      socket: null,
      clearApnsRegistration: async (_id, expected) => {
        expect(expected.deviceToken).toBe("a".repeat(64));
        current = {
          ...current,
          apnsRegistration: { ...current.apnsRegistration!, deviceToken: "b".repeat(64) },
        };
        return false;
      },
      now: () => now,
      wakeRetry: { initialBackoffMs: 10, maxBackoffMs: 10, maxAttempts: 3 },
    });

    await broadcaster.publish({
      kind: "brief",
      title: "Fictional rotated-token brief",
      body: "An invented update is ready.",
      data: { briefId: "brief-rotated-token-fictional" },
      collapseId: "brief:rotated-token-fictional",
    });
    now += 10;
    await expect(broadcaster.retryDueWakes()).resolves.toEqual({ attempted: 1, succeeded: 1 });
    expect(send.mock.calls.map(([wake]) => wake.deviceToken)).toEqual([
      "a".repeat(64),
      "b".repeat(64),
    ]);
  });

  test("a socket disconnect during dispatch remains retryable", async () => {
    const db = setupDb();
    let now = 30_000;
    let accepts = false;
    const broadcaster = new PushBroadcaster({
      queue: queue(db),
      listDevices: () => [phone()],
      apnsClient: { send: vi.fn() },
      fcmClient: null,
      relayClient: { wake: vi.fn() },
      socket: { isConnected: () => true, sendEventToDevice: () => accepts },
      now: () => now,
      wakeRetry: { initialBackoffMs: 10, maxBackoffMs: 10, maxAttempts: 3 },
    });

    await broadcaster.publish({
      kind: "brief",
      title: "Fictional socket brief",
      body: "An invented update is ready.",
      data: { briefId: "brief-socket-disconnect-fictional" },
      collapseId: "brief:socket-disconnect-fictional",
    });
    expect(
      db
        .prepare<[], { wake_state: string }>("SELECT wake_state FROM notification_deliveries")
        .get(),
    ).toEqual({ wake_state: "pending" });
    accepts = true;
    now += 10;
    await expect(broadcaster.retryDueWakes()).resolves.toEqual({ attempted: 1, succeeded: 1 });
  });

  test("relay retry-after delays the next durable attempt", async () => {
    const db = setupDb();
    let now = 40_000;
    const relayWake = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false as const,
        statusCode: 429,
        reason: "rate limited",
        retryAfterMs: 3_600_000,
      })
      .mockResolvedValueOnce({ ok: true as const, statusCode: 202 as const });
    const relayPhone = {
      ...phone(),
      pushTransport: "relay" as const,
      apnsRegistration: null,
      relayUrl: "https://push.example.test",
      relayCredential: "credential-fictional",
      relayConsent: { appId: "dev.omnesis.ios", grantedAt: 1 },
    };
    const broadcaster = new PushBroadcaster({
      queue: queue(db),
      listDevices: () => [relayPhone],
      apnsClient: null,
      fcmClient: null,
      relayClient: { wake: relayWake },
      socket: null,
      relayUrl: "https://push.example.test",
      now: () => now,
    });
    await broadcaster.publish({
      kind: "brief",
      title: "Fictional rate-limited brief",
      body: "An invented update is ready.",
      data: { briefId: "brief-rate-limited-fictional" },
      collapseId: "brief:rate-limited-fictional",
    });
    now += 300_000;
    await expect(broadcaster.retryDueWakes()).resolves.toEqual({ attempted: 0, succeeded: 0 });
    now = 40_000 + 3_600_000;
    await expect(broadcaster.retryDueWakes()).resolves.toEqual({ attempted: 1, succeeded: 1 });
  });

  test("a relay credential rotated during rejection remains retryable", async () => {
    const db = setupDb();
    let now = 50_000;
    let current = {
      ...phone(),
      pushTransport: "relay" as const,
      apnsRegistration: null,
      relayUrl: "https://push.example.test",
      relayCredential: "credential-old-fictional",
      relayConsent: { appId: "dev.omnesis.ios", grantedAt: 1 },
    };
    let finishWake: ((result: { ok: false; statusCode: 401; reason: string }) => void) | undefined;
    const relayWake = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<{ ok: false; statusCode: 401; reason: string }>((resolve) => {
            finishWake = resolve;
          }),
      )
      .mockResolvedValueOnce({ ok: true as const, statusCode: 202 as const });
    const broadcaster = new PushBroadcaster({
      queue: queue(db),
      listDevices: () => [current],
      apnsClient: null,
      fcmClient: null,
      relayClient: { wake: relayWake },
      socket: null,
      relayUrl: "https://push.example.test",
      now: () => now,
      wakeRetry: { initialBackoffMs: 10, maxBackoffMs: 10, maxAttempts: 3 },
    });

    const publishing = broadcaster.publish({
      kind: "brief",
      title: "Fictional rotated-relay brief",
      body: "An invented update is ready.",
      data: { briefId: "brief-rotated-relay-fictional" },
      collapseId: "brief:rotated-relay-fictional",
    });
    await vi.waitFor(() => expect(relayWake).toHaveBeenCalledOnce());
    current = { ...current, relayCredential: "credential-new-fictional" };
    finishWake!({ ok: false, statusCode: 401, reason: "unauthorized" });
    await publishing;

    expect(
      db
        .prepare<[], { wake_state: string }>("SELECT wake_state FROM notification_deliveries")
        .get(),
    ).toEqual({ wake_state: "pending" });
    now += 10;
    await expect(broadcaster.retryDueWakes()).resolves.toEqual({ attempted: 1, succeeded: 1 });
    expect(relayWake.mock.calls.map(([wake]) => wake.relayCredential)).toEqual([
      "credential-old-fictional",
      "credential-new-fictional",
    ]);
  });

  test("wake ownership is leased once and stale settlement cannot reopen claimed content", () => {
    const db = setupDb();
    enqueueNotification(db, {
      message: {
        kind: "brief",
        title: "Fictional lease brief",
        body: "An invented update is ready.",
        data: { briefId: "brief-lease-fictional" },
        collapseId: "brief:lease-fictional",
      },
      deviceIds: [deviceId],
      createdAt: 3_000,
      expiresAt: 5_000,
    });

    const first = leaseNotificationWakes(db, {
      now: 3_000,
      leaseMs: 100,
      limit: 10,
      maxAttempts: 3,
    });
    expect(first).toHaveLength(1);
    expect(
      leaseNotificationWakes(db, {
        now: 3_050,
        leaseMs: 100,
        limit: 10,
        maxAttempts: 3,
      }),
    ).toEqual([]);

    const claimed = claimNotification(db, { deviceId, now: 3_060 });
    expect(claimed).not.toBeNull();
    expect(
      settleNotificationWake(db, {
        leaseToken: first[0]!.leaseToken,
        now: 3_070,
        transport: "direct-apns",
        outcome: "retry",
        reason: "late failure",
        nextAttemptAt: 3_100,
        maxAttempts: 3,
      }),
    ).toBe(false);
    expect(
      leaseNotificationWakes(db, {
        now: 3_200,
        leaseMs: 100,
        limit: 10,
        maxAttempts: 3,
      }),
    ).toEqual([]);
  });

  test("expired content cannot be leased and persisted wake errors are bounded", () => {
    const db = setupDb();
    enqueueNotification(db, {
      message: {
        kind: "brief",
        title: "Fictional expiry brief",
        body: "An invented update is ready.",
        data: { briefId: "brief-expiry-fictional" },
        collapseId: "brief:expiry-fictional",
      },
      deviceIds: [deviceId],
      createdAt: 4_000,
      expiresAt: 4_100,
    });
    const claim = leaseNotificationWakes(db, {
      now: 4_000,
      leaseMs: 50,
      limit: 1,
      maxAttempts: 3,
    })[0]!;
    expect(
      settleNotificationWake(db, {
        leaseToken: claim.leaseToken,
        now: 4_010,
        transport: "relay",
        outcome: "retry",
        reason: `unsafe\n${"x".repeat(1_000)}`,
        nextAttemptAt: 4_050,
        maxAttempts: 3,
      }),
    ).toBe(true);
    const stored = db
      .prepare<
        [],
        { wake_last_error: string }
      >("SELECT wake_last_error FROM notification_deliveries")
      .get()!.wake_last_error;
    expect(stored).toHaveLength(256);
    expect(stored).not.toContain("\n");

    expect(
      leaseNotificationWakes(db, {
        now: 4_100,
        leaseMs: 50,
        limit: 1,
        maxAttempts: 3,
      }),
    ).toEqual([]);
    expect(
      db.prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM notifications").get()!.count,
    ).toBe(0);
  });

  test("an abandoned lease is recovered after its deadline with one new owner", () => {
    const db = setupDb();
    enqueueNotification(db, {
      message: {
        kind: "brief",
        title: "Fictional crash brief",
        body: "An invented update is ready.",
        data: { briefId: "brief-crash-fictional" },
        collapseId: "brief:crash-fictional",
      },
      deviceIds: [deviceId],
      createdAt: 5_000,
      expiresAt: 10_000,
    });
    const abandoned = leaseNotificationWakes(db, {
      now: 5_000,
      leaseMs: 100,
      limit: 1,
      maxAttempts: 4,
    })[0]!;
    expect(
      leaseNotificationWakes(db, {
        now: 5_099,
        leaseMs: 100,
        limit: 1,
        maxAttempts: 4,
      }),
    ).toEqual([]);
    const recovered = leaseNotificationWakes(db, {
      now: 5_100,
      leaseMs: 100,
      limit: 1,
      maxAttempts: 4,
    });
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({ attempt: 2, deliveryId: abandoned.deliveryId });
    expect(recovered[0]!.leaseToken).not.toBe(abandoned.leaseToken);
  });

  test("the final transient failure exhausts the attempt budget", () => {
    const db = setupDb();
    enqueueNotification(db, {
      message: {
        kind: "brief",
        title: "Fictional exhausted brief",
        body: "An invented update is ready.",
        data: { briefId: "brief-exhausted-fictional" },
        collapseId: "brief:exhausted-fictional",
      },
      deviceIds: [deviceId],
      createdAt: 6_000,
      expiresAt: 12_000,
    });
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const now = 6_000 + attempt * 100;
      const leased = leaseNotificationWakes(db, {
        now,
        leaseMs: 50,
        limit: 1,
        maxAttempts: 3,
      });
      expect(leased[0]?.attempt).toBe(attempt);
      expect(
        settleNotificationWake(db, {
          leaseToken: leased[0]!.leaseToken,
          now,
          transport: "relay",
          outcome: "retry",
          reason: "transient relay outage",
          nextAttemptAt: now + 100,
          maxAttempts: 3,
        }),
      ).toBe(true);
    }
    expect(
      db
        .prepare<
          [],
          { wake_state: string; wake_attempt_count: number }
        >("SELECT wake_state, wake_attempt_count FROM notification_deliveries")
        .get(),
    ).toEqual({ wake_state: "exhausted", wake_attempt_count: 3 });
    expect(
      leaseNotificationWakes(db, {
        now: 7_000,
        leaseMs: 50,
        limit: 1,
        maxAttempts: 3,
      }),
    ).toEqual([]);
  });
});
