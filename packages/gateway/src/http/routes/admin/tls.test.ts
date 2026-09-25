// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Endpoint tests for `/admin/tls`. The snapshot names certificate paths on
 * the gateway host and the renewal endpoints change what it serves, so the
 * admin guard is pinned here beside the shapes the CLI reads.
 */

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { SCOPE_ADMIN, SCOPE_READ } from "@omnesis/types";
import { createDatabase } from "../../../db.js";
import { createServer } from "../../../server.js";
import { createDevice } from "../../../data/repositories/DeviceRepository.js";
import { createToken } from "../../../data/repositories/TokenRepository.js";
import type { TlsLifecycleSnapshot } from "@omnesis/core";
import type { TlsLifecyclePort } from "./internals.js";
import type Database from "better-sqlite3";

let db: Database.Database;
let dbPath: string;
let app: ReturnType<typeof createServer>;
let calls: string[];

const snapshot: TlsLifecycleSnapshot = {
  checkedAt: "2026-09-14T00:00:00.000Z",
  ownership: "self-signed",
  certPath: "/srv/omnesis/tls/cert.pem",
  keyPath: "/srv/omnesis/tls/key.pem",
  served: {
    state: "valid",
    fingerprintSha256: "ab".repeat(32),
    subject: "CN=gateway (self-signed)",
    issuer: "CN=gateway (self-signed)",
    selfSigned: true,
    notBefore: "2026-09-01T00:00:00.000Z",
    notAfter: "2036-09-01T00:00:00.000Z",
    daysRemaining: 3640,
    names: ["localhost", "gateway"],
    uncoveredHosts: [],
  },
  pendingReplacement: null,
  renewal: {
    mode: "automatic",
    renewBeforeDays: 30,
    lastAttemptAt: null,
    lastError: null,
    lastRenewedAt: null,
  },
  rotation: null,
};

const tlsLifecycle: TlsLifecyclePort = {
  snapshot: () => snapshot,
  activateFromDisk: () => {
    calls.push("reload");
    return null;
  },
  renew: async (_signal, opts) => {
    calls.push(`renew force=${opts?.force === true}`);
    return opts?.force
      ? { ok: true, fingerprintSha256: "cd".repeat(32), snapshot }
      : { ok: false, reason: "The certificate is not due for renewal", snapshot };
  },
};

function token(scopes: readonly import("@omnesis/types").Scope[]): string {
  const device = createDevice(db, { name: `test-${randomUUID()}`, kind: "cli" });
  return createToken(db, device.id, scopes).token;
}

beforeEach(() => {
  dbPath = `/tmp/omnesis-tls-route-test-${randomUUID()}.db`;
  db = createDatabase(dbPath);
  app = createServer(db, dbPath, { tlsLifecycle });
  calls = [];
});

afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
  }
});

describe("/admin/tls", () => {
  test("every route needs an admin token", async () => {
    const read = { headers: { Authorization: `Bearer ${token([SCOPE_READ])}` } };
    expect((await app.request("/admin/tls")).status).toBe(401);
    expect((await app.request("/admin/tls", read)).status).toBe(403);
    expect((await app.request("/admin/tls/reload", { method: "POST", ...read })).status).toBe(403);
    expect(
      (
        await app.request("/admin/tls/renew", {
          method: "POST",
          body: "{}",
          headers: { ...read.headers, "Content-Type": "application/json" },
        })
      ).status,
    ).toBe(403);
    expect(calls).toEqual([]);
  });

  test("GET serves the lifecycle snapshot", async () => {
    const res = await app.request("/admin/tls", {
      headers: { Authorization: `Bearer ${token([SCOPE_ADMIN])}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(snapshot);
  });

  test("POST reload activates what is on disk and answers with the snapshot", async () => {
    const res = await app.request("/admin/tls/reload", {
      method: "POST",
      headers: { Authorization: `Bearer ${token([SCOPE_ADMIN])}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(snapshot);
    expect(calls).toEqual(["reload"]);
  });

  test("POST renew passes force through and answers with the attempt's outcome", async () => {
    const admin = {
      Authorization: `Bearer ${token([SCOPE_ADMIN])}`,
      "Content-Type": "application/json",
    };
    const refused = await app.request("/admin/tls/renew", {
      method: "POST",
      headers: admin,
      body: "{}",
    });
    expect(refused.status).toBe(200);
    expect(await refused.json()).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/not due/u),
    });

    const forced = await app.request("/admin/tls/renew", {
      method: "POST",
      headers: admin,
      body: JSON.stringify({ force: true }),
    });
    expect(await forced.json()).toMatchObject({ ok: true, fingerprintSha256: "cd".repeat(32) });
    expect(calls).toEqual(["renew force=false", "renew force=true"]);

    const malformed = await app.request("/admin/tls/renew", {
      method: "POST",
      headers: admin,
      body: JSON.stringify({ force: "yes" }),
    });
    expect(malformed.status).toBe(400);
  });

  test("a composition without TLS wiring has no such routes", async () => {
    const bare = createServer(db, dbPath);
    const res = await bare.request("/admin/tls", {
      headers: { Authorization: `Bearer ${token([SCOPE_ADMIN])}` },
    });
    expect(res.status).toBe(404);
  });
});
