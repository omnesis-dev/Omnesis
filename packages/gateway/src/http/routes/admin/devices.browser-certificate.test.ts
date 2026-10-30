// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A browser pairing code says whether the Chrome extension can trust the
 * certificate the gateway serves. The CLI and the portal both warn from this
 * field, so it is pinned here on the route they call, for every certificate
 * tier, and kept off every other kind of code.
 */

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { SCOPE_ADMIN, type DeviceKind } from "@omnesis/types";
import { createDatabase } from "../../../db.js";
import { createServer } from "../../../server.js";
import { createDevice } from "../../../data/repositories/DeviceRepository.js";
import { createToken } from "../../../data/repositories/TokenRepository.js";
import type { TlsLifecycleSnapshot, TlsOwnership } from "@omnesis/core";
import type { TlsLifecyclePort } from "./internals.js";
import type Database from "better-sqlite3";

let db: Database.Database;
let dbPath: string;

function snapshot(
  ownership: TlsOwnership,
  served: Partial<TlsLifecycleSnapshot["served"]> = {},
): TlsLifecycleSnapshot {
  return {
    checkedAt: "2026-10-01T00:00:00.000Z",
    ownership,
    certPath: `/srv/omnesis/tls/${ownership}.pem`,
    keyPath: `/srv/omnesis/tls/${ownership}.key`,
    served: {
      state: "valid",
      fingerprintSha256: "ab".repeat(32),
      subject: "CN=gateway.example.com",
      issuer: "CN=Example CA",
      selfSigned: false,
      notBefore: "2026-09-01T00:00:00.000Z",
      notAfter: "2026-12-01T00:00:00.000Z",
      daysRemaining: 60,
      names: ["gateway.example.com"],
      uncoveredHosts: [],
      ...served,
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
}

function lifecycle(snap: TlsLifecycleSnapshot): TlsLifecyclePort {
  return {
    snapshot: () => snap,
    activateFromDisk: () => null,
    renew: () => Promise.resolve({ ok: false, reason: "not due", snapshot: snap }),
  };
}

function adminToken(): string {
  const device = createDevice(db, { name: `admin-${randomUUID()}`, kind: "cli" });
  return createToken(db, device.id, [SCOPE_ADMIN]).token;
}

async function pair(
  app: ReturnType<typeof createServer>,
  kind: DeviceKind,
): Promise<Record<string, unknown>> {
  const res = await app.request("/admin/devices/pair", {
    method: "POST",
    headers: { Authorization: `Bearer ${adminToken()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ kind, ...(kind === "integration" ? { name: "Example tool" } : {}) }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

beforeEach(() => {
  dbPath = `/tmp/omnesis-test-${randomUUID()}.db`;
  db = createDatabase(dbPath);
});

afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
  }
});

describe("POST /admin/devices/pair — the browser certificate verdict", () => {
  test("a self-signed gateway still issues the browser code, marked untrusted with the native fix", async () => {
    const app = createServer(db, dbPath, {
      tlsLifecycle: lifecycle(snapshot("self-signed", { selfSigned: true })),
    });
    const body = await pair(app, "browser");
    // Not blocked: a browser may trust an authority the gateway cannot see.
    expect(body.pairingCode).toEqual(expect.any(String));
    expect(body.browserCertificate).toMatchObject({
      status: "untrusted",
      certificate: "self-signed",
      reason: "self-signed",
      docsUrl: "https://omnesis.dev/docs/setup#browser-extension",
    });
    const verdict = body.browserCertificate as { title: string; remedy: string };
    expect(verdict.title).toContain("Chrome extension cannot connect to this gateway");
    expect(verdict.remedy).toContain("`omnesis tls provision`");
  });

  test("a containerised gateway's fix is the installer, not `omnesis tls provision`", async () => {
    const app = createServer(db, dbPath, {
      tlsLifecycle: lifecycle(snapshot("self-signed", { selfSigned: true })),
      inContainer: true,
    });
    const verdict = (await pair(app, "browser")).browserCertificate as { remedy: string };
    expect(verdict.remedy).toContain("re-run the installer on the gateway host");
    expect(verdict.remedy).not.toContain("tls provision");
  });

  test.each([
    ["tailscale", "trusted"],
    ["mkcert", "local-ca"],
    ["external", "unknown"],
  ] as const)("a %s certificate is reported as %s", async (ownership, status) => {
    const app = createServer(db, dbPath, { tlsLifecycle: lifecycle(snapshot(ownership)) });
    expect((await pair(app, "browser")).browserCertificate).toMatchObject({
      status,
      certificate: ownership,
    });
  });

  test("the verdict reads the certificate served at mint time, not one from boot", async () => {
    let current = snapshot("self-signed", { selfSigned: true });
    const app = createServer(db, dbPath, {
      tlsLifecycle: { ...lifecycle(current), snapshot: () => current },
    });
    expect((await pair(app, "browser")).browserCertificate).toMatchObject({ status: "untrusted" });
    current = snapshot("tailscale");
    expect((await pair(app, "browser")).browserCertificate).toMatchObject({ status: "trusted" });
  });

  test.each(["cli", "collector", "ios", "android", "portal", "agent", "integration"] as const)(
    "a %s code carries no browser verdict",
    async (kind) => {
      const app = createServer(db, dbPath, {
        tlsLifecycle: lifecycle(snapshot("self-signed", { selfSigned: true })),
      });
      const body = await pair(app, kind);
      expect(body.pairingCode).toEqual(expect.any(String));
      expect(body).not.toHaveProperty("browserCertificate");
    },
  );

  test("a composition without TLS wiring issues the browser code without a verdict", async () => {
    const app = createServer(db, dbPath, {});
    const body = await pair(app, "browser");
    expect(body.pairingCode).toEqual(expect.any(String));
    expect(body).not.toHaveProperty("browserCertificate");
  });
});
