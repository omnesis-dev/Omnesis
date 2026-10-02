// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { SourceId, SCOPE_READ, SCOPE_WRITE_ALL } from "@omnesis/types";
import type { ResolvedAssignment, TranscriptionContext } from "@omnesis/core";
import { createDatabase } from "../../db.js";
import { createServer } from "../../server.js";
import { createDevice } from "../../data/repositories/DeviceRepository.js";
import { createToken } from "../../data/repositories/TokenRepository.js";
import { TranscribeService } from "../transcribe-service.js";
import {
  FrameDecoder,
  type WhisperRequestHeader,
  type WhisperWorkerMessage,
} from "../whisper-worker-protocol.js";
import type { WhisperWorkerProcess } from "../whisper-transcriber.js";
import { TranscriptionVocabularyService } from "./service.js";
import { resolveVocabularySettings } from "./config.js";
import {
  fetchTranscriptionVocabularyBatch,
  applyTranscriptionVocabularyBatch,
  getTranscriptionVocabulary,
} from "./storage.js";
import { extractTranscriptionVocabulary } from "./extract.js";
import type { VoiceNoteService } from "../../voice-notes/service.js";
import type { OmnesisNotesRuntime } from "../../sources/omnesis-notes/index.js";
import type { Db } from "../../data/types.js";

/** Substitute only native inference; framing, selection, routes and note writes stay real. */
class ScriptedWhisperWorker implements WhisperWorkerProcess {
  requests: WhisperRequestHeader[] = [];
  private message?: (value: WhisperWorkerMessage) => void;
  private readonly decoder = new FrameDecoder((value) => {
    const header = value as WhisperRequestHeader;
    this.requests.push(header);
    this.message?.({
      type: "result",
      id: header.id,
      text: "A scripted transcript.",
      language: "en",
      durationSec: 1,
    });
  });
  write(frame: Buffer): void {
    this.decoder.push(frame);
  }
  kill(): void {}
  onExit(): void {}
  onMessage(handler: (value: WhisperWorkerMessage) => void): void {
    this.message = handler;
    queueMicrotask(() => handler({ type: "ready" }));
  }
}

let directory: string;
let db: Db;
let app: ReturnType<typeof createServer>;
let transcriber: TranscribeService;
let worker: ScriptedWhisperWorker;
let voiceNotes: VoiceNoteService | undefined;
let notes: OmnesisNotesRuntime | undefined;
let enabled: boolean;
let readWriteToken: string;
let writeOnlyToken: string;
let priorExperimental: string | undefined;
let lookupFails: boolean;

const context: TranscriptionContext = {
  purpose: "source-audio",
  conversation: { sourceId: SourceId("whatsapp:fictional"), threadId: "fictional-thread" },
};
const audio = new Uint8Array([1, 2, 3]);

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "omnesis-vocabulary-pipeline-"));
  const path = join(directory, "gateway.db");
  db = createDatabase(path);
  enabled = true;
  lookupFails = false;
  priorExperimental = process.env.OMNESIS_EXPERIMENTAL;
  process.env.OMNESIS_EXPERIMENTAL = "1";
  db.prepare(
    `INSERT INTO documents (id,provider_id,source_id,external_id,title,content,content_hash,metadata,
    source_created_at,source_updated_at,ingested_at,updated_at,people_resolved_at)
    VALUES ('vocab-doc','fictional','whatsapp:fictional','fictional-doc','','Quorvex Nimbrax','hash',?,
    '2026-01-01T10:00:00.000Z','2026-01-01T10:00:00.000Z','2026-01-01T10:00:00.000Z','2026-01-01T10:00:00.000Z','2026-01-01T10:00:00.000Z')`,
  ).run(JSON.stringify({ extra: { conversationId: "fictional-thread" } }));
  const getSettings = () =>
    resolveVocabularySettings({ inference: { transcriptionVocabulary: { enabled } } });
  applyTranscriptionVocabularyBatch(
    db,
    extractTranscriptionVocabulary(
      fetchTranscriptionVocabularyBatch(db, getSettings()),
      getSettings(),
    ),
  );
  const vocabulary = new TranscriptionVocabularyService({
    getSettings,
    ioGate: {
      getTranscriptionVocabulary: async (input, settings) => {
        if (lookupFails) throw new Error("test reader unavailable");
        return getTranscriptionVocabulary(db, input, settings);
      },
    },
  });
  worker = new ScriptedWhisperWorker();
  const local: ResolvedAssignment = {
    role: "transcriber",
    kind: "local",
    catalogId: "whisper-small",
    modelPath: "/fictional/whisper.bin",
    available: true,
  };
  transcriber = new TranscribeService({
    resolveAssignment: () => local,
    vocabulary: {
      enabled: () => vocabulary.enabled(),
      getDictionary: (input) => vocabulary.getDictionary(input),
      maxPromptTokens: () => vocabulary.maxPromptTokens(),
    },
    deps: {
      loadModule: async () => ({ Whisper: class {} }),
      spawnWorker: () => worker,
      decodeAudio: async () => new Float32Array(16000),
    },
  });
  const device = createDevice(db, { name: "fictional test collector", kind: "collector" });
  readWriteToken = createToken(db, device.id, [SCOPE_READ, SCOPE_WRITE_ALL]).token;
  writeOnlyToken = createToken(db, device.id, [SCOPE_WRITE_ALL]).token;
  app = createServer(db, path, {
    transcribeService: transcriber,
    transcriptionVocabularyService: vocabulary,
    getDictationStatus: () => ({
      enabled: true,
      visible: true,
      active: true,
      modelAssigned: true,
      maxAudioBytes: 25 * 1024 * 1024,
    }),
    onVoiceNoteService: (service) => {
      voiceNotes = service;
    },
    onOmnesisNotesRuntime: (runtime) => {
      notes = runtime;
    },
  });
});

afterEach(async () => {
  voiceNotes?.dispose();
  await voiceNotes?.idle();
  await notes?.flushAll();
  notes?.dispose();
  await transcriber.dispose();
  db.close();
  rmSync(directory, { recursive: true, force: true });
  if (priorExperimental === undefined) delete process.env.OMNESIS_EXPERIMENTAL;
  else process.env.OMNESIS_EXPERIMENTAL = priorExperimental;
});

function sourceAudio(
  token = readWriteToken,
  rawContext = encodeURIComponent(JSON.stringify(context)),
) {
  return app.request("/inference/transcribe", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "audio/ogg",
      "x-omnesis-transcription-context": rawContext,
    },
    body: audio,
  });
}

async function capture(token: string, id: string): Promise<void> {
  const form = new FormData();
  form.set(
    "note",
    JSON.stringify({ id, text: "Fallback text", surface: "ios-app", language: "en" }),
  );
  form.set("audio", new File([audio], "voice.wav", { type: "audio/wav" }));
  const response = await app.request("/notes/voice", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  expect(response.status).toBe(202);
  await voiceNotes!.idle();
  expect(notes!.listDay().find((note) => note.id === id)?.text).toBe("A scripted transcript.");
}

describe("gateway vocabulary to Whisper pipeline", () => {
  test("source context selects materialized phrases and frames a bounded initial prompt", async () => {
    const response = await sourceAudio();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      available: true,
      text: "A scripted transcript.",
    });
    expect(worker.requests[0].vocabularyHint?.initial_prompt).toContain("Quorvex");
    expect(worker.requests[0].vocabularyHint?.no_context).toBe(true);
    expect(
      Buffer.byteLength(worker.requests[0].vocabularyHint!.initial_prompt),
    ).toBeLessThanOrEqual(224);
  });

  test("Tell Omnesis uses the same selection and adapter, retaining the transcript", async () => {
    await capture(readWriteToken, randomUUID());
    expect(worker.requests[0].vocabularyHint?.initial_prompt).toContain("Nimbrax");
  });

  test("write-only source and capture callers get transcription without private hints", async () => {
    expect((await sourceAudio(writeOnlyToken)).status).toBe(200);
    await capture(writeOnlyToken, randomUUID());
    expect(worker.requests).toHaveLength(2);
    expect(worker.requests.every((request) => request.vocabularyHint === undefined)).toBe(true);
  });

  test("live disable and dictionary read failures preserve ordinary transcription", async () => {
    enabled = false;
    expect((await sourceAudio()).status).toBe(200);
    enabled = true;
    lookupFails = true;
    expect((await sourceAudio()).status).toBe(200);
    expect(worker.requests.every((request) => request.vocabularyHint === undefined)).toBe(true);
  });

  test("malformed, oversized and structurally invalid context is rejected before inference", async () => {
    expect((await sourceAudio(readWriteToken, "%invalid")).status).toBe(400);
    expect((await sourceAudio(readWriteToken, "x".repeat(8193))).status).toBe(400);
    expect(
      (
        await sourceAudio(
          readWriteToken,
          encodeURIComponent(JSON.stringify({ purpose: "unknown" })),
        )
      ).status,
    ).toBe(400);
    expect(worker.requests).toHaveLength(0);
  });
});
