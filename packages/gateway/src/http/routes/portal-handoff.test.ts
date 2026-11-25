// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Opening the gateway's own address already signed in: a one-use, one-minute handoff from a signed
// -in portal session, redeemed only on that address, for no more than the session it came from.

import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { join as fixtureJoin } from "node:path";
import { tmpdir as fixtureTmpdir } from "node:os";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { SCOPE_ADMIN, SCOPE_READ, type Scope } from "@omnesis/types";
import { createFreshTestDatabase } from "../../testing/fresh-database.js";
import { createServer } from "../../server.js";
import { createDevice } from "../../data/repositories/DeviceRepository.js";
import { createToken } from "../../data/repositories/TokenRepository.js";
import { PortalHandoffs, PORTAL_HANDOFF_TTL_MS } from "./portal-handoff.js";
import type Database from "better-sqlite3";
import type { GatewayEnrollment } from "@omnesis/cloud-relay";

const ORIGIN = "https://g-abcdefgh.relay.example.test";
const HOME = "https://192.0.2.1:7600";
let db: Database.Database;
let dbPath: string;
let origin: string | undefined;
let stepUp: boolean;

beforeEach(() => {
  dbPath = fixtureJoin(fixtureTmpdir(), `omnesis-test-${randomUUID()}.db`);
  db = createFreshTestDatabase(dbPath);
  origin = ORIGIN;
  stepUp = false;
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  db.close();
  for (const suffix of ["", "-wal", "-shm", "-journal"])
    if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
});

function gateway() {
  const unused = () => Promise.reject(new Error("Unused management operation"));
  const enrollment = {
    gatewayPasskey: () => (origin ? { rpId: "relay.example.test", origin } : undefined),
    stepUpRequired: () => stepUp,
    stepUpCeremony: () => undefined,
  } as unknown as GatewayEnrollment;
  return createServer(db, dbPath, {
    cloudRelayManagement: {
      status: unused,
      configure: unused,
      enable: unused,
      disable: unused,
      reconnect: unused,
      renew: unused,
      accountModeActivated: () => true,
      accountPairingIdentity: () =>
        ({ ownerAccountId: "a".repeat(64), configurationKey: "k", enrollment }) as never,
    },
  } as never);
}

/** A portal signed in with a token of `scopes`: its cookie and CSRF token. */
async function signIn(app: ReturnType<typeof gateway>, scopes: Scope[] = [SCOPE_ADMIN]) {
  const device = createDevice(db, { name: `browser-${randomUUID()}`, kind: "portal" });
  const { token } = createToken(db, device.id, scopes);
  const response = await app.request("/portal/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
  const { csrfToken } = (await response.json()) as { csrfToken: string };
  return { cookie, csrfToken, deviceId: device.id };
}

function mint(
  app: ReturnType<typeof gateway>,
  session: { cookie: string; csrfToken: string },
  body: unknown = {},
) {
  return app.request("/portal/api/handoff", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: session.cookie,
      "X-Omnesis-CSRF": session.csrfToken,
    },
    body: JSON.stringify(body),
  });
}

function redeem(app: ReturnType<typeof gateway>, code: string, from: string | null = ORIGIN) {
  return app.request("/portal/api/handoff/redeem", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(from ? { Origin: from } : {}),
      // Through the relay, as the gateway's own address always is.
      "x-omnesis-cloud-relay": "1",
    },
    body: JSON.stringify({ code }),
  });
}

const codeOf = (url: string) => /#portal-handoff=([A-Za-z0-9_-]{43})/.exec(url)![1]!;

test("a signed-in portal opens the gateway's own address signed in, once, in the URL fragment", async () => {
  const app = gateway();
  const home = await signIn(app);
  const minted = await mint(app, home, { next: "confirm-passkey" });
  expect(minted.status).toBe(200);
  expect(minted.headers.get("cache-control")).toBe("no-store");
  const { url, expiresAt } = (await minted.json()) as { url: string; expiresAt: number };
  // Only in the fragment, which no server (the relay included) ever receives.
  expect(url).toMatch(
    new RegExp(
      `^${ORIGIN}/portal/settings/account#portal-handoff=[A-Za-z0-9_-]{43}&next=confirm-passkey$`,
    ),
  );
  expect(expiresAt - Date.now()).toBeLessThanOrEqual(PORTAL_HANDOFF_TTL_MS);
  const code = codeOf(url);
  const opened = await redeem(app, code);
  expect(opened.status).toBe(200);
  expect(opened.headers.get("cache-control")).toBe("no-store");
  const body = (await opened.json()) as { scopes: string[]; csrfToken: string };
  expect(body.scopes).toEqual([SCOPE_ADMIN]);
  const cookie = opened.headers.get("set-cookie")!.split(";")[0]!;
  expect(cookie).not.toBe(home.cookie);
  const session = await app.request("/portal/api/session", { headers: { Cookie: cookie } });
  expect(await session.json()).toMatchObject({ authenticated: true, scopes: [SCOPE_ADMIN] });
  // One use.
  expect((await redeem(app, code)).status).toBe(401);
  // Without a next step, the link names none.
  const plain = (await (await mint(app, home)).json()) as { url: string };
  expect(plain.url).not.toContain("next=");
});

test("the opened session is no more than the one that minted it, and step-up still applies through the relay", async () => {
  const app = gateway();
  // A read-only portal can't mint one at all.
  const reader = await signIn(app, [SCOPE_READ]);
  expect((await mint(app, reader)).status).toBe(403);
  const home = await signIn(app);
  const code = codeOf(((await (await mint(app, home)).json()) as { url: string }).url);
  const cookie = (await redeem(app, code)).headers.get("set-cookie")!.split(";")[0]!;
  const csrf = (
    (await (await app.request("/portal/api/session", { headers: { Cookie: cookie } })).json()) as {
      csrfToken: string;
    }
  ).csrfToken;
  // Once a passkey is confirmed here, an admin action through the relay needs a step-up.
  stepUp = true;
  const guarded = await app.request("/admin/devices", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie,
      "X-Omnesis-CSRF": csrf,
      "x-omnesis-cloud-relay": "1",
    },
    body: JSON.stringify({ name: "Fictional laptop", kind: "cli", scopes: [SCOPE_READ] }),
  });
  expect([403, 428]).toContain(guarded.status);
  expect(JSON.stringify(await guarded.json())).toMatch(/STEP_UP_(REQUIRED|UNAVAILABLE)/);
});

test("refused: another page, an expired or unknown code, a minting session that ended, and a gateway without its own address", async () => {
  const app = gateway();
  const home = await signIn(app);
  const fresh = async () => codeOf(((await (await mint(app, home)).json()) as { url: string }).url);
  // Redeemed from any other page, it is spent and refused.
  for (const from of [HOME, "https://g-other.relay.example.test", null]) {
    const code = await fresh();
    expect((await redeem(app, code, from)).status).toBe(401);
    expect((await redeem(app, code)).status).toBe(401);
  }
  // Unknown or malformed.
  expect((await redeem(app, "u".repeat(43))).status).toBe(401);
  expect((await redeem(app, "short")).status).toBe(400);
  // After a minute.
  const late = await fresh();
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + PORTAL_HANDOFF_TTL_MS + 1 });
  expect((await redeem(app, late)).status).toBe(401);
  vi.useRealTimers();
  // The minting session signed out in the meantime.
  const ended = await fresh();
  const out = await app.request("/portal/api/logout", {
    method: "POST",
    headers: { Cookie: home.cookie, "X-Omnesis-CSRF": home.csrfToken },
  });
  expect(out.status).toBe(200);
  expect((await redeem(app, ended)).status).toBe(401);
  // A certificate incident (or no address of its own) since it was minted, or before.
  const again = await signIn(app);
  const held = codeOf(((await (await mint(app, again)).json()) as { url: string }).url);
  origin = undefined;
  expect((await redeem(app, held)).status).toBe(401);
  const refused = await mint(app, again);
  expect(refused.status).toBe(409);
  expect(JSON.stringify(await refused.json())).toContain("PORTAL_HANDOFF_UNAVAILABLE");
  // Only a portal session mints one: a bearer token, or no CSRF token, is refused.
  origin = ORIGIN;
  const device = createDevice(db, { name: "Fictional CLI", kind: "cli" });
  const { token } = createToken(db, device.id, [SCOPE_ADMIN]);
  const bearer = await app.request("/portal/api/handoff", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: "{}",
  });
  expect(bearer.status).toBe(403);
  expect((await mint(app, { cookie: again.cookie, csrfToken: "x" })).status).toBe(403);
  // Unknown next steps or fields are refused.
  expect((await mint(app, again, { next: "delete-everything" })).status).toBe(400);
});

test("a handoff store keeps a few at a time and spends each on any attempt", () => {
  let now = 0;
  const handoffs = new PortalHandoffs(() => now);
  const issued = Array.from({ length: 20 }, () =>
    handoffs.issue({ origin: ORIGIN, session: "s", scopes: [SCOPE_ADMIN] }),
  );
  // The oldest made room for the newest.
  expect(handoffs.take(issued[0]!.code)).toBeUndefined();
  expect(handoffs.take(issued[19]!.code)).toMatchObject({ origin: ORIGIN });
  expect(handoffs.take(issued[19]!.code)).toBeUndefined();
  // Expired ones go when the next is issued.
  now = PORTAL_HANDOFF_TTL_MS;
  handoffs.issue({ origin: ORIGIN, session: "s", scopes: [] });
  expect(handoffs.take(issued[18]!.code)).toBeUndefined();
});

test("a gateway that never linked an account mints nothing and signs no one in", async () => {
  const app = createServer(db, dbPath);
  const home = await signIn(app);
  const refused = await mint(app, home);
  expect(refused.status).toBe(409);
  expect(JSON.stringify(await refused.json())).toContain("PORTAL_HANDOFF_UNAVAILABLE");
  expect((await redeem(app, "u".repeat(43))).status).toBe(401);
  // Signed out, nothing is minted at all.
  expect((await app.request("/portal/api/handoff", { method: "POST", body: "{}" })).status).toBe(
    401,
  );
});
