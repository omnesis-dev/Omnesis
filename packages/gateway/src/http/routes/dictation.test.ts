// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * HTTP-level coverage for gateway dictation: the experimental 404, the
 * operator opt-in, the transcriber requirement, the admin-scope guard, the
 * body limits, and the `/status` advertisement clients key off. Uses a real
 * TranscribeService on the synthetic (replay) transcriber, which echoes the
 * audio bytes back as text.
 */

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { SCOPE_ADMIN, SCOPE_READ, SCOPE_WRITE_ALL, type Scope } from "@omnesis/types";
import { createDatabase } from "../../db.js";
import { createServer } from "../../server.js";
import { createToken } from "../../data/repositories/TokenRepository.js";
import { createDevice } from "../../data/repositories/DeviceRepository.js";
import { TranscribeService, MAX_AUDIO_BYTES } from "../../transcribe/index.js";
import { dictationFeatureStatus } from "../../dictation/index.js";
import { MAX_QUEUED_DICTATIONS } from "./dictation.js";
import type { OmnesisConfig } from "@omnesis/config";
import type { ResolvedAssignment } from "@omnesis/core";
import type Database from "better-sqlite3";

let db: Database.Database;
let dbPath: string;
let app: ReturnType<typeof createServer>;
let ADMIN_TOKEN: string;
let resolved: ResolvedAssignment;
let optedIn: boolean;
let priorExperimental: string | undefined;
let languages: (string | undefined)[];
let transcribeService: TranscribeService;

function mintToken(scopes: readonly Scope[]): string {
  const dev = createDevice(db, { name: `test-${randomUUID()}`, kind: "ios" });
  return createToken(db, dev.id, scopes).token;
}

function post(body: Uint8Array, opts: { token?: string; query?: string } = {}) {
  return app.request(`/dictation/transcribe${opts.query ?? ""}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${opts.token ?? ADMIN_TOKEN}`,
      "content-type": "audio/mp4",
    },
    body: body as unknown as BodyInit,
  });
}

async function statusDictation(): Promise<Record<string, unknown>> {
  const res = await app.request("/status", {
    headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { dictation: Record<string, unknown> }).dictation;
}

const enc = (s: string) => new TextEncoder().encode(s);

beforeEach(() => {
  priorExperimental = process.env.OMNESIS_EXPERIMENTAL;
  process.env.OMNESIS_EXPERIMENTAL = "1";
  dbPath = `/tmp/omnesis-test-${randomUUID()}.db`;
  db = createDatabase(dbPath);
  ADMIN_TOKEN = mintToken([SCOPE_ADMIN, SCOPE_READ]);
  resolved = { role: "transcriber", kind: "replay" };
  optedIn = true;
  languages = [];
  transcribeService = new TranscribeService({ resolveAssignment: () => resolved });
  const transcribe = transcribeService.transcribe.bind(transcribeService);
  transcribeService.transcribe = (audio, mime, opts) => {
    languages.push(opts?.language);
    return transcribe(audio, mime, opts);
  };
  app = createServer(db, dbPath, {
    transcribeService,
    getDictationStatus: () =>
      dictationFeatureStatus({
        transcriberReadiness: () => transcribeService.readiness(),
        getConfig: () =>
          ({ inference: { dictation: { transcribeOnGateway: optedIn } } }) as OmnesisConfig,
      }),
  });
});

afterEach(() => {
  if (priorExperimental === undefined) delete process.env.OMNESIS_EXPERIMENTAL;
  else process.env.OMNESIS_EXPERIMENTAL = priorExperimental;
  db.close();
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
  }
});

describe("POST /dictation/transcribe", () => {
  test("returns the transcript when experimental, opted in and a transcriber runs", async () => {
    const res = await post(enc("  remind me to water the ferns  "));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ text: "remind me to water the ferns" });
  });

  test("does not exist outside experimental mode, even before auth", async () => {
    delete process.env.OMNESIS_EXPERIMENTAL;
    expect((await post(enc("hello"))).status).toBe(404);
    const unauthenticated = await app.request("/dictation/transcribe", {
      method: "POST",
      body: enc("hello") as unknown as BodyInit,
    });
    expect(unauthenticated.status).toBe(404);
  });

  test("refuses with DICTATION_DISABLED until the operator opts in", async () => {
    optedIn = false;
    const res = await post(enc("hello"));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("DICTATION_DISABLED");
  });

  test("refuses with TRANSCRIBER_UNAVAILABLE and the reason when no transcriber is assigned", async () => {
    resolved = { role: "transcriber", kind: "disabled" };
    const res = await post(enc("hello"));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      code: "TRANSCRIBER_UNAVAILABLE",
      error: "No transcriber model is assigned.",
    });
  });

  test("a remote transcriber assignment does not count: transcription is local-only", async () => {
    resolved = {
      role: "transcriber",
      kind: "http",
      backendKey: "vllm",
      model: "whisper-1",
      url: "http://localhost:8000",
      allowRemoteInference: false,
      available: true,
    };
    const res = await post(enc("hello"));
    expect(res.status).toBe(503);
  });

  test("a failed transcription answers TRANSCRIBER_UNAVAILABLE", async () => {
    transcribeService.transcribe = () => Promise.resolve(null);
    const res = await post(enc("hello"));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      code: "TRANSCRIBER_UNAVAILABLE",
      error: "The transcription failed.",
    });
  });

  test("refuses with DICTATION_BUSY once the interactive queue is full", async () => {
    transcribeService.interactiveBacklog = () => MAX_QUEUED_DICTATIONS;
    const res = await post(enc("hello"));
    expect(res.status).toBe(429);
    expect(((await res.json()) as { code: string }).code).toBe("DICTATION_BUSY");
  });

  test("requires the admin scope", async () => {
    const writer = mintToken([SCOPE_WRITE_ALL, SCOPE_READ]);
    expect((await post(enc("hello"), { token: writer })).status).toBe(403);
  });

  test("rejects an empty body with 400 and an oversized one with 413", async () => {
    expect((await post(new Uint8Array(0))).status).toBe(400);
    expect((await post(new Uint8Array(MAX_AUDIO_BYTES + 1))).status).toBe(413);
  });

  test("passes a well-formed language hint through and drops a malformed one", async () => {
    await post(enc("bonjour"), { query: "?language=FR" });
    await post(enc("hello"), { query: "?language=en-GB" });
    await post(enc("hello"));
    expect(languages).toEqual(["fr", undefined, undefined]);
  });
});

describe("GET /status dictation", () => {
  test("advertises active only when every lever is set", async () => {
    expect(await statusDictation()).toEqual({
      visible: true,
      enabled: true,
      modelAssigned: true,
      active: true,
      maxAudioBytes: MAX_AUDIO_BYTES,
    });

    optedIn = false;
    expect(await statusDictation()).toMatchObject({ visible: true, enabled: false, active: false });

    optedIn = true;
    resolved = { role: "transcriber", kind: "disabled" };
    expect(await statusDictation()).toMatchObject({
      enabled: true,
      modelAssigned: false,
      active: false,
      reason: "No transcriber model is assigned.",
    });

    resolved = { role: "transcriber", kind: "replay" };
    delete process.env.OMNESIS_EXPERIMENTAL;
    expect(await statusDictation()).toMatchObject({ visible: false, active: false });
  });

  test("a gateway without the gate wired advertises nothing to show", async () => {
    app = createServer(db, dbPath, {});
    expect(await statusDictation()).toEqual({
      visible: false,
      enabled: false,
      modelAssigned: false,
      active: false,
      maxAudioBytes: MAX_AUDIO_BYTES,
    });
  });
});
