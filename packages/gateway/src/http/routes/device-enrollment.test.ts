// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createPublicKey, generateKeyPairSync, randomUUID, type KeyObject } from "node:crypto";
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { signDeviceTranscript, tokenRotationTranscript } from "@omnesis/cloud-relay";
import { defaultScopesForDeviceKind } from "@omnesis/types";
import { createDatabase } from "../../db.js";
import {
  createDevice,
  createPairing,
  redeemDevicePairing,
} from "../../data/repositories/DeviceRepository.js";
import { createToken, lookupToken } from "../../data/repositories/TokenRepository.js";
import { createServer } from "../../server.js";
import type Database from "better-sqlite3";

const SPKI = "a".repeat(64);

let db: Database.Database;
let dbPath: string;
let app: ReturnType<typeof createServer>;
let adminToken: string;

function deviceKey(): { privateKey: KeyObject; publicKey: string } {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    privateKey,
    publicKey: createPublicKey(privateKey)
      .export({ type: "spki", format: "der" })
      .toString("base64url"),
  };
}

function boot(): void {
  app = createServer(db, undefined, {
    tlsSpkiFingerprintSha256: SPKI,
  } as never);
}

beforeEach(() => {
  vi.stubEnv("OMNESIS_CLOUD_RELAY_ENABLED", "1");
  dbPath = `/tmp/omnesis-device-enrollment-${randomUUID()}.db`;
  db = createDatabase(dbPath);
  const admin = createDevice(db, { name: "Admin phone", kind: "ios" });
  adminToken = createToken(db, admin.id, defaultScopesForDeviceKind("ios")).token;
  boot();
});

afterEach(() => {
  vi.unstubAllEnvs();
  db.close();
  for (const suffix of ["", "-wal", "-shm"]) rmSync(dbPath + suffix, { force: true });
});

const json = (token: string | null, body?: unknown, method = "POST"): RequestInit => ({
  method,
  headers: {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

describe("token rotation", () => {
  /** A collector that joined by signing in, so the gateway holds its device key. */
  function enrolledDevice() {
    const key = deviceKey();
    const pending = createPairing(db, {
      kind: "collector",
      scopes: defaultScopesForDeviceKind("collector"),
      enrollment: { method: "automatic", signIn: "google", devicePublicKey: key.publicKey },
    });
    const result = redeemDevicePairing(db, {
      pairingCode: pending.pairingCode,
      expectedKind: "collector",
      capabilities: { suggestedName: "build-01" },
    });
    if (result.outcome !== "paired") throw new Error(result.outcome);
    return { ...result, key };
  }

  async function rotate(device: ReturnType<typeof enrolledDevice>, spki = SPKI) {
    const { challenge } = (await (
      await app.request("/devices/token/challenge", json(device.token, {}))
    ).json()) as { challenge: string };
    const signature = signDeviceTranscript(
      device.key.privateKey,
      tokenRotationTranscript({
        deviceId: device.device.id,
        gatewaySpkiFingerprint: spki,
        challenge,
        devicePublicKey: device.key.publicKey,
      }),
    );
    const send = () =>
      app.request("/devices/token/rotate", json(device.token, { challenge, signature }));
    return { first: await send(), retry: send };
  }

  test("mints a token of the same scopes, keeps the old one for an hour, and a retry is the same answer", async () => {
    const device = enrolledDevice();
    const { first, retry } = await rotate(device);
    expect(first.status).toBe(200);
    const rotated = (await first.json()) as { token: string; tokenId: string };
    expect(lookupToken(db, rotated.token)?.scopes).toEqual(device.scopes);
    expect(lookupToken(db, device.token)).not.toBeNull();
    const again = (await (await retry()).json()) as { token: string };
    expect(again.token).toBe(rotated.token);
  });

  test("refuses a signature over another TLS key", async () => {
    const device = enrolledDevice();
    expect((await rotate(device, "c".repeat(64))).first.status).toBe(403);
  });

  test("refuses a device that never had a device key", async () => {
    const response = await app.request("/devices/token/challenge", json(adminToken, {}));
    const { challenge } = (await response.json()) as { challenge: string };
    const rotateResponse = await app.request(
      "/devices/token/rotate",
      json(adminToken, { challenge, signature: "A".repeat(86) }),
    );
    expect(rotateResponse.status).toBe(409);
    expect(((await rotateResponse.json()) as { code: string }).code).toBe("DEVICE_KEY_REQUIRED");
  });
});

describe("without the cloud relay opt-in", () => {
  beforeEach(() => {
    vi.stubEnv("OMNESIS_CLOUD_RELAY_ENABLED", "");
    boot();
  });

  test("none of these routes exist", async () => {
    for (const path of ["/devices/token/challenge", "/devices/token/rotate"]) {
      const response = await app.request(path, json(adminToken, {}));
      expect(response.status, path).toBe(404);
    }
  });

  test("whoami and the device list keep their shape", async () => {
    const whoami = (await (
      await app.request("/whoami", json(adminToken, undefined, "GET"))
    ).json()) as object;
    expect(Object.keys(whoami).sort()).toEqual(["deviceId", "deviceName", "scopes", "tokenId"]);
    // Even a row enrolled while the opt-in was on.
    const enrolled = createDevice(db, { name: "Enrolled", kind: "cli" });
    db.prepare(
      "UPDATE devices SET enrollment_method = 'automatic', enrolled_at = ?, enrollment_public_key = 'k' WHERE id = ?",
    ).run(Date.now(), enrolled.id);
    boot();
    const devices = (await (
      await app.request("/admin/devices", json(adminToken, undefined, "GET"))
    ).json()) as { items: object[] };
    expect(devices.items.every((device) => !("enrollment" in device))).toBe(true);
  });
});
