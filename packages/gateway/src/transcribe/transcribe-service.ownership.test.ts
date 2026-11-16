// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, expect, test, vi } from "vitest";
import { ownedProcessCleanupReceipt, type ResolvedAssignment } from "@omnesis/core";
import { OptionalServiceCleanup } from "../optional-service-cleanup.js";
import { TranscribeService } from "./transcribe-service.js";
import type { WhisperWorkerProcess } from "./whisper-transcriber.js";
import {
  FrameDecoder,
  type WhisperRequestHeader,
  type WhisperWorkerMessage,
} from "./whisper-worker-protocol.js";

class FixtureWorker implements WhisperWorkerProcess {
  private readonly closure = Promise.withResolvers<void>();
  readonly joined = this.closure.promise;
  joinedConfirmed = false;
  stopFailure: Error | undefined;
  private message: ((msg: WhisperWorkerMessage) => void) | undefined;
  private exit:
    ((info: { code: number | null; signal: string | null; error?: Error }) => void) | undefined;
  private readonly decoder = new FrameDecoder((header) => {
    this.message?.({
      type: "result",
      id: (header as WhisperRequestHeader).id,
      text: "Invented service fixture transcript.",
    });
  });
  constructor() {
    void this.joined.catch(() => {});
  }
  write(frame: Buffer): void {
    this.decoder.push(frame);
  }
  kill(): Promise<void> {
    if (this.stopFailure) {
      this.closure.reject(this.stopFailure);
      this.exit?.({ code: null, signal: null, error: this.stopFailure });
    } else {
      this.joinedConfirmed = true;
      this.closure.resolve();
      this.exit?.({ code: null, signal: "SIGKILL" });
    }
    return this.joined;
  }
  onMessage(handler: (msg: WhisperWorkerMessage) => void): void {
    this.message = handler;
    queueMicrotask(() => handler({ type: "ready" }));
  }
  onExit(
    handler: (info: { code: number | null; signal: string | null; error?: Error }) => void,
  ): void {
    this.exit = handler;
  }
}
const local = (catalogId = "whisper-tiny"): ResolvedAssignment => ({
  role: "transcriber",
  kind: "local",
  catalogId,
  modelPath: "invented-model.bin",
  available: true,
});
const services: TranscribeService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.dispose().catch(() => {});
});
const audio = new Uint8Array([1, 2, 3]);
const available = async () => ({ Whisper: class {} });
function remember(service: TranscribeService) {
  services.push(service);
  return service;
}

test("normal service transcription and independently joined capability disposal remain usable", async () => {
  const worker = new FixtureWorker();
  const service = remember(
    new TranscribeService({
      resolveAssignment: () => local(),
      deps: {
        loadModule: available,
        spawnWorker: () => worker,
        decodeAudio: async () => new Float32Array(160),
      },
    }),
  );
  expect(await service.transcribeOutcome(audio, "audio/wav")).toMatchObject({
    kind: "transcribed",
    result: { text: "Invented service fixture transcript." },
  });
  await service.dispose();
  expect(worker.joinedConfirmed).toBe(true);
});

test("shutdown retains an accepted capability load and prevents it admitting model work afterwards", async () => {
  const load = Promise.withResolvers<{ Whisper: unknown }>();
  const entered = Promise.withResolvers<void>();
  const spawnWorker = vi.fn(() => new FixtureWorker());
  const service = remember(
    new TranscribeService({
      resolveAssignment: () => local(),
      deps: {
        loadModule: () => {
          entered.resolve();
          return load.promise;
        },
        spawnWorker,
        decodeAudio: async () => new Float32Array(160),
      },
    }),
  );
  const request = service.transcribeOutcome(audio, "audio/wav");
  await entered.promise;
  let settled = false;
  const closing = service.dispose().then(() => {
    settled = true;
  });
  try {
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
  } finally {
    load.resolve({ Whisper: class {} });
    await request;
    await closing;
  }
  expect(spawnWorker).not.toHaveBeenCalled();
});

test("shutdown cancels accepted decoding and queued transcriptions without loading a replacement", async () => {
  const decoded = Promise.withResolvers<Float32Array>();
  const entered = Promise.withResolvers<void>();
  const spawnWorker = vi.fn(() => new FixtureWorker());
  let calls = 0;
  const service = remember(
    new TranscribeService({
      resolveAssignment: () => local(),
      deps: {
        loadModule: available,
        spawnWorker,
        decodeAudio: async () => {
          if (++calls === 1) {
            entered.resolve();
            return decoded.promise;
          }
          return new Float32Array(160);
        },
      },
    }),
  );
  const first = service.transcribeOutcome(audio, "audio/wav");
  await entered.promise;
  const queued = service.transcribeOutcome(audio, "audio/wav");
  const closing = service.dispose();
  decoded.resolve(new Float32Array(160));
  const results = await Promise.all([first, queued]);
  await closing;
  expect(results.map((result) => result.kind)).toEqual(["cancelled", "cancelled"]);
  expect(spawnWorker).not.toHaveBeenCalled();
});

test("uncertain capability retirement refuses model replacement and propagates the cleanup marker", async () => {
  const first = new FixtureWorker();
  const second = new FixtureWorker();
  const spawnWorker = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
  let assignment = local();
  const service = remember(
    new TranscribeService({
      resolveAssignment: () => assignment,
      deps: { loadModule: available, spawnWorker, decodeAudio: async () => new Float32Array(160) },
    }),
  );
  expect((await service.transcribeOutcome(audio, "audio/wav")).kind).toBe("transcribed");
  first.stopFailure = Object.assign(new Error("invented unconfirmed worker retirement"), {
    cleanupFailure: undefined,
  });
  assignment = local("whisper-base");
  await expect(service.transcribeOutcome(audio, "audio/wav")).rejects.toHaveProperty(
    "cleanupFailure",
    undefined,
  );
  expect(spawnWorker).toHaveBeenCalledOnce();
});

test("disposal closes service admission before any new capability is loaded", async () => {
  const loadModule = vi.fn(available);
  const spawnWorker = vi.fn(() => new FixtureWorker());
  const service = remember(
    new TranscribeService({
      resolveAssignment: () => local(),
      deps: { loadModule, spawnWorker, decodeAudio: async () => new Float32Array(160) },
    }),
  );
  await service.dispose();
  await expect(service.transcribeOutcome(audio, "audio/wav")).rejects.toThrow(
    /shutting down|disposed/,
  );
  expect(loadModule).not.toHaveBeenCalled();
  expect(spawnWorker).not.toHaveBeenCalled();
});

test("the optional service owner retains an undefined cleanup marker through shutdown", async () => {
  const worker = new FixtureWorker();
  const service = remember(
    new TranscribeService({
      resolveAssignment: () => local(),
      deps: {
        loadModule: available,
        spawnWorker: () => worker,
        decodeAudio: async () => new Float32Array(160),
      },
    }),
  );
  await service.transcribeOutcome(audio, "audio/wav");
  worker.stopFailure = Object.assign(new Error("invented unconfirmed cohort"), {
    cleanupFailure: undefined,
  });
  const owner = new OptionalServiceCleanup("Transcription fixture", () => service);
  const failure = await owner.settle().catch((error: unknown) => error);
  expect(ownedProcessCleanupReceipt(failure)).toEqual({ failure: undefined, pending: false });
  expect(ownedProcessCleanupReceipt(service.cleanupFailure())).toEqual({
    failure: undefined,
    pending: false,
  });
  expect(owner.hasTerminalFailure()).toBe(true);
  await expect(service.transcribeOutcome(audio, "audio/wav")).rejects.toHaveProperty(
    "cleanupFailure",
    undefined,
  );
});

test("an availability probe cannot hide an owned cleanup failure as a missing optional module", async () => {
  const marker = Object.assign(new Error("invented runtime probe cleanup uncertainty"), {
    cleanupFailure: undefined,
  });
  const loadModule = vi.fn(async () => {
    throw marker;
  });
  const service = remember(
    new TranscribeService({ resolveAssignment: () => local(), deps: { loadModule } }),
  );
  await expect(service.settledReadiness()).rejects.toBe(marker);
  expect(ownedProcessCleanupReceipt(service.cleanupFailure())).toEqual({
    failure: undefined,
    pending: false,
  });
  await expect(service.close()).rejects.toHaveProperty("cleanupFailure", undefined);
  await expect(service.transcribeOutcome(audio, "audio/wav")).rejects.toHaveProperty(
    "cleanupFailure",
    undefined,
  );
  expect(loadModule).toHaveBeenCalledOnce();
});
