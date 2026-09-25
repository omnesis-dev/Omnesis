// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * End-to-end seam test for the direct APNs transport.
 *
 * Drives the real `ApnsClient` → `Http2ApnsTransport` (node:http2)
 * stack against the fake APNs server,
 * with no Apple credentials and no network. The only injected seam is
 * `ApnsClient.baseUrl` (mirroring the `gateway.apns.baseUrl` /
 * `OMNESIS_APNS_BASE_URL` config the gateway reads at boot), which
 * points the transport at the fake's h2c origin.
 *
 * Asserts the fake observed the exact content-free wake bytes an iPhone
 * would receive.
 */

import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { APNS_WAKE_JSON, APNS_WAKE_PAYLOAD } from "@omnesis/core/push";
import { ApnsClient } from "../../../gateway/src/push/transports/direct-apns.js";

import { startFakeApnsServer, type FakeApnsServer } from "./fake-apns.js";

function mintP256KeyFile(dir: string): string {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pem = privateKey.export({ format: "pem", type: "pkcs8" }) as string;
  const path = join(dir, "AuthKey.p8");
  writeFileSync(path, pem);
  return path;
}

let tmpDir: string;
let keyPath: string;
let fake: FakeApnsServer;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "fake-apns-e2e-"));
  keyPath = mintP256KeyFile(tmpDir);
});

afterEach(async () => {
  if (fake) await fake.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("direct APNs end-to-end against fake APNs", () => {
  test("real transport dispatches to baseUrl and the fake records the push", async () => {
    fake = await startFakeApnsServer();

    const client = new ApnsClient({
      config: {
        keyPath,
        keyId: "ABCDE12345",
        teamId: "TEAM123456",
        bundleId: "dev.omnesis.ios",
        environment: "production",
      },
      baseUrl: fake.url,
    });

    const result = await client.send({
      deviceToken: "a".repeat(64),
      environment: "production",
      bundleId: "dev.omnesis.ios",
    });

    await client.dispose();

    expect(result).toMatchObject({ ok: true, statusCode: 200 });

    expect(fake.received).toHaveLength(1);
    const push = fake.received[0]!;
    expect(push.deviceToken).toBe("a".repeat(64));
    expect(push.headers["apns-topic"]).toBe("dev.omnesis.ios");
    expect(push.headers["apns-push-type"]).toBe("alert");
    expect(push.headers.authorization).toMatch(/^bearer eyJ/);

    expect(push.body.toString("utf8")).toBe(APNS_WAKE_JSON);
    expect(push.payload).toEqual(APNS_WAKE_PAYLOAD);
  });

  test("fans out to multiple devices, recording one push each", async () => {
    fake = await startFakeApnsServer();
    const client = new ApnsClient({
      config: {
        keyPath,
        keyId: "ABCDE12345",
        teamId: "TEAM123456",
        bundleId: "dev.omnesis.ios",
        environment: "production",
      },
      baseUrl: fake.url,
    });

    const results = await Promise.all([
      client.send({ deviceToken: "a".repeat(64), environment: "production" }),
      client.send({ deviceToken: "b".repeat(64), environment: "sandbox" }),
    ]);
    await client.dispose();

    expect(results.every((result) => result.ok)).toBe(true);
    expect(fake.received).toHaveLength(2);
    expect(fake.received.map((p) => p.deviceToken).sort()).toEqual(
      ["a".repeat(64), "b".repeat(64)].sort(),
    );
  });

  test("reports 410 Unregistered as a stale registration", async () => {
    fake = await startFakeApnsServer({
      respond: () => ({ statusCode: 410, reason: "Unregistered" }),
    });
    const client = new ApnsClient({
      config: {
        keyPath,
        keyId: "ABCDE12345",
        teamId: "TEAM123456",
        bundleId: "dev.omnesis.ios",
        environment: "production",
      },
      baseUrl: fake.url,
    });

    const result = await client.send({
      deviceToken: "a".repeat(64),
      environment: "production",
    });
    await client.dispose();

    expect(result).toMatchObject({
      ok: false,
      statusCode: 410,
      reason: "Unregistered",
      unregistered: true,
    });
  });
});
