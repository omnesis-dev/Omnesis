// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * HTTP-level coverage for the recorded-conversation routes: the experimental
 * gate, the operator's transcription setting, the scope guard, multipart and
 * body validation, idempotency, the 404/409 refusals, the size limit, and the
 * whole start → chunks → finish → document → delete path. The synthetic
 * (replay) transcriber echoes each chunk's bytes back as its transcript.
 */

import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { SCOPE_ADMIN, SCOPE_READ, type Scope } from "@omnesis/types";
import { createFreshTestDatabase } from "../../testing/fresh-database.js";
import { getRecordingSession } from "../../recordings/storage.js";
import { createServer } from "../../server.js";
import { setLabFlag } from "../../lab/store.js";
import { createToken } from "../../data/repositories/TokenRepository.js";
import { createDevice } from "../../data/repositories/DeviceRepository.js";
import { TranscribeService } from "../../transcribe/index.js";
import { dictationFeatureStatus } from "../../dictation/index.js";
import { ReplayVoiceSeparator } from "../../recordings/voices/replay-voice-separator.js";
import { backfillOnePerson, findOrCreatePerson } from "../../people.js";
import { ConfigStore, type ConfigChangeListener } from "../../config-store.js";
import { MAX_RECORDING_CHUNK_BYTES } from "./recordings.js";
import type { OmnesisConfig } from "@omnesis/config";
import type { VoiceSeparator } from "../../recordings/voices/voices.js";
import type { RecordingTranscriptionService } from "../../recordings/index.js";
import type Database from "better-sqlite3";

let db: Database.Database;
let dbPath: string;
let app: ReturnType<typeof createServer>;
let ADMIN_TOKEN: string;
let optedIn: boolean | undefined;
let priorExperimental: string | undefined;
let recordings: RecordingTranscriptionService | undefined;
/** The operator's `inference.recordings.keepAudioDays`; undefined leaves it unset. */
let keepAudioDays: number | undefined;
/** The operator's `inference.recordings.selfVoice`; undefined leaves it unset. */
let selfVoice: "off" | "match" | undefined;

const START = "2026-03-02T09:00:00.000Z";
const voices = new ReplayVoiceSeparator();
/** The separator the gateway is given. */
let separator: VoiceSeparator;
/** The gateway's config-change listeners, whether told at once or in turn. */
let configListeners: ConfigChangeListener[];

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
  dbPath = join(tmpdir(), `omnesis-test-${randomUUID()}.db`);
  db = createFreshTestDatabase(dbPath);
  setLabFlag(db, "recordings", true);
  ADMIN_TOKEN = mintToken([SCOPE_ADMIN, SCOPE_READ]);
  optedIn = undefined;
  keepAudioDays = undefined;
  selfVoice = undefined;
  separator = voices;
  configListeners = [];
  app = serve({
    onChange: (listener: ConfigChangeListener) => {
      configListeners.push(listener);
      return () => {};
    },
    onCommit: (listener: ConfigChangeListener) => {
      configListeners.push(listener);
      return () => {};
    },
    get: () =>
      ({
        inference: {
          recordings: {
            ...(keepAudioDays === undefined ? {} : { keepAudioDays }),
            ...(selfVoice === undefined ? {} : { selfVoice }),
          },
        },
      }) as OmnesisConfig,
  } as unknown as ConfigStore);
});

/** A gateway on the test database, reading its settings from `configStore`. */
function serve(configStore: ConfigStore): ReturnType<typeof createServer> {
  const transcribeService = new TranscribeService({
    resolveAssignment: () => ({ role: "transcriber", kind: "replay" }),
    deps: {
      loadModule: async () => {
        throw new Error("Cannot find module 'smart-whisper'");
      },
    },
  });
  return createServer(db, dbPath, {
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
    voiceSeparator: () => separator,
    configStore,
  });
}

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

  test("a wearable's automatic episode is opened as ambient; anything else is refused", async () => {
    const id = randomUUID();
    expect((await startRecording(id, { origin: "ambient" })).status).toBe(201);
    expect(getRecordingSession(db, id)?.origin).toBe("ambient");
    expect((await startRecording(randomUUID(), { origin: "always" })).status).toBe(400);
  });

  test("a session's speakers are listed, named, and their names written into the document", async () => {
    const id = randomUUID();
    await startRecording(id);
    const script = JSON.stringify({
      segments: [
        { startMs: 0, endMs: 3_000, text: "Is the venue booked?", voice: "jamie" },
        { startMs: 4_000, endMs: 6_000, text: "Booked for Friday.", voice: "owner" },
      ],
    });
    await request("PUT", `/recordings/${id}/chunks/0`, chunkForm(0, script));
    await request("POST", `/recordings/${id}/finish`, {
      chunkCount: 1,
      endedAt: "2026-03-02T09:01:00.000Z",
    });
    await vi.waitFor(async () => {
      expect(await (await request("GET", `/recordings/${id}`)).json()).toMatchObject({
        state: "done",
      });
    });
    expect(documentContent(id)).toContain("[00:00:00] Speaker 1: Is the venue booked?");

    const listed = await (await request("GET", "/recordings?limit=5")).json();
    expect(listed).toEqual({
      recordings: [expect.objectContaining({ id, speakers: 2, namedSpeakers: 0 })],
    });
    const speakers = await (await request("GET", `/recordings/${id}/speakers`)).json();
    expect(speakers).toEqual({
      speakers: [
        expect.objectContaining({ speaker: 1, samples: ["Is the venue booked?"], personId: null }),
        expect.objectContaining({ speaker: 2, samples: ["Booked for Friday."], isSelf: false }),
      ],
      participants: [],
    });

    const jamie = findOrCreatePerson(
      db,
      { role: "sender", name: "Jamie", emails: ["jamie@example.com"] },
      "gmail:test",
      "2026-01-01",
    )!;
    const named = await request("PUT", `/recordings/${id}/speakers/1`, { personId: jamie });
    expect(named.status).toBe(200);
    expect(await named.json()).toMatchObject({
      speakers: [
        expect.objectContaining({ speaker: 1, personId: jamie, name: "Jamie" }),
        expect.objectContaining({ speaker: 2 }),
      ],
    });
    expect((await request("PUT", `/recordings/${id}/speakers/2`, { self: true })).status).toBe(200);
    await vi.waitFor(() => {
      expect(documentContent(id)).toContain("[00:00:00] Jamie: Is the venue booked?");
      expect(documentContent(id)).toContain("[00:00:04] You: Booked for Friday.");
    });
    // People are resolved by the background backfill; run it to the end.
    while (backfillOnePerson(db) !== null) {
      /* next document */
    }
    const linked = db
      .prepare(
        `SELECT dp.person_id FROM document_people dp JOIN documents d ON d.id = dp.document_id
          WHERE d.external_id = ? AND dp.person_id = ?`,
      )
      .all(id, jamie);
    expect(linked).toHaveLength(1);

    expect((await request("PUT", `/recordings/${id}/speakers/9`, { self: true })).status).toBe(404);
    expect((await request("PUT", `/recordings/${id}/speakers/0`, { self: true })).status).toBe(404);
    expect(
      (await request("PUT", `/recordings/${id}/speakers/1`, { personId: "nobody" })).status,
    ).toBe(400);
    expect(
      (await request("PUT", `/recordings/${id}/speakers/1`, { self: true, name: "x" })).status,
    ).toBe(400);
    expect((await request("GET", `/recordings/${randomUUID()}/speakers`)).status).toBe(404);
  });

  test("people present without a turn are added, written into the document and removed", async () => {
    const id = randomUUID();
    await startRecording(id);
    await request("PUT", `/recordings/${id}/chunks/0`, chunkForm(0, "We open on Monday."));
    await request("POST", `/recordings/${id}/finish`, {
      chunkCount: 1,
      endedAt: "2026-03-02T09:01:00.000Z",
    });
    await vi.waitFor(async () => {
      expect(await (await request("GET", `/recordings/${id}`)).json()).toMatchObject({
        state: "done",
      });
    });
    const david = findOrCreatePerson(
      db,
      { role: "sender", name: "David Lin", emails: ["david@example.com"] },
      "gmail:test",
      "2026-01-01",
    )!;

    const added = await request("POST", `/recordings/${id}/participants`, { personId: david });
    expect(added.status).toBe(200);
    expect(await added.json()).toEqual({
      participants: [{ key: `person:${david}`, personId: david, name: "David Lin" }],
    });
    expect(
      (await request("POST", `/recordings/${id}/participants`, { name: " Sarah Mendez " })).status,
    ).toBe(200);
    await vi.waitFor(() => {
      expect(documentContent(id)).toContain("Also present: David Lin, Sarah Mendez");
    });
    while (backfillOnePerson(db) !== null) {
      /* next document */
    }
    const linked = () =>
      db
        .prepare(
          `SELECT dp.role FROM document_people dp JOIN documents d ON d.id = dp.document_id
            WHERE d.external_id = ? AND dp.person_id = ?`,
        )
        .all(id, david);
    expect(linked()).toEqual([{ role: "participant" }]);
    expect(await (await request("GET", `/recordings/${id}/speakers`)).json()).toMatchObject({
      participants: [
        { key: `person:${david}` },
        { key: "name:sarah mendez", personId: null, name: "Sarah Mendez" },
      ],
    });

    const removed = await request(
      "DELETE",
      `/recordings/${id}/participants/${encodeURIComponent(`person:${david}`)}`,
    );
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({
      participants: [{ key: "name:sarah mendez", personId: null, name: "Sarah Mendez" }],
    });
    await vi.waitFor(() => {
      expect(documentContent(id)).toContain("Also present: Sarah Mendez");
    });
    while (backfillOnePerson(db) !== null) {
      /* next document */
    }
    expect(linked()).toEqual([]);

    // A key carries the name as given, slashes and all.
    expect(
      (await request("POST", `/recordings/${id}/participants`, { name: "Ops/Infra team" })).status,
    ).toBe(200);
    const slashed = await request(
      "DELETE",
      `/recordings/${id}/participants/${encodeURIComponent("name:ops/infra team")}`,
    );
    expect(slashed.status).toBe(200);
    expect(await slashed.json()).toEqual({
      participants: [{ key: "name:sarah mendez", personId: null, name: "Sarah Mendez" }],
    });

    // Refusals.
    expect(
      (await request("POST", `/recordings/${id}/participants`, { personId: "nobody" })).status,
    ).toBe(400);
    expect(
      (await request("POST", `/recordings/${id}/participants`, { personId: david, name: "x" }))
        .status,
    ).toBe(400);
    expect((await request("POST", `/recordings/${id}/participants`, { name: "  " })).status).toBe(
      400,
    );
    expect(
      (await request("POST", `/recordings/${randomUUID()}/participants`, { name: "Maya" })).status,
    ).toBe(404);
    expect(
      (await request("DELETE", `/recordings/${id}/participants/${encodeURIComponent("person:x")}`))
        .status,
    ).toBe(404);
    expect((await request("DELETE", `/recordings/${id}/participants/other`)).status).toBe(404);
    const readOnly = mintToken([SCOPE_READ]);
    expect(
      (await request("POST", `/recordings/${id}/participants`, { name: "Maya" }, readOnly)).status,
    ).toBe(403);
  });

  test("the owner's voice is enrolled, recognised in a recording, undone and deleted", async () => {
    const clip = (seconds: number, voice = "owner") => {
      const form = new FormData();
      const segments = Array.from({ length: Math.ceil(seconds / 8) }, (_, i) => ({
        startMs: i * 8_000,
        endMs: Math.min((i + 1) * 8_000, seconds * 1000),
        text: "",
        voice,
      }));
      form.set(
        "audio",
        new Blob([new TextEncoder().encode(JSON.stringify({ segments }))], { type: "audio/webm" }),
        "voice.webm",
      );
      return form;
    };
    const codeOf = async (res: Response) => ((await res.json()) as { code: string }).code;

    expect(await (await request("GET", "/recordings/self-voice")).json()).toEqual({
      setting: "off",
      ready: true,
      minSpeechMs: 20_000,
      profile: null,
    });
    const off = await request("PUT", "/recordings/self-voice", clip(24));
    expect(off.status).toBe(409);
    expect(await codeOf(off)).toBe("SELF_VOICE_OFF");

    selfVoice = "match";
    const short = await request("PUT", "/recordings/self-voice", clip(10));
    expect(short.status).toBe(422);
    expect(await codeOf(short)).toBe("SELF_VOICE_TOO_SHORT");
    expect((await request("PUT", "/recordings/self-voice", new FormData())).status).toBe(400);
    const enrolled = await request("PUT", "/recordings/self-voice", clip(24));
    expect(enrolled.status).toBe(200);
    expect(await enrolled.json()).toMatchObject({
      setting: "match",
      profile: { speechMs: 24_000, current: true },
    });

    const id = randomUUID();
    await startRecording(id);
    const script = JSON.stringify({
      segments: [
        { startMs: 0, endMs: 3_000, text: "Is the venue booked?", voice: "jamie" },
        { startMs: 4_000, endMs: 6_000, text: "Booked for Friday.", voice: "owner" },
      ],
    });
    await request("PUT", `/recordings/${id}/chunks/0`, chunkForm(0, script));
    await request("POST", `/recordings/${id}/finish`, {
      chunkCount: 1,
      endedAt: "2026-03-02T09:01:00.000Z",
    });
    await vi.waitFor(async () => {
      expect(await (await request("GET", `/recordings/${id}`)).json()).toMatchObject({
        state: "done",
      });
    });
    expect(documentContent(id)).toContain("[00:00:04] You: Booked for Friday.");
    expect((await (await request("GET", `/recordings/${id}/speakers`)).json()).speakers).toEqual([
      expect.objectContaining({ speaker: 1, isSelf: false, selfMatched: false }),
      expect.objectContaining({ speaker: 2, isSelf: true, selfMatched: true }),
    ]);

    const cleared = await request("PUT", `/recordings/${id}/speakers/2`, { clear: true });
    expect((await cleared.json()).speakers[1]).toMatchObject({ isSelf: false, selfMatched: false });
    await vi.waitFor(() => {
      expect(documentContent(id)).toContain("[00:00:04] Speaker 2: Booked for Friday.");
    });

    expect((await request("DELETE", "/recordings/self-voice")).status).toBe(204);
    expect((await (await request("GET", "/recordings/self-voice")).json()).profile).toBeNull();
    const readOnly = mintToken([SCOPE_READ]);
    expect((await request("GET", "/recordings/self-voice", undefined, readOnly)).status).toBe(403);
    expect((await request("PUT", "/recordings/self-voice", clip(24), readOnly)).status).toBe(403);
  });

  test("an enrolment still being read when the voice is deleted or switched off stores nothing", async () => {
    const clip = () => {
      const form = new FormData();
      const segments = [0, 1, 2].map((i) => ({
        startMs: i * 8_000,
        endMs: (i + 1) * 8_000,
        text: "",
        voice: "owner",
      }));
      form.set(
        "audio",
        new Blob([new TextEncoder().encode(JSON.stringify({ segments }))], { type: "audio/webm" }),
        "voice.webm",
      );
      return form;
    };
    const waiting: (() => void)[] = [];
    separator = {
      name: voices.name,
      model: voices.model,
      separate: async (audio) => {
        await new Promise<void>((resolve) => waiting.push(resolve));
        return voices.separate(audio);
      },
      group: (vectors, durations) => voices.group(vectors, durations),
      dispose: async () => {},
    };
    const profile = async () =>
      (await (await request("GET", "/recordings/self-voice")).json()).profile;
    const refusal = async (res: Response) => [
      res.status,
      ((await res.json()) as { code: string }).code,
    ];
    selfVoice = "match";

    const deleted = request("PUT", "/recordings/self-voice", clip());
    await vi.waitFor(() => expect(waiting).toHaveLength(1));
    expect((await request("DELETE", "/recordings/self-voice")).status).toBe(204);
    waiting[0]!();
    expect(await refusal(await deleted)).toEqual([409, "SELF_VOICE_SUPERSEDED"]);
    expect(await profile()).toBeNull();

    // Switched off and on again by the operator while the clip is read.
    const switched = request("PUT", "/recordings/self-voice", clip());
    await vi.waitFor(() => expect(waiting).toHaveLength(2));
    const change = async (to: "off" | "match") => {
      const before = { inference: { recordings: { selfVoice } } } as OmnesisConfig;
      selfVoice = to;
      const after = { inference: { recordings: { selfVoice } } } as OmnesisConfig;
      for (const listener of configListeners) await listener(before, after, []);
    };
    await change("off");
    await change("match");
    waiting[1]!();
    expect(await refusal(await switched)).toEqual([409, "SELF_VOICE_SUPERSEDED"]);
    expect(await profile()).toBeNull();

    // Enrolling after both works.
    const enrolled = request("PUT", "/recordings/self-voice", clip());
    await vi.waitFor(() => expect(waiting).toHaveLength(3));
    waiting[2]!();
    expect((await enrolled).status).toBe(200);
    expect(await profile()).toMatchObject({ speechMs: 24_000 });
  });

  test("switched off and on again before the change is heard, an enrolment under way stores nothing", async () => {
    // The real config store, already matching, with a listener ahead of the
    // gateway's that is slow to finish: every change waits on it in turn.
    const dir = mkdtempSync(join(tmpdir(), "omnesis-test-"));
    const filePath = join(dir, "omnesis.json");
    writeFileSync(filePath, JSON.stringify({ inference: { recordings: { selfVoice: "match" } } }));
    const store = new ConfigStore({ filePath, watchDebounceMs: 60_000 });
    try {
      await store.load();
      let release!: () => void;
      const slow = new Promise<void>((resolve) => (release = resolve));
      store.onChange(() => slow);
      recordings?.dispose();
      await recordings?.idle();
      app = serve(store);
      let heard = 0;
      store.onChange(() => {
        heard++;
      });
      const waiting: (() => void)[] = [];
      separator = {
        name: voices.name,
        model: voices.model,
        separate: async (audio) => {
          await new Promise<void>((resolve) => waiting.push(resolve));
          return voices.separate(audio);
        },
        group: (vectors, durations) => voices.group(vectors, durations),
        dispose: async () => {},
      };
      const clip = () => {
        const segments = [0, 1, 2].map((i) => ({
          startMs: i * 8_000,
          endMs: (i + 1) * 8_000,
          text: "",
          voice: "owner",
        }));
        const form = new FormData();
        form.set(
          "audio",
          new Blob([new TextEncoder().encode(JSON.stringify({ segments }))], {
            type: "audio/webm",
          }),
          "voice.webm",
        );
        return form;
      };
      const profile = async () =>
        (await (await request("GET", "/recordings/self-voice")).json()).profile;

      const enrolment = request("PUT", "/recordings/self-voice", clip());
      await vi.waitFor(() => expect(waiting).toHaveLength(1));
      expect((await store.patch({ inference: { recordings: { selfVoice: "off" } } })).ok).toBe(
        true,
      );
      expect((await store.patch({ inference: { recordings: { selfVoice: "match" } } })).ok).toBe(
        true,
      );
      // Every listener hears both changes only now, with the setting on again.
      release();
      await vi.waitFor(() => expect(heard).toBe(2));
      waiting[0]!();
      const res = await enrolment;
      expect([res.status, ((await res.json()) as { code?: string }).code]).toEqual([
        409,
        "SELF_VOICE_SUPERSEDED",
      ]);
      expect(await profile()).toBeNull();

      // Enrolling afresh works.
      const fresh = request("PUT", "/recordings/self-voice", clip());
      await vi.waitFor(() => expect(waiting).toHaveLength(2));
      waiting[1]!();
      expect((await fresh).status).toBe(200);
      expect(await profile()).toMatchObject({ speechMs: 24_000 });
    } finally {
      store.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a session's chunks are listed, and audio kept by the operator is served as audio only", async () => {
    keepAudioDays = 3;
    const id = randomUUID();
    await startRecording(id);
    await request("PUT", `/recordings/${id}/chunks/0`, chunkForm(0, "We open on Monday."));
    await request("PUT", `/recordings/${id}/chunks/1`, chunkForm(1, null));
    // A device that labels its upload as a page gets it back as bytes.
    const page = chunkForm(2, "<script>alert(1)</script>");
    page.set("audio", new Blob(["<script>alert(1)</script>"], { type: "text/html" }), "c.html");
    await request("PUT", `/recordings/${id}/chunks/2`, page);
    await recordings?.idle();

    const listed = await request("GET", `/recordings/${id}/chunks`);
    expect(listed.headers.get("cache-control")).toBe("no-store");
    const { recording, chunks } = (await listed.json()) as {
      recording: Record<string, unknown>;
      chunks: Record<string, unknown>[];
    };
    expect(recording).toMatchObject({
      id,
      state: "recording",
      durationMs: 180_000,
      chunks: { received: 3, transcribed: 2, silent: 1 },
    });
    expect(chunks.map((c) => [c.seq, c.status, c.audio])).toEqual([
      [0, "transcribed", true],
      [1, "silent", false],
      [2, "transcribed", true],
    ]);
    expect(typeof chunks[0]!.audioDeletedAt).toBe("string");

    const audio = await request("GET", `/recordings/${id}/chunks/0/audio`);
    expect(audio.status).toBe(200);
    expect(audio.headers.get("content-type")).toBe("audio/aac");
    expect(audio.headers.get("content-security-policy")).toBe("sandbox");
    expect(audio.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(new TextDecoder().decode(await audio.arrayBuffer())).toBe("We open on Monday.");

    const html = await request("GET", `/recordings/${id}/chunks/2/audio`);
    expect(html.headers.get("content-type")).toBe("application/octet-stream");

    expect((await request("GET", `/recordings/${id}/chunks/1/audio`)).status).toBe(404);
    expect((await request("GET", `/recordings/${id}/chunks/9/audio`)).status).toBe(404);
    expect((await request("GET", `/recordings/${id}/chunks/x/audio`)).status).toBe(404);
    expect((await request("GET", `/recordings/${randomUUID()}/chunks`)).status).toBe(404);
  });

  test("without a retention the audio is gone once transcribed", async () => {
    const id = randomUUID();
    await startRecording(id);
    await request("PUT", `/recordings/${id}/chunks/0`, chunkForm(0, "We open on Monday."));
    await recordings?.idle();
    const { chunks } = (await (await request("GET", `/recordings/${id}/chunks`)).json()) as {
      chunks: Record<string, unknown>[];
    };
    expect(chunks[0]).toMatchObject({ status: "transcribed", audio: false, audioDeletedAt: null });
    expect((await request("GET", `/recordings/${id}/chunks/0/audio`)).status).toBe(404);
  });

  test("suggests from the calendar and the transcript; the owner accepts or dismisses", async () => {
    // A meeting on the owner's calendar across the recording, with one invitee.
    const priya = findOrCreatePerson(
      db,
      { role: "attendee", name: "Priya", emails: ["priya@example.com"] },
      "google-calendar",
      "2026-01-01",
    )!;
    db.prepare(
      `INSERT INTO documents (id, provider_id, source_id, external_id, title, content, content_hash, metadata, source_created_at, source_updated_at, ingested_at, updated_at)
       VALUES ('doc-sync', 'google', 'google-calendar', 'cal:sync', 'Weekly sync', 'body', 'hash-sync', '{"documentType":"event"}', '2026-03-01', '2026-03-01', '2026-03-01', '2026-03-01')`,
    ).run();
    db.prepare(
      `INSERT INTO document_people (document_id, person_id, role) VALUES ('doc-sync', ?, 'attendee')`,
    ).run(priya);
    db.prepare(
      `INSERT INTO document_temporal_projections
         (id, source_id, document_id, document_external_id, slot, start_ms, end_exclusive_ms,
          start_canonical, end_canonical, precision, all_day, time_zone, label, kind, modality,
          status, projected_at)
       VALUES ('tp_sync', 'google-calendar', 'doc-sync', 'cal:sync', 'calendar', ?, ?,
               '2026-03-02T08:55:00.000Z', '2026-03-02T09:30:00.000Z', 'instant', 0, 'UTC',
               'Weekly sync', 'appointment', 'scheduled', 'active', '2026-03-01')`,
    ).run(Date.parse("2026-03-02T08:55:00.000Z"), Date.parse("2026-03-02T09:30:00.000Z"));
    db.prepare(
      `INSERT INTO document_temporal_projection_sources (source_id, slots_json, last_sync_at)
       VALUES ('google-calendar', '["calendar"]', '2026-03-01')`,
    ).run();

    const id = randomUUID();
    await startRecording(id);
    const script = JSON.stringify({
      segments: [
        { startMs: 0, endMs: 3_000, text: "Thanks, Alex.", voice: "owner" },
        { startMs: 4_000, endMs: 6_000, text: "Happy to help.", voice: "alex" },
      ],
    });
    await request("PUT", `/recordings/${id}/chunks/0`, chunkForm(0, script));
    await request("POST", `/recordings/${id}/finish`, {
      chunkCount: 1,
      endedAt: "2026-03-02T09:01:00.000Z",
    });
    await vi.waitFor(async () => {
      expect(await (await request("GET", `/recordings/${id}`)).json()).toMatchObject({
        state: "done",
      });
    });

    const res = await request("GET", `/recordings/${id}/suggestions`);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      suggestions: [
        {
          key: "title:doc-sync",
          kind: "title",
          source: "calendar",
          title: "Weekly sync",
          documentId: "doc-sync",
        },
        {
          key: "mention:2:alex",
          kind: "person",
          source: "mention",
          speaker: 2,
          personId: null,
          name: "Alex",
          evidence: "Thanks, Alex.",
        },
        {
          key: `person:${priya}`,
          kind: "person",
          source: "calendar",
          speaker: null,
          personId: priya,
          name: "Priya",
          evidence: "Weekly sync",
        },
      ],
    });

    // Accept the title, dismiss the rest: nothing is left to offer.
    const titled = await request("PUT", `/recordings/${id}/title`, { title: "Weekly sync" });
    expect(await titled.json()).toMatchObject({ id, title: "Weekly sync" });
    for (const key of ["mention:2:alex", `person:${priya}`]) {
      expect((await request("POST", `/recordings/${id}/suggestions/dismiss`, { key })).status).toBe(
        204,
      );
    }
    expect(await (await request("GET", `/recordings/${id}/suggestions`)).json()).toEqual({
      suggestions: [],
    });
    await vi.waitFor(() => expect(documentContent(id)).toContain("# Weekly sync"));

    expect((await request("PUT", `/recordings/${id}/title`, { title: 7 })).status).toBe(400);
    expect((await request("POST", `/recordings/${id}/suggestions/dismiss`, {})).status).toBe(400);
    const missing = randomUUID();
    expect((await request("GET", `/recordings/${missing}/suggestions`)).status).toBe(404);
    expect((await request("PUT", `/recordings/${missing}/title`, { title: "x" })).status).toBe(404);
    expect(
      (await request("POST", `/recordings/${missing}/suggestions/dismiss`, { key: "x" })).status,
    ).toBe(404);
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

  test("is advertised, and served, only while the recordings opt-in is on", async () => {
    const health = await (await app.request("/health")).json();
    expect(health.capabilities.recordings).toEqual({ min: 1, max: 1 });

    setLabFlag(db, "recordings", false);
    expect((await startRecording()).status).toBe(404);
    const off = await (await app.request("/health")).json();
    expect(off.capabilities.recordings).toBeUndefined();
    setLabFlag(db, "recordings", true);
    expect((await startRecording()).status).toBe(201);
  });

  test("is advertised, and served, only in experimental mode", async () => {
    const health = await (await app.request("/health")).json();
    expect(health.capabilities.recordings).toEqual({ min: 1, max: 1 });

    delete process.env.OMNESIS_EXPERIMENTAL;
    expect((await startRecording()).status).toBe(404);
    expect((await request("GET", `/recordings/${randomUUID()}`)).status).toBe(404);
    expect((await request("GET", "/recordings/self-voice")).status).toBe(404);
    const stable = await (await app.request("/health")).json();
    expect(stable.capabilities.recordings).toBeUndefined();
  });
});
