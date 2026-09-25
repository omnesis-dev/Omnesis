// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * HTTP coverage for `/admin/instructions` — the read/replace/delete surface
 * over `OMNESIS.md`: the scope guard, the byte cap, and the optimistic
 * concurrency that keeps a portal save from silently discarding an edit made
 * in a terminal editor.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { SCOPE_ADMIN, SCOPE_READ, type Scope } from "@omnesis/types";
import { createDatabase } from "../../db.js";
import { createServer } from "../../server.js";
import { createToken } from "../../data/repositories/TokenRepository.js";
import { createDevice } from "../../data/repositories/DeviceRepository.js";
import { directWriteGate } from "../../write-gate.js";
import {
  MAX_OPERATOR_INSTRUCTIONS_BYTES,
  OPERATOR_INSTRUCTIONS_FILENAME,
} from "../../instructions/store.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

let db: Db;
let dbPath: string;
let configDir: string;
let file: string;
let app: ReturnType<typeof createServer>;
let ADMIN_TOKEN: string;
let READ_TOKEN: string;

function mintToken(scopes: readonly Scope[]): string {
  const dev = createDevice(db, { name: `test-${randomUUID()}`, kind: "cli" });
  return createToken(db, dev.id, scopes).token;
}

async function req(init: RequestInit = {}, token = ADMIN_TOKEN): Promise<Response> {
  return await app.request("/admin/instructions", {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...init.headers,
    },
  });
}

beforeEach(() => {
  dbPath = `/tmp/omnesis-instructions-http-${randomUUID()}.db`;
  db = createDatabase(dbPath);
  configDir = mkdtempSync(join(tmpdir(), "omnesis-instructions-http-"));
  file = join(configDir, OPERATOR_INSTRUCTIONS_FILENAME);
  ADMIN_TOKEN = mintToken([SCOPE_ADMIN, SCOPE_READ]);
  READ_TOKEN = mintToken([SCOPE_READ]);
  app = createServer(db, dbPath, { writeGate: directWriteGate(db), configDir });
});

afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
  }
  rmSync(configDir, { recursive: true, force: true });
});

describe("GET /admin/instructions", () => {
  test("reports the absent file without inventing one", async () => {
    const res = await req();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      exists: false,
      content: "",
      bytes: 0,
      updatedAt: null,
      truncated: false,
      maxBytes: MAX_OPERATOR_INSTRUCTIONS_BYTES,
      path: file,
    });
    // Reading must never scaffold the file: an absent OMNESIS.md is what an
    // operator who has not opted in should keep having.
    expect(existsSync(file)).toBe(false);
  });

  test("serves what a terminal editor wrote", async () => {
    writeFileSync(file, "# House rules\n\nAnswer in metric units.\n", "utf8");
    const body = await (await req()).json();
    expect(body.exists).toBe(true);
    expect(body.content).toContain("metric units");
    expect(body.updatedAt).toBeGreaterThan(0);
  });

  test("names why an unloadable file could not be read", async () => {
    // The portal decides whether to open an editor on this; inferring it from
    // an empty `content` would put an empty document over the real file.
    writeFileSync(file, "z".repeat(MAX_OPERATOR_INSTRUCTIONS_BYTES * 16 + 1), "utf8");
    const body = await (await req()).json();
    expect(body.exists).toBe(true);
    expect(body.problem).toBe("too-large");
    expect(body.content).toBe("");
  });

  test("flags a file past the cap so the editor can say so", async () => {
    writeFileSync(file, "x".repeat(MAX_OPERATOR_INSTRUCTIONS_BYTES + 10), "utf8");
    const body = await (await req()).json();
    expect(body.truncated).toBe(true);
    expect(body.problem).toBeNull();
    expect(body.bytes).toBe(MAX_OPERATOR_INSTRUCTIONS_BYTES + 10);
  });

  test("requires admin scope", async () => {
    expect((await req({}, READ_TOKEN)).status).toBe(403);
  });

  test("is never cached", async () => {
    expect((await req()).headers.get("cache-control")).toBe("no-store");
  });
});

describe("PUT /admin/instructions", () => {
  test("writes the file and returns the new state", async () => {
    const res = await req({
      method: "PUT",
      body: JSON.stringify({ content: "Be terse." }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.exists).toBe(true);
    expect(body.content).toBe("Be terse.");
    expect(readFileSync(file, "utf8")).toBe("Be terse.");
  });

  test("refuses a body past the byte cap", async () => {
    const res = await req({
      method: "PUT",
      body: JSON.stringify({ content: "x".repeat(MAX_OPERATOR_INSTRUCTIONS_BYTES + 1) }),
    });
    expect(res.status).toBe(400);
    expect(existsSync(file)).toBe(false);
  });

  test("refuses a save built on a version that has since changed", async () => {
    const first = await (
      await req({ method: "PUT", body: JSON.stringify({ content: "original" }) })
    ).json();

    // Someone edits the file in vim while the portal tab sits open.
    const later = new Date(Date.now() + 5_000);
    writeFileSync(file, "written in a terminal editor", "utf8");
    utimesSync(file, later, later);

    const res = await req({
      method: "PUT",
      body: JSON.stringify({ content: "from the stale tab", expectedUpdatedAt: first.updatedAt }),
    });
    expect(res.status).toBe(409);
    expect(readFileSync(file, "utf8")).toBe("written in a terminal editor");
  });

  test("accepts a save built on the current version", async () => {
    const first = await (
      await req({ method: "PUT", body: JSON.stringify({ content: "original" }) })
    ).json();
    const res = await req({
      method: "PUT",
      body: JSON.stringify({ content: "replacement", expectedUpdatedAt: first.updatedAt }),
    });
    expect(res.status).toBe(200);
    expect(readFileSync(file, "utf8")).toBe("replacement");
  });

  test("requires admin scope", async () => {
    const res = await req({ method: "PUT", body: JSON.stringify({ content: "nope" }) }, READ_TOKEN);
    expect(res.status).toBe(403);
    expect(existsSync(file)).toBe(false);
  });

  test("a create claiming there was no file loses to one written meanwhile", async () => {
    // The editor opened on an empty tab; a terminal wrote the file in between.
    // A create with no version claim would silently win that race.
    const before = await (await req()).json();
    expect(before.updatedAt).toBeNull();
    writeFileSync(file, "written in a terminal editor", "utf8");

    const res = await req({
      method: "PUT",
      body: JSON.stringify({ content: "from the empty tab", expectedUpdatedAt: null }),
    });
    expect(res.status).toBe(409);
    expect(readFileSync(file, "utf8")).toBe("written in a terminal editor");
  });

  test("refuses to write over a path that is not a regular file", async () => {
    mkdirSync(file);
    const res = await req({ method: "PUT", body: JSON.stringify({ content: "hello" }) });
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("not a regular file");
    rmSync(file, { recursive: true, force: true });
  });
});

describe("DELETE /admin/instructions", () => {
  test("accepts a bodyless delete, the natural shape from a shell", async () => {
    // The route is guarded for a bearer token so an operator can script it;
    // demanding a JSON body would make `curl -X DELETE` fail validation.
    await req({ method: "PUT", body: JSON.stringify({ content: "something" }) });
    const res = await app.request("/admin/instructions", {
      method: "DELETE",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).removed).toBe(true);
    expect(existsSync(file)).toBe(false);
  });

  test("removes the file and says whether there was one", async () => {
    await req({ method: "PUT", body: JSON.stringify({ content: "something" }) });
    const body = await (await req({ method: "DELETE", body: "{}" })).json();
    expect(body.removed).toBe(true);
    expect(body.exists).toBe(false);
    expect(existsSync(file)).toBe(false);

    const again = await (await req({ method: "DELETE", body: "{}" })).json();
    expect(again.removed).toBe(false);
  });

  test("refuses a delete built on a stale version", async () => {
    const first = await (
      await req({ method: "PUT", body: JSON.stringify({ content: "original" }) })
    ).json();
    const later = new Date(Date.now() + 5_000);
    writeFileSync(file, "edited elsewhere", "utf8");
    utimesSync(file, later, later);

    const res = await req({
      method: "DELETE",
      body: JSON.stringify({ expectedUpdatedAt: first.updatedAt }),
    });
    expect(res.status).toBe(409);
    expect(existsSync(file)).toBe(true);
  });

  test("requires admin scope", async () => {
    await req({ method: "PUT", body: JSON.stringify({ content: "keep me" }) });
    expect((await req({ method: "DELETE", body: "{}" }, READ_TOKEN)).status).toBe(403);
    expect(existsSync(file)).toBe(true);
  });
});

describe("a gateway with no config directory", () => {
  test("reports the surface unavailable rather than half-working", async () => {
    const bare = createServer(db, dbPath, { writeGate: directWriteGate(db) });
    const res = await bare.request("/admin/instructions", {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(503);
  });
});
