// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * HTTP-level coverage for POST /inference/transcribe: the write-scope guard,
 * body-size limits, and the available/unavailable response contract. Uses a
 * real TranscribeService backed by the synthetic (replay) transcriber — no
 * Whisper model or native dependency required.
 */

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, expect, test, beforeEach, afterEach } from "vitest";

import { SCOPE_WRITE_ALL, SCOPE_READ, type Scope } from "@omnesis/types";
import { createDatabase } from "../../db.js";
import { createServer } from "../../server.js";
import { createToken } from "../../data/repositories/TokenRepository.js";
import { createDevice } from "../../data/repositories/DeviceRepository.js";
import { TranscribeService } from "../../transcribe/index.js";
import type Database from "better-sqlite3";
import type { ResolvedAssignment } from "@omnesis/core";

type Db = Database.Database;

let db: Db;
let dbPath: string;
let app: ReturnType<typeof createServer>;
let WRITE_TOKEN: string;
let READ_TOKEN: string;
let resolved: ResolvedAssignment;

function cleanupDb(path: string) {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}

function mintToken(scopes: readonly Scope[]): string {
  const dev = createDevice(db, { name: `test-${randomUUID()}`, kind: "cli" });
  return createToken(db, dev.id, scopes).token;
}

function post(
  body: Uint8Array,
  opts: { token?: string; contentType?: string; query?: string } = {},
) {
  return app.request(`/inference/transcribe${opts.query ?? ""}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${opts.token ?? WRITE_TOKEN}`,
      "content-type": opts.contentType ?? "audio/ogg",
    },
    body: body as unknown as BodyInit,
  });
}

const enc = (s: string) => new TextEncoder().encode(s);

beforeEach(() => {
  dbPath = `/tmp/omnesis-transcribe-http-${randomUUID()}.db`;
  db = createDatabase(dbPath);
  WRITE_TOKEN = mintToken([SCOPE_WRITE_ALL]);
  READ_TOKEN = mintToken([SCOPE_READ]);
  resolved = { role: "transcriber", kind: "replay" };
  const transcribeService = new TranscribeService({ resolveAssignment: () => resolved });
  app = createServer(db, dbPath, { transcribeService });
});

afterEach(() => {
  db.close();
  cleanupDb(dbPath);
});

describe("POST /inference/transcribe", () => {
  test("transcribes audio and returns the transcript (synthetic passthrough)", async () => {
    const res = await post(enc("meet me at the docks at nine"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { available: boolean; text: string };
    expect(body.available).toBe(true);
    expect(body.text).toBe("meet me at the docks at nine");
  });

  test("reports available:false when no transcriber is configured", async () => {
    resolved = { role: "transcriber", kind: "disabled" };
    const res = await post(enc("hello"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { available: boolean };
    expect(body.available).toBe(false);
  });

  test("rejects an empty body with 400", async () => {
    const res = await post(new Uint8Array(0));
    expect(res.status).toBe(400);
  });

  test("rejects an oversized body with 413 (before buffering it)", async () => {
    const tooBig = new Uint8Array(26 * 1024 * 1024); // > 25 MB cap
    const res = await post(tooBig);
    expect(res.status).toBe(413);
  });

  test("requires a write scope (a read-only token is rejected)", async () => {
    const res = await post(enc("hello"), { token: READ_TOKEN });
    expect(res.status).toBe(403);
  });

  test("rejects an unauthenticated request", async () => {
    const res = await app.request("/inference/transcribe", {
      method: "POST",
      headers: { "content-type": "audio/ogg" },
      body: enc("hello") as unknown as BodyInit,
    });
    expect(res.status).toBe(401);
  });
});
