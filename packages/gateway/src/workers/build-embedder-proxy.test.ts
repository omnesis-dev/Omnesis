// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { EventEmitter } from "node:events";
import { afterEach, expect, test, vi } from "vitest";
import { BuildWorkerEmbedder } from "./build-embedder-proxy.js";
import type { Worker } from "node:worker_threads";

afterEach(() => vi.useRealTimers());

class ScriptedWorker extends EventEmitter {
  threadId = 1;
  sent: Array<{ type: string }> = [];
  postMessage(message: { type: string }): void {
    this.sent.push(message);
  }
  terminate(): Promise<number> {
    this.threadId = -1;
    this.emit("exit", 0);
    return Promise.resolve(0);
  }
}
function fixture(): { worker: ScriptedWorker; embedder: BuildWorkerEmbedder } {
  const worker = new ScriptedWorker();
  return {
    worker,
    embedder: new BuildWorkerEmbedder({
      createWorker: () => worker as unknown as Worker,
      modelPath: "scripted.gguf",
      embedDim: 2,
      encoding: { kind: "none" },
      embedConcurrency: 1,
      embedderContextSize: 64,
      embedderTimeoutMs: 1000,
      embedderMaxInputChars: 100,
    }),
  };
}

test("disposal before ready rejects startup callers and shares the exit join", async () => {
  const { worker, embedder } = fixture();
  const waiting = expect(embedder.embedQuery("invented query")).rejects.toThrow(/shut down/);
  const stopped = embedder.dispose();
  expect(embedder.dispose()).toBe(stopped);
  await waiting;
  worker.emit("message", { type: "shutdownComplete" });
  await stopped;
  expect(worker.threadId).toBe(-1);
  await expect(embedder.embed([])).rejects.toThrow();
});

test("unexpected exit rejects ready and in-flight operations", async () => {
  const first = fixture();
  const startup = expect(first.embedder.embedQuery("invented query")).rejects.toThrow(
    /exited code=1/,
  );
  first.worker.threadId = -1;
  first.worker.emit("exit", 1);
  await startup;
  await first.embedder.dispose();

  const { worker, embedder } = fixture();
  worker.emit("message", { type: "ready" });
  const request = expect(embedder.embed(["invented document"])).rejects.toThrow(/exited code=2/);
  await Promise.resolve();
  worker.threadId = -1;
  worker.emit("exit", 2);
  await request;
  await expect(embedder.embedQuery("after exit")).rejects.toThrow(/disposed/);
  await embedder.dispose();
});

test("native build shutdown never forces a thread still draining its model", async () => {
  vi.useFakeTimers();
  const { worker, embedder } = fixture();
  const stopped = embedder.dispose();
  await vi.advanceTimersByTimeAsync(5_001);
  expect(worker.threadId).toBe(1);
  worker.emit("message", { type: "shutdownComplete" });
  await stopped;
  expect(worker.threadId).toBe(-1);
});
