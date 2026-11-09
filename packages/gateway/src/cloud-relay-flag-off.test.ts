// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Responses a gateway has always given must not change shape unless the cloud
 * relay opt-in is set. Each check runs both ways, so an absence means something.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { SCOPE_ADMIN, SCOPE_READ } from "@omnesis/types";
import { createDatabase } from "./db.js";
import { createDevice } from "./data/repositories/DeviceRepository.js";
import { createToken } from "./data/repositories/TokenRepository.js";
import { createServer } from "./server.js";

let dir: string;
let db: ReturnType<typeof createDatabase>;
let app: ReturnType<typeof createServer>;
let admin: string;

function flag(on: boolean): void {
  vi.stubEnv("OMNESIS_CLOUD_RELAY_ENABLED", on ? "1" : "");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omnesis-flag-off-"));
  const path = join(dir, "gateway.sqlite");
  db = createDatabase(path);
  const device = createDevice(db, { name: "Fictional admin CLI", kind: "cli" });
  admin = createToken(db, device.id, [SCOPE_ADMIN, SCOPE_READ]).token;
  app = createServer(db, path, {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const authorized = () => ({ authorization: `Bearer ${admin}` });

test("/health and /status name the cloud relay only with the opt-in", async () => {
  for (const path of ["/health", "/status"]) {
    flag(false);
    const first = await app.request(path, { headers: authorized() });
    expect(first.status, path).toBe(200);
    const off = (await first.json()) as object;
    expect(off, path).not.toHaveProperty("cloudRelay");
    flag(true);
    const on = (await (await app.request(path, { headers: authorized() })).json()) as object;
    expect(on, path).toMatchObject({ cloudRelay: true });
    // The opt-in adds its one key and moves no other.
    expect(Object.keys(on).filter((key) => key !== "cloudRelay")).toEqual(Object.keys(off));
  }
});

test("a signed-out session answer carries the sign-in hint only with the opt-in", async () => {
  flag(false);
  const off = await app.request("/portal/api/session");
  expect(await off.text()).toBe('{"authenticated":false}');
  flag(true);
  expect(await (await app.request("/portal/api/session")).json()).toEqual({
    authenticated: false,
    cloudRelay: true,
  });
});

test("the pairing QR refuses the strict trust modes as unknown values without the opt-in", async () => {
  const encode = (trustMode: string) =>
    app.request("/admin/devices/pair-qr", {
      method: "POST",
      headers: { ...authorized(), "content-type": "application/json" },
      body: JSON.stringify({
        pairingCode: "ABCDEF0123",
        gatewayUrl: "https://gateway.example.test",
        trustMode,
      }),
    });
  for (const trustMode of ["pinned-leaf-strict", "pinned-key-strict"]) {
    flag(false);
    const refused = await encode(trustMode);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({
      error: "Validation failed",
      code: "VALIDATION_ERROR",
      detail: [
        {
          path: "/trustMode",
          message: 'Invalid option: expected one of "auto"|"system"|"pinned-leaf"',
        },
      ],
    });
    flag(true);
    expect(((await (await encode(trustMode)).json()) as { code?: string }).code).not.toBe(
      "VALIDATION_ERROR",
    );
  }
  // A value neither side knows is worded by whichever set is in force.
  flag(false);
  const unknown = (await (await encode("pinned-chain")).json()) as {
    detail: Array<{ message: string }>;
  };
  expect(unknown.detail[0]!.message).toBe(
    'Invalid option: expected one of "auto"|"system"|"pinned-leaf"',
  );
});
