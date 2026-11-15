// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Without OMNESIS_TAILSCALE_EMBED_ENABLED=1 the gateway must answer exactly as
 * it did before the embedded Tailscale device existed, experimental mode
 * included. Each check runs both ways, so an absence means something.
 */
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { SCOPE_ADMIN, SCOPE_READ } from "@omnesis/types";
import { createDatabase } from "./db.js";
import { createDevice, getDevice } from "./data/repositories/DeviceRepository.js";
import { createToken } from "./data/repositories/TokenRepository.js";
import { deviceCapabilitySchema } from "./http/schemas/common.js";
import { createServer } from "./server.js";
import { TailscaleEmbedService } from "./tailscale-embed/service.js";

let dir: string;
let db: ReturnType<typeof createDatabase>;
let admin: string;
let path: string;

function flag(on: boolean): void {
  vi.stubEnv("OMNESIS_TAILSCALE_EMBED_ENABLED", on ? "1" : "");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omnesis-ts-flag-off-"));
  path = join(dir, "gateway.sqlite");
  db = createDatabase(path);
  const device = createDevice(db, { name: "Fictional admin CLI", kind: "cli" });
  admin = createToken(db, device.id, [SCOPE_ADMIN, SCOPE_READ]).token;
});

afterEach(() => {
  vi.unstubAllEnvs();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const authorized = () => ({ authorization: `Bearer ${admin}` });

function service(): TailscaleEmbedService {
  return new TailscaleEmbedService({
    configDir: dir,
    tlsMaterial: () => ({ cert: "", key: "" }),
    joins: { notifyWaiting: () => {}, notifyJoined: () => {} },
    resolveBinary: () => ({ path: null, reason: "not in this test" }),
  });
}

for (const experimental of ["", "1"]) {
  test(`/health and /status name the embedded Tailscale device only with the opt-in (experimental=${experimental || "off"})`, async () => {
    vi.stubEnv("OMNESIS_EXPERIMENTAL", experimental);
    const app = createServer(db, path, {});
    for (const route of ["/health", "/status"]) {
      flag(false);
      const off = (await (await app.request(route, { headers: authorized() })).json()) as object;
      expect(off, route).not.toHaveProperty("tailscaleEmbed");
      flag(true);
      const on = (await (await app.request(route, { headers: authorized() })).json()) as object;
      expect(on, route).toMatchObject({ tailscaleEmbed: true });
      // The opt-in adds its one key and moves no other.
      expect(Object.keys(on).filter((key) => key !== "tailscaleEmbed")).toEqual(Object.keys(off));
    }
  });
}

test("no route exists without the opt-in, even when a service is wired", async () => {
  flag(false);
  const app = createServer(db, path, {});
  const probes: Array<[string, string]> = [
    ["GET", "/admin/tailscale"],
    ["POST", "/admin/tailscale/enable"],
    ["POST", "/admin/tailscale/sign-in"],
    ["POST", "/admin/tailscale/sign-out"],
    ["PATCH", "/admin/tailscale/settings"],
    ["GET", "/admin/tailscale/join-requests"],
    ["POST", "/admin/tailscale/join-requests/x/decision"],
    ["POST", "/tailscale/join"],
    ["POST", "/tailscale/join/x/poll"],
  ];
  const control = await app.request("/admin/never-existed", { headers: authorized() });
  for (const [method, route] of probes) {
    const res = await app.request(route, {
      method,
      headers: { ...authorized(), "content-type": "application/json" },
      ...(method === "GET" ? {} : { body: "{}" }),
    });
    expect(res.status, `${method} ${route}`).toBe(control.status);
  }
  // A service handed to a gateway without the opt-in mounts nothing either.
  const wired = createServer(db, path, { tailscaleEmbed: service() });
  expect((await wired.request("/admin/tailscale", { headers: authorized() })).status).toBe(
    control.status,
  );
  flag(true);
  const on = createServer(db, path, { tailscaleEmbed: service() });
  expect((await on.request("/admin/tailscale", { headers: authorized() })).status).toBe(200);
});

test("without the opt-in the Tailscale join capability is any unknown key: kept as sent", () => {
  flag(false);
  for (const value of [true, "yes", { nested: 1 }]) {
    const input = { platform: "ios", tailscaleJoinNotifications: value, someFutureKey: 1 };
    expect(deviceCapabilitySchema.parse(input)).toEqual(input);
  }
  flag(true);
  expect(deviceCapabilitySchema.parse({ tailscaleJoinNotifications: true })).toMatchObject({
    tailscaleJoinNotifications: true,
  });
  expect(() => deviceCapabilitySchema.parse({ tailscaleJoinNotifications: "yes" })).toThrow();
});

test("pairing a phone that says it shows Tailscale join requests stores what it sent, as before", async () => {
  flag(false);
  const app = createServer(db, path, {});
  const minted = await app.request("/admin/devices/pair", {
    method: "POST",
    headers: { ...authorized(), "content-type": "application/json" },
    body: JSON.stringify({ kind: "ios" }),
  });
  const { pairingCode } = (await minted.json()) as { pairingCode: string };
  const paired = await app.request("/devices/pair", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      pairingCode,
      capabilities: { platform: "ios", tailscaleJoinNotifications: true, someFutureKey: 1 },
    }),
  });
  expect(paired.status).toBe(200);
  const { device } = (await paired.json()) as { device: { id: string } };
  expect(getDevice(db, device.id as never)?.capabilities).toMatchObject({
    tailscaleJoinNotifications: true,
    someFutureKey: 1,
  });
});

test("nothing is written to the config directory until the owner uses the feature", () => {
  flag(true);
  const embedded = service();
  embedded.state();
  expect(readdirSync(dir)).not.toContain("tailscale");
});
