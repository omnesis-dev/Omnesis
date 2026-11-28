// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test, vi } from "vitest";
import { LocalVoiceSeparator, type VoiceWorkerProcess } from "./local-voice-separator.js";
import type { VoiceWorkerMessage } from "./voice-worker-protocol.js";
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
class Worker implements VoiceWorkerProcess {
  private closure = deferred();
  readonly joined = this.closure.promise;
  message: ((message: VoiceWorkerMessage) => void) | undefined;
  exit: ((info: { code: number | null; signal: string | null; error?: Error }) => void) | undefined;
  write = vi.fn();
  stop = vi.fn(() => this.joined);
  onMessage(handler: (message: VoiceWorkerMessage) => void) {
    this.message = handler;
  }
  onExit(handler: NonNullable<Worker["exit"]>) {
    this.exit = handler;
  }
  ready() {
    this.message?.({ type: "ready" });
  }
  finish() {
    this.exit?.({ code: null, signal: "SIGKILL" });
    this.closure.resolve();
  }
}
const models = { segmentation: "/example/segmentation.onnx", embedding: "/example/embedding.onnx" };

test("disposing STARTING worker rejects startup and joins physical closure; late ready cannot resurrect it", async () => {
  const worker = new Worker();
  const spawn = vi.fn(() => worker);
  const local = new LocalVoiceSeparator({
    model: "invented-scripted-model",
    models,
    spawnWorker: spawn,
  });
  const call = local.group([new Float32Array([1, 0])], [1]);
  const rejected = expect(call).rejects.toThrow("disposed");
  await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
  let closed = false;
  const disposed = local.dispose();
  expect(local.dispose()).toBe(disposed);
  void disposed.then(() => {
    closed = true;
  });
  await rejected;
  await Promise.resolve();
  expect(closed).toBe(false);
  expect(worker.stop).toHaveBeenCalledOnce();
  worker.ready();
  worker.finish();
  await disposed;
  expect(closed).toBe(true);
  await expect(local.group([new Float32Array([1, 0])], [1])).rejects.toThrow("disposed");
  expect(spawn).toHaveBeenCalledOnce();
});

test("active native request is cancelled but separator disposal remains pending until actual join", async () => {
  const worker = new Worker();
  const local = new LocalVoiceSeparator({
    model: "invented-scripted-model",
    models,
    spawnWorker: () => worker,
  });
  const call = local.group([new Float32Array([1, 0])], [1]);
  const rejected = expect(call).rejects.toThrow("disposed");
  await vi.waitFor(() => expect(worker.message).toBeDefined());
  worker.ready();
  await vi.waitFor(() => expect(worker.write).toHaveBeenCalledOnce());
  let closed = false;
  const disposed = local.dispose().then(() => {
    closed = true;
  });
  await rejected;
  expect(closed).toBe(false);
  worker.finish();
  await disposed;
  expect(closed).toBe(true);
});

test("request timeout retains old process until joined before admitting a replacement", async () => {
  const first = new Worker(),
    second = new Worker();
  const spawn = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
  const local = new LocalVoiceSeparator({
    model: "invented-scripted-model",
    models,
    spawnWorker: spawn,
    requestTimeoutMs: 10,
  });
  const call = local.group([new Float32Array([1, 0])], [1]);
  const rejected = expect(call).rejects.toThrow("timed out");
  await vi.waitFor(() => expect(first.message).toBeDefined());
  first.ready();
  await rejected;
  const next = local.group([new Float32Array([1, 0])], [1]);
  const nextRejected = expect(next).rejects.toThrow("disposed");
  await Promise.resolve();
  expect(spawn).toHaveBeenCalledOnce();
  first.finish();
  await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));
  const disposed = local.dispose();
  await nextRejected;
  second.finish();
  await disposed;
});

test("early exit during startup rejects without publishing a worker and later dispose joins it", async () => {
  const worker = new Worker();
  worker.onExit = (handler) => {
    worker.exit = handler;
    handler({ code: 1, signal: null });
  };
  const local = new LocalVoiceSeparator({
    model: "invented-scripted-model",
    models,
    spawnWorker: () => worker,
  });
  const failed = expect(local.group([new Float32Array([1, 0])], [1])).rejects.toThrow(
    "failed to start",
  );
  await failed;
  let closed = false;
  const disposed = local.dispose().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  worker.finish();
  await disposed;
});

test("uncertain owned cleanup stays refused and cannot admit another worker", async () => {
  const worker = new Worker();
  worker.stop = vi.fn(async () => {
    throw new Error("Owned cleanup unconfirmed");
  });
  const spawn = vi.fn(() => worker);
  const local = new LocalVoiceSeparator({
    model: "invented-scripted-model",
    models,
    spawnWorker: spawn,
  });
  const call = local.group([new Float32Array([1, 0])], [1]);
  const rejected = expect(call).rejects.toThrow("disposed");
  await vi.waitFor(() => expect(worker.message).toBeDefined());
  worker.ready();
  await vi.waitFor(() => expect(worker.write).toHaveBeenCalledOnce());
  const disposal = local.dispose();
  await rejected;
  await expect(disposal).rejects.toThrow("cleanup unconfirmed");
  expect(local.dispose()).toBe(disposal);
  await expect(local.group([new Float32Array([1, 0])], [1])).rejects.toThrow("disposed");
  expect(spawn).toHaveBeenCalledOnce();
  worker.finish();
});
