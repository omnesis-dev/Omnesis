// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The internal notes source on the admin surface: it is advertised beside
 * the registered sources, never inside them, and every per-source mutation
 * is refused with an explicit 409 rather than a misleading 404.
 */

import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { SCOPE_ADMIN, SCOPE_READ, SCOPE_WRITE_ALL } from "@omnesis/types";
import { createDatabase } from "../../../db.js";
import { createServer } from "../../../server.js";
import { createDevice } from "../../../data/repositories/DeviceRepository.js";
import { createToken } from "../../../data/repositories/TokenRepository.js";
import { OMNESIS_NOTES_SOURCE_ID } from "../../../sources/omnesis-notes/index.js";
import type { Scope } from "@omnesis/types";
import type { OmnesisNotesRuntime } from "../../../sources/omnesis-notes/index.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

let db: Db;
let app: ReturnType<typeof createServer>;
let dbPath: string;
let token: string;
let notesRuntime: OmnesisNotesRuntime | undefined;

function cleanupDb(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}

function mintToken(scopes: readonly Scope[]): string {
  const dev = createDevice(db, { name: `test-${randomUUID()}`, kind: "cli" });
  return createToken(db, dev.id, scopes).token;
}

function req(path: string, init: RequestInit = {}): Promise<Response> {
  // Hono's overloads resolve to `Response | Promise<Response>`; the
  // (path, init) form always returns the promise at runtime.
  return app.request(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...init.headers,
    },
  }) as Promise<Response>;
}

beforeEach(() => {
  dbPath = `/tmp/omnesis-test-${randomUUID()}.db`;
  db = createDatabase(dbPath);
  token = mintToken([SCOPE_ADMIN, SCOPE_READ, SCOPE_WRITE_ALL]);
  notesRuntime = undefined;
  app = createServer(db, dbPath, {
    onOmnesisNotesRuntime: (rt) => {
      notesRuntime = rt;
    },
  });
});

afterEach(async () => {
  await notesRuntime?.flushAll();
  notesRuntime?.dispose();
  db.close();
  cleanupDb(dbPath);
});

describe("internal sources on GET /admin/sources", () => {
  test("lists omnesis-notes beside, not inside, the registered sources", async () => {
    const res = await req("/admin/sources");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ id: string }>;
      internalSources: Array<{ id: string }>;
    };
    expect(body.internalSources).toEqual([{ id: OMNESIS_NOTES_SOURCE_ID }]);
    expect(body.items.map((s) => s.id)).not.toContain(OMNESIS_NOTES_SOURCE_ID);
  });
});

describe("admin mutations on the internal source", () => {
  test.each([
    ["DELETE", `/admin/sources/${OMNESIS_NOTES_SOURCE_ID}`, undefined],
    ["POST", `/admin/sources/${OMNESIS_NOTES_SOURCE_ID}/sync`, undefined],
    ["POST", `/admin/sources/${OMNESIS_NOTES_SOURCE_ID}/resync`, {}],
    ["POST", `/admin/sources/${OMNESIS_NOTES_SOURCE_ID}/members`, { deviceId: "fictional-device" }],
    ["DELETE", `/admin/sources/${OMNESIS_NOTES_SOURCE_ID}/members/fictional-device`, undefined],
    ["PATCH", `/admin/sources/${OMNESIS_NOTES_SOURCE_ID}`, { enabled: false }],
    [
      "PATCH",
      `/admin/sources/${OMNESIS_NOTES_SOURCE_ID}/members/fictional-device`,
      { configOverride: {} },
    ],
    ["GET", `/admin/sources/${OMNESIS_NOTES_SOURCE_ID}/debug`, undefined],
    ["POST", `/admin/sources/${OMNESIS_NOTES_SOURCE_ID}/import-history`, { values: {} }],
    ["GET", `/admin/sources/${OMNESIS_NOTES_SOURCE_ID}`, undefined],
    ["GET", `/admin/sync/status/${OMNESIS_NOTES_SOURCE_ID}`, undefined],
  ] as const)("%s %s → 409 INTERNAL_SOURCE", async (method, path, body) => {
    const res = await req(
      path,
      method === "GET" || body === undefined ? { method } : { method, body: JSON.stringify(body) },
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "INTERNAL_SOURCE" });
  });
});

describe("guard ordering", () => {
  test("a malformed id fails on parse, never as INTERNAL_SOURCE", async () => {
    const res = await req("/admin/sources/oh%20no", { method: "DELETE" });
    expect(res.status).not.toBe(409);
  });
});

describe("recent documents for the internal source", () => {
  test("a captured note surfaces as a day document", async () => {
    const capture = await req("/notes", {
      method: "POST",
      body: JSON.stringify({ text: "Remember the fictional lighthouse visit", surface: "cli" }),
    });
    expect(capture.status).toBe(201);
    // Flush the day-doc debounce so the projection lands before the read.
    await notesRuntime?.flushAll();

    const res = await req(`/sources/${OMNESIS_NOTES_SOURCE_ID}/recent?limit=25`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      kind: string;
      internal: boolean;
      documents: Array<{ id: string; sourceId: string; title: string }>;
    };
    expect(body.kind).toBe("documents");
    expect(body.internal).toBe(true);
    expect(body.documents).toHaveLength(1);
    expect(body.documents[0]?.sourceId).toBe(OMNESIS_NOTES_SOURCE_ID);

    // The document endpoint flags it too, so clients render the generated
    // day document read-only (managed with the original note instead).
    const docId = body.documents[0]?.id;
    expect(docId).toBeTruthy();
    const detail = (await (await req(`/documents/${docId}`)).json()) as {
      source_id: string;
      internal: boolean;
    };
    expect(detail.source_id).toBe(OMNESIS_NOTES_SOURCE_ID);
    expect(detail.internal).toBe(true);

    // A direct user delete of the generated document is refused — the
    // original note is untouched, and the day document survives the attempt.
    const del = await req(`/documents/${docId}`, { method: "DELETE" });
    expect(del.status).toBe(409);
    expect(await del.json()).toMatchObject({ code: "MANAGE_ORIGINAL_NOTES" });
    const after = (await (
      await req(`/sources/${OMNESIS_NOTES_SOURCE_ID}/recent?limit=25`)
    ).json()) as { kind: string; internal: boolean };
    expect(after.kind).toBe("documents");
    expect(after.internal).toBe(true);
  });
});
