// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Needs-auth re-auth reminder E2E coverage (#689).
 *
 * Boots a real gateway with fake APNs, pairs a fake iOS device, then drives
 * the same collector -> gateway `sync.status` events the production collector
 * emits when a provider connection's credentials expire. The backoff policy is
 * already unit-tested; this pins the over-the-wire integration: one push per
 * provider connection per device, exponential backoff persisted in SQLite,
 * and reset on a successful sync — by the device that recovered, with a
 * sibling member's success leaving a lapsed member's reminder in place.
 */

import "./synth-env.js";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  makeCommand,
  PROTOCOL_VERSION,
  websocketAuthProtocol,
  type WsEventPayload,
  type WsResponse,
} from "@omnesis/core";
import { APNS_WAKE_PAYLOAD } from "@omnesis/core/push";
import { SyntheticE2EHarness } from "./synth-harness.js";
import type { ReceivedApnsPush } from "./fake-apns.js";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const ACCOUNT_ID = "john.smith@example.com";
const PROVIDER_ID = `google:${ACCOUNT_ID}`;
const PRIMARY_SOURCE_TYPE = "gmail";
const SIBLING_SOURCE_TYPE = "google-calendar";
const PRIMARY_SOURCE_ID = `${PRIMARY_SOURCE_TYPE}:${ACCOUNT_ID}`;
const SIBLING_SOURCE_ID = `${SIBLING_SOURCE_TYPE}:${ACCOUNT_ID}`;
/** A second collector joined to the primary source as a member. */
const MEMBER_DEVICE_NAME = "Studio-Mini";

interface ClaimedDelivery {
  id: string;
  kind: string;
  targetId: string;
  title: string;
  body: string;
  collapseId: string;
}

interface ReauthReminderRow {
  principal: string;
  device_id: string;
  first_needed_at: number;
  last_notified_at: number;
  notify_count: number;
}

describe("needs-auth re-auth reminder backoff (fake APNs)", () => {
  let harness: SyntheticE2EHarness;
  let ws: WebSocket;
  let memberWs: WebSocket | undefined;
  let deviceToken: string;
  let authToken: string;
  let db: Database.Database;
  let ownerDeviceId: string;
  let ownerDeviceName: string;

  beforeAll(async () => {
    harness = new SyntheticE2EHarness({
      gatewayMode: "stable",
      universe: "e2e-minimal",
      apnsBackend: "fake",
    });
    await harness.start();
    ({ token: deviceToken, authToken } = await harness.registerFakeIosDevice());
    // Sync status is only accepted from a device that hosts the source, so
    // the socket speaks as the roster collector the harness attributed it to.
    const owner = harness.deviceForSource(PRIMARY_SOURCE_ID);
    ownerDeviceId = owner.deviceId;
    ownerDeviceName = owner.name;
    ws = await connectGatewayWs(harness, owner.token);
    db = new Database(harness.getDbPath());
  }, 120_000);

  afterAll(async () => {
    for (const socket of [ws, memberWs]) {
      try {
        socket?.close();
      } catch {
        /* best effort */
      }
    }
    try {
      db?.close();
    } catch {
      /* best effort */
    }
    await harness?.destroy();
  }, 15_000);

  test("one reminder per provider connection, backed off and reset after re-auth", async () => {
    emitNeedsAuth(ws, PRIMARY_SOURCE_ID);
    const firstPush = await waitForPushCount(harness, 1);
    expect(firstPush.deviceToken).toBe(deviceToken);
    expect(firstPush.headers["apns-collapse-id"]).toBeUndefined();
    expect(firstPush.payload).toEqual(APNS_WAKE_PAYLOAD);
    expectNeedsAuthNotification(await claimNotification(), PRIMARY_SOURCE_ID, ownerDeviceName);
    expect(readReminder(ownerDeviceId)?.notify_count).toBe(1);

    // Same provider connection, different source: the edge is observed, but
    // the persisted provider-principal gate suppresses a per-source duplicate.
    emitNeedsAuth(ws, SIBLING_SOURCE_ID);
    await expectNoAdditionalPushes(harness, 1);
    expect(readReminder(ownerDeviceId)?.notify_count).toBe(1);

    // First rung: one day after the immediate reminder.
    ageReminderBy(ownerDeviceId, ONE_DAY_MS - 1_000);
    emitNeedsAuth(ws, PRIMARY_SOURCE_ID);
    await expectNoAdditionalPushes(harness, 1);
    expect(readReminder(ownerDeviceId)?.notify_count).toBe(1);

    ageReminderBy(ownerDeviceId, ONE_DAY_MS + 1_000);
    emitNeedsAuth(ws, PRIMARY_SOURCE_ID);
    const secondPush = await waitForPushCount(harness, 2);
    expect(secondPush.payload).toEqual(APNS_WAKE_PAYLOAD);
    expectNeedsAuthNotification(await claimNotification(), PRIMARY_SOURCE_ID, ownerDeviceName);
    expect(readReminder(ownerDeviceId)?.notify_count).toBe(2);

    // Second rung: two days after the second reminder.
    ageReminderBy(ownerDeviceId, 2 * ONE_DAY_MS + 1_000);
    emitNeedsAuth(ws, PRIMARY_SOURCE_ID);
    const thirdPush = await waitForPushCount(harness, 3);
    expect(thirdPush.payload).toEqual(APNS_WAKE_PAYLOAD);
    expectNeedsAuthNotification(await claimNotification(), PRIMARY_SOURCE_ID, ownerDeviceName);
    expect(readReminder(ownerDeviceId)?.notify_count).toBe(3);

    // Recovery also revokes an already-claimed durable copy, not just the
    // backoff row. The expired episode cannot reappear after its lease ends.
    ageReminderBy(ownerDeviceId, 4 * ONE_DAY_MS + 1_000);
    emitNeedsAuth(ws, PRIMARY_SOURCE_ID);
    await waitForPushCount(harness, 4);
    const leased = await claimWithoutConfirm();
    emitCompleted(ws, PRIMARY_SOURCE_ID);
    await waitForReminderCleared(ownerDeviceId);
    expect(await confirmNotification(leased.id)).toBe(404);

    // A later expiry starts a distinct episode with an immediate first push.
    emitNeedsAuth(ws, PRIMARY_SOURCE_ID);
    const freshPush = await waitForPushCount(harness, 5);
    expect(freshPush.payload).toEqual(APNS_WAKE_PAYLOAD);
    expectNeedsAuthNotification(await claimNotification(), PRIMARY_SOURCE_ID, ownerDeviceName);
    expect(readReminder(ownerDeviceId)?.notify_count).toBe(1);
  }, 60_000);

  test("a member device's lapse is its own episode: named, backed off and reset per device", async () => {
    // Join a second collector to the primary source and speak as it. The
    // membership row is seeded straight into `source_devices`: gmail is
    // `exclusive` in the e2e-minimal universe, so the join endpoint would
    // refuse a second host, while sync-status ingest authorizes each event
    // by reading that table and accepts the member's reports all the same.
    const member = await harness.gatewayJson<{ device: { id: string }; token: string }>(
      "/admin/devices",
      {
        method: "POST",
        body: JSON.stringify({
          name: MEMBER_DEVICE_NAME,
          kind: "collector",
          scopes: ["write:*"],
        }),
      },
    );
    const memberDeviceId = member.device.id;
    db.prepare("INSERT INTO source_devices (source_id, device_id, added_at) VALUES (?, ?, ?)").run(
      PRIMARY_SOURCE_ID,
      memberDeviceId,
      Date.now(),
    );
    memberWs = await connectGatewayWs(harness, member.token);

    // The owner's episode from the previous test is still open (count 1);
    // the member's lapse is a distinct episode with its own immediate push.
    expect(readReminder(ownerDeviceId)?.notify_count).toBe(1);
    emitNeedsAuth(memberWs, PRIMARY_SOURCE_ID);
    const memberPush = await waitForPushCount(harness, 6);
    expect(memberPush.payload).toEqual(APNS_WAKE_PAYLOAD);
    const memberDelivery = await claimNotification();
    expectNeedsAuthNotification(memberDelivery, PRIMARY_SOURCE_ID, MEMBER_DEVICE_NAME);
    expect(readReminder(memberDeviceId)?.notify_count).toBe(1);
    expect(readReminder(ownerDeviceId)?.notify_count).toBe(1);

    // The owner re-auths: its own episode closes, the member's stays open.
    emitCompleted(ws, PRIMARY_SOURCE_ID);
    await waitForReminderCleared(ownerDeviceId);
    expect(readReminder(memberDeviceId)?.notify_count).toBe(1);
    // ...and the member's reminder is still inside its backoff window.
    emitNeedsAuth(memberWs, PRIMARY_SOURCE_ID);
    await expectNoAdditionalPushes(harness, 6);

    // The member re-auths: only now does its episode close.
    emitCompleted(memberWs, PRIMARY_SOURCE_ID);
    await waitForReminderCleared(memberDeviceId);
    expect(readReminder(ownerDeviceId)).toBeNull();
    // Nothing is left to deliver on the phone.
    expect((await fetchClaim()).status).toBe(204);
  }, 60_000);

  function emitNeedsAuth(socket: WebSocket, sourceId: string): void {
    emitSyncStatus(socket, {
      sourceId,
      providerId: PROVIDER_ID,
      state: "needs-auth",
      errorMessage: "needs reauth: token expired",
    });
  }

  function emitCompleted(socket: WebSocket, sourceId: string): void {
    emitSyncStatus(socket, {
      sourceId,
      providerId: PROVIDER_ID,
      state: "completed",
      completedAt: Date.now(),
    });
  }

  function emitSyncStatus(socket: WebSocket, payload: WsEventPayload<"sync.status">): void {
    socket.send(JSON.stringify({ kind: "event", type: "sync.status", payload }));
  }

  function readReminder(deviceId: string): ReauthReminderRow | null {
    return (
      db
        .prepare<
          [string, string],
          ReauthReminderRow
        >("SELECT * FROM reauth_reminders WHERE principal = ? AND device_id = ?")
        .get(PROVIDER_ID, deviceId) ?? null
    );
  }

  function ageReminderBy(deviceId: string, ageMs: number): void {
    db.prepare(
      "UPDATE reauth_reminders SET last_notified_at = ? WHERE principal = ? AND device_id = ?",
    ).run(Date.now() - ageMs, PROVIDER_ID, deviceId);
  }

  async function waitForReminderCleared(deviceId: string): Promise<void> {
    await waitForCondition(
      () => readReminder(deviceId) === null,
      `re-auth reminder row for ${deviceId} to clear`,
    );
  }

  async function claimNotification(): Promise<ClaimedDelivery> {
    const delivery = await claimWithoutConfirm();
    expect(await confirmNotification(delivery.id)).toBe(200);
    return delivery;
  }

  async function claimWithoutConfirm(): Promise<ClaimedDelivery> {
    const response = await fetchClaim();
    expect(response.status).toBe(200);
    return (await response.json()) as ClaimedDelivery;
  }

  function fetchClaim(): Promise<Response> {
    return fetch(`${harness.gatewayUrl}/notifications/claim`, {
      method: "POST",
      headers: { authorization: `Bearer ${authToken}`, "content-type": "application/json" },
      body: "{}",
    });
  }

  async function confirmNotification(id: string): Promise<number> {
    const confirm = await fetch(`${harness.gatewayUrl}/notifications/confirm`, {
      method: "POST",
      headers: { authorization: `Bearer ${authToken}`, "content-type": "application/json" },
      body: JSON.stringify({ id }),
    });
    return confirm.status;
  }
});

async function connectGatewayWs(harness: SyntheticE2EHarness, token: string): Promise<WebSocket> {
  const ws = new WebSocket(
    `wss://localhost:${harness.gatewayPort}/device/ws`,
    websocketAuthProtocol(token),
  );
  await waitForOpen(ws);
  const hello = makeCommand("hello", {
    token,
    capabilities: {},
    protocolVersion: PROTOCOL_VERSION,
  });
  ws.send(JSON.stringify(hello));
  const res = await waitForMessage<WsResponse>(
    ws,
    (msg): msg is WsResponse => msg.kind === "response" && msg.correlationId === hello.id,
  );
  if (!res.ok) throw new Error(`gateway WS hello failed: ${JSON.stringify(res.error)}`);
  return ws;
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("gateway WS open timeout")), 10_000);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("gateway WS failed to open"));
    });
  });
}

function waitForMessage<T>(
  ws: WebSocket,
  predicate: (msg: { kind?: string; correlationId?: string }) => msg is T,
  timeoutMs = 10_000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener("message", handler);
      reject(new Error("gateway WS message timeout"));
    }, timeoutMs);
    const handler = (event: MessageEvent) => {
      const parsed = JSON.parse(event.data as string) as { kind?: string; correlationId?: string };
      if (!predicate(parsed)) return;
      clearTimeout(timer);
      ws.removeEventListener("message", handler);
      resolve(parsed);
    };
    ws.addEventListener("message", handler);
  });
}

async function waitForPushCount(
  harness: SyntheticE2EHarness,
  count: number,
): Promise<ReceivedApnsPush> {
  await waitForCondition(
    () => harness.getApnsPushes().length === count,
    `${count} APNs push(es)`,
    10_000,
  );
  return harness.getApnsPushes()[count - 1]!;
}

async function expectNoAdditionalPushes(
  harness: SyntheticE2EHarness,
  count: number,
  timeoutMs = 10_000,
  pollMs = 25,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    expect(harness.getApnsPushes().length).toBe(count);
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

async function waitForCondition(
  fn: () => boolean,
  label: string,
  timeoutMs = 10_000,
  pollMs = 25,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

function expectNeedsAuthNotification(
  delivery: ClaimedDelivery,
  sourceId: string,
  deviceName: string,
): void {
  expect(delivery.title.trim()).not.toBe("");
  expect(delivery.body.trim()).not.toBe("");
  expect(delivery).toMatchObject({
    kind: "needs-auth",
    targetId: sourceId,
    title: "Re-auth needed",
    body: `Sign in again on ${deviceName} to keep ${PROVIDER_ID} syncing.`,
  });
  expect(delivery.collapseId).toMatch(/^needs-auth:[a-f0-9]{20}:[a-f0-9]{20}:[a-f0-9]{20}$/);
}
