// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Endpoint tests for `GET /admin/doctor`.
 *
 * The report describes the host: config-tree modes, keyring backend,
 * service-unit contents, device names. `scope.admin()` is the only thing
 * between that and a read-scoped token, so the guard is pinned here
 * alongside the response shape the portal's Doctor tab renders.
 */

import { unlinkSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { SCOPE_ADMIN, SCOPE_READ } from "@omnesis/types";
import { createDatabase } from "../../../db.js";
import { createServer } from "../../../server.js";
import {
  createDevice,
  updateDeviceCapabilities,
} from "../../../data/repositories/DeviceRepository.js";
import { createToken } from "../../../data/repositories/TokenRepository.js";
import { DeviceDoctorService } from "../../services/DeviceDoctorService.js";
import { directWriteGate } from "../../../write-gate.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

let db: Db;
let app: ReturnType<typeof createServer>;
let dbPath: string;

function mintToken(scopes: readonly import("@omnesis/types").Scope[]): string {
  const dev = createDevice(db, { name: `test-${randomUUID()}`, kind: "cli" });
  return createToken(db, dev.id, scopes).token;
}

beforeEach(() => {
  dbPath = `/tmp/omnesis-doctor-route-test-${randomUUID()}.db`;
  db = createDatabase(dbPath);
  app = createServer(db, dbPath);
});

afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
  }
});

describe("GET /admin/doctor", () => {
  test("rejects an unauthenticated request", async () => {
    expect((await app.request("/admin/doctor")).status).toBe(401);
  });

  test("rejects a read-scoped token — the report is host detail, not read data", async () => {
    const res = await app.request("/admin/doctor", {
      headers: { Authorization: `Bearer ${mintToken([SCOPE_READ])}` },
    });
    expect(res.status).toBe(403);
  });

  test("an admin token gets a well-formed report", async () => {
    const res = await app.request("/admin/doctor", {
      headers: { Authorization: `Bearer ${mintToken([SCOPE_ADMIN])}` },
    });
    expect(res.status).toBe(200);

    const report = await res.json();
    expect(report).toMatchObject({
      ok: expect.any(Boolean),
      summary: { errors: expect.any(Number), warnings: expect.any(Number) },
      checks: expect.any(Array),
    });
    expect(report.checks.length).toBeGreaterThan(0);

    // `ok` is a function of the failures, not an independently-set flag.
    const failures = report.checks.filter((c: { status: string }) => c.status === "fail");
    expect(report.summary.errors).toBe(failures.length);
    expect(report.ok).toBe(failures.length === 0);

    // The gateway answered, so it necessarily classifies itself reachable.
    expect(report.checks).toContainEqual(
      expect.objectContaining({ id: "gateway.reachable", status: "pass" }),
    );
  });

  test("reports the calling token's own identity in the auth section", async () => {
    const res = await app.request("/admin/doctor", {
      headers: { Authorization: `Bearer ${mintToken([SCOPE_ADMIN])}` },
    });
    const report = await res.json();

    const scopes = report.checks.find((c: { id: string }) => c.id === "auth.scopes");
    expect(scopes.status).toBe("pass");
    expect(scopes.message).toContain("admin");
  });
});

describe("/admin/fleet/doctor", () => {
  test("uses the injected coordinator shared with the WebSocket lifecycle", async () => {
    const coordinator = new DeviceDoctorService({ db, writeGate: directWriteGate(db) });
    const request = vi.spyOn(coordinator, "request").mockResolvedValue({ devices: [] });
    const coordinatedApp = createServer(db, dbPath, { deviceDoctorService: coordinator });
    const token = mintToken([SCOPE_ADMIN]);

    const res = await coordinatedApp.request("/admin/fleet/doctor", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ devices: [] });
    expect(request).toHaveBeenCalledOnce();
  });

  test("requires admin scope for the device report inventory", async () => {
    expect((await app.request("/admin/fleet/doctor")).status).toBe(401);
    const readOnly = await app.request("/admin/fleet/doctor", {
      headers: { Authorization: `Bearer ${mintToken([SCOPE_READ])}` },
    });
    expect(readOnly.status).toBe(403);
  });

  test("lists non-collector devices as not applicable", async () => {
    const token = mintToken([SCOPE_ADMIN]);
    const res = await app.request("/admin/fleet/doctor", {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.devices).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "cli", state: "not-applicable" })]),
    );
  });

  test("an offline compatible collector remains pending for reconnect", async () => {
    const collector = createDevice(db, { name: "collector-alpha", kind: "collector" });
    updateDeviceCapabilities(db, collector.id, { version: "99.0.0", deviceDoctor: true }, 1);
    const token = mintToken([SCOPE_ADMIN]);

    const res = await app.request("/admin/fleet/doctor", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ deviceIds: [collector.id] }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.devices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ deviceId: collector.id, state: "pending", online: false }),
      ]),
    );
  });
});
