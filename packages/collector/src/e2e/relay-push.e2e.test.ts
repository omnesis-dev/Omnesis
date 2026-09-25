// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { generateKeyPairSync } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpsServer } from "node:https";
import { once } from "node:events";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { serve } from "@hono/node-server";
import Database from "better-sqlite3";
import {
  APNS_WAKE_BYTES,
  APNS_WAKE_JSON,
  ApnsRelayCarrier,
  FCM_WAKE_DATA,
  FcmRelayCarrier,
  RelayService,
  RelayStore,
  createRelayApp,
} from "@omnesis/relay";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { startFakeApnsServer, type FakeApnsServer } from "./fake-apns.js";
import { MultiCollectorHarness } from "./multi-collector-harness.js";
import type { AddressInfo } from "node:net";

const IOS_APP_ID = "dev.omnesis.ios";
const ANDROID_APP_ID = "dev.omnesis.android";
const SELF_BUILT_IOS_APP_ID = "dev.example.omnesis.selfbuilt";
const IOS_TOKEN = "ab".repeat(32);
const DIRECT_IOS_TOKEN = "cd".repeat(32);
const ANDROID_TOKEN = "fictional-fcm-registration-token";
const FCM_BASE_URL = "https://fcm.example.test";
const OAUTH_URL = "https://oauth.example.test/token";

interface RecordedFcmRequest {
  url: string;
  body: Buffer;
  headers: Headers;
}

class RecordingFcmFetch {
  readonly sends: RecordedFcmRequest[] = [];

  readonly fetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url === OAUTH_URL) {
      return Response.json({ access_token: "fictional-access-token", expires_in: 3600 });
    }
    const body = Buffer.from(typeof init?.body === "string" ? init.body : "");
    this.sends.push({ url, body, headers: new Headers(init?.headers) });
    return Response.json({ name: "projects/fictional/messages/1" });
  };
}

interface DeviceCredentials {
  device: { id: string };
  token: string;
}

interface ClaimedDelivery {
  id: string;
  kind: string;
  targetId: string;
  title: string;
  body: string;
  collapseId: string;
  remaining: number;
}

function generateRelayTlsBundle(directory: string): { cert: string; key: string } {
  const configPath = join(directory, "relay-tls.cnf");
  const certPath = join(directory, "relay-cert.pem");
  const keyPath = join(directory, "relay-key.pem");
  writeFileSync(
    configPath,
    `
[req]
distinguished_name = dn
prompt = no
x509_extensions = v3_ext

[dn]
CN = fictional-relay

[v3_ext]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = IP:127.0.0.1
`.trim(),
  );
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "3",
      "-nodes",
      "-config",
      configPath,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  return { cert: readFileSync(certPath, "utf8"), key: readFileSync(keyPath, "utf8") };
}

describe("real gateway and relay push flow", () => {
  let tempDir: string;
  let relayUrl: string;
  let relayServer: ReturnType<typeof serve>;
  let relayService: RelayService;
  let harness: MultiCollectorHarness;
  let directApns: FakeApnsServer;
  const relayFcm = new RecordingFcmFetch();

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "omnesis-relay-push-e2e-"));
    const { privateKey: apnsPrivateKey } = generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
    });
    const apnsKeyPath = join(tempDir, "AuthKey_Fictional.p8");
    writeFileSync(apnsKeyPath, apnsPrivateKey.export({ format: "pem", type: "pkcs8" }));

    const { privateKey: fcmPrivateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
    const fcmKeyPath = join(tempDir, "fictional-service-account.json");
    writeFileSync(
      fcmKeyPath,
      JSON.stringify({
        client_email: "relay@example.com",
        private_key: fcmPrivateKey.export({ format: "pem", type: "pkcs8" }).toString(),
        project_id: "fictional-project",
        token_uri: OAUTH_URL,
      }),
    );

    // Both the relay and gateway use the shared full HTTP/2 fake carrier so
    // the E2E observes the exact bytes each real APNs client puts on the wire.
    directApns = await startFakeApnsServer();

    relayService = new RelayService({
      store: new RelayStore(join(tempDir, "relay.db")),
      carriers: [
        new ApnsRelayCarrier({
          keyPath: apnsKeyPath,
          keyId: "ABCDE12345",
          teamId: "TEAM123456",
          appIds: [IOS_APP_ID],
          baseUrl: directApns.url,
        }),
        new FcmRelayCarrier({
          serviceAccountPath: fcmKeyPath,
          appIds: [ANDROID_APP_ID],
          baseUrl: FCM_BASE_URL,
          fetchFn: relayFcm.fetch,
        }),
      ],
    });
    const relayTls = generateRelayTlsBundle(tempDir);
    const relayApp = createRelayApp(relayService);
    relayServer = serve({
      fetch: (request) => {
        const headers = new Headers(request.headers);
        headers.set("cf-connecting-ip", "192.0.2.1");
        return relayApp.fetch(new Request(request, { headers }));
      },
      hostname: "127.0.0.1",
      port: 0,
      createServer: createHttpsServer,
      serverOptions: relayTls,
    });
    if (!relayServer.listening) await once(relayServer, "listening");
    relayUrl = `https://127.0.0.1:${(relayServer.address() as AddressInfo).port}`;

    harness = new MultiCollectorHarness({
      extraGatewayEnv: {
        OMNESIS_EXPERIMENTAL: "1",
        OMNESIS_APNS_BASE_URL: directApns.url,
      },
      gatewayConfig: {
        gateway: {
          pushRelay: {
            enabled: false,
            url: relayUrl,
          },
          apns: {
            keyPath: apnsKeyPath,
            keyId: "ABCDE12345",
            teamId: "TEAM123456",
            bundleId: SELF_BUILT_IOS_APP_ID,
            environment: "production",
          },
        },
      },
    });
    await harness.start();
  }, 120_000);

  afterAll(async () => {
    await harness?.destroy();
    await directApns?.close();
    if (relayServer) {
      await new Promise<void>((resolve, reject) =>
        relayServer.close((error) => (error ? reject(error) : resolve())),
      );
    }
    await relayService?.dispose();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  }, 30_000);

  test("enrols by proof of possession and preserves content-free wake bytes through both paths", async () => {
    const wakesBeforeNeverEnrolled = iosWakeRequests().length;
    await expectRelayWake(`omnrelay_v1_${"A".repeat(43)}`, 401);
    expect(iosWakeRequests()).toHaveLength(wakesBeforeNeverEnrolled);

    const iosDevice = await createDevice("Fictional iPhone", "ios", IOS_APP_ID);
    const sibling = await createDevice("Fictional sibling iPhone", "ios", IOS_APP_ID);
    expect(await pushPlan(iosDevice, "ios", IOS_APP_ID)).toMatchObject({
      transport: "unavailable",
      reasonCode: "relay-disabled",
    });
    expect(await pushPlan(sibling, "ios", IOS_APP_ID)).toMatchObject({
      transport: "unavailable",
      reasonCode: "relay-disabled",
    });
    const crossDeviceGrant = await fetch(
      `${harness.gatewayUrl}/admin/devices/${sibling.device.id}/push-relay-consent`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${iosDevice.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ platform: "ios", appId: IOS_APP_ID }),
      },
    );
    expect(crossDeviceGrant.status).toBe(403);
    await gatewayDeviceJson(
      `/admin/devices/${iosDevice.device.id}/push-relay-consent`,
      iosDevice.token,
      { method: "POST", body: { platform: "ios", appId: IOS_APP_ID } },
    );
    expect(await pushPlan(iosDevice, "ios", IOS_APP_ID)).toEqual({
      transport: "relay",
      relayUrl,
    });
    expect(await pushPlan(sibling, "ios", IOS_APP_ID)).toMatchObject({
      transport: "unavailable",
      reasonCode: "relay-disabled",
    });
    const iosEnrolment = await relayJson<{ challengeId: string }>(
      "/v1/enrol",
      {
        platform: "ios",
        token: IOS_TOKEN,
        bundleId: IOS_APP_ID,
        environment: "production",
      },
      202,
    );
    const challenge = directApns.received.at(-1)!;
    expect(challenge.headers["apns-push-type"]).toBe("background");
    const nonce = (challenge.payload as { omnesis: { nonce: string } }).omnesis.nonce;
    const verified = await relayJson<{ credential: string }>("/v1/enrol/verify", {
      challengeId: iosEnrolment.challengeId,
      nonce,
    });

    await expectRelayStatus(
      "/v1/enrol/verify",
      { challengeId: iosEnrolment.challengeId, nonce },
      401,
    );
    const wakesBeforeForgery = iosWakeRequests().length;
    const replacement = verified.credential.endsWith("A") ? "B" : "A";
    await expectRelayWake(`${verified.credential.slice(0, -1)}${replacement}`, 401);
    expect(iosWakeRequests()).toHaveLength(wakesBeforeForgery);

    await gatewayDeviceJson(
      `/admin/devices/${iosDevice.device.id}/push-registration`,
      iosDevice.token,
      {
        method: "POST",
        body: {
          transport: "relay",
          relayUrl,
          credential: verified.credential,
        },
      },
    );

    const firstResult = await triggerPushTest(iosDevice.device.id);
    expect(firstResult.status, JSON.stringify(firstResult)).toBe("ok");
    expect(iosWakeRequests().at(-1)?.body.equals(APNS_WAKE_BYTES)).toBe(true);
    expect(iosWakeRequests().at(-1)?.body.toString("utf8")).toBe(APNS_WAKE_JSON);

    const firstClaim = await claim(iosDevice.token);
    expect(firstClaim).toMatchObject({
      kind: "diagnostic",
      targetId: "app",
      title: "Omnesis",
      body: "Test notification from your gateway.",
      collapseId: "push-test",
      remaining: 0,
    });
    await confirm(iosDevice.token, firstClaim.id);

    const orderedLeases: string[] = [];
    const wakesBeforeSequence = iosWakeRequests().length;
    for (let index = 0; index < 3; index += 1) {
      await triggerPushTest(iosDevice.device.id);
      const delivery = await claim(iosDevice.token);
      orderedLeases.push(delivery.id);
    }
    expect(
      iosWakeRequests()
        .slice(wakesBeforeSequence)
        .map((request) => request.body),
    ).toEqual([APNS_WAKE_BYTES, APNS_WAKE_BYTES, APNS_WAKE_BYTES]);
    expect(
      iosWakeRequests()
        .slice(wakesBeforeSequence)
        .map((request) => request.deviceToken),
    ).toEqual([IOS_TOKEN, IOS_TOKEN, IOS_TOKEN]);
    expect(new Set(orderedLeases)).toHaveLength(3);
    for (const deliveryId of orderedLeases) await confirm(iosDevice.token, deliveryId);

    const wakesBeforeSupersession = iosWakeRequests().length;
    await triggerPushTest(iosDevice.device.id);
    await triggerPushTest(iosDevice.device.id);
    expect(iosWakeRequests()).toHaveLength(wakesBeforeSupersession + 2);
    const newestOnly = await claim(iosDevice.token);
    expect(newestOnly.remaining).toBe(0);
    await confirm(iosDevice.token, newestOnly.id);
    expect(await claimOrNull(iosDevice.token)).toBeNull();

    const directDevice = await createDevice(
      "Fictional direct iPhone",
      "ios",
      SELF_BUILT_IOS_APP_ID,
    );
    await harness.json(`/admin/devices/${directDevice.device.id}/push-registration`, {
      method: "POST",
      body: JSON.stringify({
        transport: "direct-apns",
        deviceToken: DIRECT_IOS_TOKEN,
        environment: "production",
        bundleId: SELF_BUILT_IOS_APP_ID,
      }),
    });
    const directRequestsBefore = directApns.received.length;
    await triggerPushTest(directDevice.device.id);
    const directWake = directApns.received
      .slice(directRequestsBefore)
      .find((request) => request.deviceToken === DIRECT_IOS_TOKEN);
    expect(directWake).toMatchObject({
      deviceToken: DIRECT_IOS_TOKEN,
      headers: { "apns-push-type": "alert", "apns-topic": SELF_BUILT_IOS_APP_ID },
    });
    expect(directWake?.body.toString("utf8")).toBe(APNS_WAKE_JSON);

    await gatewayDeviceJson(
      `/admin/devices/${iosDevice.device.id}/push-relay-consent`,
      iosDevice.token,
      { method: "DELETE" },
    );
    expect(await pushPlan(iosDevice, "ios", IOS_APP_ID)).toMatchObject({
      transport: "unavailable",
      reasonCode: "relay-disabled",
    });
  }, 120_000);

  test("the real FCM carrier emits only the exact constant data wake", async () => {
    const androidDevice = await createDevice("Example phone", "android", ANDROID_APP_ID);
    await gatewayDeviceJson(
      `/admin/devices/${androidDevice.device.id}/push-relay-consent`,
      androidDevice.token,
      { method: "POST", body: { platform: "android", appId: ANDROID_APP_ID } },
    );
    const enrolment = await relayJson<{ challengeId: string }>(
      "/v1/enrol",
      {
        platform: "android",
        token: ANDROID_TOKEN,
        appId: ANDROID_APP_ID,
      },
      202,
    );
    const challenge = JSON.parse(relayFcm.sends.at(-1)!.body.toString("utf8")) as {
      message: { data: { nonce: string } };
    };
    const verified = await relayJson<{ credential: string }>("/v1/enrol/verify", {
      challengeId: enrolment.challengeId,
      nonce: challenge.message.data.nonce,
    });

    await gatewayDeviceJson(
      `/admin/devices/${androidDevice.device.id}/push-registration`,
      androidDevice.token,
      {
        method: "POST",
        body: {
          transport: "relay",
          relayUrl,
          credential: verified.credential,
        },
      },
    );
    const sendsBeforeGatewayWake = relayFcm.sends.length;
    const result = await triggerPushTest(androidDevice.device.id);
    expect(result.status, JSON.stringify(result)).toBe("ok");
    expect(relayFcm.sends).toHaveLength(sendsBeforeGatewayWake + 1);
    const wake = relayFcm.sends.at(-1)!;
    expect(wake.url).toBe(`${FCM_BASE_URL}/v1/projects/fictional-project/messages:send`);
    expect(wake.body.toString("utf8")).toBe(
      JSON.stringify({
        message: {
          token: ANDROID_TOKEN,
          data: FCM_WAKE_DATA,
          android: { priority: "high" },
        },
      }),
    );

    const claimed = await claim(androidDevice.token);
    expect(claimed).toMatchObject({
      kind: "diagnostic",
      targetId: "app",
      title: "Omnesis",
      body: "Test notification from your gateway.",
      collapseId: "push-test",
      remaining: 0,
    });
    await confirm(androidDevice.token, claimed.id);
    expect(await claimOrNull(androidDevice.token)).toBeNull();

    // The gateway wake above consumed one slot. Exactly 29 more are accepted;
    // the next request is rejected by the real rolling hourly bucket.
    for (let index = 1; index < 30; index += 1) {
      await expectRelayWake(verified.credential, 202);
    }
    const sendsAtLimit = relayFcm.sends.length;
    await expectRelayWake(verified.credential, 429);
    expect(relayFcm.sends).toHaveLength(sendsAtLimit);
  });

  test("shared broadcasts use only each phone's own current relay consent", async () => {
    const first = await createDevice("Example first relay phone", "ios", IOS_APP_ID);
    const second = await createDevice("Example second relay phone", "ios", IOS_APP_ID);
    const firstToken = "ef".repeat(32);
    const secondToken = "12".repeat(32);
    const db = new Database(harness.getDbPath(), { readonly: true });
    const notificationIds = new Set<string>();

    async function enrol(device: DeviceCredentials, token: string): Promise<string> {
      await gatewayDeviceJson(
        `/admin/devices/${device.device.id}/push-relay-consent`,
        device.token,
        {
          method: "POST",
          body: { platform: "ios", appId: IOS_APP_ID },
        },
      );
      expect(await pushPlan(device, "ios", IOS_APP_ID)).toEqual({ transport: "relay", relayUrl });
      const before = directApns.received.length;
      const enrolment = await relayJson<{ challengeId: string }>(
        "/v1/enrol",
        {
          platform: "ios",
          token,
          bundleId: IOS_APP_ID,
          environment: "production",
        },
        202,
      );
      const challenges = directApns.received
        .slice(before)
        .filter((request) => request.deviceToken === token);
      expect(challenges).toHaveLength(1);
      expect(challenges[0]!.headers["apns-push-type"]).toBe("background");
      const nonce = (challenges[0]!.payload as { omnesis: { nonce: string } }).omnesis.nonce;
      const { credential } = await relayJson<{ credential: string }>("/v1/enrol/verify", {
        challengeId: enrolment.challengeId,
        nonce,
      });
      await gatewayDeviceJson(
        `/admin/devices/${device.device.id}/push-registration`,
        device.token,
        {
          method: "POST",
          body: { transport: "relay", relayUrl, credential },
        },
      );
      return credential;
    }

    async function registrationRefused(
      device: DeviceCredentials,
      credential: string,
    ): Promise<void> {
      const response = await gatewayDeviceRequest(
        `/admin/devices/${device.device.id}/push-registration`,
        device.token,
        {
          transport: "relay",
          relayUrl,
          credential,
        },
      );
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("relay push is not authorized for this device");
    }

    async function broadcast(firstWake: boolean, secondWake: boolean): Promise<void> {
      const before = db
        .prepare<
          [],
          { rowid: number }
        >("SELECT COALESCE(MAX(rowid), 0) AS rowid FROM notifications")
        .get()!.rowid;
      const carrierBefore = directApns.received.length;
      // No device query: both durable copies must originate from this one broadcast.
      await harness.json("/admin/push/test", { method: "POST" });
      const notifications = db
        .prepare<
          [number],
          { id: string }
        >("SELECT id FROM notifications WHERE rowid > ? AND collapse_id = 'push-test'")
        .all(before);
      expect(notifications).toHaveLength(1);
      const notificationId = notifications[0]!.id;
      expect(notificationIds.has(notificationId)).toBe(false);
      notificationIds.add(notificationId);
      const copies = db
        .prepare<
          [string, string, string],
          { device_id: string }
        >("SELECT device_id FROM notification_deliveries WHERE notification_id = ? AND device_id IN (?, ?)")
        .all(notificationId, first.device.id, second.device.id);
      expect(copies.map((copy) => copy.device_id).sort()).toEqual(
        [first.device.id, second.device.id].sort(),
      );

      for (const [token, shouldWake] of [
        [firstToken, firstWake],
        [secondToken, secondWake],
      ] as const) {
        const requests = directApns.received
          .slice(carrierBefore)
          .filter((request) => request.deviceToken === token);
        expect(requests).toHaveLength(shouldWake ? 1 : 0);
        for (const request of requests) {
          expect(request.headers).toMatchObject({
            "apns-push-type": "alert",
            "apns-topic": IOS_APP_ID,
          });
          expect(request.body).toEqual(APNS_WAKE_BYTES);
          expect(request.body.toString("utf8")).toBe(APNS_WAKE_JSON);
        }
      }

      // Consent gates the external relay, not either phone's authenticated local claim.
      const firstClaim = await claim(first.token);
      const secondClaim = await claim(second.token);
      expect(firstClaim.id).not.toBe(secondClaim.id);
      for (const [device, delivery, sibling] of [
        [first, firstClaim, second],
        [second, secondClaim, first],
      ] as const) {
        expect(delivery).toMatchObject({
          kind: "diagnostic",
          collapseId: "push-test",
          remaining: 0,
        });
        expect(
          db
            .prepare<
              [string],
              { notification_id: string; device_id: string; state: string }
            >("SELECT notification_id, device_id, state FROM notification_deliveries WHERE lease_token = ?")
            .get(delivery.id),
        ).toEqual({
          notification_id: notificationId,
          device_id: device.device.id,
          state: "leased",
        });
        const crossDeviceConfirm = await gatewayDeviceRequest(
          "/notifications/confirm",
          sibling.token,
          { id: delivery.id },
        );
        expect(crossDeviceConfirm.status).toBe(404);
        await confirm(device.token, delivery.id);
        expect(await claimOrNull(device.token)).toBeNull();
      }
    }

    try {
      const firstCredential = await enrol(first, firstToken);
      expect(await pushPlan(second, "ios", IOS_APP_ID)).toMatchObject({
        transport: "unavailable",
        reasonCode: "relay-disabled",
      });
      await registrationRefused(second, firstCredential);
      await broadcast(true, false);
      // Includes enrolment challenges: this token never reached the carrier before consent.
      expect(
        directApns.received.filter((request) => request.deviceToken === secondToken),
      ).toHaveLength(0);

      await enrol(second, secondToken);
      await broadcast(true, true);

      await gatewayDeviceJson(`/admin/devices/${first.device.id}/push-relay-consent`, first.token, {
        method: "DELETE",
      });
      expect(await pushPlan(first, "ios", IOS_APP_ID)).toMatchObject({
        transport: "unavailable",
        reasonCode: "relay-disabled",
      });
      expect(await pushPlan(second, "ios", IOS_APP_ID)).toEqual({ transport: "relay", relayUrl });
      await registrationRefused(first, firstCredential);
      await broadcast(false, true);
      expect(notificationIds.size).toBe(3);
    } finally {
      db.close();
    }
  }, 120_000);

  test("consent from a pre-capability pairing adopts the attested app", async () => {
    // A phone paired before pushAppId existed carries no declared identity.
    // Consent used to refuse it with a 400 that the app could only render as
    // "check the connection"; the write now adopts the attested identity.
    const stale: DeviceCredentials = await harness.json<DeviceCredentials>("/admin/devices", {
      method: "POST",
      body: JSON.stringify({
        name: "Fictional pre-capability iPhone",
        kind: "ios",
        scopes: ["admin", "push:claim"],
        capabilities: {},
      }),
    });
    expect(await pushPlan(stale, "ios", IOS_APP_ID)).toMatchObject({
      transport: "unavailable",
      reasonCode: "relay-disabled",
    });
    await gatewayDeviceJson(`/admin/devices/${stale.device.id}/push-relay-consent`, stale.token, {
      method: "POST",
      body: { platform: "ios", appId: IOS_APP_ID },
    });
    expect(await pushPlan(stale, "ios", IOS_APP_ID)).toEqual({
      transport: "relay",
      relayUrl,
    });
    const listed = await gatewayDeviceJson<{
      items: Array<{ id: string; capabilities: { pushAppId?: string } }>;
    }>("/admin/devices", stale.token, { method: "GET" });
    expect(listed.items.find((row) => row.id === stale.device.id)?.capabilities.pushAppId).toBe(
      IOS_APP_ID,
    );
  });

  async function createDevice(
    name: string,
    kind: "ios" | "android",
    appId: string,
  ): Promise<DeviceCredentials> {
    return await harness.json<DeviceCredentials>("/admin/devices", {
      method: "POST",
      body: JSON.stringify({
        name,
        kind,
        scopes: ["admin", "push:claim"],
        capabilities: { pushAppId: appId },
      }),
    });
  }

  async function pushPlan(
    device: DeviceCredentials,
    platform: "ios" | "android",
    appId: string,
  ): Promise<Record<string, unknown>> {
    return await gatewayDeviceJson(
      `/admin/devices/${device.device.id}/push-plan?platform=${platform}&appId=${encodeURIComponent(appId)}`,
      device.token,
      { method: "GET" },
    );
  }

  async function gatewayDeviceJson<T = Record<string, unknown>>(
    path: string,
    token: string,
    init: { method: "GET" | "POST" | "DELETE"; body?: Record<string, unknown> },
  ): Promise<T> {
    const response = await fetch(`${harness.gatewayUrl}${path}`, {
      method: init.method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    });
    expect(response.status).toBe(200);
    return (await response.json()) as T;
  }

  async function triggerPushTest(
    deviceId: string,
  ): Promise<{ status: string; error?: string; stderrTail?: string }> {
    const response = await harness.json<{
      result: { status: string; error?: string; stderrTail?: string };
    }>(`/admin/push/test?deviceId=${encodeURIComponent(deviceId)}`, {
      method: "POST",
    });
    return response.result;
  }

  async function claim(token: string): Promise<ClaimedDelivery> {
    const delivery = await claimOrNull(token);
    if (!delivery) throw new Error("expected a queued notification delivery");
    return delivery;
  }

  async function claimOrNull(token: string): Promise<ClaimedDelivery | null> {
    const response = await gatewayDeviceRequest("/notifications/claim", token, {});
    if (response.status === 204) return null;
    expect(response.status).toBe(200);
    return (await response.json()) as ClaimedDelivery;
  }

  async function confirm(token: string, id: string): Promise<void> {
    const response = await gatewayDeviceRequest("/notifications/confirm", token, { id });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  }

  async function gatewayDeviceRequest(
    path: string,
    token: string,
    body: Record<string, unknown>,
  ): Promise<Response> {
    return await fetch(`${harness.gatewayUrl}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function relayJson<T>(
    path: string,
    body: Record<string, unknown>,
    expectedStatus = 200,
  ): Promise<T> {
    const response = await fetch(`${relayUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(expectedStatus);
    return (await response.json()) as T;
  }

  async function expectRelayStatus(
    path: string,
    body: Record<string, unknown>,
    status: number,
  ): Promise<void> {
    const response = await fetch(`${relayUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(status);
  }

  async function expectRelayWake(credential: string, status: number): Promise<void> {
    const response = await fetch(`${relayUrl}/v1/wake`, {
      method: "POST",
      headers: { authorization: `Bearer ${credential}` },
    });
    expect(response.status).toBe(status);
  }

  function iosWakeRequests() {
    return directApns.received.filter(
      (request) =>
        request.deviceToken === IOS_TOKEN && request.headers["apns-push-type"] === "alert",
    );
  }
});
