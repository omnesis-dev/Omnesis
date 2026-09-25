// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Endpoint tests for the owned-web-domains routes.
 *
 * Auth posture under test:
 *   - `POST /admin/owned-web-domains` requires broad write (`write:*`) or admin
 *     because it is process-wide collector metadata.
 *   - `GET /owned-web-domains` is public — the browser extension fetches it
 *     with a `write:web`-only token (which can't satisfy `read`), and the
 *     set is non-secret public vendor hostnames.
 */

import { unlinkSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { SCOPE_READ, SCOPE_WRITE_ALL, writeScope, SourceType } from "@omnesis/types";
import { createDatabase } from "../../../db.js";
import { createServer } from "../../../server.js";
import { resetOwnedWebDomains } from "../../../owned-web-domains.js";
import { createDevice } from "../../../data/repositories/DeviceRepository.js";
import { createToken } from "../../../data/repositories/TokenRepository.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

let db: Db;
let app: ReturnType<typeof createServer>;
let dbPath: string;

function cleanupDb(path: string) {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}

function mintToken(scopes: readonly import("@omnesis/types").Scope[]): string {
  const dev = createDevice(db, { name: `test-${randomUUID()}`, kind: "cli" });
  return createToken(db, dev.id, scopes).token;
}

beforeEach(() => {
  dbPath = `/tmp/omnesis-owned-domains-test-${randomUUID()}.db`;
  db = createDatabase(dbPath);
  app = createServer(db);
  resetOwnedWebDomains();
});

afterEach(() => {
  db.close();
  cleanupDb(dbPath);
  resetOwnedWebDomains();
});

describe("owned-web-domains endpoints", () => {
  test("a write token pushes the set; the public GET returns the union", async () => {
    const writeToken = mintToken([SCOPE_WRITE_ALL]);
    const post = await app.request("/admin/owned-web-domains", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${writeToken}` },
      body: JSON.stringify({ domains: ["web.whatsapp.com", "mail.google.com", "notion.so"] }),
    });
    expect(post.status).toBe(200);
    expect((await post.json()) as { ok: boolean; count: number }).toEqual({ ok: true, count: 3 });

    // GET is public — no Authorization header at all.
    const get = await app.request("/owned-web-domains");
    expect(get.status).toBe(200);
    expect((await get.json()) as { domains: string[] }).toEqual({
      domains: ["mail.google.com", "notion.so", "web.whatsapp.com"],
    });
  });

  test("the extension's write:web-only token can read the public GET", async () => {
    // The browser device's token carries write:web only, never read.
    const browserToken = mintToken([writeScope(SourceType("web"))]);
    const get = await app.request("/owned-web-domains", {
      headers: { Authorization: `Bearer ${browserToken}` },
    });
    expect(get.status).toBe(200);
    expect((await get.json()) as { domains: string[] }).toEqual({ domains: [] });
  });

  test("a read-only token cannot push the set", async () => {
    const readToken = mintToken([SCOPE_READ]);
    const post = await app.request("/admin/owned-web-domains", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${readToken}` },
      body: JSON.stringify({ domains: ["example.com"] }),
    });
    expect(post.status).toBe(403);
  });

  test("a source-specific write token cannot push the process-wide set", async () => {
    const webToken = mintToken([writeScope(SourceType("web"))]);
    const post = await app.request("/admin/owned-web-domains", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${webToken}` },
      body: JSON.stringify({ domains: ["example.com"] }),
    });
    expect(post.status).toBe(403);
  });

  test("re-pushing fully replaces the previous set", async () => {
    const writeToken = mintToken([SCOPE_WRITE_ALL]);
    const push = (domains: string[]) =>
      app.request("/admin/owned-web-domains", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${writeToken}` },
        body: JSON.stringify({ domains }),
      });

    await push(["a.example.com"]);
    await push(["b.example.com"]);

    const get = await app.request("/owned-web-domains");
    expect((await get.json()) as { domains: string[] }).toEqual({ domains: ["b.example.com"] });
  });
});
