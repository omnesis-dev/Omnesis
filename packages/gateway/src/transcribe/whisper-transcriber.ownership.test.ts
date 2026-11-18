// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, expect, test, vi } from "vitest";
import { WhisperTranscriber, type WhisperWorkerProcess } from "./whisper-transcriber.js";
import {
  FrameDecoder,
  type WhisperRequestHeader,
  type WhisperWorkerMessage,
} from "./whisper-worker-protocol.js";

/** Root exit and independently confirmed cohort closure are separate events. */
class ControlledWorker implements WhisperWorkerProcess {
  readonly request = Promise.withResolvers<WhisperRequestHeader>();
  private readonly closure = Promise.withResolvers<void>();
  readonly joined = this.closure.promise;
  joinedConfirmed = false;
  readonly kill = vi.fn(() => this.joined);
  private message: ((msg: WhisperWorkerMessage) => void) | undefined;
  private exited:
    ((info: { code: number | null; signal: string | null; error?: Error }) => void) | undefined;
  private readonly decoder = new FrameDecoder((header) => {
    const request = header as WhisperRequestHeader;
    this.request.resolve(request);
    if (this.answer)
      this.message?.({ type: "result", id: request.id, text: "Invented fixture transcript." });
  });
  constructor(
    readonly answer = true,
    readonly automaticReady = true,
  ) {}
  write(frame: Buffer): void {
    this.decoder.push(frame);
  }
  onMessage(handler: (msg: WhisperWorkerMessage) => void): void {
    this.message = handler;
    if (this.automaticReady) queueMicrotask(() => this.ready());
  }
  onExit(
    handler: (info: { code: number | null; signal: string | null; error?: Error }) => void,
  ): void {
    this.exited = handler;
  }
  ready(): void {
    this.message?.({ type: "ready" });
  }
  exit(): void {
    this.exited?.({ code: 1, signal: null });
  }
  close(): void {
    this.joinedConfirmed = true;
    this.closure.resolve();
    this.exited?.({ code: null, signal: "SIGKILL" });
  }
}
const transcribers: WhisperTranscriber[] = [];
const workers: ControlledWorker[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const worker of workers.splice(0)) {
    worker.ready();
    worker.close();
  }
  for (const transcriber of transcribers.splice(0)) await transcriber.dispose();
});
function create(...sequence: ControlledWorker[]) {
  workers.push(...sequence);
  const spawned = Promise.withResolvers<void>();
  let index = 0;
  const spawnWorker = vi.fn(() => {
    const worker = sequence[index++];
    if (!worker) throw new Error("Unexpected replacement worker");
    spawned.resolve();
    return worker;
  });
  const transcriber = new WhisperTranscriber({
    modelPath: "invented-model.bin",
    modelId: "whisper-tiny",
    spawnWorker,
    decodeAudio: async () => new Float32Array(160),
    requestTimeoutMs: 1,
  });
  transcribers.push(transcriber);
  return { transcriber, spawnWorker, spawned: spawned.promise };
}
const audio = new Uint8Array([1, 2, 3]);

test("confirmed closure permits ordinary transcription and disposal", async () => {
  const worker = new ControlledWorker();
  const { transcriber } = create(worker);
  const result = await transcriber.transcribe(audio, "audio/wav");
  expect(result.text).toBe("Invented fixture transcript.");
  worker.close();
  await transcriber.dispose();
});

test("disposing a ready worker waits for physical cohort closure", async () => {
  const worker = new ControlledWorker();
  const { transcriber } = create(worker);
  await transcriber.transcribe(audio, "audio/wav");
  let settled = false;
  const closing = transcriber.dispose().then(() => {
    settled = true;
  });
  try {
    await Promise.resolve();
    await Promise.resolve();
    expect(worker.kill).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
  } finally {
    worker.close();
    await closing;
  }
  expect(settled).toBe(true);
});

test("disposing while the model loads owns and stops that worker before returning", async () => {
  const worker = new ControlledWorker(true, false);
  const { transcriber, spawned } = create(worker);
  const request = transcriber.transcribe(audio, "audio/wav").catch((error: unknown) => error);
  await spawned;
  let settled = false;
  const closing = transcriber.dispose().then(() => {
    settled = true;
  });
  try {
    await Promise.resolve();
    await Promise.resolve();
    expect(worker.kill).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
  } finally {
    // Let an uncorrected implementation finish its pending startup too.
    worker.ready();
    await new Promise<void>((resolve) => setImmediate(resolve));
    worker.close();
    await closing;
    await request;
  }
});

test("a request timeout cannot settle before the killed worker's cohort closes", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const worker = new ControlledWorker(false);
  const { transcriber } = create(worker);
  let settled = false;
  const request = transcriber.transcribe(audio, "audio/wav").then(
    () => {
      settled = true;
      return undefined;
    },
    (error: unknown) => {
      settled = true;
      return error;
    },
  );
  await worker.request.promise;
  try {
    await vi.advanceTimersByTimeAsync(1);
    expect(worker.kill).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
  } finally {
    worker.close();
  }
  expect(await request).toBeInstanceOf(Error);
  expect(settled).toBe(true);
});

test("disposal closes new transcription admission", async () => {
  const worker = new ControlledWorker();
  const { transcriber, spawnWorker } = create(worker);
  await transcriber.dispose();
  const result = await transcriber.transcribe(audio, "audio/wav").catch((error: unknown) => error);
  expect(result).toBeInstanceOf(Error);
  expect(spawnWorker).not.toHaveBeenCalled();
});
