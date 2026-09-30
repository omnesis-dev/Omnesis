// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * HTTP-level coverage for POST /notes/voice: the experimental 404, the
 * operator opt-in, the transcriber requirement, the scope guard, multipart
 * validation, the size limit, and the save-now-transcribe-later contract. The
 * synthetic (replay) transcriber echoes the audio bytes back as text.
 */

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { SCOPE_ADMIN, SCOPE_READ, type Scope } from "@omnesis/types";
import { createDatabase } from "../../db.js";
import { createServer } from "../../server.js";
import { createToken } from "../../data/repositories/TokenRepository.js";
import { createDevice } from "../../data/repositories/DeviceRepository.js";
import { TranscribeService, MAX_AUDIO_BYTES } from "../../transcribe/index.js";
import { dictationFeatureStatus } from "../../dictation/index.js";
import { TRANSCRIBING_PLACEHOLDER, type VoiceNoteService } from "../../voice-notes/index.js";
import { languageHint } from "./voice-notes.js";
import type { OmnesisConfig } from "@omnesis/config";
import type { ResolvedAssignment } from "@omnesis/core";
import type { OmnesisNotesRuntime } from "../../sources/omnesis-notes/index.js";
import type Database from "better-sqlite3";

let db: Database.Database;
let dbPath: string;
let app: ReturnType<typeof createServer>;
let ADMIN_TOKEN: string;
let resolved: ResolvedAssignment;
let optedIn: boolean;
let priorExperimental: string | undefined;
let voiceNotes: VoiceNoteService | undefined;
let notesRuntime: OmnesisNotesRuntime | undefined;
let languages: (string | undefined)[];

function mintToken(scopes: readonly Scope[]): string {
  const dev = createDevice(db, { name: `test-${randomUUID()}`, kind: "ios" });
  return createToken(db, dev.id, scopes).token;
}

function voiceNoteForm(
  note: Record<string, unknown>,
  audio: Uint8Array | null = new TextEncoder().encode("water the ferns on sunday"),
): FormData {
  const form = new FormData();
  form.set("note", JSON.stringify(note));
  if (audio) form.set("audio", new Blob([audio], { type: "audio/mp4" }), "note.m4a");
  return form;
}

function post(body: FormData | string, token = ADMIN_TOKEN) {
  return app.request("/notes/voice", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: body as unknown as BodyInit,
  });
}

function noteText(id: string): string | undefined {
  return notesRuntime?.listDay().find((entry) => entry.id === id)?.text;
}

beforeEach(() => {
  priorExperimental = process.env.OMNESIS_EXPERIMENTAL;
  process.env.OMNESIS_EXPERIMENTAL = "1";
  dbPath = `/tmp/omnesis-test-${randomUUID()}.db`;
  db = createDatabase(dbPath);
  ADMIN_TOKEN = mintToken([SCOPE_ADMIN, SCOPE_READ]);
  resolved = { role: "transcriber", kind: "replay" };
  optedIn = true;
  languages = [];
  const transcribeService = new TranscribeService({ resolveAssignment: () => resolved });
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
    onVoiceNoteService: (service) => {
      voiceNotes = service;
    },
    onOmnesisNotesRuntime: (runtime) => {
      notesRuntime = runtime;
    },
  });
});

afterEach(async () => {
  voiceNotes?.dispose();
  await voiceNotes?.idle();
  await notesRuntime?.flushAll();
  notesRuntime?.dispose();
  if (priorExperimental === undefined) delete process.env.OMNESIS_EXPERIMENTAL;
  else process.env.OMNESIS_EXPERIMENTAL = priorExperimental;
  db.close();
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
  }
});

describe("POST /notes/voice", () => {
  test("saves the note at once and replaces its text with the gateway's transcript", async () => {
    const id = randomUUID();
    const res = await post(
      voiceNoteForm({ id, text: "water the ferns", language: "en-GB", surface: "ios-app" }),
    );
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ id, transcription: "pending" });

    await vi.waitFor(() => expect(noteText(id)).toBe("water the ferns on sunday"));
    expect(languages).toEqual(["en"]);
  });

  test("a note without the device's transcript shows a placeholder first", async () => {
    const id = randomUUID();
    await voiceNotes!.idle();
    voiceNotes!.dispose();
    expect((await post(voiceNoteForm({ id }))).status).toBe(202);
    expect(noteText(id)).toBe(TRANSCRIBING_PLACEHOLDER);
  });

  test("a retried capture is accepted again without a duplicate", async () => {
    const id = randomUUID();
    expect((await post(voiceNoteForm({ id, text: "water the ferns" }))).status).toBe(202);
    expect((await post(voiceNoteForm({ id, text: "water the ferns" }))).status).toBe(202);
    await voiceNotes!.idle();
    expect(notesRuntime!.listDay().filter((entry) => entry.id === id)).toHaveLength(1);
  });

  test("does not exist outside experimental mode, even before auth", async () => {
    delete process.env.OMNESIS_EXPERIMENTAL;
    expect((await post(voiceNoteForm({ id: randomUUID() }))).status).toBe(404);
    const unauthenticated = await app.request("/notes/voice", { method: "POST" });
    expect(unauthenticated.status).toBe(404);
  });

  test("refuses with DICTATION_DISABLED until the operator opts in", async () => {
    optedIn = false;
    const res = await post(voiceNoteForm({ id: randomUUID() }));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("DICTATION_DISABLED");
  });

  test("refuses with TRANSCRIBER_UNAVAILABLE when no transcriber can run", async () => {
    resolved = { role: "transcriber", kind: "disabled" };
    const res = await post(voiceNoteForm({ id: randomUUID() }));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      code: "TRANSCRIBER_UNAVAILABLE",
      error: "No transcriber model is assigned.",
    });
  });

  test("requires the notes write scope", async () => {
    const reader = mintToken([SCOPE_READ]);
    expect((await post(voiceNoteForm({ id: randomUUID() }), reader)).status).toBe(403);
  });

  test("rejects a malformed body with 400", async () => {
    expect((await post("not multipart")).status).toBe(400);
    expect((await post(voiceNoteForm({ id: randomUUID() }, null))).status).toBe(400);
    expect((await post(voiceNoteForm({ id: randomUUID() }, new Uint8Array(0)))).status).toBe(400);
    expect((await post(voiceNoteForm({ id: "not-a-uuid" }))).status).toBe(400);
    expect((await post(voiceNoteForm({ id: randomUUID(), latitude: 51.5 }))).status).toBe(400);
    const badJson = new FormData();
    badJson.set("note", "{");
    badJson.set("audio", new Blob([new Uint8Array(4)]), "note.m4a");
    expect((await post(badJson)).status).toBe(400);
  });

  test("rejects audio over the limit with 413", async () => {
    const res = await post(
      voiceNoteForm({ id: randomUUID() }, new Uint8Array(MAX_AUDIO_BYTES + 1)),
    );
    expect(res.status).toBe(413);
  });
});

describe("GET /status dictation", () => {
  async function statusDictation(): Promise<Record<string, unknown>> {
    const res = await app.request("/status", {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { dictation: Record<string, unknown> }).dictation;
  }

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

describe("languageHint", () => {
  test("keeps the ISO 639 part of a locale tag and drops anything else", () => {
    expect(languageHint("en-GB")).toBe("en");
    expect(languageHint("fr_FR")).toBe("fr");
    expect(languageHint("yue")).toBe("yue");
    expect(languageHint("english")).toBeUndefined();
    expect(languageHint(undefined)).toBeUndefined();
  });
});
