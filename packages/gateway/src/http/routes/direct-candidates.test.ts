// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi, afterEach } from "vitest";
import { SCOPE_WRITE_ALL } from "@omnesis/types";
import { createDatabase } from "../../db.js";
import { createServer } from "../../server.js";
import { createDevice } from "../../data/repositories/DeviceRepository.js";
import { createToken } from "../../data/repositories/TokenRepository.js";

afterEach(() => vi.unstubAllEnvs());
test("LAN metadata is absent without experimental and requires an actual approved device bearer even over loopback", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omnesis-direct-route-"));
  const dbPath = join(dir, "gateway.sqlite");
  const db = createDatabase(dbPath);
  try {
    writeFileSync(join(dir, "host-network"), "port 8443\ninterface en0 192.168.1.20\n");
    const device = createDevice(db, { name: "Synthetic collector", kind: "collector" });
    const token = createToken(db, device.id, [SCOPE_WRITE_ALL]).token;
    vi.stubEnv("OMNESIS_EXPERIMENTAL", "0");
    expect(
      (
        await createServer(db, dbPath, { configDir: dir, port: 7600 }).request(
          "/devices/direct-candidates",
          { headers: { authorization: `Bearer ${token}` } },
        )
      ).status,
    ).toBe(404);
    vi.stubEnv("OMNESIS_EXPERIMENTAL", "1");
    const app = createServer(db, dbPath, { configDir: dir, port: 7600 });
    const deniedHeaders: Record<string, string>[] = [
      {},
      { authorization: "Bearer wrong-relay-token" },
      { "x-forwarded-for": "127.0.0.1", "x-real-ip": "127.0.0.1" },
    ];
    for (const headers of deniedHeaders)
      expect((await app.request("/devices/direct-candidates", { headers })).status).toBe(401);
    const response = await app.request("/devices/direct-candidates", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      version: 1,
      candidates: [{ address: "192.168.1.20", port: 8443 }],
    });
    expect(
      (
        await app.request("/devices/direct-candidates?address=8.8.8.8", {
          headers: { authorization: `Bearer ${token}`, "x-forwarded-host": "attacker.example" },
        })
      ).status,
    ).toBe(200);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
