// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, describe, expect, test, vi } from "vitest";
import { createLogger } from "@omnesis/core";
import { omnesisConfigSchema } from "@omnesis/config";
import { resolveVocabularySettings } from "../../transcribe/vocabulary/config.js";
import { EventBus, type DocumentUpsertedEvent } from "../../events.js";
import { Scheduler } from "../scheduler.js";
import {
  createTranscriptionVocabularyTask,
  scheduleTranscriptionVocabulary,
} from "./transcription-vocabulary.js";
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
  generation: 1,
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
      advanceTranscriptionVocabularyRebuild: vi.fn(async () => ({ ready: true, worked: false })),
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
    expect(d.writeGate.advanceTranscriptionVocabularyRebuild).not.toHaveBeenCalled();
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
    expect(d.writeGate.advanceTranscriptionVocabularyRebuild).not.toHaveBeenCalled();
    expect(d.ioGate.fetchTranscriptionVocabularyBatch).not.toHaveBeenCalled();
    expect(d.cpuGate.extractTranscriptionVocabulary).not.toHaveBeenCalled();
    expect(d.writeGate.applyTranscriptionVocabularyBatch).not.toHaveBeenCalled();
  });
  test("reset is bounded to one writer call and holds extraction closed", async () => {
    const d = deps();
    d.writeGate.advanceTranscriptionVocabularyRebuild.mockResolvedValue({
      ready: false,
      worked: true,
    });
    expect(await run(createTranscriptionVocabularyTask(d))).toEqual({
      kind: "done",
      value: { idle: false },
    });
    expect(d.writeGate.advanceTranscriptionVocabularyRebuild).toHaveBeenCalledTimes(1);
    expect(d.ioGate.fetchTranscriptionVocabularyBatch).not.toHaveBeenCalled();
  });
  test("disable while resetting prevents subsequent IO", async () => {
    const d = deps();
    let enabled = true;
    d.getSettings = () => ({ ...settings, enabled });
    d.writeGate.advanceTranscriptionVocabularyRebuild.mockImplementation(async () => {
      enabled = false;
      return { ready: true, worked: true };
    });
    expect(await run(createTranscriptionVocabularyTask(d))).toEqual({
      kind: "done",
      value: { idle: true },
    });
    expect(d.ioGate.fetchTranscriptionVocabularyBatch).not.toHaveBeenCalled();
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
    d.cpuGate.extractTranscriptionVocabulary.mockImplementation(() => {
      enabled = false;
      return Promise.resolve([]);
    });
    expect(await run(createTranscriptionVocabularyTask(d))).toEqual({
      kind: "done",
      value: { idle: true },
    });
    expect(d.cpuGate.extractTranscriptionVocabulary).toHaveBeenCalledTimes(1);
    expect(d.writeGate.applyTranscriptionVocabularyBatch).not.toHaveBeenCalled();
  });
});

describe("scheduleTranscriptionVocabulary", () => {
  const upsert = {} as DocumentUpsertedEvent;
  afterEach(() => vi.restoreAllMocks());

  function noLivePeriodicWarnings(warn: ReturnType<typeof vi.spyOn>): unknown[][] {
    return warn.mock.calls.filter((call: unknown[]) =>
      String(call[0]).includes("no live periodic"),
    );
  }

  test("documents arriving before registration never kick a periodic that does not exist yet", async () => {
    // The HTTP server accepts documents while boot is still registering
    // periodics. A wake wired independently of registration kicks a name the
    // scheduler does not know and warns once per ingest batch.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const scheduler = new Scheduler({ enablePreemption: false });
    const bus = new EventBus();
    const task = createTranscriptionVocabularyTask(deps());

    scheduler.kickPeriodic(task.name);
    expect(noLivePeriodicWarnings(warn)).toHaveLength(1);
    warn.mockClear();

    bus.emit("document.upserted", upsert);
    const handle = scheduleTranscriptionVocabulary({
      scheduler,
      eventBus: bus,
      task,
      enabled: () => true,
    });
    bus.emit("document.upserted", upsert);
    expect(noLivePeriodicWarnings(warn)).toEqual([]);

    handle.stop();
    await scheduler.dispose();
  });

  test("an arrival kicks the registered periodic only while the feature is enabled", () => {
    const bus = new EventBus();
    const order: string[] = [];
    const scheduler = {
      schedule: vi.fn(() => {
        order.push("schedule");
        return { stop: vi.fn() };
      }),
      kickPeriodic: vi.fn((name: string) => order.push(`kick:${name}`)),
    };
    let enabled = false;
    const task = createTranscriptionVocabularyTask(deps());
    scheduleTranscriptionVocabulary({ scheduler, eventBus: bus, task, enabled: () => enabled });

    bus.emit("document.upserted", upsert);
    expect(scheduler.kickPeriodic).not.toHaveBeenCalled();

    enabled = true;
    bus.emit("document.upserted", upsert);
    expect(order).toEqual(["schedule", `kick:${task.name}`]);
  });

  test("stop unsubscribes the wake and stops the periodic", () => {
    const bus = new EventBus();
    const stop = vi.fn();
    const scheduler = { schedule: vi.fn(() => ({ stop })), kickPeriodic: vi.fn() };
    const handle = scheduleTranscriptionVocabulary({
      scheduler,
      eventBus: bus,
      task: createTranscriptionVocabularyTask(deps()),
      enabled: () => true,
    });

    handle.stop();
    bus.emit("document.upserted", upsert);

    expect(stop).toHaveBeenCalledTimes(1);
    expect(scheduler.kickPeriodic).not.toHaveBeenCalled();
  });
});
