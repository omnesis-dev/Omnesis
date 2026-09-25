// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Which network carries a content-free wake, and what a carrier's refusal
 * costs the device it refused.
 *
 * The gateway picks a wake's transport per attempt, at dispatch: a phone
 * holding a device WebSocket is woken over that socket and puts no bytes on
 * Apple's network, even though its row still carries a complete direct-APNs
 * registration. That is the privacy and cost claim of the push subsystem, and
 * it is invisible to any functional test, because the notification arrives
 * either way. The choice is also made after an asynchronous hop through the
 * writer worker that leases the wake, so the selection reads the device as it
 * is now, not as it was when the content was rendered — a phone that
 * foregrounds while its wake sits in the retry ladder finishes that same wake
 * over its socket.
 *
 * The other half is what a refusal means. `Unregistered` is a verdict about
 * one registration, not about the phone: the gateway compare-and-swaps away
 * exactly the registration the send used, marks that wake terminal so a dead
 * token is not retried, keeps the rendered content claimable, and selects the
 * carrier again as soon as the phone registers a new token — delivering the
 * wake that was queued while it had no transport.
 *
 * This needs a real gateway rather than a unit test: the selection reads a
 * WebSocket registry that exists only in the running process, the lease and
 * each settlement are separately dispatched writer-worker tasks, the
 * compare-and-swap is SQL against the exact registration the send used, and
 * the carrier verdicts arrive over a real HTTP/2 session to the fake APNs
 * server. The unit suites pin each half against stubs; nothing joins them.
 *
 * Three things to know when reading the assertions. Time is never waited out:
 * the retry backoff is configured far longer than the suite runs, so a parked
 * wake can only advance when the test rewrites its persisted deadline, which
 * makes every attempt count exact rather than a wall-clock bet. Claiming a
 * delivery rewrites its `wake_state` to 'sent' (`claimNotification`), so every
 * wake-ledger assertion is made before the content is claimed. And every
 * publish shares the collapse id `push-test`, so each new publish supersedes
 * that device's previous unclaimed delivery — which is what keeps
 * `leaseNotificationWakes`, whose `device_rank = 1` picks the oldest due
 * delivery for a device rather than the one just enqueued, pointed at the
 * delivery the test is talking about.
 */

import "./synth-env.js";
import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  isWsEvent,
  isWsResponse,
  makeCommand,
  PROTOCOL_VERSION,
  websocketAuthProtocol,
  type WsResponse,
} from "@omnesis/core";
import { APNS_WAKE_PAYLOAD } from "@omnesis/core/push";
import { SyntheticE2EHarness } from "./synth-harness.js";
import { waitForCondition } from "./multi-collector-harness.js";

/** How the fake APNs server answers a push, keyed by the token it was sent to. */
type ApnsMode = "ok" | "unavailable" | "unregistered";

/**
 * Far longer than the whole suite runs, so a settled retry parks until a test
 * rewrites its deadline. Nothing in this file advances a ladder by waiting.
 */
const PARK_MS = 60 * 60_000;
/** Retry sweep cadence, so a deadline the test brings forward fires promptly. */
const SWEEP_MS = 250;
const MAX_ATTEMPTS = 8;
const BUNDLE_ID = "dev.omnesis.ios";
const COLLAPSE_ID = "push-test";

const apnsMode = new Map<string, ApnsMode>();

interface Phone {
  name: string;
  deviceId: string;
  token: string;
  authToken: string;
}

interface DeliveryRow {
  id: string;
  state: string;
  wake_state: string;
  wake_attempt_count: number;
  wake_next_attempt_at: number | null;
  wake_last_error: string | null;
  wake_last_transport: string | null;
  claimed_at: number | null;
}

interface DeviceRow {
  apns_device_token: string | null;
  apns_environment: string | null;
  apns_bundle_id: string | null;
  apns_token_updated_at: number | null;
  push_transport: string | null;
}

interface NotifyResult {
  status: string;
  attempted: number;
  delivered: number;
}

interface AdminDevice {
  id: string;
  kind: string;
  online: boolean;
}

interface PushStatus {
  devices: {
    directApns: number;
    deliveryHealth: Array<{
      id: string;
      transport: string | null;
      available: boolean;
      queue: { wake: { lastTransport: string | null } };
    }>;
  };
}

interface ClaimedDelivery {
  id: string;
  kind: string;
  collapseId: string;
  title: string;
}

interface PhoneSocket {
  ws: WebSocket;
  /** Every `push.available` frame this socket received, in arrival order. */
  wakes: unknown[];
}

describe("push transport selection and carrier fan-out (fake APNs)", () => {
  let harness: SyntheticE2EHarness;
  let readDb: Database.Database;
  let writeDb: Database.Database;
  let socketPhone: Phone;
  let ladderPhone: Phone;
  let retryPhone: Phone;
  let doomedPhone: Phone;
  let healthyPhone: Phone;
  let phones: Phone[];
  let openSockets: PhoneSocket[] = [];

  beforeAll(async () => {
    harness = new SyntheticE2EHarness({
      gatewayMode: "stable",
      universe: "e2e-minimal",
      apnsBackend: "fake",
      fakeApnsOptions: {
        // Fixed at construction, before any token exists, so it reads a table
        // the tests rewrite between publishes.
        respond: (push) => {
          switch (apnsMode.get(push.deviceToken) ?? "ok") {
            case "unregistered":
              return { statusCode: 410, reason: "Unregistered" };
            case "unavailable":
              return { statusCode: 503, reason: "ServiceUnavailable" };
            default:
              return { statusCode: 200 };
          }
        },
      },
      extraGatewayConfig: {
        gateway: {
          pushWakeRetry: {
            initialBackoffMs: PARK_MS,
            maxBackoffMs: PARK_MS,
            maxAttempts: MAX_ATTEMPTS,
            leaseMs: 60_000,
            batchSize: 50,
            intervalMs: SWEEP_MS,
            idleIntervalMs: SWEEP_MS,
          },
        },
      },
    });
    await harness.start();
    socketPhone = await registerPhone("Maya-iPhone");
    ladderPhone = await registerPhone("Jamie-iPhone");
    retryPhone = await registerPhone("Dana-iPhone");
    doomedPhone = await registerPhone("Kai-iPhone");
    healthyPhone = await registerPhone("Rowan-iPhone");
    phones = [socketPhone, ladderPhone, retryPhone, doomedPhone, healthyPhone];
    readDb = new Database(harness.getDbPath(), { readonly: true });
    writeDb = new Database(harness.getDbPath());
    writeDb.pragma("busy_timeout = 10000");
  }, 180_000);

  afterAll(async () => {
    for (const socket of openSockets) {
      try {
        socket.ws.close();
      } catch {
        /* best effort */
      }
    }
    openSockets = [];
    try {
      readDb?.close();
    } catch {
      /* best effort */
    }
    try {
      writeDb?.close();
    } catch {
      /* best effort */
    }
    await harness?.destroy();
  }, 30_000);

  test("a phone holding its socket is woken over it and puts nothing on APNs, and falls back to the carrier once the socket is gone", async () => {
    // The claim under test is a choice between two working transports, so
    // the carrier registration must be intact and unused before the socket
    // opens. Otherwise "no APNs traffic" would be true for a boring reason.
    expect(deviceRow(socketPhone.deviceId)).toMatchObject({
      apns_device_token: socketPhone.token,
      apns_bundle_id: BUNDLE_ID,
      push_transport: "direct-apns",
    });
    expect(pushesFor(socketPhone.token)).toBe(0);

    const socket = await openPhoneSocket(socketPhone);
    const overSocket = await publishTest(socketPhone.deviceId);
    expect(overSocket.result).toMatchObject({ status: "ok", attempted: 1, delivered: 1 });

    const socketDeliveryId = await settle(
      overSocket.notificationId,
      socketPhone.deviceId,
      (row) => row.wake_state === "sent",
    );
    expect(deliveryById(socketDeliveryId)).toMatchObject({
      state: "pending",
      wake_state: "sent",
      wake_attempt_count: 1,
      wake_last_transport: "socket",
    });
    // The whole point: the notification arrived, and Apple never heard of it.
    expect(pushesFor(socketPhone.token)).toBe(0);
    await waitForCondition(() => socket.wakes.length === 1, 10_000, "one push.available frame");
    expect(socket.wakes[0]).toEqual({});
    // The registration the selection declined to use is still on the row.
    expect(deviceRow(socketPhone.deviceId)).toMatchObject({
      apns_device_token: socketPhone.token,
      push_transport: "direct-apns",
    });

    await closePhoneSocket(socketPhone, socket);
    const overCarrier = await publishTest(socketPhone.deviceId);
    expect(overCarrier.result).toMatchObject({ status: "ok", attempted: 1, delivered: 1 });
    const carrierDeliveryId = await settle(
      overCarrier.notificationId,
      socketPhone.deviceId,
      (row) => row.wake_state === "sent",
    );
    expect(carrierDeliveryId).not.toBe(socketDeliveryId);
    expect(deliveryById(carrierDeliveryId)).toMatchObject({
      wake_state: "sent",
      wake_attempt_count: 1,
      wake_last_transport: "direct-apns",
    });
    expect(pushesFor(socketPhone.token)).toBe(1);
    expect(socket.wakes).toHaveLength(1);

    const carried = harness.getApnsPushes().filter((p) => p.deviceToken === socketPhone.token);
    expect(carried[0]?.headers["apns-topic"]).toBe(BUNDLE_ID);
    expect(carried[0]?.payload).toEqual(APNS_WAKE_PAYLOAD);
  }, 60_000);

  test("a phone that foregrounds while its wake is parked finishes that same wake over the socket, not the carrier", async () => {
    apnsMode.set(ladderPhone.token, "unavailable");
    const published = await publishTest(ladderPhone.deviceId);
    expect(published.result).toMatchObject({
      status: "exit-non-zero",
      attempted: 1,
      delivered: 0,
    });

    // Precondition for everything below: attempt 1 really went to the
    // carrier, really failed, and really parked — with a reason that names
    // no carrier detail.
    const deliveryId = await settle(
      published.notificationId,
      ladderPhone.deviceId,
      (row) => row.wake_state === "pending" && row.wake_last_transport !== null,
    );
    const parked = deliveryById(deliveryId);
    expect(parked).toMatchObject({
      wake_state: "pending",
      wake_attempt_count: 1,
      wake_last_transport: "direct-apns",
      wake_last_error: "carrier wake failed",
    });
    expect(pushesFor(ladderPhone.token)).toBe(1);
    // The ladder cannot advance on its own within this suite, so the second
    // attempt below is the one the test releases, at a moment it chooses.
    expect(parked.wake_next_attempt_at).not.toBeNull();
    expect(parked.wake_next_attempt_at!).toBeGreaterThan(Date.now() + PARK_MS / 2);

    const socket = await openPhoneSocket(ladderPhone);
    releaseParkedWake(deliveryId);

    await waitForCondition(
      () => {
        const row = deliveryById(deliveryId);
        return row.wake_state === "sent" && row.wake_last_transport === "socket";
      },
      20_000,
      "the parked wake to finish over the socket",
    );
    // One delivery, two attempts, one carrier request: the transport was
    // re-selected at dispatch rather than captured when the wake was queued.
    expect(deliveryById(deliveryId)).toMatchObject({
      wake_state: "sent",
      wake_attempt_count: 2,
      wake_last_transport: "socket",
    });
    expect(pushesFor(ladderPhone.token)).toBe(1);
    await waitForCondition(() => socket.wakes.length === 1, 10_000, "one push.available frame");
    expect(socket.wakes[0]).toEqual({});

    // Leave the phone as the next test needs it: offline and answerable, so
    // its ladder cannot bleed carrier requests into the fan-out counts.
    await closePhoneSocket(ladderPhone, socket);
    apnsMode.set(ladderPhone.token, "ok");
  }, 60_000);

  test("one fan-out, three carrier verdicts: each ladder settles on its own, an Unregistered token is retired on that device alone, and a re-registered phone receives the wake queued while it had none", async () => {
    apnsMode.set(retryPhone.token, "unavailable");
    apnsMode.set(doomedPhone.token, "unregistered");
    apnsMode.set(healthyPhone.token, "ok");

    // Every registered phone must be off its socket, or the fan-out's
    // carrier-byte accounting would be measuring the wrong thing.
    await waitForCondition(
      async () => {
        const items = await adminDevices();
        return phones.every((phone) => items.some((d) => d.id === phone.deviceId && !d.online));
      },
      20_000,
      "every registered phone offline",
    );
    // The universe roster contributes an iPhone and an Android that never
    // registered for push — free `unavailable` targets in the same fan-out.
    const allPhones = (await adminDevices()).filter(
      (d) => d.kind === "ios" || d.kind === "android",
    );
    const rosterPhoneIds = allPhones
      .map((d) => d.id)
      .filter((id) => !phones.some((phone) => phone.deviceId === id));
    expect(rosterPhoneIds.length).toBeGreaterThan(0);
    expect(deviceRow(doomedPhone.deviceId)).toMatchObject({
      apns_device_token: doomedPhone.token,
      apns_environment: "production",
      apns_bundle_id: BUNDLE_ID,
      push_transport: "direct-apns",
    });

    const baseline = new Map(phones.map((phone) => [phone.token, pushesFor(phone.token)]));
    const pushesBefore = harness.getApnsPushes().length;
    const fanOut = await publishTest();
    // Every phone the gateway knows is attempted; the three the fake answers
    // 200 for are delivered, and the 503, the 410 and the two unregistered
    // roster phones are not.
    expect(fanOut.result).toMatchObject({
      status: "exit-non-zero",
      attempted: allPhones.length,
      delivered: phones.length - 2,
    });

    const fanOutId = new Map<string, string>();
    for (const deviceId of [...phones.map((p) => p.deviceId), ...rosterPhoneIds]) {
      fanOutId.set(
        deviceId,
        await settle(
          fanOut.notificationId,
          deviceId,
          (row) => row.wake_state !== "leased" && row.wake_last_transport !== null,
        ),
      );
    }

    // Three concurrent verdicts on one notification, three independent
    // outcomes on three rows.
    expect(deliveryById(fanOutId.get(healthyPhone.deviceId)!)).toMatchObject({
      wake_state: "sent",
      wake_attempt_count: 1,
      wake_last_transport: "direct-apns",
    });
    expect(deliveryById(fanOutId.get(doomedPhone.deviceId)!)).toMatchObject({
      state: "pending",
      wake_state: "terminal",
      wake_attempt_count: 1,
      wake_last_transport: "direct-apns",
      wake_last_error: "carrier rejected registration",
    });
    const retryRow = deliveryById(fanOutId.get(retryPhone.deviceId)!);
    expect(retryRow).toMatchObject({
      wake_state: "pending",
      wake_attempt_count: 1,
      wake_last_transport: "direct-apns",
      wake_last_error: "carrier wake failed",
    });
    expect(retryRow.wake_next_attempt_at).not.toBeNull();

    // A phone that never registered is dispatched and deferred, not written
    // off — and costs nothing on the carrier.
    for (const rosterId of rosterPhoneIds) {
      const row = deliveryById(fanOutId.get(rosterId)!);
      expect(row.wake_last_transport).toBe("unavailable");
      expect(row.wake_last_error).toBe("push transport unavailable");
      expect(row.wake_attempt_count).toBeGreaterThanOrEqual(1);
    }
    for (const phone of phones) {
      expect(pushesFor(phone.token)).toBe(baseline.get(phone.token)! + 1);
    }
    expect(harness.getApnsPushes().length - pushesBefore).toBe(phones.length);

    // The compare-and-swap landed on exactly the registration the refused
    // send used, and on nothing else.
    await waitForCondition(
      () => deviceRow(doomedPhone.deviceId).apns_device_token === null,
      10_000,
      "the rejected APNs registration to be retired",
    );
    expect(deviceRow(doomedPhone.deviceId)).toEqual({
      apns_device_token: null,
      apns_environment: null,
      apns_bundle_id: null,
      apns_token_updated_at: null,
      push_transport: null,
    });
    for (const sibling of [retryPhone, healthyPhone, socketPhone, ladderPhone]) {
      expect(deviceRow(sibling.deviceId)).toMatchObject({
        apns_device_token: sibling.token,
        apns_bundle_id: BUNDLE_ID,
        push_transport: "direct-apns",
      });
    }
    const cleared = await pushStatus();
    expect(cleared.devices.directApns).toBe(phones.length - 1);
    expect(deliveryHealth(cleared, doomedPhone.deviceId)).toMatchObject({
      transport: null,
      available: false,
      queue: { wake: { lastTransport: "direct-apns" } },
    });

    // The transient failure recovers on its own ladder; the terminal one is
    // not retried, and the phone that succeeded is not touched again.
    apnsMode.set(retryPhone.token, "ok");
    releaseParkedWake(fanOutId.get(retryPhone.deviceId)!);
    await waitForCondition(
      () => deliveryById(fanOutId.get(retryPhone.deviceId)!).wake_state === "sent",
      20_000,
      "the transient carrier failure to recover",
    );
    expect(deliveryById(fanOutId.get(retryPhone.deviceId)!)).toMatchObject({
      wake_state: "sent",
      wake_attempt_count: 2,
      wake_last_transport: "direct-apns",
    });
    expect(pushesFor(retryPhone.token)).toBe(baseline.get(retryPhone.token)! + 2);
    expect(deliveryById(fanOutId.get(doomedPhone.deviceId)!)).toMatchObject({
      wake_state: "terminal",
      wake_attempt_count: 1,
    });
    expect(pushesFor(doomedPhone.token)).toBe(baseline.get(doomedPhone.token)! + 1);
    expect(deliveryById(fanOutId.get(healthyPhone.deviceId)!).wake_attempt_count).toBe(1);
    expect(pushesFor(healthyPhone.token)).toBe(baseline.get(healthyPhone.token)! + 1);

    // A terminal wake retires a token, not the content it was announcing:
    // the refused phone still claims exactly that delivery by polling.
    const claimed = await claim(doomedPhone);
    expect(claimed).toMatchObject({
      kind: "diagnostic",
      collapseId: COLLAPSE_ID,
      title: "Omnesis",
    });
    expect(deliveryById(fanOutId.get(doomedPhone.deviceId)!)).toMatchObject({ state: "leased" });
    expect(deliveryById(fanOutId.get(doomedPhone.deviceId)!).claimed_at).not.toBeNull();
    expect(await confirm(doomedPhone, claimed.id)).toBe(200);
    expect(deliveryById(fanOutId.get(doomedPhone.deviceId)!)).toMatchObject({
      state: "delivered",
    });

    // With no transport the next wake is queued, not discarded, and still
    // nothing reaches the retired token.
    const queued = await publishTest(doomedPhone.deviceId);
    expect(queued.result).toMatchObject({
      status: "exit-non-zero",
      attempted: 1,
      delivered: 0,
    });
    const queuedId = await settle(
      queued.notificationId,
      doomedPhone.deviceId,
      (row) => row.wake_state === "pending" && row.wake_last_transport !== null,
    );
    expect(deliveryById(queuedId)).toMatchObject({
      state: "pending",
      wake_state: "pending",
      wake_attempt_count: 1,
      wake_last_transport: "unavailable",
      wake_last_error: "push transport unavailable",
    });
    expect(pushesFor(doomedPhone.token)).toBe(baseline.get(doomedPhone.token)! + 1);

    // What the app does on its next launch after a reinstall.
    const newToken = randomBytes(32).toString("hex");
    await harness.gatewayJson(
      `/admin/devices/${encodeURIComponent(doomedPhone.deviceId)}/push-registration`,
      {
        method: "POST",
        body: JSON.stringify({
          transport: "direct-apns",
          deviceToken: newToken,
          environment: "production",
          bundleId: BUNDLE_ID,
        }),
      },
    );
    await waitForCondition(
      () => deviceRow(doomedPhone.deviceId).apns_device_token === newToken,
      10_000,
      "the new APNs registration to land",
    );
    expect(deviceRow(doomedPhone.deviceId)).toMatchObject({ push_transport: "direct-apns" });

    releaseParkedWake(queuedId);
    await waitForCondition(
      () => deliveryById(queuedId).wake_state === "sent",
      20_000,
      "the queued wake to reach the re-registered phone",
    );
    // The same delivery, not a replacement: retiring a registration parked
    // the work rather than discarding it.
    expect(deliveryById(queuedId)).toMatchObject({
      wake_state: "sent",
      wake_attempt_count: 2,
      wake_last_transport: "direct-apns",
    });
    expect(pushesFor(newToken)).toBe(1);
    expect(pushesFor(doomedPhone.token)).toBe(baseline.get(doomedPhone.token)! + 1);
    const recovered = await pushStatus();
    expect(recovered.devices.directApns).toBe(phones.length);
    expect(deliveryHealth(recovered, doomedPhone.deviceId)).toMatchObject({
      transport: "direct-apns",
      available: true,
      queue: { wake: { lastTransport: "direct-apns" } },
    });
  }, 120_000);

  // ── helpers ─────────────────────────────────────────────────────────────

  async function registerPhone(name: string): Promise<Phone> {
    const registered = await harness.registerFakeIosDevice(name);
    return { name, ...registered };
  }

  function pushesFor(token: string): number {
    return harness.getApnsPushes().filter((push) => push.deviceToken === token).length;
  }

  function deviceRow(deviceId: string): DeviceRow {
    const row = readDb
      .prepare<
        [string],
        DeviceRow
      >(`SELECT apns_device_token, apns_environment, apns_bundle_id, apns_token_updated_at, push_transport FROM devices WHERE id = ?`)
      .get(deviceId);
    if (!row) throw new Error(`no device row for ${deviceId}`);
    return row;
  }

  function deliveryFor(notificationId: string, deviceId: string): DeliveryRow | undefined {
    return readDb
      .prepare<
        [string, string],
        DeliveryRow
      >(`SELECT id, state, wake_state, wake_attempt_count, wake_next_attempt_at, wake_last_error, wake_last_transport, claimed_at FROM notification_deliveries WHERE notification_id = ? AND device_id = ?`)
      .get(notificationId, deviceId);
  }

  function deliveryById(deliveryId: string): DeliveryRow {
    const row = readDb
      .prepare<
        [string],
        DeliveryRow
      >(`SELECT id, state, wake_state, wake_attempt_count, wake_next_attempt_at, wake_last_error, wake_last_transport, claimed_at FROM notification_deliveries WHERE id = ?`)
      .get(deliveryId);
    if (!row) throw new Error(`no delivery row ${deliveryId}`);
    return row;
  }

  /** Wait for one device's delivery of a notification to reach a state, and return its id. */
  async function settle(
    notificationId: string,
    deviceId: string,
    reached: (row: DeliveryRow) => boolean,
  ): Promise<string> {
    await waitForCondition(
      () => {
        const row = deliveryFor(notificationId, deviceId);
        return row !== undefined && reached(row);
      },
      20_000,
      `delivery of ${notificationId} to ${deviceId} to settle`,
    );
    return deliveryFor(notificationId, deviceId)!.id;
  }

  /**
   * Bring a parked wake's persisted deadline forward so the next sweep leases
   * it. The gateway's own backoff is configured beyond this suite's lifetime,
   * so a retry happens when — and only when — a test asks for one.
   */
  function releaseParkedWake(deliveryId: string): void {
    const result = writeDb
      .prepare(
        `UPDATE notification_deliveries SET wake_next_attempt_at = ?
          WHERE id = ? AND wake_state = 'pending'`,
      )
      .run(Date.now() - 1, deliveryId);
    expect(result.changes).toBe(1);
  }

  function maxNotificationRowid(): number {
    return readDb
      .prepare<[], { rowid: number }>("SELECT COALESCE(MAX(rowid), 0) AS rowid FROM notifications")
      .get()!.rowid;
  }

  function newestPushTest(afterRowid: number): string | undefined {
    return readDb
      .prepare<
        [string, number],
        { id: string }
      >("SELECT id FROM notifications WHERE collapse_id = ? AND rowid > ? ORDER BY rowid DESC LIMIT 1")
      .get(COLLAPSE_ID, afterRowid)?.id;
  }

  async function publishTest(
    deviceId?: string,
  ): Promise<{ notificationId: string; result: NotifyResult }> {
    const before = maxNotificationRowid();
    const path = deviceId
      ? `/admin/push/test?deviceId=${encodeURIComponent(deviceId)}`
      : "/admin/push/test";
    const body = await harness.gatewayJson<{ result: NotifyResult }>(path, { method: "POST" });
    await waitForCondition(
      () => newestPushTest(before) !== undefined,
      10_000,
      "the published push-test notification",
    );
    return { notificationId: newestPushTest(before)!, result: body.result };
  }

  async function adminDevices(): Promise<AdminDevice[]> {
    const page = await harness.gatewayJson<{ items: AdminDevice[] }>("/admin/devices");
    return page.items;
  }

  async function pushStatus(): Promise<PushStatus> {
    return await harness.gatewayJson<PushStatus>("/admin/push/status");
  }

  function deliveryHealth(status: PushStatus, deviceId: string) {
    const entry = status.devices.deliveryHealth.find((d) => d.id === deviceId);
    if (!entry) throw new Error(`no deliveryHealth entry for ${deviceId}`);
    return entry;
  }

  async function claim(phone: Phone): Promise<ClaimedDelivery> {
    const response = await fetch(`${harness.gatewayUrl}/notifications/claim`, {
      method: "POST",
      headers: { authorization: `Bearer ${phone.authToken}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(200);
    return (await response.json()) as ClaimedDelivery;
  }

  async function confirm(phone: Phone, id: string): Promise<number> {
    const response = await fetch(`${harness.gatewayUrl}/notifications/confirm`, {
      method: "POST",
      headers: { authorization: `Bearer ${phone.authToken}`, "content-type": "application/json" },
      body: JSON.stringify({ id }),
    });
    return response.status;
  }

  async function waitOnline(deviceId: string, expected: boolean): Promise<void> {
    await waitForCondition(
      async () => {
        const items = await adminDevices();
        return items.some((d) => d.id === deviceId && d.online === expected);
      },
      20_000,
      `device ${deviceId} to report online=${expected}`,
    );
  }

  /**
   * A phone's own device socket. The gateway registers the handle before it
   * answers `hello`, and `/admin/devices` reports `online` straight off that
   * registry — the same predicate the transport selection reads.
   */
  async function openPhoneSocket(phone: Phone): Promise<PhoneSocket> {
    const wakes: unknown[] = [];
    const ws = new WebSocket(
      `wss://localhost:${harness.gatewayPort}/device/ws`,
      websocketAuthProtocol(phone.authToken),
    );
    await waitForOpen(ws);
    // An admin-scoped socket also receives `device.status` and `ping`, so the
    // wake frames are selected by type rather than by arrival order.
    ws.addEventListener("message", (event: MessageEvent) => {
      const parsed: unknown = JSON.parse(event.data as string);
      if (isWsEvent(parsed) && parsed.type === "push.available") wakes.push(parsed.payload);
    });
    const hello = makeCommand("hello", {
      token: phone.authToken,
      capabilities: {},
      protocolVersion: PROTOCOL_VERSION,
    });
    ws.send(JSON.stringify(hello));
    const response = await waitForResponse(ws, hello.id);
    if (!response.ok) throw new Error(`gateway WS hello failed: ${JSON.stringify(response.error)}`);
    const socket: PhoneSocket = { ws, wakes };
    openSockets.push(socket);
    await waitOnline(phone.deviceId, true);
    return socket;
  }

  async function closePhoneSocket(phone: Phone, socket: PhoneSocket): Promise<void> {
    socket.ws.close();
    openSockets = openSockets.filter((entry) => entry !== socket);
    await waitOnline(phone.deviceId, false);
  }
});

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("gateway WS open timeout")), 15_000);
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

function waitForResponse(
  ws: WebSocket,
  correlationId: string,
  timeoutMs = 15_000,
): Promise<WsResponse> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener("message", handler);
      reject(new Error("gateway WS response timeout"));
    }, timeoutMs);
    const handler = (event: MessageEvent) => {
      const parsed: unknown = JSON.parse(event.data as string);
      if (!isWsResponse(parsed) || parsed.correlationId !== correlationId) return;
      clearTimeout(timer);
      ws.removeEventListener("message", handler);
      resolve(parsed);
    };
    ws.addEventListener("message", handler);
  });
}
