// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The gateway's own tailnet device in one process: the real server and app,
 * the real private socket, the real pairing redemption, and the scripted
 * helper standing in for Tailscale. Requests that "come through the helper"
 * are written to the socket exactly as the helper writes them.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { generateSelfSigned } from "../tls.js";
import { writeTlsMaterial } from "../tls-lifecycle/persistence.js";
import { HelperSupervisor } from "./supervisor.js";
import { TAILNET_TRANSPORT_HEADER, type TailnetSocketServer } from "./socket-server.js";
import { spawnOwnedChildProcess } from "@omnesis/core";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getRequestListener } from "@hono/node-server";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { SCOPE_ADMIN, SCOPE_READ } from "@omnesis/types";
import { createDatabase } from "../db.js";
import { createDevice, getDevice, listDevices } from "../data/repositories/DeviceRepository.js";
import { createToken } from "../data/repositories/TokenRepository.js";
import { createServer } from "../server.js";
import { TailscaleEmbedService } from "./service.js";
import type { TailscaleAdminState } from "@omnesis/core";
import type { TailnetCaller } from "./caller.js";

const FAKE = fileURLToPath(new URL("./testing/fake-helper.mjs", import.meta.url));

let material: { cert: string; key: string };
beforeAll(async () => {
  material = await generateSelfSigned();
});
let dir: string;
let db: ReturnType<typeof createDatabase>;
let app: ReturnType<typeof createServer>;
let service: TailscaleEmbedService;
let admin: string;
let notified: { waiting: unknown[]; joined: unknown[] };

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const peer = (overrides: Partial<NonNullable<TailnetCaller["peer"]>> = {}) => ({
  nodeId: "nMaya",
  nodeName: "maya-laptop.example-net.ts.net",
  os: "macOS",
  userId: "7",
  login: "maya@example.com",
  sameOwner: true,
  ...overrides,
});

async function boot(scenario = "connected", { cloudRelay = false } = {}): Promise<void> {
  if (cloudRelay) vi.stubEnv("OMNESIS_CLOUD_RELAY_ENABLED", "1");
  dir = mkdtempSync(join(tmpdir(), "ts-int-"));
  mkdirSync(join(dir, "tailscale", "node"), { recursive: true });
  writeFileSync(join(dir, "tailscale", "node", "fake-scenario"), scenario);
  await writeTlsMaterial(join(dir, "cert.pem"), join(dir, "key.pem"), material, dir);
  const path = join(dir, "gateway.sqlite");
  db = createDatabase(path);
  const device = createDevice(db, { name: "Fictional admin CLI", kind: "cli" });
  admin = createToken(db, device.id, [SCOPE_ADMIN, SCOPE_READ]).token;
  notified = { waiting: [], joined: [] };
  service = new TailscaleEmbedService({
    configDir: dir,
    supervisor: new HelperSupervisor((_binary, args, env) =>
      spawnOwnedChildProcess(process.execPath, [FAKE, ...args], { env }),
    ),
    tlsMaterial: () => ({ cert: join(dir, "cert.pem"), key: join(dir, "key.pem") }),
    env: { ...process.env, OMNESIS_TAILSCALE_HELPER: FAKE },
    joins: {
      notifyWaiting: (r) => notified.waiting.push(r),
      notifyJoined: (d) => notified.joined.push(d),
    },
  });
  app = createServer(db, path, {
    tailscaleEmbed: service,
    // As the running gateway does: agents reach it by its tailnet name too.
    additionalOAuthIssuerUrls: () => [service.tailnetOrigin()].filter((o): o is string => !!o),
  });
  await service.attach({ listener: getRequestListener(app.fetch) });
}

beforeEach(async () => {
  await boot();
});
afterEach(async () => {
  await service.shutdown();
  vi.unstubAllEnvs();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function adminCall(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const res = await app.request(path, {
    method,
    headers: {
      authorization: `Bearer ${admin}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: await res.json() };
}

async function until(predicate: (s: TailscaleAdminState) => boolean): Promise<TailscaleAdminState> {
  for (let i = 0; i < 200; i++) {
    const state = (await adminCall("GET", "/admin/tailscale")).json as TailscaleAdminState;
    if (predicate(state)) return state;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("state never reached");
}

/** A request as the helper forwards it: over the private socket, naming the caller. */
function viaHelper(
  method: string,
  path: string,
  caller: TailnetCaller,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; json: any }> {
  const socket = (service as unknown as { socket: TailnetSocketServer }).socket;
  const socketPath = socket.path;
  return new Promise((resolve, reject) => {
    const request = socket.transport ? httpsRequest : httpRequest;
    const req = request(
      {
        socketPath,
        ...(socket.transport ? { ca: material.cert, servername: "localhost" } : {}),
        method,
        path,
        headers: {
          ...extraHeaders,
          host: "omnesis.example-net.ts.net",
          ...(socket.transport ? { [TAILNET_TRANSPORT_HEADER]: socket.transport.token } : {}),
          "x-omnesis-tailnet": encode(caller),
          ...(body ? { "content-type": "application/json" } : {}),
        },
      },
      (res) => {
        let text = "";
        res.on("data", (d) => (text += d));
        res.on("end", () => {
          let json: unknown = text;
          try {
            json = JSON.parse(text);
          } catch {
            // not JSON
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on("error", reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

const tailnet = (p = peer()): TailnetCaller => ({
  via: "tailnet",
  client: "100.64.0.2:5555",
  peer: p,
});

describe("owner controls", () => {
  test("off by default; turning on starts the device and reports where it is", async () => {
    expect((await adminCall("GET", "/admin/tailscale")).json).toMatchObject({
      enabled: false,
      connection: "off",
      helper: { state: "off" },
      joinPolicy: "ask",
      url: null,
    });
    await adminCall("POST", "/admin/tailscale/enable", { enabled: true });
    const on = await until((s) => s.connection === "connected");
    expect(on).toMatchObject({
      enabled: true,
      url: "https://omnesis.example-net.ts.net",
      owner: { login: "maya@example.com", displayName: "Maya Reeves" },
      certificate: { source: "tailscale" },
      public: { wanted: false, state: "off" },
    });
    expect(service.tailnetOrigin()).toBe("https://omnesis.example-net.ts.net");
    expect(service.tailnetCertificateTrusted()).toBe(true);
    expect(service.tailnetCertificatePending()).toBe(false);
    expect(service.publicOrigin()).toBeNull();
  });

  test("the public address follows the owner's switch", async () => {
    await adminCall("POST", "/admin/tailscale/enable", { enabled: true });
    await until((s) => s.connection === "connected");
    await adminCall("PATCH", "/admin/tailscale/settings", { publicAccess: true });
    await until((s) => s.public.state === "on");
    expect(service.publicOrigin()).toBe("https://omnesis.example-net.ts.net");
    await adminCall("PATCH", "/admin/tailscale/settings", { publicAccess: false });
    await until((s) => s.public.state === "off" && !s.public.wanted);
  });

  test("settings are validated", async () => {
    expect(
      (await adminCall("PATCH", "/admin/tailscale/settings", { deviceName: "not a name!" })).status,
    ).toBe(400);
    expect((await adminCall("PATCH", "/admin/tailscale/settings", {})).status).toBe(400);
    expect(
      (await adminCall("PATCH", "/admin/tailscale/settings", { joinPolicy: "maybe" })).status,
    ).toBe(400);
  });

  test("turning off stops the device and closes the socket", async () => {
    await adminCall("POST", "/admin/tailscale/enable", { enabled: true });
    await until((s) => s.connection === "connected");
    await adminCall("POST", "/admin/tailscale/enable", { enabled: false });
    expect((await adminCall("GET", "/admin/tailscale")).json).toMatchObject({
      connection: "off",
      url: null,
    });
  });

  test("an admin token is required", async () => {
    expect((await app.request("/admin/tailscale")).status).toBe(401);
  });
});

describe("collectors joining through Tailscale", () => {
  beforeEach(async () => {
    await adminCall("POST", "/admin/tailscale/enable", { enabled: true });
    await until((s) => s.connection === "connected");
  });

  test("ask first: the owner approves, the collector collects working credentials once", async () => {
    const asked = await viaHelper("POST", "/tailscale/join", tailnet(), {
      name: "maya-laptop",
      capabilities: { platform: "darwin" },
    });
    expect(asked.status).toBe(202);
    expect(asked.json).toMatchObject({
      status: "pending",
      requestId: expect.any(String),
      secret: expect.any(String),
    });
    expect(notified.waiting).toHaveLength(1);
    expect(listDevices(db).some((d) => d.kind === "collector")).toBe(false);

    const list = await adminCall("GET", "/admin/tailscale/join-requests");
    expect(list.json.requests).toEqual([
      expect.objectContaining({
        id: asked.json.requestId,
        name: "maya-laptop",
        machine: "maya-laptop",
        login: "maya@example.com",
      }),
    ]);
    const poll = () =>
      viaHelper("POST", `/tailscale/join/${asked.json.requestId}/poll`, tailnet(), {
        secret: asked.json.secret,
      });
    expect((await poll()).status).toBe(202);
    expect(
      (
        await adminCall("POST", `/admin/tailscale/join-requests/${asked.json.requestId}/decision`, {
          approve: true,
        })
      ).json,
    ).toEqual({ status: "approved" });

    const done = await poll();
    expect(done.status).toBe(200);
    expect(done.json).toMatchObject({
      status: "joined",
      device: { kind: "collector" },
      token: expect.any(String),
    });
    expect(done.json.scopes).toEqual(expect.arrayContaining(["read", "write:*"]));
    expect(getDevice(db, done.json.device.id)?.name).toBe("maya-laptop");
    // The credentials work like any paired collector's.
    const whoami = await app.request("/whoami", {
      headers: { authorization: `Bearer ${done.json.token}` },
    });
    expect(whoami.status).toBe(200);
    expect((await poll()).status).toBe(404);
    // Approval was a person's decision, so no "joined without approval" notice.
    expect(notified.joined).toHaveLength(0);
  });

  test("automatic: the collector joins at once and the owner is told", async () => {
    await adminCall("PATCH", "/admin/tailscale/settings", { joinPolicy: "automatic" });
    const res = await viaHelper("POST", "/tailscale/join", tailnet(), { name: "maya-laptop" });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ status: "joined", device: { name: "maya-laptop" } });
    expect(notified.joined).toEqual([expect.objectContaining({ name: "maya-laptop" })]);
  });

  test("a join never takes over a device it names or claims, and a rejoin keeps its own row", async () => {
    await adminCall("PATCH", "/admin/tailscale/settings", { joinPolicy: "automatic" });
    const existing = createDevice(db, {
      name: "maya-laptop",
      kind: "collector",
      capabilities: { installId: "install-of-another-machine" },
    });
    const first = await viaHelper("POST", "/tailscale/join", tailnet(), {
      name: "maya-laptop",
      capabilities: {
        installId: "install-of-another-machine",
        previousDeviceId: existing.id,
      },
    });
    expect(first.status).toBe(200);
    expect(first.json.device.id).not.toBe(existing.id);
    expect(first.json.device.name).not.toBe("maya-laptop");
    expect(getDevice(db, existing.id)).toMatchObject({
      name: "maya-laptop",
      installId: "install-of-another-machine",
      revokedAt: null,
    });
    expect(getDevice(db, first.json.device.id)?.installId).toBeNull();
    // The same Tailscale machine joining again lands on the row it proved before.
    const again = await viaHelper("POST", "/tailscale/join", tailnet(), { name: "maya-laptop" });
    expect(again.json.device.id).toBe(first.json.device.id);
    // A different machine of the owner's gets a row of its own.
    const other = await viaHelper(
      "POST",
      "/tailscale/join",
      tailnet(peer({ nodeId: "nDesk", nodeName: "maya-desk.example-net.ts.net" })),
      {},
    );
    expect(other.json.device.id).not.toBe(first.json.device.id);
  });

  test("revoking the machine's device after approving its request denies the request", async () => {
    await adminCall("PATCH", "/admin/tailscale/settings", { joinPolicy: "automatic" });
    const first = await viaHelper("POST", "/tailscale/join", tailnet(), { name: "maya-laptop" });
    await adminCall("PATCH", "/admin/tailscale/settings", { joinPolicy: "ask" });
    const asked = await viaHelper("POST", "/tailscale/join", tailnet(), { name: "maya-laptop" });
    await adminCall("POST", `/admin/tailscale/join-requests/${asked.json.requestId}/decision`, {
      approve: true,
    });
    await new Promise((r) => setTimeout(r, 5));
    expect((await adminCall("DELETE", `/admin/devices/${first.json.device.id}`)).status).toBe(200);
    const polled = await viaHelper(
      "POST",
      `/tailscale/join/${asked.json.requestId}/poll`,
      tailnet(),
      { secret: asked.json.secret },
    );
    expect(polled.status).toBe(403);
    expect(getDevice(db, first.json.device.id)?.revokedAt).not.toBeNull();
  });

  test("a collector that joined through Tailscale is no sign-in join and has no device key", async () => {
    vi.stubEnv("OMNESIS_CLOUD_RELAY_ENABLED", "1");
    await adminCall("PATCH", "/admin/tailscale/settings", { joinPolicy: "automatic" });
    const joined = await viaHelper("POST", "/tailscale/join", tailnet(), { name: "maya-laptop" });
    expect(getDevice(db, joined.json.device.id)?.enrollment).toBeUndefined();
  });

  test("a machine whose device was revoked waits for approval even when joins are automatic", async () => {
    await adminCall("PATCH", "/admin/tailscale/settings", { joinPolicy: "automatic" });
    const first = await viaHelper("POST", "/tailscale/join", tailnet(), { name: "maya-laptop" });
    expect(first.status).toBe(200);
    expect((await adminCall("DELETE", `/admin/devices/${first.json.device.id}`)).status).toBe(200);
    const again = await viaHelper("POST", "/tailscale/join", tailnet(), { name: "maya-laptop" });
    expect(again.status).toBe(202);
    expect(getDevice(db, first.json.device.id)?.revokedAt).not.toBeNull();
    await adminCall("POST", `/admin/tailscale/join-requests/${again.json.requestId}/decision`, {
      approve: true,
    });
    const done = await viaHelper(
      "POST",
      `/tailscale/join/${again.json.requestId}/poll`,
      tailnet(),
      { secret: again.json.secret },
    );
    expect(done.status).toBe(200);
    // The owner's yes restores the machine's own row.
    expect(done.json.device.id).toBe(first.json.device.id);
    expect(getDevice(db, first.json.device.id)?.revokedAt).toBeNull();
  });

  test("denied requests end without a device", async () => {
    const asked = await viaHelper("POST", "/tailscale/join", tailnet(), { name: "maya-laptop" });
    await adminCall("POST", `/admin/tailscale/join-requests/${asked.json.requestId}/decision`, {
      approve: false,
    });
    const res = await viaHelper("POST", `/tailscale/join/${asked.json.requestId}/poll`, tailnet(), {
      secret: asked.json.secret,
    });
    expect(res.status).toBe(403);
    expect(listDevices(db).some((d) => d.kind === "collector")).toBe(false);
    expect(
      (
        await adminCall("POST", `/admin/tailscale/join-requests/${asked.json.requestId}/decision`, {
          approve: true,
        })
      ).status,
    ).toBe(404);
  });

  test("another person's device, a tagged device, and joining off are refused", async () => {
    const stranger = await viaHelper(
      "POST",
      "/tailscale/join",
      tailnet(peer({ userId: "8", login: "jamie@example.com", sameOwner: false })),
      {},
    );
    expect(stranger).toMatchObject({ status: 403, json: { code: "not-owner" } });
    const tagged = await viaHelper(
      "POST",
      "/tailscale/join",
      tailnet(peer({ tags: ["tag:server"], sameOwner: false })),
      {},
    );
    expect(tagged).toMatchObject({ status: 403, json: { code: "not-owner" } });
    await adminCall("PATCH", "/admin/tailscale/settings", { joinPolicy: "off" });
    const off = await viaHelper("POST", "/tailscale/join", tailnet(), {});
    expect(off).toMatchObject({ status: 403, json: { code: "joining-off" } });
    expect(notified.waiting).toHaveLength(0);
  });

  test("one tailnet device cannot hammer the join routes", async () => {
    await adminCall("PATCH", "/admin/tailscale/settings", { joinPolicy: "off" });
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      statuses.push((await viaHelper("POST", "/tailscale/join", tailnet(), {})).status);
    }
    expect(statuses).toEqual([403, 403, 403, 403, 403, 403, 429]);
    const other = tailnet(peer({ nodeId: "nDesk", nodeName: "maya-desk.example-net.ts.net" }));
    expect(
      (await viaHelper("POST", "/tailscale/join", { ...other, client: "100.64.0.3:5555" }, {}))
        .status,
    ).toBe(403);
  });

  test("the join routes refuse anything that did not come through the tailnet", async () => {
    // The ordinary listener: a forged header means nothing there.
    const direct = await app.request("/tailscale/join", {
      method: "POST",
      headers: { "content-type": "application/json", "x-omnesis-tailnet": encode(tailnet()) },
      body: "{}",
    });
    expect(direct.status).toBe(403);
    expect(await direct.json()).toMatchObject({ code: "not-tailnet" });
    // The public address never reaches them.
    const pub = await viaHelper(
      "POST",
      "/tailscale/join",
      { via: "public", client: "198.51.100.4:1" },
      {},
    );
    expect(pub.status).toBe(404);
  });

  test("tailnet requests reach the whole gateway; public ones only agent paths", async () => {
    const portal = await viaHelper("GET", "/health", tailnet());
    expect(portal.status).toBe(200);
    expect(portal.json).toMatchObject({ status: "ok", tailscaleEmbed: true });
    expect(
      (await viaHelper("GET", "/health", { via: "public", client: "198.51.100.4:1" })).status,
    ).toBe(404);
    const metadata = await viaHelper("GET", "/.well-known/oauth-protected-resource", {
      via: "public",
      client: "198.51.100.4:1",
    });
    expect(metadata.status).not.toBe(404);
  });
});

describe("the pairing QR", () => {
  test("offers the tailnet address first, verified by the phone's own trust, and marks it", async () => {
    await adminCall("POST", "/admin/tailscale/enable", { enabled: true });
    await until((s) => s.connection === "connected");
    const minted = await adminCall("POST", "/admin/devices/pair", { kind: "ios" });
    expect(minted.status).toBe(200);
    const code = minted.json.pairingCode as string;
    const plan = await adminCall("POST", "/admin/devices/pair-addresses", { pairingCode: code });
    expect(plan.status).toBe(200);
    expect(plan.json.recommendedUrl).toBe("https://omnesis.example-net.ts.net");
    expect(plan.json.addresses[0]).toMatchObject({
      gatewayUrl: "https://omnesis.example-net.ts.net",
      usable: true,
      reach: "tailnet",
    });
    const qr = await adminCall("POST", "/admin/devices/pair-qr", {
      pairingCode: code,
      gatewayUrl: "https://omnesis.example-net.ts.net",
    });
    expect(qr.status).toBe(200);
    expect(JSON.parse(qr.json.qrPayload)).toMatchObject({
      v: 4,
      gatewayUrl: "https://omnesis.example-net.ts.net",
      tls: { mode: "system" },
      tailnet: true,
    });
    // Any other address carries no marker.
    const other = plan.json.addresses.find(
      (a: { gatewayUrl: string; usable: boolean }) =>
        a.usable && !a.gatewayUrl.includes("example-net"),
    );
    if (other) {
      const plain = await adminCall("POST", "/admin/devices/pair-qr", {
        pairingCode: code,
        gatewayUrl: other.gatewayUrl,
      });
      expect(JSON.parse(plain.json.qrPayload)).not.toHaveProperty("tailnet");
    }
  });

  test("a tailnet without HTTPS certificates gets a pinned, still marked, QR", async () => {
    await service.shutdown();
    vi.unstubAllEnvs();
    db.close();
    rmSync(dir, { recursive: true, force: true });
    await boot("https-disabled");
    await adminCall("POST", "/admin/tailscale/enable", { enabled: true });
    await until((s) => s.connection === "connected" && s.certificate?.reason === "https-disabled");
    const code = (await adminCall("POST", "/admin/devices/pair", { kind: "android" })).json
      .pairingCode as string;
    const qr = await adminCall("POST", "/admin/devices/pair-qr", {
      pairingCode: code,
      gatewayUrl: "https://omnesis.example-net.ts.net",
    });
    expect(qr.status).toBe(200);
    const payload = JSON.parse(qr.json.qrPayload);
    expect(payload.tailnet).toBe(true);
    expect(payload.tls?.mode).not.toBe("system");
    // Certificates being off is not a certificate on its way.
    expect(service.tailnetCertificatePending()).toBe(false);
  });

  test("the Access overview says the tailnet address's certificate is on its way", async () => {
    await service.shutdown();
    vi.unstubAllEnvs();
    db.close();
    rmSync(dir, { recursive: true, force: true });
    await boot("certificate-pending");
    await adminCall("POST", "/admin/tailscale/enable", { enabled: true });
    await until((s) => s.connection === "connected" && s.certificate?.reason === "pending");
    expect(service.tailnetCertificatePending()).toBe(true);
    const overview = (await adminCall("GET", "/admin/access")).json as {
      oauth: { resources: Array<{ resource: string; certificatePending?: boolean }> };
    };
    const tailnet = overview.oauth.resources.find((entry) =>
      entry.resource.startsWith("https://omnesis.example-net.ts.net"),
    );
    expect(tailnet?.certificatePending).toBe(true);
    expect(
      overview.oauth.resources.filter((entry) => entry !== tailnet && entry.certificatePending),
    ).toEqual([]);
  });
});

/**
 * Both opt-ins at once: the cloud relay and the gateway's own Tailscale device
 * are independent ways in, and an owner may run both. Neither may widen or
 * hide the other.
 */
describe("with the cloud relay on as well", () => {
  beforeEach(async () => {
    await service.shutdown();
    db.close();
    rmSync(dir, { recursive: true, force: true });
    await boot("connected", { cloudRelay: true });
    await adminCall("POST", "/admin/tailscale/enable", { enabled: true });
    await until((s) => s.connection === "connected");
  });

  test("the gateway advertises both, on the tailnet as everywhere", async () => {
    const status = await adminCall("GET", "/status");
    expect(status.json).toMatchObject({ cloudRelay: true, tailscaleEmbed: true });
    const health = await viaHelper("GET", "/health", tailnet());
    expect(health.json).toMatchObject({ cloudRelay: true, tailscaleEmbed: true });
  });

  test("the Tailscale public address still opens only agent paths, relay routes included", async () => {
    const pub = { via: "public" as const, client: "198.51.100.4:1" };
    for (const path of [
      "/health",
      "/status",
      "/portal/",
      "/portal/api/session",
      "/admin/devices",
      "/admin/tailscale",
      "/device/ws",
    ]) {
      expect((await viaHelper("GET", path, pub)).status, path).toBe(404);
    }
    expect((await viaHelper("GET", "/.well-known/oauth-protected-resource", pub)).status).not.toBe(
      404,
    );
  });

  test("a sign-in device and a collector joined through Tailscale sit side by side, each as it joined", async () => {
    const phone = createDevice(db, { name: "Maya's phone", kind: "ios" });
    db.prepare(
      `UPDATE devices SET enrollment_public_key = ?, enrollment_method = 'automatic',
         enrollment_sign_in = 'passkey', enrolled_at = ? WHERE id = ?`,
    ).run("fictional-device-key", Date.now(), phone.id);
    await adminCall("PATCH", "/admin/tailscale/settings", { joinPolicy: "automatic" });
    const joined = await viaHelper("POST", "/tailscale/join", tailnet(), { name: "maya-laptop" });
    expect(joined.status).toBe(200);
    expect(getDevice(db, phone.id)?.enrollment).toMatchObject({
      method: "automatic",
      signIn: "passkey",
    });
    expect(getDevice(db, joined.json.device.id)?.enrollment).toBeUndefined();
    // Removing the collector leaves the sign-in device and its enrollment alone.
    expect((await adminCall("DELETE", `/admin/devices/${joined.json.device.id}`)).status).toBe(200);
    expect(getDevice(db, phone.id)?.revokedAt).toBeFalsy();
    expect(getDevice(db, phone.id)?.enrollment).toMatchObject({ method: "automatic" });
  });

  test("a relay mark on a tailnet request grants nothing: an ask-first join still waits", async () => {
    await adminCall("PATCH", "/admin/tailscale/settings", { joinPolicy: "ask" });
    const marked = await viaHelper(
      "POST",
      "/tailscale/join",
      tailnet(),
      { name: "maya-laptop" },
      { "x-omnesis-cloud-relay": "1" },
    );
    // The mark can only withhold: the join still waits for the owner.
    expect(marked.status).toBe(202);
    expect(listDevices(db).some((d) => d.name === "maya-laptop")).toBe(false);
  });
});
