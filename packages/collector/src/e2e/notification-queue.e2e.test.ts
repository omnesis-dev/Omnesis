// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The durable notification queue as a running product: what a phone is owed,
 * what it is allowed to acknowledge, and when the rendered text is destroyed.
 *
 * `push/queue.ts` is exhaustively unit-tested against a bare SQLite handle,
 * and `wake-retry.test.ts` pins the wake state machine against a stub
 * broadcaster. Neither can reach what this file is about. In the running
 * gateway every one of those functions is a *writer-worker op* reached over
 * HTTP, and the ones that matter here carry different priorities:
 * `notifications.claim` and `notifications.confirm` are `user`, while
 * `notifications.leaseWakes` and `notifications.settleWake` are `background`
 * (`scheduler/write-ops.ts`), so the order two of them were issued in is not
 * the order they commit in — and the wake lease token is the only authority a
 * settlement carries into that. Nor can a unit test show that
 * `notifications.retryWakes.tick` is wired at all: it is constructed and
 * scheduled only in `index.ts`, and a break there is silent — the delivery row
 * still reads `pending` while nothing ever wakes the phone again.
 *
 * So this boots a real gateway with a fake APNs carrier and pins the promises
 * the queue makes to an operator:
 *
 *   - A phone that claims and then dies gets its content back. The claim lease
 *     (`DEFAULT_NOTIFICATION_LEASE_MS`, 30s, fixed at the
 *     `mountNotificationRoutes` call site and not configurable) lapses, the
 *     next claim yields the same content under a *new* token, and the dead
 *     process's token is refused.
 *   - `remaining` — the number the phone writes into its app badge — is right
 *     across the HTTP boundary for a backlog from three different producers,
 *     drained oldest-first; a fresh delivery collapses an unclaimed peer under
 *     the same collapse id, and never a lease a phone is holding.
 *   - A carrier 5xx costs the content nothing: the wake climbs its ladder on
 *     the scheduler's own cadence until it lands, stops at the attempt budget
 *     when it never does, and the rendered text stays claimable throughout.
 *   - A wake settled after the phone has already claimed writes nothing at
 *     all. Its lease token was invalidated by the claim, so a carrier failure
 *     arriving late cannot re-arm a banner the phone has already rendered.
 *   - Expired content is deleted, except while a phone holds a live lease on
 *     it — the privacy guarantee and the delivery guarantee colliding on one
 *     row — and goes as soon as that lease drains. Note what that last one
 *     does not claim: `expireNotificationsInTransaction` is reached from the
 *     `notifications.cleanupExpired.tick` boot sweep, from every wake lease and
 *     from every claim, so the assertions pin the guard and the deletion, never
 *     which caller performed it.
 *
 * Time is never waited out. A lease is aged by rewriting `leased_until` from a
 * second connection, or — where the gateway must not observe the intermediate
 * state — inside `restartGateway`'s `whileStopped` callback while the process
 * is down. Every other wait gates on the carrier's arrival log, a persisted
 * row, or a counter on `GET /admin/push/status`.
 */

import "./synth-env.js";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { APNS_WAKE_PAYLOAD } from "@omnesis/core/push";
import { SourceId } from "@omnesis/types";
import { collapsePrefix } from "@omnesis/gateway/src/push/producers/source-permission.js";
import { SyntheticE2EHarness } from "./synth-harness.js";
import { waitForCondition } from "./multi-collector-harness.js";
import type { FakeApnsResponse, ReceivedApnsPush } from "./fake-apns.js";

/** Retry sweep cadence, active and idle alike, so a ladder advances promptly. */
const SWEEP_MS = 250;
/** Flat backoff: every rung of a ladder is the same short wait. */
const BACKOFF_MS = 200;
/** Small enough that a permanently failing wake costs three carrier calls. */
const MAX_ATTEMPTS = 3;
const COLLAPSE_ID = "push-test";
const TEST_TITLE = "Omnesis";
const TEST_BODY = "Test notification from your gateway.";
const PRIMARY_SOURCE_ID = "activity-segments:local";
const SECONDARY_SOURCE_ID = "activity-segments:secondary";

/**
 * How the fake carrier answers, keyed by the hex device token it was sent to —
 * the token the fake reads off the `/3/device/<token>` path. Bound once at
 * construction, before any phone exists, so each test installs its own policy.
 */
const apnsPolicy = new Map<string, (push: ReceivedApnsPush) => FakeApnsResponse>();

/**
 * A claim issued from a throwaway Node process, so the calling thread is
 * blocked until the gateway has committed it.
 *
 * The fake APNs server runs in this process and answers a push synchronously,
 * which is what makes the mid-flight race constructible at all: while this
 * runs, the gateway is parked inside its carrier round trip holding the wake
 * lease, and the claim provably commits before the carrier verdict comes back.
 * An in-process `fetch` could not do that — it needs the event loop the fake's
 * request handler is occupying.
 */
const CLAIM_SUBPROCESS = `
const [url, token] = process.argv.slice(1);
fetch(url, {
  method: "POST",
  headers: { authorization: "Bearer " + token, "content-type": "application/json" },
  body: "{}",
})
  .then(async (response) => ({ status: response.status, body: await response.text() }))
  .catch((error) => ({ status: 0, body: String(error) }))
  .then((result) => process.stdout.write(JSON.stringify(result)));
`;

interface Phone {
  deviceId: string;
  token: string;
  authToken: string;
}

interface ClaimedDelivery {
  id: string;
  kind: string;
  targetId: string;
  affectedDeviceId?: string;
  title: string;
  body: string;
  collapseId: string;
  remaining: number;
  route?: { kind: string };
}

interface NotifyResult {
  status: string;
  attempted: number;
  delivered: number;
}

interface QueueLedger {
  pending: number;
  leased: number;
  delivered: number;
  superseded: number;
  expired: number;
  wake: {
    pending: number;
    leased: number;
    sent: number;
    terminal: number;
    exhausted: number;
    attempts: number;
    lastOutcome: string | null;
    lastError: string | null;
    lastTransport: string | null;
  };
}

interface PushStatus {
  devices: { deliveryHealth: Array<{ id: string; queue: QueueLedger }> };
}

interface DeliveryRow {
  id: string;
  notification_id: string;
  state: string;
  lease_token: string | null;
  leased_until: number | null;
  expires_at: number;
}

describe("durable notification queue (fake APNs)", () => {
  let harness: SyntheticE2EHarness;
  let db: Database.Database;

  beforeAll(async () => {
    harness = new SyntheticE2EHarness({
      gatewayMode: "stable",
      universe: "e2e-minimal",
      apnsBackend: "fake",
      fakeApnsOptions: {
        respond: (push) => apnsPolicy.get(push.deviceToken)?.(push) ?? { statusCode: 200 },
      },
      extraGatewayConfig: {
        gateway: {
          pushWakeRetry: {
            initialBackoffMs: BACKOFF_MS,
            maxBackoffMs: BACKOFF_MS,
            maxAttempts: MAX_ATTEMPTS,
            // The schema floors the wake lease at 60s so it outlives a carrier
            // request deadline; the sweep is its only holder here.
            leaseMs: 60_000,
            batchSize: 50,
            intervalMs: SWEEP_MS,
            idleIntervalMs: SWEEP_MS,
          },
          // Short rungs so the two device-hosted sources of the backlog test
          // each mint their own reminder episode rather than sharing a window.
          mobilePermissionReminders: {
            initialDelay: "50ms",
            multiplier: 2,
            maxDelay: "1s",
            reservationTtl: "100ms",
            scanInterval: "1h",
          },
        },
      },
    });
    await harness.start();
    db = new Database(harness.getDbPath());
    db.pragma("busy_timeout = 10000");
  }, 180_000);

  afterAll(async () => {
    try {
      db?.close();
    } catch {
      /* best effort */
    }
    await harness?.destroy();
  }, 30_000);

  test("a lapsed claim lease re-offers the same content under a new token and refuses the dead claimant's", async () => {
    const phone = await registerPhone("Nadia-iPhone");
    expect(await publishTest(phone.deviceId)).toMatchObject({
      status: "ok",
      attempted: 1,
      delivered: 1,
    });
    const wakes = pushesFor(phone.token);
    expect(wakes).toHaveLength(1);
    // The carrier carries no notification text — only the fixed wake.
    expect(wakes[0]!.payload).toEqual(APNS_WAKE_PAYLOAD);

    const first = await claim(phone);
    expect(first).toMatchObject({
      kind: "diagnostic",
      targetId: "app",
      title: TEST_TITLE,
      body: TEST_BODY,
      collapseId: COLLAPSE_ID,
      remaining: 0,
      route: { kind: "diagnostic" },
    });
    // Precondition for the lapse: the delivery really is leased right now.
    expect((await ledgerFor(phone.deviceId)).leased).toBe(1);

    // The claim lease is a fixed 30s, so it is aged rather than waited out.
    const aged = db
      .prepare("UPDATE notification_deliveries SET leased_until = ? WHERE lease_token = ?")
      .run(Date.now() - 1_000, first.id);
    expect(aged.changes).toBe(1);

    // Same content, different authority. `claimNotification` returns the
    // lease token as `id`, so a regression that reused it — or that matched
    // confirmation on the delivery row id — would let a phone that never
    // rendered anything mark the banner delivered.
    const second = await claim(phone);
    expect(second.id).not.toBe(first.id);
    expect(second).toMatchObject({
      kind: first.kind,
      targetId: first.targetId,
      title: first.title,
      body: first.body,
      collapseId: first.collapseId,
      remaining: 0,
    });

    expect(await confirmStatus(phone, first.id)).toBe(404);
    expect(await confirmStatus(phone, second.id)).toBe(200);
    expect(await claimStatus(phone)).toBe(204);

    const ledger = await ledgerFor(phone.deviceId);
    expect(ledger).toMatchObject({ pending: 0, leased: 0, delivered: 1, expired: 0 });
    // A lapsed content lease makes the text claimable again but never
    // re-arms the carrier: `claimNotification` hard-sets `wake_state='sent'`,
    // and `leaseNotificationWakes` only ever considers 'pending' or 'leased'
    // wakes, so no sweep can pick this delivery up again.
    expect(ledger.wake).toMatchObject({ sent: 1, pending: 0, leased: 0 });
    expect(pushesFor(phone.token)).toHaveLength(1);

    await retire(phone.deviceId);
  }, 60_000);

  test("a mixed backlog drains oldest-first, and a fresh delivery collapses an unclaimed peer but never a live lease", async () => {
    const phone = await registerPhone("Theo-iPhone");
    // The source-permission producer targets only phones that have reported
    // healthy delivery, and a phone may report health only for itself.
    await reportHealthy(phone);
    for (const accountId of ["local", "secondary"]) {
      await harness.gatewayJson("/admin/sources", {
        method: "POST",
        body: JSON.stringify({
          type: "activity-segments",
          accountId,
          deviceId: phone.deviceId,
          enabled: true,
        }),
      });
    }

    // Three producers, three collapse ids. Each one's row is on disk before
    // the next is issued, so `created_at` order is established rather than
    // assumed — and `n.rowid` breaks a same-millisecond tie anyway.
    await publishTest(phone.deviceId);
    expect((await ledgerFor(phone.deviceId)).pending).toBe(1);
    await reportPermission(phone, PRIMARY_SOURCE_ID);
    expect((await ledgerFor(phone.deviceId)).pending).toBe(2);
    await reportPermission(phone, SECONDARY_SOURCE_ID);
    expect((await ledgerFor(phone.deviceId)).pending).toBe(3);

    const drained: ClaimedDelivery[] = [];
    for (let i = 0; i < 3; i += 1) {
      const claimed = await claim(phone);
      drained.push(claimed);
      expect(await confirmStatus(phone, claimed.id)).toBe(200);
    }

    // The badge counts down as the phone drains, and never counts the row it
    // was just handed.
    expect(drained.map((entry) => entry.remaining)).toEqual([2, 1, 0]);
    expect(drained.map((entry) => entry.kind)).toEqual([
      "diagnostic",
      "source-permission",
      "source-permission",
    ]);
    expect(drained.map((entry) => entry.targetId)).toEqual([
      "app",
      PRIMARY_SOURCE_ID,
      SECONDARY_SOURCE_ID,
    ]);
    expect(drained[0]!.collapseId).toBe(COLLAPSE_ID);
    // Two episodes on two sources hash to two different collapse ids, so
    // neither could have quietly superseded the other.
    expect(drained[1]!.collapseId.startsWith(collapsePrefix(SourceId(PRIMARY_SOURCE_ID)))).toBe(
      true,
    );
    expect(drained[2]!.collapseId.startsWith(collapsePrefix(SourceId(SECONDARY_SOURCE_ID)))).toBe(
      true,
    );
    expect(drained[1]!.collapseId).not.toBe(drained[2]!.collapseId);
    expect(new Set(drained.map((entry) => entry.id)).size).toBe(3);
    expect(await claimStatus(phone)).toBe(204);
    expect(await ledgerFor(phone.deviceId)).toMatchObject({
      pending: 0,
      leased: 0,
      delivered: 3,
    });

    // An unclaimed peer under the same collapse id is collapsed, not queued
    // twice: one banner, the newest text.
    await publishTest(phone.deviceId);
    const stale = await onlyPendingDelivery(phone.deviceId);
    await publishTest(phone.deviceId);
    expect(await ledgerFor(phone.deviceId)).toMatchObject({ pending: 1, superseded: 1 });
    expect(deliveryById(stale.id).state).toBe("superseded");
    const fresh = await onlyPendingDelivery(phone.deviceId);
    expect(fresh.id).not.toBe(stale.id);

    // ...and a lease a phone is already holding is never revoked: its client
    // has the text, so the collapse skips it and queues alongside.
    const held = await claim(phone);
    expect(deliveryById(fresh.id)).toMatchObject({ state: "leased", lease_token: held.id });
    await publishTest(phone.deviceId);
    expect(deliveryById(fresh.id)).toMatchObject({ state: "leased", lease_token: held.id });
    expect(await confirmStatus(phone, held.id)).toBe(200);
    expect(await ledgerFor(phone.deviceId)).toMatchObject({
      pending: 1,
      superseded: 1,
      delivered: 4,
    });

    await retire(phone.deviceId);
  }, 120_000);

  test("a carrier that never recovers spends its attempt budget and stops; one that recovers is landed by the sweep — and neither disturbs the content", async () => {
    const doomed = await registerPhone("Priya-iPhone");
    apnsPolicy.set(doomed.token, () => ({ statusCode: 503, reason: "ServiceUnavailable" }));
    expect(await publishTest(doomed.deviceId)).toMatchObject({
      status: "exit-non-zero",
      attempted: 1,
      delivered: 0,
    });
    // Precondition: attempt 1 is the publishing request's own carrier call,
    // so every further push below came from a scheduler tick.
    expect(pushesFor(doomed.token)).toHaveLength(1);

    await waitForCondition(
      async () => (await ledgerFor(doomed.deviceId)).wake.exhausted === 1,
      30_000,
      "the doomed phone's wake budget to be spent",
    );
    expect(pushesFor(doomed.token)).toHaveLength(MAX_ATTEMPTS);
    const doomedLedger = await ledgerFor(doomed.deviceId);
    // The budget terminates; one dead token cannot burn carrier calls
    // forever. The content it was announcing is untouched.
    expect(doomedLedger).toMatchObject({ pending: 1, leased: 0, delivered: 0, expired: 0 });
    expect(doomedLedger.wake).toMatchObject({
      attempts: MAX_ATTEMPTS,
      exhausted: 1,
      pending: 0,
      leased: 0,
      lastTransport: "direct-apns",
      // The only operator-facing explanation of a failing push, and it sits
      // on the privacy boundary: never the carrier's reason, never the text.
      lastError: "carrier wake failed",
    });

    const recovering = await registerPhone("Marcus-iPhone");
    let carrierCalls = 0;
    apnsPolicy.set(recovering.token, () => {
      carrierCalls += 1;
      return carrierCalls >= 3
        ? { statusCode: 200 }
        : { statusCode: 503, reason: "ServiceUnavailable" };
    });
    expect(await publishTest(recovering.deviceId)).toMatchObject({
      status: "exit-non-zero",
      delivered: 0,
    });
    expect(pushesFor(recovering.token)).toHaveLength(1);

    // This wait *is* the retry assertion: attempts 2 and 3 exist only if
    // `notifications.retryWakes.tick` fired twice against the real
    // broadcaster. Nothing in the test moved the ladder along.
    await waitForCondition(
      () => pushesFor(recovering.token).length === 3,
      30_000,
      "the recovering phone's third carrier attempt",
    );
    await waitForCondition(
      async () => (await ledgerFor(recovering.deviceId)).wake.sent === 1,
      30_000,
      "the recovered wake to settle as sent",
    );
    const recoveredLedger = await ledgerFor(recovering.deviceId);
    expect(recoveredLedger.wake).toMatchObject({
      attempts: 3,
      sent: 1,
      pending: 0,
      exhausted: 0,
      lastOutcome: "sent",
      lastError: null,
      lastTransport: "direct-apns",
    });
    expect(recoveredLedger.pending).toBe(1);

    // Three carrier attempts, one delivery.
    const claimed = await claim(recovering);
    expect(claimed).toMatchObject({ kind: "diagnostic", collapseId: COLLAPSE_ID, remaining: 0 });
    expect(await confirmStatus(recovering, claimed.id)).toBe(200);
    expect(await claimStatus(recovering)).toBe(204);

    // Gated, not hopeful: the recovering phone's ladder proves two sweep
    // generations ran after the doomed one exhausted, and it stayed at three.
    expect(pushesFor(doomed.token)).toHaveLength(MAX_ATTEMPTS);
    const stranded = await claim(doomed);
    expect(stranded).toMatchObject({
      kind: "diagnostic",
      title: TEST_TITLE,
      body: TEST_BODY,
      collapseId: COLLAPSE_ID,
      remaining: 0,
    });
    expect(await confirmStatus(doomed, stranded.id)).toBe(200);

    await retire(doomed.deviceId);
    await retire(recovering.deviceId);
  }, 120_000);

  test("a claim that lands mid-flight wins the wake, and the carrier's late failure cannot re-arm it", async () => {
    const phone = await registerPhone("Lena-iPhone");
    const midFlight = {
      calls: 0,
      wakeStateAtDispatch: "",
      status: 0,
      body: "",
      error: null as string | null,
    };
    apnsPolicy.set(phone.token, () => {
      midFlight.calls += 1;
      if (midFlight.calls === 1) {
        try {
          // Read from the second connection while the gateway is parked
          // inside this very request: the wake lease is held right now, and
          // that is the window the claim below lands in.
          midFlight.wakeStateAtDispatch = wakeStateFor(phone.deviceId);
          const claimed = claimWhileCarrierIsHeld(phone.authToken);
          midFlight.status = claimed.status;
          midFlight.body = claimed.body;
        } catch (error) {
          midFlight.error = error instanceof Error ? error.message : String(error);
        }
      }
      return { statusCode: 503, reason: "ServiceUnavailable" };
    });

    // The carrier's verdict is only produced after the claim above has been
    // committed, so the settlement below carries a lease token the claim has
    // already invalidated — the interleaving the wake lease exists for.
    expect(await publishTest(phone.deviceId)).toMatchObject({
      status: "exit-non-zero",
      attempted: 1,
      delivered: 0,
    });
    expect(midFlight.error).toBeNull();
    expect(midFlight.calls).toBe(1);
    expect(midFlight.wakeStateAtDispatch).toBe("leased");
    expect(midFlight.status).toBe(200);
    const claimed = JSON.parse(midFlight.body) as ClaimedDelivery;
    expect(claimed).toMatchObject({
      kind: "diagnostic",
      title: TEST_TITLE,
      body: TEST_BODY,
      collapseId: COLLAPSE_ID,
      remaining: 0,
    });
    expect(pushesFor(phone.token)).toHaveLength(1);

    const ledger = await ledgerFor(phone.deviceId);
    expect(ledger).toMatchObject({ leased: 1, pending: 0, delivered: 0 });
    expect(ledger.wake).toMatchObject({
      sent: 1,
      pending: 0,
      leased: 0,
      terminal: 0,
      exhausted: 0,
      // Only `leaseNotificationWakes` increments this, so the wake really was
      // leased and dispatched before the claim arrived.
      attempts: 1,
      // The stale settlement matched no row and therefore wrote nothing at
      // all — not the failure it was reporting, not even the transport it
      // failed on. That is what distinguishes "refused" from "ran and
      // happened to pick a harmless state".
      lastError: null,
      lastTransport: null,
    });

    // A canary whose ladder runs out is the witness that sweeps kept running
    // after the claim; only then is "still one push" a real assertion.
    const canary = await registerPhone("Ivo-iPhone");
    apnsPolicy.set(canary.token, () => ({ statusCode: 503, reason: "ServiceUnavailable" }));
    await publishTest(canary.deviceId);
    await waitForCondition(
      () => pushesFor(canary.token).length === MAX_ATTEMPTS,
      30_000,
      "the canary's ladder to run out",
    );
    expect(pushesFor(phone.token)).toHaveLength(1);
    expect((await ledgerFor(phone.deviceId)).wake).toMatchObject({ pending: 0, sent: 1 });

    // The claim the phone actually made is still the one the gateway honours.
    expect(await confirmStatus(phone, claimed.id)).toBe(200);
    expect(await claimStatus(phone)).toBe(204);

    await retire(phone.deviceId);
    await retire(canary.deviceId);
  }, 120_000);

  test("queued content survives a restart; expired content is deleted except under a live lease, and goes once that lease drains", async () => {
    const holder = await registerPhone("Zara-iPhone");
    const bystander = await registerPhone("Bruno-iPhone");
    const survivor = await registerPhone("Cleo-iPhone");
    for (const phone of [holder, bystander, survivor]) await publishTest(phone.deviceId);

    const held = await claim(holder);
    const holderRow = await onlyDelivery(holder.deviceId);
    const bystanderRow = await onlyDelivery(bystander.deviceId);
    expect(holderRow).toMatchObject({ state: "leased", lease_token: held.id });
    expect(bystanderRow.state).toBe("pending");
    expect((await onlyDelivery(survivor.deviceId)).state).toBe("pending");

    // The 7-day TTL is a hard constant, so the rows are aged instead of
    // waited on — with the gateway confirmed down, so it never observes a
    // half-mutated row and the holder's 30s claim lease cannot lapse during
    // a boot that is budgeted in tens of seconds.
    await harness.restartGateway(() => {
      const staging = new Database(harness.getDbPath());
      try {
        staging.pragma("busy_timeout = 10000");
        const expired = staging
          .prepare("UPDATE notifications SET expires_at = ? WHERE id IN (?, ?)")
          .run(Date.now() - 1_000, holderRow.notification_id, bystanderRow.notification_id);
        expect(expired.changes).toBe(2);
        const extended = staging
          .prepare("UPDATE notification_deliveries SET leased_until = ? WHERE lease_token = ?")
          .run(Date.now() + 600_000, held.id);
        expect(extended.changes).toBe(1);
      } finally {
        staging.close();
      }
    });

    // The bystander has no live lease, so its disappearance is the positive
    // gate: a sweep ran on the rebooted gateway.
    await waitForCondition(
      () => deliveriesFor(bystander.deviceId).length === 0,
      60_000,
      "the bystander's expired content to be swept",
    );
    // ...and the row a phone is holding survived it. Cleanup does not yank
    // content out from under a client that is mid-render.
    expect(deliveriesFor(holder.deviceId)).toEqual([
      expect.objectContaining({ state: "leased", lease_token: held.id }),
    ]);

    // Ordinary queued content is not collateral damage of a restart: still
    // there, still counted, still exactly what was rendered before the boot.
    expect(deliveriesFor(survivor.deviceId)).toHaveLength(1);
    expect((await ledgerFor(survivor.deviceId)).pending).toBe(1);
    const survived = await claim(survivor);
    expect(survived).toMatchObject({
      kind: "diagnostic",
      targetId: "app",
      title: TEST_TITLE,
      body: TEST_BODY,
      collapseId: COLLAPSE_ID,
      remaining: 0,
    });
    expect(await confirmStatus(survivor, survived.id)).toBe(200);
    // That claim ran the global expiry sweep of its own, and the guard held
    // against it too.
    expect(deliveriesFor(holder.deviceId)).toHaveLength(1);

    // The holder finishes. Its lease drains, and with nothing left to
    // protect the expired content the next sweep deletes it — the row and
    // the rendered title and body with it, not merely a state transition.
    expect(await confirmStatus(holder, held.id)).toBe(200);
    await waitForCondition(
      () => deliveriesFor(holder.deviceId).length === 0,
      60_000,
      "the holder's content to be deleted once its lease drained",
    );
    expect(notificationExists(holderRow.notification_id)).toBe(false);
    expect(await confirmStatus(holder, held.id)).toBe(404);
    expect(await claimStatus(holder)).toBe(204);

    await retire(holder.deviceId);
    await retire(bystander.deviceId);
    await retire(survivor.deviceId);
  }, 240_000);

  // ── helpers ─────────────────────────────────────────────────────────────

  async function registerPhone(name: string): Promise<Phone> {
    return await harness.registerFakeIosDevice(name);
  }

  /** Revoke a phone: its outstanding deliveries are superseded with it, so a
   * finished test's queue cannot bleed carrier calls into the next one. */
  async function retire(deviceId: string): Promise<void> {
    const response = await harness.gatewayFetch(`/admin/devices/${encodeURIComponent(deviceId)}`, {
      method: "DELETE",
    });
    expect(response.status).toBe(200);
  }

  function pushesFor(token: string): ReceivedApnsPush[] {
    return harness.getApnsPushes().filter((push) => push.deviceToken === token);
  }

  async function publishTest(deviceId: string): Promise<NotifyResult> {
    const { result } = await harness.gatewayJson<{ result: NotifyResult }>(
      `/admin/push/test?deviceId=${encodeURIComponent(deviceId)}`,
      { method: "POST" },
    );
    return result;
  }

  /** A phone reports its own delivery health; the admin key carries no device. */
  async function reportHealthy(phone: Phone): Promise<void> {
    const response = await deviceRequest(
      `/admin/devices/${encodeURIComponent(phone.deviceId)}/push-health`,
      "POST",
      { status: "healthy" },
      phone.authToken,
    );
    expect(response.status).toBe(200);
  }

  /** One degraded capability on a source the phone owns — a reminder episode. */
  async function reportPermission(phone: Phone, sourceId: string): Promise<void> {
    const response = await deviceRequest(
      `/admin/sources/${encodeURIComponent(sourceId)}/permission-health`,
      "PUT",
      {
        checkedAt: Date.now(),
        validForMs: 60_000,
        capabilities: [
          {
            id: "background-access",
            label: "Background access",
            state: "background-access-missing",
            requirement: "required",
            impact: "New records stop while the app is closed.",
            remediation: "Restore access in system Settings.",
            repairAction: "open-system-settings",
          },
        ],
      },
      phone.authToken,
    );
    expect(response.status).toBe(200);
  }

  async function ledgerFor(deviceId: string): Promise<QueueLedger> {
    const status = await harness.gatewayJson<PushStatus>("/admin/push/status");
    const entry = status.devices.deliveryHealth.find((device) => device.id === deviceId);
    // Revoked phones are dropped from the report, so a stray read after
    // `retire()` names itself rather than throwing a TypeError inside a poll.
    if (!entry) throw new Error(`no delivery health for ${deviceId} — revoked?`);
    return entry.queue;
  }

  async function claim(phone: Phone): Promise<ClaimedDelivery> {
    const response = await deviceRequest("/notifications/claim", "POST", {}, phone.authToken);
    expect(response.status).toBe(200);
    return (await response.json()) as ClaimedDelivery;
  }

  async function claimStatus(phone: Phone): Promise<number> {
    return (await deviceRequest("/notifications/claim", "POST", {}, phone.authToken)).status;
  }

  async function confirmStatus(phone: Phone, id: string): Promise<number> {
    return (await deviceRequest("/notifications/confirm", "POST", { id }, phone.authToken)).status;
  }

  async function deviceRequest(
    path: string,
    method: "POST" | "PUT",
    body: Record<string, unknown>,
    token: string,
  ): Promise<Response> {
    return await fetch(`${harness.gatewayUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  function claimWhileCarrierIsHeld(authToken: string): { status: number; body: string } {
    const stdout = execFileSync(
      process.execPath,
      ["-e", CLAIM_SUBPROCESS, `${harness.gatewayUrl}/notifications/claim`, authToken],
      {
        encoding: "utf8",
        timeout: 20_000,
        // The spawned process talks to the same self-signed gateway the suite
        // does; the harness sets this for its own process at construction.
        env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: "0", NODE_NO_WARNINGS: "1" },
      },
    );
    return JSON.parse(stdout) as { status: number; body: string };
  }

  function deliveriesFor(deviceId: string): DeliveryRow[] {
    return db
      .prepare<[string], DeliveryRow>(
        `SELECT d.id, d.notification_id, d.state, d.lease_token, d.leased_until, n.expires_at
           FROM notification_deliveries d
           JOIN notifications n ON n.id = d.notification_id
          WHERE d.device_id = ?
          ORDER BY d.rowid`,
      )
      .all(deviceId);
  }

  function deliveryById(deliveryId: string): DeliveryRow {
    const row = db
      .prepare<[string], DeliveryRow>(
        `SELECT d.id, d.notification_id, d.state, d.lease_token, d.leased_until, n.expires_at
           FROM notification_deliveries d
           JOIN notifications n ON n.id = d.notification_id
          WHERE d.id = ?`,
      )
      .get(deliveryId);
    if (!row) throw new Error(`no delivery row ${deliveryId}`);
    return row;
  }

  /** The wake state on a device's newest delivery row. */
  function wakeStateFor(deviceId: string): string {
    const row = db
      .prepare<
        [string],
        { wake_state: string }
      >("SELECT wake_state FROM notification_deliveries WHERE device_id = ? ORDER BY rowid DESC LIMIT 1")
      .get(deviceId);
    if (!row) throw new Error(`no delivery row for ${deviceId}`);
    return row.wake_state;
  }

  function notificationExists(notificationId: string): boolean {
    return (
      db
        .prepare<
          [string],
          { count: number }
        >("SELECT COUNT(*) AS count FROM notifications WHERE id = ?")
        .get(notificationId)!.count > 0
    );
  }

  /** The device's single delivery row, once the writer has committed it. */
  async function onlyDelivery(deviceId: string): Promise<DeliveryRow> {
    await waitForCondition(
      () => deliveriesFor(deviceId).length === 1,
      10_000,
      `one delivery row for ${deviceId}`,
    );
    return deliveriesFor(deviceId)[0]!;
  }

  /** The device's single claimable row, once the writer has committed it. */
  async function onlyPendingDelivery(deviceId: string): Promise<DeliveryRow> {
    await waitForCondition(
      () => deliveriesFor(deviceId).filter((row) => row.state === "pending").length === 1,
      10_000,
      `one pending delivery row for ${deviceId}`,
    );
    return deliveriesFor(deviceId).find((row) => row.state === "pending")!;
  }
});
