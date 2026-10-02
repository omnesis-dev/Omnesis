// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test, vi } from "vitest";
import { createLogger } from "@omnesis/core";
import { omnesisConfigSchema } from "@omnesis/config";
import { resolveVocabularySettings } from "../../transcribe/vocabulary/config.js";
import { createTranscriptionVocabularyTask } from "./transcription-vocabulary.js";
import type { VocabularyDocument, VocabularySettings } from "../../transcribe/vocabulary/types.js";

const settings: VocabularySettings = {
  enabled: true,
  maxTerms: 64,
  maxPromptTokens: 224,
  batchSize: 4,
  maxDocumentChars: 32768,
  maxTermsPerDocument: 64,
  periodMs: 1000,
  idlePeriodMs: 60000,
};
const doc: VocabularyDocument = {
  id: "fictional-doc",
  contentHash: "hash",
  updatedAt: "2026-01-01",
  revision: 0,
  title: "",
  content: "Quorvex",
  sourceId: "fictional:messages",
  threadId: null,
  recordedAt: "2026-01-01",
  people: [],
};
function deps() {
  return {
    ioGate: { fetchTranscriptionVocabularyBatch: vi.fn(async () => [doc]) },
    cpuGate: { extractTranscriptionVocabulary: vi.fn(async () => []) },
    writeGate: {
      applyTranscriptionVocabularyBatch: vi.fn(async () => ({ applied: 1, skipped: 0 })),
    },
    getSettings: () => settings,
    log: createLogger("test:vocabulary"),
  } satisfies Parameters<typeof createTranscriptionVocabularyTask>[0];
}
// Periodic main orchestration does not consume a task context. Cast only the
// context placeholder so tests exercise the real factory/run body.
async function run(task: ReturnType<typeof createTranscriptionVocabularyTask>) {
  return task.run(undefined, undefined as never);
}
describe("bounded vocabulary scheduler", () => {
  test("omitted opt-in performs no precomputation and live enable resumes the same task", async () => {
    const d = deps();
    let config = omnesisConfigSchema.parse({});
    d.getSettings = () => resolveVocabularySettings(config);
    const task = createTranscriptionVocabularyTask(d);
    expect(await run(task)).toEqual({ kind: "done", value: { idle: true } });
    expect(d.ioGate.fetchTranscriptionVocabularyBatch).not.toHaveBeenCalled();
    expect(d.cpuGate.extractTranscriptionVocabulary).not.toHaveBeenCalled();
    expect(d.writeGate.applyTranscriptionVocabularyBatch).not.toHaveBeenCalled();
    config = omnesisConfigSchema.parse({
      inference: { transcriptionVocabulary: { enabled: true } },
    });
    expect(await run(task)).toEqual({ kind: "done", value: { idle: false } });
    expect(d.ioGate.fetchTranscriptionVocabularyBatch).toHaveBeenCalledTimes(1);
    expect(d.cpuGate.extractTranscriptionVocabulary).toHaveBeenCalledTimes(1);
    expect(d.writeGate.applyTranscriptionVocabularyBatch).toHaveBeenCalledTimes(1);
  });
  test("routes exactly one page IO → CPU → writer and yields to the periodic cadence", async () => {
    const d = deps();
    const task = createTranscriptionVocabularyTask(d);
    expect(task.priority).toBe("background");
    expect(task.runner).toBe("main");
    expect(await run(task)).toEqual({ kind: "done", value: { idle: false } });
    expect(d.ioGate.fetchTranscriptionVocabularyBatch).toHaveBeenCalledTimes(1);
    expect(d.cpuGate.extractTranscriptionVocabulary).toHaveBeenCalledWith([doc], settings);
    expect(d.writeGate.applyTranscriptionVocabularyBatch).toHaveBeenCalledTimes(1);
  });
  test("disabled setting prevents all precomputation", async () => {
    const d = deps();
    d.getSettings = () => ({ ...settings, enabled: false });
    expect(await run(createTranscriptionVocabularyTask(d))).toEqual({
      kind: "done",
      value: { idle: true },
    });
    expect(d.ioGate.fetchTranscriptionVocabularyBatch).not.toHaveBeenCalled();
    expect(d.cpuGate.extractTranscriptionVocabulary).not.toHaveBeenCalled();
    expect(d.writeGate.applyTranscriptionVocabularyBatch).not.toHaveBeenCalled();
  });
  test("disable during IO prevents CPU and writer work", async () => {
    const d = deps();
    let enabled = true;
    d.getSettings = () => ({ ...settings, enabled });
    d.ioGate.fetchTranscriptionVocabularyBatch.mockImplementation(async () => {
      enabled = false;
      return [doc];
    });
    expect(await run(createTranscriptionVocabularyTask(d))).toEqual({
      kind: "done",
      value: { idle: true },
    });
    expect(d.cpuGate.extractTranscriptionVocabulary).not.toHaveBeenCalled();
    expect(d.writeGate.applyTranscriptionVocabularyBatch).not.toHaveBeenCalled();
  });

  test("disable during extraction prevents writer work", async () => {
    const d = deps();
    let enabled = true;
    d.getSettings = () => ({ ...settings, enabled });
    d.cpuGate.extractTranscriptionVocabulary.mockImplementation(async () => {
      enabled = false;
      return [];
    });
    expect(await run(createTranscriptionVocabularyTask(d))).toEqual({
      kind: "done",
      value: { idle: true },
    });
    expect(d.cpuGate.extractTranscriptionVocabulary).toHaveBeenCalledTimes(1);
    expect(d.writeGate.applyTranscriptionVocabularyBatch).not.toHaveBeenCalled();
  });
});
