// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Step-up on `POST /admin/tokens` for a phone that joined on its own. Once the owner confirmed a
// passkey, such a device steps up before minting a token, even on the home network
// (docs/device-enrollment.md, "Step-up"). The one exception is the phone's own notification
// credential: a token for itself with only `push:claim`, which its own token already carries.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { EnrollmentChallenges, type GatewayEnrollment } from "@omnesis/cloud-relay";
import { SCOPE_ADMIN, SCOPE_PUSH_CLAIM, SCOPE_READ, type Scope } from "@omnesis/types";
import { createFreshTestDatabase } from "../../../testing/fresh-database.js";
import { createServer } from "../../../server.js";
import { createDevice } from "../../../data/repositories/DeviceRepository.js";
import { createToken } from "../../../data/repositories/TokenRepository.js";
import type Database from "better-sqlite3";

let db: Database.Database;
let dir: string;
let path: string;
beforeEach(() => {
  vi.stubEnv("OMNESIS_EXPERIMENTAL", "0");
  dir = mkdtempSync(join(tmpdir(), "omnesis-token-step-up-"));
  path = join(dir, "gateway.sqlite");
  db = createFreshTestDatabase(path);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

/** A linked gateway where the owner confirmed a passkey, so loosening actions step up. */
function linkedServer() {
  const enrollment = {
    policy: () => "automatic",
    spkiFingerprint: () => "c".repeat(64),
    challenges: new EnrollmentChallenges(),
    verifyProof: async () => undefined,
    canTrust: async () => false,
    trustSignIn: async () => {},
    stepUpRequired: () => true,
    gatewayPasskey: () => ({ rpId: "relay.example.test", origin: "https://g-1.example.test" }),
  } satisfies GatewayEnrollment;
  const unused = () => Promise.reject(new Error("Unused management operation"));
  return createServer(db, path, {
    tlsFingerprintSha256: "a".repeat(64),
    cloudRelayManagement: {
      status: unused,
      configure: unused,
      enable: unused,
      disable: unused,
      reconnect: unused,
      renew: unused,
      accountModeActivated: () => true,
      accountPairingIdentity: () => ({
        identity: { verify: () => Promise.reject(new Error("unused")) },
        ownerAccountId: createHash("sha256").update("fictional-owner").digest("hex"),
        configurationKey: "fictional-account",
        enrollment,
      }),
    },
  });
}

/** A phone that joined by signing in on its own, with the token it joined with. */
function joinedPhone(name: string, scopes: Scope[] = [SCOPE_ADMIN, SCOPE_READ, SCOPE_PUSH_CLAIM]) {
  const device = createDevice(db, { name, kind: "ios" });
  db.prepare(
    "UPDATE devices SET enrollment_method = 'automatic', enrollment_sign_in = 'google', enrolled_at = ? WHERE id = ?",
  ).run(Date.now(), device.id);
  return { device, token: createToken(db, device.id, scopes).token };
}

function mint(
  server: ReturnType<typeof linkedServer>,
  token: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return server.request("/admin/tokens", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

test("a phone that joined on its own mints its own notification credential without a step-up", async () => {
  const server = linkedServer();
  const phone = joinedPhone("Fictional phone");
  // What the iOS and Android apps send.
  const response = await mint(server, phone.token, {
    deviceId: phone.device.id,
    scopes: ["push:claim"],
    name: "notifications",
  });
  expect(response.status).toBe(200);
  const minted = (await response.json()) as { deviceId: string; scopes: string[]; token: string };
  expect(minted).toMatchObject({ deviceId: phone.device.id, scopes: ["push:claim"] });
  // The new token claims this phone's notifications and does nothing else.
  const claim = await server.request("/notifications/claim", {
    method: "POST",
    headers: { authorization: `Bearer ${minted.token}`, "content-type": "application/json" },
    body: "{}",
  });
  expect(claim.status).toBe(204);
  const read = await server.request("/admin/tokens", {
    headers: { authorization: `Bearer ${minted.token}` },
  });
  expect(read.status).toBe(403);
  // The same through the relay, as the phone sends it away from home.
  expect(
    (
      await mint(
        server,
        phone.token,
        { deviceId: phone.device.id, scopes: ["push:claim"] },
        { "x-omnesis-cloud-relay": "1" },
      )
    ).status,
  ).toBe(200);
});

test("anything wider than the phone's own notification credential still steps up", async () => {
  const server = linkedServer();
  const phone = joinedPhone("Fictional phone");
  const other = createDevice(db, { name: "Fictional other phone", kind: "ios" });
  for (const body of [
    // Another device's credential.
    { deviceId: other.id, scopes: ["push:claim"] },
    // Any other scope, alone or alongside.
    { deviceId: phone.device.id, scopes: ["admin"] },
    { deviceId: phone.device.id, scopes: ["read"] },
    { deviceId: phone.device.id, scopes: ["push:claim", "read"] },
    { deviceId: phone.device.id, scopes: ["push:claim", "push:claim"] },
    { deviceId: phone.device.id, scopes: [] },
    // Not a body the gateway would accept as the exception.
    { deviceId: phone.device.id },
    { scopes: ["push:claim"] },
  ]) {
    const response = await mint(server, phone.token, body);
    expect(response.status, JSON.stringify(body)).toBe(428);
    expect(await response.json()).toMatchObject({ code: "STEP_UP_REQUIRED" });
  }
  // A body that only looks right without a JSON content type is not read as one.
  const plain = await server.request("/admin/tokens", {
    method: "POST",
    headers: { authorization: `Bearer ${phone.token}`, "content-type": "text/plain" },
    body: JSON.stringify({ deviceId: phone.device.id, scopes: ["push:claim"] }),
  });
  expect(plain.status).toBe(428);
});

test("a caller whose own token can't claim notifications gets no exception for minting one", async () => {
  const server = linkedServer();
  // An admin-only token on a phone that joined on its own: push:claim would be new authority.
  const phone = joinedPhone("Fictional phone", [SCOPE_ADMIN]);
  const response = await mint(server, phone.token, {
    deviceId: phone.device.id,
    scopes: ["push:claim"],
  });
  expect(response.status).toBe(428);
});

test("on a gateway that never linked an account, minting a token is as before", async () => {
  const server = createServer(db, path, { tlsFingerprintSha256: "a".repeat(64) });
  const phone = joinedPhone("Fictional phone");
  const other = createDevice(db, { name: "Fictional other phone", kind: "ios" });
  for (const body of [
    { deviceId: phone.device.id, scopes: ["push:claim"] },
    { deviceId: other.id, scopes: ["admin"] },
  ])
    expect((await mint(server, phone.token, body)).status).toBe(200);
});
