// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Endpoint tests for the source-document-profiles routes.
 *
 * Auth posture under test:
 *   - `POST /admin/source-document-profiles` requires broad write (`write:*`)
 *     or admin — it is a process-wide collector push, so a source-specific
 *     write token must not be able to replace it.
 *   - `GET /admin/source-document-profiles` requires read.
 *
 * Also covered: the stored set survives a fresh server over the same database
 * file, which is the reason this push is persisted rather than in-memory.
 *
 * All fixture data is invented — never corpus-derived.
 */

import { unlinkSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { SCOPE_READ, SCOPE_WRITE_ALL, writeScope, SourceType } from "@omnesis/types";
import { createDatabase } from "../../../db.js";
import { createServer } from "../../../server.js";
import { createDevice } from "../../../data/repositories/DeviceRepository.js";
import { createToken } from "../../../data/repositories/TokenRepository.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

let db: Db;
let app: ReturnType<typeof createServer>;
let dbPath: string;

const mailbox = {
  sourceType: "mailbox",
  outputRevision: 1,
  profile: {
    documentTypes: ["email"],
    personRoles: ["sender", "recipient"],
    metadataFields: [
      {
        path: "tags",
        type: "string-array",
        description: "Labels the mailbox applies to a message.",
        canonicalValues: ["receipts", "travel"],
        valueAliases: { receipts: ["receipt"] },
      },
    ],
  },
};

const notebook = {
  sourceType: "notebook",
  outputRevision: 1,
  profile: { documentTypes: ["note"], personRoles: ["author"] },
};

function cleanupDb(path: string) {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}

function mintToken(scopes: readonly import("@omnesis/types").Scope[]): string {
  const dev = createDevice(db, { name: `test-${randomUUID()}`, kind: "cli" });
  return createToken(db, dev.id, scopes).token;
}

function post(token: string, entries: unknown): Promise<Response> {
  return app.request("/admin/source-document-profiles", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ entries }),
  });
}

beforeEach(() => {
  dbPath = `/tmp/omnesis-doc-profiles-test-${randomUUID()}.db`;
  db = createDatabase(dbPath);
  app = createServer(db);
});

afterEach(() => {
  db.close();
  cleanupDb(dbPath);
});

describe("source-document-profiles endpoints", () => {
  test("a write token publishes the set; a read token reads it back", async () => {
    const writeToken = mintToken([SCOPE_WRITE_ALL]);
    const response = await post(writeToken, [mailbox, notebook]);
    expect(response.status).toBe(200);
    expect((await response.json()) as { ok: boolean; count: number }).toEqual({
      ok: true,
      count: 2,
      skipped: 0,
    });

    const get = await app.request("/admin/source-document-profiles", {
      headers: { Authorization: `Bearer ${mintToken([SCOPE_READ])}` },
    });
    expect(get.status).toBe(200);
    expect((await get.json()) as { entries: unknown[] }).toEqual({ entries: [mailbox, notebook] });
  });

  test("a read-only token cannot publish", async () => {
    expect((await post(mintToken([SCOPE_READ]), [mailbox])).status).toBe(403);
  });

  test("a source-specific write token cannot publish the process-wide set", async () => {
    const scoped = mintToken([writeScope(SourceType("web"))]);
    expect((await post(scoped, [mailbox])).status).toBe(403);
  });

  test("an unauthenticated request is rejected", async () => {
    const response = await app.request("/admin/source-document-profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entries: [mailbox] }),
    });
    expect(response.status).toBe(401);
  });

  test("the GET is not public", async () => {
    expect((await app.request("/admin/source-document-profiles")).status).toBe(401);
  });

  test("a second publisher adds to the set without erasing the first", async () => {
    // Two collectors on different platforms load different sources, so each
    // one's list is complete for itself and partial for the install.
    const writeToken = mintToken([SCOPE_WRITE_ALL]);
    await post(writeToken, [mailbox, notebook]);
    await post(writeToken, [notebook]);

    const get = await app.request("/admin/source-document-profiles", {
      headers: { Authorization: `Bearer ${mintToken([SCOPE_READ])}` },
    });
    expect((await get.json()) as { entries: unknown[] }).toEqual({
      entries: [mailbox, notebook],
    });
  });

  test("a profile whose alias names an undeclared value is rejected whole", async () => {
    const writeToken = mintToken([SCOPE_WRITE_ALL]);
    await post(writeToken, [mailbox]);

    const bad = await post(writeToken, [
      notebook,
      {
        sourceType: "ledger",
        profile: {
          metadataFields: [
            {
              path: "status",
              type: "string",
              description: "Settlement state.",
              canonicalValues: ["settled"],
              valueAliases: { pending: ["in flight"] },
            },
          ],
        },
      },
    ]);
    expect(bad.status).toBe(400);

    // Nothing landed — the earlier set is still what a reader sees.
    const get = await app.request("/admin/source-document-profiles", {
      headers: { Authorization: `Bearer ${mintToken([SCOPE_READ])}` },
    });
    expect((await get.json()) as { entries: unknown[] }).toEqual({ entries: [mailbox] });
  });

  test("the same source type published twice in one push is rejected", async () => {
    const writeToken = mintToken([SCOPE_WRITE_ALL]);
    expect((await post(writeToken, [mailbox, mailbox])).status).toBe(400);
  });

  test("the published set survives a restart before the collector reconnects", async () => {
    await post(mintToken([SCOPE_WRITE_ALL]), [mailbox]);
    const readToken = mintToken([SCOPE_READ]);
    db.close();

    // A fresh gateway over the same file, with no collector connected yet.
    db = createDatabase(dbPath);
    app = createServer(db);
    const get = await app.request("/admin/source-document-profiles", {
      headers: { Authorization: `Bearer ${readToken}` },
    });
    expect((await get.json()) as { entries: unknown[] }).toEqual({ entries: [mailbox] });
  });

  test("a field declared as identifying people keeps that flag through the round trip", async () => {
    // Only the source knows which of its fields carry identity, and this route
    // is the only path that knowledge takes. A schema that omits the key drops
    // it silently, and the operator is then asked to approve a filter that
    // singles out a person as though it named nobody.
    const roster = {
      sourceType: "roster",
      profile: {
        documentTypes: ["conversation"],
        personRoles: ["participant"],
        metadataFields: [
          {
            path: "extra.chatName",
            type: "string",
            description: "Name of the person on the other end of a direct message.",
            identifiesPeople: true,
          },
          {
            path: "extra.messageCount",
            type: "number",
            description: "Turns exchanged that day.",
          },
        ],
      },
    };
    expect((await post(mintToken([SCOPE_WRITE_ALL]), [roster])).status).toBe(200);

    const get = await app.request("/admin/source-document-profiles", {
      headers: { Authorization: `Bearer ${mintToken([SCOPE_READ])}` },
    });
    const body = (await get.json()) as {
      entries: Array<{
        sourceType: string;
        profile: { metadataFields: Array<Record<string, unknown>> };
      }>;
    };
    const fields = body.entries.find((e) => e.sourceType === "roster")!.profile.metadataFields;
    expect(fields.find((f) => f.path === "extra.chatName")!.identifiesPeople).toBe(true);
    // A field that never claimed identity must not acquire it.
    expect(fields.find((f) => f.path === "extra.messageCount")!.identifiesPeople).toBeUndefined();
  });

  test("a collector that sends no source version cannot replace a profile published with one", async () => {
    const writeToken = mintToken([SCOPE_WRITE_ALL]);
    const newer = {
      sourceType: "mailbox",
      outputRevision: 2,
      profile: { documentTypes: ["email", "attachment"] },
    };
    await post(writeToken, [newer]);

    const older = await post(writeToken, [
      { sourceType: "mailbox", profile: { documentTypes: ["email"] } },
      notebook,
    ]);
    expect(older.status).toBe(200);
    expect(await older.json()).toEqual({ ok: true, count: 1, skipped: 1 });

    const get = await app.request("/admin/source-document-profiles", {
      headers: { Authorization: `Bearer ${mintToken([SCOPE_READ])}` },
    });
    expect((await get.json()) as { entries: unknown[] }).toEqual({ entries: [newer, notebook] });
  });

  test("an equal source version replaces the stored profile", async () => {
    const writeToken = mintToken([SCOPE_WRITE_ALL]);
    await post(writeToken, [mailbox]);
    const revised = { ...mailbox, profile: { documentTypes: ["email", "attachment"] } };
    expect(await (await post(writeToken, [revised])).json()).toEqual({
      ok: true,
      count: 1,
      skipped: 0,
    });

    const get = await app.request("/admin/source-document-profiles", {
      headers: { Authorization: `Bearer ${mintToken([SCOPE_READ])}` },
    });
    expect((await get.json()) as { entries: unknown[] }).toEqual({ entries: [revised] });
  });

  test.each([
    ["negative", -1],
    ["fractional", 1.5],
    ["a string", "2"],
  ])("a source version that is %s is rejected", async (_label, outputRevision) => {
    const response = await post(mintToken([SCOPE_WRITE_ALL]), [{ ...notebook, outputRevision }]);
    expect(response.status).toBe(400);
  });

  test("filter declarations are stored as published, whether or not this gateway knows them", async () => {
    // A collector newer than the gateway may declare a capability or a key this
    // build has never heard of. Refusing the publication would cost the source
    // its whole profile, and stripping the key would lose the fact that the
    // source declared something; both are stored, and judged where they are read.
    const drive = {
      sourceType: "drive",
      outputRevision: 3,
      profile: {
        documentTypes: ["file"],
        personRoles: ["owner"],
        metadataFields: [
          {
            path: "extra.folderIds",
            type: "string-array",
            description: "Ids of the folders a file sits in.",
            filter: {
              capability: "tree",
              minVersion: 2,
              scope: "global",
              noun: { one: "folder", many: "folders" },
              picker: "tree",
              inside: { one: "folder", many: "folders" },
              aKeyFromALaterContract: { anything: true },
            },
          },
          {
            path: "extra.modifiedOn",
            type: "string",
            description: "Day the file last changed.",
            filter: { capability: "date-range", minVersion: 3, granularity: "day" },
          },
        ],
        personFilter: {
          minVersion: 0,
          roles: ["owner"],
          identifiers: ["email", "handle"],
        },
      },
    };
    const response = await post(mintToken([SCOPE_WRITE_ALL]), [drive]);
    expect(response.status).toBe(200);

    const get = await app.request("/admin/source-document-profiles", {
      headers: { Authorization: `Bearer ${mintToken([SCOPE_READ])}` },
    });
    expect((await get.json()) as { entries: unknown[] }).toEqual({ entries: [drive] });
  });

  test("a key the profile contract does not know is dropped without refusing the publication", async () => {
    const response = await post(mintToken([SCOPE_WRITE_ALL]), [
      {
        ...notebook,
        aKeyFromALaterContract: 1,
        profile: { ...notebook.profile, retention: "complete" },
      },
    ]);
    expect(response.status).toBe(200);

    const get = await app.request("/admin/source-document-profiles", {
      headers: { Authorization: `Bearer ${mintToken([SCOPE_READ])}` },
    });
    expect((await get.json()) as { entries: unknown[] }).toEqual({ entries: [notebook] });
  });

  test("a filter declaration that is not an object is rejected", async () => {
    const response = await post(mintToken([SCOPE_WRITE_ALL]), [
      {
        sourceType: "drive",
        profile: {
          metadataFields: [
            { path: "extra.folderIds", type: "string-array", description: "Ids.", filter: "tree" },
          ],
        },
      },
    ]);
    expect(response.status).toBe(400);
  });
});
