// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * HTTP-level coverage for the recorded-conversation routes: the experimental
 * gate, the operator's transcription setting, the scope guard, multipart and
 * body validation, idempotency, the 404/409 refusals, the size limit, and the
 * whole start → chunks → finish → document → delete path. The synthetic
 * (replay) transcriber echoes each chunk's bytes back as its transcript.
 */

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { SCOPE_ADMIN, SCOPE_READ, type Scope } from "@omnesis/types";
import { createDatabase } from "../../db.js";
import { createServer } from "../../server.js";
import { createToken } from "../../data/repositories/TokenRepository.js";
import { createDevice } from "../../data/repositories/DeviceRepository.js";
import { TranscribeService } from "../../transcribe/index.js";
import { dictationFeatureStatus } from "../../dictation/index.js";
import { MAX_RECORDING_CHUNK_BYTES } from "./recordings.js";
import type { OmnesisConfig } from "@omnesis/config";
import type { RecordingTranscriptionService } from "../../recordings/index.js";
import type Database from "better-sqlite3";

let db: Database.Database;
let dbPath: string;
let app: ReturnType<typeof createServer>;
let ADMIN_TOKEN: string;
let optedIn: boolean | undefined;
let priorExperimental: string | undefined;
let recordings: RecordingTranscriptionService | undefined;

const START = "2026-03-02T09:00:00.000Z";

function mintToken(scopes: readonly Scope[]): string {
  const dev = createDevice(db, { name: `test-${randomUUID()}`, kind: "android" });
  return createToken(db, dev.id, scopes).token;
}

function request(method: string, path: string, body?: unknown, token = ADMIN_TOKEN) {
  const isForm = body instanceof FormData;
  return app.request(path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined && !isForm ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined
      ? { body: (isForm ? body : JSON.stringify(body)) as unknown as BodyInit }
      : {}),
  });
}

function chunkForm(
  seq: number,
  text: string | null,
  extra: Record<string, unknown> = {},
): FormData {
  const form = new FormData();
  form.set(
    "chunk",
    JSON.stringify({
      startedAt: new Date(Date.parse(START) + seq * 60_000).toISOString(),
      durationMs: 60_000,
      ...(text === null ? { silent: true } : {}),
      ...extra,
    }),
  );
  if (text !== null) {
    form.set("audio", new Blob([new TextEncoder().encode(text)], { type: "audio/aac" }), "c.aac");
  }
  return form;
}

function startRecording(id = randomUUID(), extra: Record<string, unknown> = {}) {
  return request("POST", "/recordings", { id, startedAt: START, language: "en-GB", ...extra });
}

function documentContent(id: string): string | undefined {
  return (
    db
      .prepare(
        `SELECT content FROM documents WHERE source_id = 'omnesis-recordings' AND external_id = ?`,
      )
      .get(id) as { content: string } | undefined
  )?.content;
}

beforeEach(() => {
  priorExperimental = process.env.OMNESIS_EXPERIMENTAL;
  process.env.OMNESIS_EXPERIMENTAL = "1";
  dbPath = `/tmp/omnesis-test-${randomUUID()}.db`;
  db = createDatabase(dbPath);
  ADMIN_TOKEN = mintToken([SCOPE_ADMIN, SCOPE_READ]);
  optedIn = undefined;
  const transcribeService = new TranscribeService({
    resolveAssignment: () => ({ role: "transcriber", kind: "replay" }),
    deps: {
      loadModule: async () => {
        throw new Error("Cannot find module 'smart-whisper'");
      },
    },
  });
  app = createServer(db, dbPath, {
    transcribeService,
    getDictationStatus: () =>
      dictationFeatureStatus({
        transcriberReadiness: () => transcribeService.readiness(),
        getConfig: () =>
          (optedIn === undefined
            ? {}
            : { inference: { dictation: { transcribeOnGateway: optedIn } } }) as OmnesisConfig,
      }),
    onRecordingService: (service) => {
      recordings = service;
    },
  });
});

afterEach(async () => {
  recordings?.dispose();
  await recordings?.idle();
  if (priorExperimental === undefined) delete process.env.OMNESIS_EXPERIMENTAL;
  else process.env.OMNESIS_EXPERIMENTAL = priorExperimental;
  db.close();
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
  }
});

describe("recordings routes", () => {
  test("start, upload, finish: the conversation becomes one document, and delete removes it", async () => {
    const id = randomUUID();
    const started = await startRecording(id, { title: "Quarterly planning" });
    expect(started.status).toBe(201);
    expect(await started.json()).toMatchObject({ id, state: "recording", chunkCount: null });

    expect(
      (await request("PUT", `/recordings/${id}/chunks/0`, chunkForm(0, "We open on Monday.")))
        .status,
    ).toBe(200);
    expect((await request("PUT", `/recordings/${id}/chunks/1`, chunkForm(1, null))).status).toBe(
      200,
    );
    const late = await request(
      "PUT",
      `/recordings/${id}/chunks/2`,
      chunkForm(2, "Maya brings the keys."),
    );
    expect(await late.json()).toEqual({ seq: 2, status: "stored" });

    const finished = await request("POST", `/recordings/${id}/finish`, {
      chunkCount: 3,
      endedAt: "2026-03-02T09:03:00.000Z",
    });
    expect(finished.status).toBe(200);

    await vi.waitFor(async () => {
      const res = await request("GET", `/recordings/${id}`);
      expect(await res.json()).toMatchObject({
        state: "done",
        chunks: { received: 3, transcribed: 2, silent: 1, pending: 0 },
      });
    });
    const content = documentContent(id)!;
    expect(content).toContain("# Quarterly planning");
    expect(content).toContain("[00:00:00] We open on Monday.");
    expect(content).toContain("[00:02:00] Maya brings the keys.");

    // The projected document is the recording's own: the document routes refuse it.
    const docId = (
      db
        .prepare(
          `SELECT id FROM documents WHERE source_id = 'omnesis-recordings' AND external_id = ?`,
        )
        .get(id) as { id: string }
    ).id;
    const direct = await request("DELETE", `/documents/${docId}`);
    expect(direct.status).toBe(409);
    expect(await direct.json()).toMatchObject({ code: "MANAGE_ORIGINAL_NOTES" });
    const batch = await request("POST", "/documents/delete", {
      providerId: "system",
      sourceId: "omnesis-recordings",
      externalIds: [id],
    });
    expect(batch.status).toBe(409);
    expect(documentContent(id)).toBeDefined();

    expect((await request("DELETE", `/recordings/${id}`)).status).toBe(204);
    expect(documentContent(id)).toBeUndefined();
    expect((await request("GET", `/recordings/${id}`)).status).toBe(404);
    expect((await request("DELETE", `/recordings/${id}`)).status).toBe(404);
  });

  test("retries are idempotent", async () => {
    const id = randomUUID();
    expect((await startRecording(id)).status).toBe(201);
    expect((await startRecording(id)).status).toBe(200);
    await request("PUT", `/recordings/${id}/chunks/0`, chunkForm(0, "hello"));
    const again = await request("PUT", `/recordings/${id}/chunks/0`, chunkForm(0, "hello"));
    expect(await again.json()).toEqual({ seq: 0, status: "duplicate" });
    const finish = { chunkCount: 1, endedAt: "2026-03-02T09:01:00.000Z" };
    expect((await request("POST", `/recordings/${id}/finish`, finish)).status).toBe(200);
    expect((await request("POST", `/recordings/${id}/finish`, finish)).status).toBe(200);
    const conflicting = await request("POST", `/recordings/${id}/finish`, {
      ...finish,
      chunkCount: 4,
    });
    expect(conflicting.status).toBe(409);
  });

  test("refuses chunks for an unknown session or past the declared count", async () => {
    expect(
      (await request("PUT", `/recordings/${randomUUID()}/chunks/0`, chunkForm(0, "x"))).status,
    ).toBe(404);
    expect(
      (await request("PUT", `/recordings/not-a-uuid/chunks/0`, chunkForm(0, "x"))).status,
    ).toBe(404);
    const id = randomUUID();
    await startRecording(id);
    await request("POST", `/recordings/${id}/finish`, {
      chunkCount: 1,
      endedAt: "2026-03-02T09:01:00.000Z",
    });
    expect((await request("PUT", `/recordings/${id}/chunks/1`, chunkForm(1, "x"))).status).toBe(
      409,
    );
  });

  test("validates bodies, chunk numbers and the audio part", async () => {
    expect((await request("POST", "/recordings", { id: "nope", startedAt: START })).status).toBe(
      400,
    );
    expect(
      (await request("POST", "/recordings", { id: randomUUID(), startedAt: "yesterday" })).status,
    ).toBe(400);
    const id = randomUUID();
    await startRecording(id);
    expect((await request("PUT", `/recordings/${id}/chunks/-1`, chunkForm(0, "x"))).status).toBe(
      400,
    );
    expect((await request("PUT", `/recordings/${id}/chunks/10000`, chunkForm(0, "x"))).status).toBe(
      400,
    );
    for (const seq of ["0x1", "1e3", "1.0"]) {
      expect(
        (await request("PUT", `/recordings/${id}/chunks/${seq}`, chunkForm(0, "x"))).status,
      ).toBe(400);
    }
    // A time zone this gateway does not know only labels the recording: it is
    // dropped, not a reason to refuse the recording.
    const odd = randomUUID();
    expect((await startRecording(odd, { startedTimeZoneId: "Mars/Olympus_Mons" })).status).toBe(
      201,
    );
    // A chunk that is not silent needs its audio.
    const noAudio = new FormData();
    noAudio.set("chunk", JSON.stringify({ startedAt: START, durationMs: 60_000 }));
    expect((await request("PUT", `/recordings/${id}/chunks/0`, noAudio)).status).toBe(400);
    const badMeta = chunkForm(0, "x", { unknownField: true });
    expect((await request("PUT", `/recordings/${id}/chunks/0`, badMeta)).status).toBe(400);
  });

  test("refuses a chunk over the size limit", async () => {
    const id = randomUUID();
    await startRecording(id);
    const form = new FormData();
    form.set("chunk", JSON.stringify({ startedAt: START, durationMs: 60_000 }));
    form.set(
      "audio",
      new Blob([new Uint8Array(MAX_RECORDING_CHUNK_BYTES + 1)], { type: "audio/aac" }),
    );
    expect((await request("PUT", `/recordings/${id}/chunks/0`, form)).status).toBe(413);
  });

  test("refuses to start while the operator has switched gateway transcription off", async () => {
    optedIn = false;
    const res = await startRecording();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "DICTATION_DISABLED" });
  });

  test("a token without the recordings write scope is refused", async () => {
    const readOnly = mintToken([SCOPE_READ]);
    const res = await request(
      "POST",
      "/recordings",
      { id: randomUUID(), startedAt: START },
      readOnly,
    );
    expect(res.status).toBe(403);
  });

  test("is advertised, and served, only in experimental mode", async () => {
    const health = await (await app.request("/health")).json();
    expect(health.capabilities.recordings).toEqual({ min: 1, max: 1 });

    delete process.env.OMNESIS_EXPERIMENTAL;
    expect((await startRecording()).status).toBe(404);
    expect((await request("GET", `/recordings/${randomUUID()}`)).status).toBe(404);
    const stable = await (await app.request("/health")).json();
    expect(stable.capabilities.recordings).toBeUndefined();
  });
});
