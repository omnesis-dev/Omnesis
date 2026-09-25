// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { writeFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, test, beforeEach, afterEach } from "vitest";

import { ApnsClient } from "./direct-apns.js";
import type { ApnsTransport, ApnsTransportRequest, ApnsTransportResponse } from "./apns-http2.js";
import type { ApnsConfig } from "./apns-types.js";

/**
 * Fake transport that records the requests it sees and returns
 * caller-configured responses (or a default 200 OK). Lets us assert
 * on the wire shape without standing up real HTTP/2.
 */
class FakeApnsTransport implements ApnsTransport {
  readonly requests: ApnsTransportRequest[] = [];
  private response: ApnsTransportResponse = {
    statusCode: 200,
    headers: { "apns-id": "fake-apns-id" },
    body: "",
  };
  disposed = false;

  setResponse(resp: ApnsTransportResponse): void {
    this.response = resp;
  }

  async request(req: ApnsTransportRequest): Promise<ApnsTransportResponse> {
    this.requests.push(req);
    return this.response;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
  }
}

function mintP256KeyFile(dir: string, name = "AuthKey.p8"): string {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pem = privateKey.export({ format: "pem", type: "pkcs8" }) as string;
  const path = join(dir, name);
  writeFileSync(path, pem);
  return path;
}

function makeConfig(keyPath: string, overrides: Partial<ApnsConfig> = {}): ApnsConfig {
  return {
    keyPath,
    keyId: "ABCDE12345",
    teamId: "TEAM123456",
    bundleId: "dev.omnesis.ios",
    environment: "production",
    ...overrides,
  };
}

let tmpDir: string;
let keyPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "apns-test-"));
  keyPath = mintP256KeyFile(tmpDir);
});

afterEach(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

describe("ApnsClient.send — wire shape", () => {
  test("posts to /3/device/<token> with apns-topic + apns-push-type headers", async () => {
    const transport = new FakeApnsTransport();
    const client = new ApnsClient({ config: makeConfig(keyPath), transport });
    const result = await client.send({
      deviceToken: "abcdef0123456789".repeat(4),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.apnsId).toBe("fake-apns-id");

    const sent = transport.requests[0]!;
    expect(sent.authority).toBe("https://api.push.apple.com");
    expect(sent.path).toBe(`/3/device/${"abcdef0123456789".repeat(4)}`);
    expect(sent.headers["apns-topic"]).toBe("dev.omnesis.ios");
    expect(sent.headers["apns-push-type"]).toBe("alert");
    expect(sent.headers.authorization).toMatch(/^bearer eyJ/); // JWT base64 header starts with eyJ

    const body = JSON.parse(sent.body);
    expect(body.aps.alert).toEqual({
      title: "Omnesis",
      body: "Omnesis has something for you",
    });
    expect(body.aps["mutable-content"]).toBe(1);
    expect(body.aps.sound).toBe("default");
    expect(body.aps["interruption-level"]).toBeUndefined();
    expect(body.omnesis).toBeUndefined();
  });

  test("uses sandbox host when environment is sandbox", async () => {
    const transport = new FakeApnsTransport();
    const client = new ApnsClient({
      config: makeConfig(keyPath, { environment: "sandbox" }),
      transport,
    });
    await client.send({
      deviceToken: "a".repeat(64),
    });
    expect(transport.requests[0]!.authority).toBe("https://api.sandbox.push.apple.com");
  });

  test("per-notification environment override wins over config default", async () => {
    const transport = new FakeApnsTransport();
    const client = new ApnsClient({
      config: makeConfig(keyPath, { environment: "production" }),
      transport,
    });
    await client.send({
      deviceToken: "a".repeat(64),
      environment: "sandbox",
    });
    expect(transport.requests[0]!.authority).toBe("https://api.sandbox.push.apple.com");
  });

  test("per-notification bundleId override appears in apns-topic", async () => {
    const transport = new FakeApnsTransport();
    const client = new ApnsClient({ config: makeConfig(keyPath), transport });
    await client.send({
      deviceToken: "a".repeat(64),
      bundleId: "dev.omnesis.ios.beta",
    });
    expect(transport.requests[0]!.headers["apns-topic"]).toBe("dev.omnesis.ios.beta");
  });

  test("never emits a content-derived collapse header", async () => {
    const transport = new FakeApnsTransport();
    const client = new ApnsClient({ config: makeConfig(keyPath), transport });
    await client.send({
      deviceToken: "a".repeat(64),
    });
    expect(transport.requests[0]!.headers["apns-collapse-id"]).toBeUndefined();
  });
});

describe("ApnsClient.send — APNs error responses", () => {
  test("BadDeviceToken is surfaced with unregistered: true", async () => {
    const transport = new FakeApnsTransport();
    transport.setResponse({
      statusCode: 400,
      headers: {},
      body: JSON.stringify({ reason: "BadDeviceToken" }),
    });
    const client = new ApnsClient({ config: makeConfig(keyPath), transport });
    const result = await client.send({
      deviceToken: "a".repeat(64),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.statusCode).toBe(400);
      expect(result.reason).toBe("BadDeviceToken");
      expect(result.unregistered).toBe(true);
    }
  });

  test("Unregistered (410) is surfaced with unregistered: true", async () => {
    const transport = new FakeApnsTransport();
    transport.setResponse({
      statusCode: 410,
      headers: {},
      body: JSON.stringify({ reason: "Unregistered" }),
    });
    const client = new ApnsClient({ config: makeConfig(keyPath), transport });
    const result = await client.send({
      deviceToken: "a".repeat(64),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.unregistered).toBe(true);
  });

  test("TooManyRequests is surfaced with unregistered: false", async () => {
    const transport = new FakeApnsTransport();
    transport.setResponse({
      statusCode: 429,
      headers: {},
      body: JSON.stringify({ reason: "TooManyRequests" }),
    });
    const client = new ApnsClient({ config: makeConfig(keyPath), transport });
    const result = await client.send({
      deviceToken: "a".repeat(64),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("TooManyRequests");
      expect(result.unregistered).toBe(false);
    }
  });

  test("non-JSON error body produces empty reason", async () => {
    const transport = new FakeApnsTransport();
    transport.setResponse({ statusCode: 500, headers: {}, body: "<html>oops</html>" });
    const client = new ApnsClient({ config: makeConfig(keyPath), transport });
    const result = await client.send({
      deviceToken: "a".repeat(64),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.statusCode).toBe(500);
      expect(result.reason).toBe("");
    }
  });
});

describe("ApnsClient.send — JWT caching + reuse", () => {
  test("re-uses the same JWT across calls within the cache window", async () => {
    const transport = new FakeApnsTransport();
    let nowMs = 1_700_000_000_000;
    const client = new ApnsClient({
      config: makeConfig(keyPath),
      transport,
      now: () => nowMs,
    });
    await client.send({ deviceToken: "a".repeat(64) });
    const auth1 = transport.requests[0]!.headers.authorization;
    nowMs += 60_000; // 1 min later — well inside the cache window.
    await client.send({ deviceToken: "a".repeat(64) });
    const auth2 = transport.requests[1]!.headers.authorization;
    expect(auth1).toBe(auth2);
  });

  test("re-mints the JWT once the cache window elapses", async () => {
    const transport = new FakeApnsTransport();
    let nowMs = 1_700_000_000_000;
    const client = new ApnsClient({
      config: makeConfig(keyPath),
      transport,
      now: () => nowMs,
    });
    await client.send({ deviceToken: "a".repeat(64) });
    const auth1 = transport.requests[0]!.headers.authorization;
    nowMs += 50 * 60_000; // 50 min — past the 45-min refresh threshold.
    await client.send({ deviceToken: "a".repeat(64) });
    const auth2 = transport.requests[1]!.headers.authorization;
    expect(auth1).not.toBe(auth2);
  });
});

describe("ApnsClient.send — failure modes", () => {
  test("missing .p8 file rejects with the underlying ENOENT error", async () => {
    const transport = new FakeApnsTransport();
    const missingPath = join(tmpDir, "no-such-key.p8");
    const client = new ApnsClient({ config: makeConfig(missingPath), transport });
    await expect(client.send({ deviceToken: "a".repeat(64) })).rejects.toThrow(
      /ENOENT|no such file/i,
    );
  });

  test("malformed .p8 (not a P-256 PEM) rejects on first send", async () => {
    const badPath = join(tmpDir, "bad.p8");
    writeFileSync(badPath, "not a key");
    const transport = new FakeApnsTransport();
    const client = new ApnsClient({ config: makeConfig(badPath), transport });
    await expect(client.send({ deviceToken: "a".repeat(64) })).rejects.toThrow();
  });

  test("dispose() is a no-op when the transport is caller-owned", async () => {
    const transport = new FakeApnsTransport();
    const client = new ApnsClient({ config: makeConfig(keyPath), transport });
    await client.dispose();
    expect(transport.disposed).toBe(false);
  });

  test("buildPayload is byte-for-byte constant", () => {
    expect(ApnsClient.buildPayload()).toBe(ApnsClient.buildPayload());
    expect(ApnsClient.buildPayload()).not.toContain("agent-answer");
    expect(ApnsClient.buildPayload()).not.toContain("11:00");
  });
});
