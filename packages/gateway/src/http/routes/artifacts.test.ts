// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { SCOPE_ADMIN, SCOPE_READ, SCOPE_READ_BULK, SCOPE_WRITE_ALL } from "@omnesis/types";
import { createDatabase } from "../../db.js";
import { createServer } from "../../server.js";
import { directWriteGate } from "../../write-gate.js";
import {
  createDevice,
  updateDeviceCapabilities,
} from "../../data/repositories/DeviceRepository.js";
import {
  createSession,
  createToken,
  deviceIdForToken,
  revokeToken,
} from "../../data/repositories/TokenRepository.js";
import { sessionCookieName } from "../cookies.js";
import { ExportService } from "../services/ExportService.js";
import type { ArtifactCatalogItem } from "../services/artifact-files.js";

let dir: string;
let db: ReturnType<typeof createDatabase>;
let app: ReturnType<typeof createServer>;
let admin: ReturnType<typeof createToken>;
let readToken: string;
let bulkToken: string;
let collectorToken: string;
let output: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "omnesis-artifact-routes-"));
  const dbPath = join(dir, "gateway.db");
  db = createDatabase(dbPath);
  const owner = createDevice(db, { name: "Fictional desktop", kind: "cli" });
  admin = createToken(db, owner.id, [SCOPE_ADMIN, SCOPE_READ]);
  readToken = createToken(db, owner.id, [SCOPE_READ]).token;
  bulkToken = createToken(db, owner.id, [SCOPE_READ_BULK]).token;
  const collector = createDevice(db, { name: "Fictional collector", kind: "collector" });
  collectorToken = createToken(db, collector.id, [SCOPE_READ, SCOPE_WRITE_ALL]).token;
  output = join(dir, "exports", "completed");
  await mkdir(output, { recursive: true });
  await writeFile(join(output, "documents.jsonl"), "fictional export document\n");
  await writeFile(
    join(output, "manifest.json"),
    JSON.stringify({
      version: "0.0.0",
      format: "json",
      startedAt: "2026-02-03T04:00:00.000Z",
      finishedAt: "2026-02-03T04:05:06.000Z",
      files: ["documents.jsonl", "manifest.json"],
    }),
  );
  const exports = new ExportService({
    configDir: dir,
    gatewayDbPath: dbPath,
    analyticsExport: () => Promise.resolve([]),
  });
  app = createServer(db, dbPath, {
    configDir: dir,
    writeGate: directWriteGate(db),
    exportService: exports,
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await app.close();
  db.close();
  await rm(dir, { recursive: true, force: true });
});
function request(path: string, token: string | null = admin.token): Promise<Response> {
  return app.request(path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
}
async function catalog(): Promise<ArtifactCatalogItem[]> {
  const response = await request("/admin/artifacts?kind=export");
  expect(response.status).toBe(200);
  return ((await response.json()) as { items: ArtifactCatalogItem[] }).items;
}

describe("authenticated artifact routes", () => {
  test("a portal cookie cannot use an expired underlying device token to export data", async () => {
    const session = createSession(db, admin.id, [SCOPE_ADMIN, SCOPE_READ]);
    const headers = { cookie: `${sessionCookieName()}=${session}` };
    expect((await app.request("/admin/artifacts", { headers })).status).toBe(200);
    db.prepare("UPDATE tokens SET expires_at = ? WHERE id = ?").run(Date.now() - 1, admin.id);
    expect((await app.request("/admin/artifacts", { headers })).status).toBe(403);
  });

  test("a desktop storage requirement gates actual artifact routes before catalog or download", async () => {
    const item = (await catalog())[0]!;
    updateDeviceCapabilities(db, deviceIdForToken(db, admin.id)!, {
      requiresEncryptedStorage: true,
    });
    for (const path of ["/admin/artifacts", `/admin/artifacts/${item.id}/download`]) {
      const response = await request(path);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: "STORAGE_PROTECTION_REQUIRED" });
    }
    expect((await request("/health")).status).toBe(200);
    expect((await request("/whoami")).status).toBe(200);
  });

  test("only administrative credentials can list or download, including from loopback", async () => {
    const item = (await catalog())[0]!;
    for (const token of [null, readToken, bulkToken, collectorToken]) {
      expect((await request("/admin/artifacts", token)).status).toBe(token === null ? 401 : 403);
      expect((await request(`/admin/artifacts/${item.id}/download`, token)).status).toBe(
        token === null ? 401 : 403,
      );
    }
  });
  test("lists opaque completed exports and returns a real authenticated archive without paths or bearer URLs", async () => {
    const response = await request("/admin/artifacts");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.text();
    expect(body).not.toContain(dir);
    expect(body).not.toContain(admin.token);
    const { items } = JSON.parse(body) as { items: ArtifactCatalogItem[] };
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "export",
      format: "json",
      encrypted: false,
      protection: "plaintext",
    });
    const archive = await request(`/admin/artifacts/${items[0]!.id}/download`);
    expect(archive.status).toBe(200);
    expect(archive.headers.get("content-type")).toBe("application/x-tar");
    expect(archive.headers.get("cache-control")).toBe("no-store");
    expect(archive.headers.get("content-disposition")).toMatch(
      /^attachment; filename="Omnesis-export-/u,
    );
    const bytes = Buffer.from(await archive.arrayBuffer());
    expect(bytes.includes(Buffer.from("fictional export document"))).toBe(true);
    expect(bytes.includes(Buffer.from(dir))).toBe(false);
    expect(bytes.includes(Buffer.from(admin.token))).toBe(false);
  });
  test("rejects paths and malformed IDs instead of accepting arbitrary filesystem selectors", async () => {
    expect((await request("/admin/artifacts?kind=private")).status).toBe(400);
    expect((await request("/admin/artifacts?kind=export&path=private-value")).status).toBe(400);
    expect((await request("/admin/artifacts/not-an-id/download")).status).toBe(400);
    const item = (await catalog())[0]!;
    const response = await request(`/admin/artifacts/${item.id}/download?path=private-value`);
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("private-value");
    expect((await request(`/admin/artifacts/${"a".repeat(64)}/download`)).status).toBe(404);
  });
  test("a changed artifact cannot be fetched under an earlier catalog identity", async () => {
    const item = (await catalog())[0]!;
    await writeFile(join(output, "documents.jsonl"), "replacement invented document");
    expect((await request(`/admin/artifacts/${item.id}/download`)).status).toBe(404);
  });
  test("revocation terminates a live download even after its initial HTTP authorization", async () => {
    await writeFile(join(output, "documents.jsonl"), Buffer.alloc(4 * 1024 * 1024, 0x52));
    const item = (await catalog())[0]!;
    const response = await request(`/admin/artifacts/${item.id}/download`);
    const reader = response.body!.getReader();
    await reader.read();
    revokeToken(db, admin.id);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 2000);
    const consume = async (): Promise<void> => {
      while (!(await reader.read()).done) {
        /* Fixture response only. */
      }
    };
    await expect(consume()).rejects.toThrow("artifact download could not finish");
  });
});
