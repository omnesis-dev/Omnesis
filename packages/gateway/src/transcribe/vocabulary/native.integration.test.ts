// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Opt-in local proof of gateway vocabulary with actual Whisper inference.
 * Supply OMNESIS_WHISPER_TEST_MODEL and OMNESIS_WHISPER_TEST_AUDIO pointing to
 * a downloaded model and an invented synthetic recording outside the repo.
 * No native model is mocked, no production gateway is used, and assertions
 * establish working transcription rather than a vocabulary accuracy gain.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { SourceId, SCOPE_READ, SCOPE_WRITE_ALL } from "@omnesis/types";
import type { ResolvedAssignment, TranscriptionContext } from "@omnesis/core";
import { omnesisConfigSchema } from "@omnesis/config";
import { createDatabase } from "../../db.js";
import { createServer } from "../../server.js";
import { createDevice } from "../../data/repositories/DeviceRepository.js";
import { createToken } from "../../data/repositories/TokenRepository.js";
import { TranscribeService } from "../transcribe-service.js";
import { defaultWhisperSpawner } from "../whisper-transcriber.js";
import { FrameDecoder, type WhisperRequestHeader } from "../whisper-worker-protocol.js";
import { decodeToPcm16kMono } from "../audio-decode.js";
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

const model = process.env.OMNESIS_WHISPER_TEST_MODEL;
const audioPath = process.env.OMNESIS_WHISPER_TEST_AUDIO;
const ffmpegPath = process.env.OMNESIS_WHISPER_TEST_FFMPEG;

test.skipIf(!model || !audioPath)(
  "real Whisper handles source voice notes, Tell Omnesis and live vocabulary disable",
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "omnesis-vocabulary-native-"));
    const path = join(directory, "gateway.db");
    const db = createDatabase(path);
    const priorExperimental = process.env.OMNESIS_EXPERIMENTAL;
    process.env.OMNESIS_EXPERIMENTAL = "1";
    let voiceNotes: VoiceNoteService | undefined;
    let notes: OmnesisNotesRuntime | undefined;
    let enabled = true;
    const contexts: TranscriptionContext[] = [];
    const requests: WhisperRequestHeader[] = [];
    const getSettings = () =>
      resolveVocabularySettings(
        omnesisConfigSchema.parse({ inference: { transcriptionVocabulary: { enabled } } }),
      );
    const context: TranscriptionContext = {
      purpose: "source-audio",
      conversation: { sourceId: SourceId("whatsapp:fictional"), threadId: "fictional-thread" },
    };
    const vocabulary = new TranscriptionVocabularyService({
      getSettings,
      ioGate: {
        getTranscriptionVocabulary: async (input, settings) =>
          getTranscriptionVocabulary(db, input, settings),
      },
    });
    const assignment: ResolvedAssignment = {
      role: "transcriber",
      kind: "local",
      catalogId: "whisper-native-test",
      modelPath: model!,
      available: true,
    };
    const transcriber = new TranscribeService({
      resolveAssignment: () => assignment,
      vocabulary: {
        enabled: () => vocabulary.enabled(),
        getDictionary: (input) => {
          contexts.push(input);
          return vocabulary.getDictionary(input);
        },
        maxPromptTokens: () => vocabulary.maxPromptTokens(),
      },
      deps: {
        // Recording wrapper forwards every frame to the actual isolated worker.
        spawnWorker: (args) => {
          const worker = defaultWhisperSpawner({ ...args, gpu: false });
          const decoder = new FrameDecoder((header) =>
            requests.push(header as WhisperRequestHeader),
          );
          return {
            write: (frame) => {
              decoder.push(frame);
              worker.write(frame);
            },
            kill: () => worker.kill(),
            onExit: (handler) => worker.onExit(handler),
            onMessage: (handler) => worker.onMessage(handler),
          };
        },
        ...(ffmpegPath
          ? { decodeAudio: (bytes: Uint8Array) => decodeToPcm16kMono(bytes, { ffmpegPath }) }
          : {}),
      },
    });
    try {
      db.prepare(
        `INSERT INTO documents (id,provider_id,source_id,external_id,title,content,content_hash,metadata,
      source_created_at,source_updated_at,ingested_at,updated_at,people_resolved_at)
      VALUES ('native-vocab','fictional','whatsapp:fictional','native-vocab','','Northstar Quorvex','hash',?,
      '2026-01-01T10:00:00.000Z','2026-01-01T10:00:00.000Z','2026-01-01T10:00:00.000Z','2026-01-01T10:00:00.000Z','2026-01-01T10:00:00.000Z')`,
      ).run(JSON.stringify({ extra: { conversationId: "fictional-thread" } }));
      const docs = fetchTranscriptionVocabularyBatch(db, getSettings());
      expect(
        applyTranscriptionVocabularyBatch(db, extractTranscriptionVocabulary(docs, getSettings()))
          .applied,
      ).toBe(1);
      expect(
        (await vocabulary.getDictionary(context)).entries.some((entry) =>
          entry.text.includes("Quorvex"),
        ),
      ).toBe(true);
      const device = createDevice(db, { name: "fictional native collector", kind: "collector" });
      const token = createToken(db, device.id, [SCOPE_READ, SCOPE_WRITE_ALL]).token;
      const app = createServer(db, path, {
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
      const audio = new Uint8Array(readFileSync(audioPath!));
      const sourceAudio = () =>
        app.request("/inference/transcribe", {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "audio/wav",
            "x-omnesis-transcription-context": encodeURIComponent(JSON.stringify(context)),
          },
          body: audio,
        });
      const first = await sourceAudio();
      expect(first.status).toBe(200);
      const firstResult = (await first.json()) as { available: boolean; text: string };
      expect(firstResult.available).toBe(true);
      expect(firstResult.text.length).toBeGreaterThan(10);
      expect(requests[0]?.vocabularyHint?.initial_prompt).toContain("Quorvex");
      const id = randomUUID();
      const form = new FormData();
      form.set(
        "note",
        JSON.stringify({
          id,
          text: "Synthetic recording fallback",
          surface: "ios-app",
          language: "en",
        }),
      );
      form.set("audio", new File([audio], "synthetic.wav", { type: "audio/wav" }));
      expect(
        (
          await app.request("/notes/voice", {
            method: "POST",
            headers: { authorization: `Bearer ${token}` },
            body: form,
          })
        ).status,
      ).toBe(202);
      await voiceNotes!.idle();
      const saved = notes!.listDay().find((note) => note.id === id)?.text;
      expect(saved?.length).toBeGreaterThan(10);
      expect(saved).not.toBe("Synthetic recording fallback");
      expect(requests[1]?.vocabularyHint?.initial_prompt).toContain("Quorvex");
      expect(contexts.map((input) => input.purpose)).toEqual(["source-audio", "dictation"]);
      enabled = false;
      const disabled = await sourceAudio();
      expect(disabled.status).toBe(200);
      const disabledResult = (await disabled.json()) as { available: boolean; text: string };
      expect(disabledResult.available).toBe(true);
      expect(disabledResult.text.length).toBeGreaterThan(10);
      expect(requests).toHaveLength(3);
      expect(requests[2].vocabularyHint).toBeUndefined();
      expect(contexts).toHaveLength(2);
    } finally {
      voiceNotes?.dispose();
      await voiceNotes?.idle();
      await notes?.flushAll();
      notes?.dispose();
      await transcriber.dispose();
      db.close();
      rmSync(directory, { recursive: true, force: true });
      if (priorExperimental === undefined) delete process.env.OMNESIS_EXPERIMENTAL;
      else process.env.OMNESIS_EXPERIMENTAL = priorExperimental;
    }
  },
  180_000,
);
