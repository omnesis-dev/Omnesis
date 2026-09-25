// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { APNS_WAKE_JSON, FCM_WAKE_DATA } from "@omnesis/core/push";
import { afterEach, describe, expect, it } from "vitest";

import { ApnsRelayCarrier, type ApnsRequest, type ApnsRequestInput } from "./apns.js";
import { FcmRelayCarrier } from "./fcm.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function privateKey(type: "ec" | "rsa"): string {
  const pair =
    type === "ec"
      ? generateKeyPairSync("ec", { namedCurve: "prime256v1" })
      : generateKeyPairSync("rsa", { modulusLength: 2048 });
  return pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

class FakeApnsRequest implements ApnsRequest {
  received: ApnsRequestInput[] = [];
  response = { statusCode: 200, body: "" };
  disposed = false;

  send(input: ApnsRequestInput): Promise<{ statusCode: number; body: string }> {
    this.received.push(input);
    return Promise.resolve(this.response);
  }

  dispose(): Promise<void> {
    this.disposed = true;
    return Promise.resolve();
  }
}

describe("ApnsRelayCarrier", () => {
  it("sends the exact core wake bytes and a distinct possession challenge", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-apns-"));
    dirs.push(dir);
    const keyPath = join(dir, "AuthKey_TEST.p8");
    writeFileSync(keyPath, privateKey("ec"), { mode: 0o600 });
    const request = new FakeApnsRequest();
    const carrier = new ApnsRelayCarrier({
      keyPath,
      keyId: "KEYID12345",
      teamId: "TEAMID1234",
      appIds: ["dev.omnesis.ios"],
      baseUrl: "http://carrier.example.test",
      request,
      clock: { now: () => 1_700_000_000_000 },
    });
    const target = {
      platform: "ios" as const,
      token: "ab".repeat(32),
      appId: "dev.omnesis.ios",
      environment: "production" as const,
    };

    await carrier.sendWake(target);
    await carrier.sendChallenge(target, "fictional-nonce");

    expect(request.received[0]?.body.toString("utf8")).toBe(APNS_WAKE_JSON);
    expect(request.received[0]).toMatchObject({
      authority: "http://carrier.example.test",
      path: `/3/device/${target.token}`,
      headers: {
        "apns-topic": "dev.omnesis.ios",
        "apns-push-type": "alert",
        "apns-priority": "10",
      },
    });
    expect(JSON.parse(request.received[1]!.body.toString("utf8"))).toEqual({
      aps: { "content-available": 1 },
      omnesis: { kind: "relay-enrol-challenge", nonce: "fictional-nonce" },
    });
    expect(request.received[1]?.headers).toMatchObject({
      "apns-push-type": "background",
      "apns-priority": "5",
    });
    expect(carrier.covers("dev.omnesis.ios")).toBe(true);
    expect(carrier.covers("org.example.other")).toBe(false);
    expect(carrier.health()).toMatchObject({
      status: "reachable",
      lastSuccessAt: 1_700_000_000_000,
    });
    await carrier.dispose();
    expect(request.disposed).toBe(false);
  });

  it.each([
    [410, "Unregistered", "unregistered"],
    [400, "BadDeviceToken", "bad_device_token"],
    [400, "DeviceTokenNotForTopic", "device_token_not_for_topic"],
  ] as const)("classifies APNs %s %s as stale", async (statusCode, reason, pruneReason) => {
    const dir = mkdtempSync(join(tmpdir(), "relay-apns-"));
    dirs.push(dir);
    const keyPath = join(dir, "AuthKey_TEST.p8");
    writeFileSync(keyPath, privateKey("ec"));
    const request = new FakeApnsRequest();
    request.response = { statusCode, body: JSON.stringify({ reason }) };
    const carrier = new ApnsRelayCarrier({
      keyPath,
      keyId: "KEYID12345",
      teamId: "TEAMID1234",
      appIds: ["dev.omnesis.ios"],
      request,
      clock: { now: () => 2_000 },
    });
    await expect(carrier.sendWake(iosTarget())).rejects.toMatchObject({
      kind: "stale_credential",
      pruneReason,
      message: "carrier dispatch failed: stale_credential",
    });
    expect(carrier.health()).toMatchObject({ status: "unreachable", lastFailureAt: 2_000 });
  });

  it("maps unknown APNs responses to other without exposing the response", async () => {
    const { carrier, request } = apnsFixture();
    request.response = {
      statusCode: 403,
      body: '{"reason":"SensitiveUnknownReason","detail":"do-not-expose"}',
    };
    const error = await carrier.sendWake(iosTarget()).catch((err: unknown) => err);
    expect(error).toEqual(expect.objectContaining({ kind: "other", pruneReason: null }));
    expect(String(error)).not.toMatch(/SensitiveUnknownReason|do-not-expose/);
  });

  it("classifies APNs JWT mint failures without exposing signing errors", async () => {
    const { carrier } = apnsFixture("not-a-private-key");
    await expect(carrier.sendWake(iosTarget())).rejects.toMatchObject({
      kind: "credential_mint_failed",
      message: "carrier dispatch failed: credential_mint_failed",
    });
  });
});

describe("FcmRelayCarrier", () => {
  function fixture(responses?: Response[]) {
    const dir = mkdtempSync(join(tmpdir(), "relay-fcm-"));
    dirs.push(dir);
    const serviceAccountPath = join(dir, "service-account.json");
    writeFileSync(
      serviceAccountPath,
      JSON.stringify({
        client_email: "relay@example.com",
        private_key: privateKey("rsa"),
        project_id: "example-project",
        token_uri: "https://oauth.example.test/token",
      }),
      { mode: 0o600 },
    );
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const queue = responses ?? [
      Response.json({ access_token: "access-token", expires_in: 3600 }),
      Response.json({ name: "messages/1" }),
      Response.json({ name: "messages/2" }),
    ];
    const fetchFn = (input: string | URL, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(input), init });
      const response = queue.shift();
      return response ? Promise.resolve(response) : Promise.reject(new Error("unexpected fetch"));
    };
    const carrier = new FcmRelayCarrier({
      serviceAccountPath,
      appIds: ["dev.omnesis.android"],
      baseUrl: "https://fcm.example.test",
      fetchFn,
      clock: { now: () => 1_700_000_000_000 },
    });
    return { carrier, calls };
  }

  it("sends exact core wake data through the service account's Firebase project", async () => {
    const { carrier, calls } = fixture();
    const target = {
      platform: "android" as const,
      token: "fictional-registration-token",
      appId: "dev.omnesis.android",
    };
    await carrier.sendWake(target);
    await carrier.sendChallenge(target, "fictional-nonce");

    expect(calls[0]?.url).toBe("https://oauth.example.test/token");
    expect(calls[1]?.url).toBe(
      "https://fcm.example.test/v1/projects/example-project/messages:send",
    );
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
      message: {
        token: target.token,
        data: FCM_WAKE_DATA,
        android: { priority: "high" },
      },
    });
    expect(JSON.parse(String(calls[2]?.init?.body))).toEqual({
      message: {
        token: target.token,
        data: { kind: "relay-enrol-challenge", nonce: "fictional-nonce" },
        android: { priority: "high" },
      },
    });
    expect(carrier.covers("dev.omnesis.android")).toBe(true);
    expect(carrier.covers("org.example.other")).toBe(false);
    expect(carrier.health()).toMatchObject({ status: "reachable" });
  });

  it("classifies FCM UNREGISTERED as stale", async () => {
    const { carrier } = fixture([
      Response.json({ access_token: "access-token", expires_in: 3600 }),
      Response.json({ error: { details: [{ errorCode: "UNREGISTERED" }] } }, { status: 404 }),
    ]);
    await expect(carrier.sendWake(androidTarget())).rejects.toMatchObject({
      kind: "stale_credential",
      pruneReason: "unregistered",
    });
    expect(carrier.health()).toMatchObject({
      status: "unreachable",
      lastFailureAt: 1_700_000_000_000,
    });
  });

  it("maps unknown FCM responses to other without exposing the response", async () => {
    const { carrier } = fixture([
      Response.json({ access_token: "access-token", expires_in: 3600 }),
      Response.json({ error: { status: "SENSITIVE_UNKNOWN" } }, { status: 503 }),
    ]);
    const error = await carrier.sendWake(androidTarget()).catch((err: unknown) => err);
    expect(error).toEqual(expect.objectContaining({ kind: "other", pruneReason: null }));
    expect(String(error)).not.toContain("SENSITIVE_UNKNOWN");
  });

  it("classifies FCM OAuth mint failures", async () => {
    const { carrier } = fixture([Response.json({ error: "invalid_grant" }, { status: 401 })]);
    await expect(carrier.sendWake(androidTarget())).rejects.toMatchObject({
      kind: "credential_mint_failed",
      message: "carrier dispatch failed: credential_mint_failed",
    });
  });
});

function iosTarget() {
  return {
    platform: "ios" as const,
    token: "ab".repeat(32),
    appId: "dev.omnesis.ios",
    environment: "sandbox" as const,
  };
}

function androidTarget() {
  return {
    platform: "android" as const,
    token: "fictional-registration-token",
    appId: "dev.omnesis.android",
  };
}

function apnsFixture(key = privateKey("ec")) {
  const dir = mkdtempSync(join(tmpdir(), "relay-apns-"));
  dirs.push(dir);
  const keyPath = join(dir, "AuthKey_TEST.p8");
  writeFileSync(keyPath, key);
  const request = new FakeApnsRequest();
  const carrier = new ApnsRelayCarrier({
    keyPath,
    keyId: "KEYID12345",
    teamId: "TEAMID1234",
    appIds: ["dev.omnesis.ios"],
    request,
    clock: { now: () => 2_000 },
  });
  return { carrier, request };
}
