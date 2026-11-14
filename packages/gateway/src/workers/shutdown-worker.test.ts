// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { EventEmitter, once } from "node:events";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, test, vi } from "vitest";
import { shutdownWorker } from "./shutdown-worker.js";

class DeferredWorker extends EventEmitter {
  threadId = 1;
  finishTermination!: (code: number) => void;
  terminate = vi.fn(
    () =>
      new Promise<number>((resolve) => {
        this.finishTermination = resolve;
      }),
  );
  asWorker(): Worker {
    return this as unknown as Worker;
  }
}

async function tick(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => vi.useRealTimers());

describe("worker shutdown ownership", () => {
  test("acknowledgement waits for exit and the termination promise", async () => {
    const worker = new DeferredWorker();
    let complete = false;
    const stopped = shutdownWorker(
      worker.asWorker(),
      () => {},
      () => {},
    ).then(() => {
      complete = true;
    });
    worker.emit("message", { type: "shutdownComplete" });
    await tick();
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(complete).toBe(false);
    worker.emit("exit", 0);
    await tick();
    expect(complete).toBe(false);
    worker.finishTermination(0);
    await stopped;
    expect(complete).toBe(true);
    expect(worker.listenerCount("message")).toBe(0);
  });

  test("timeout forces termination and joins it", async () => {
    vi.useFakeTimers();
    const worker = new DeferredWorker();
    const timedOut = vi.fn();
    let complete = false;
    const stopped = shutdownWorker(worker.asWorker(), () => {}, timedOut).then(() => {
      complete = true;
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(timedOut).toHaveBeenCalledOnce();
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(complete).toBe(false);
    worker.finishTermination(1);
    worker.emit("exit", 1);
    await stopped;
  });

  test("native drain cannot be interrupted by the shutdown timeout", async () => {
    vi.useFakeTimers();
    const worker = new DeferredWorker();
    const warning = vi.fn();
    let complete = false;
    const stopped = shutdownWorker(worker.asWorker(), () => {}, warning, {
      waitForNativeDrain: true,
    }).then(() => {
      complete = true;
    });
    await vi.advanceTimersByTimeAsync(5_001);
    expect(warning).toHaveBeenCalledOnce();
    expect(worker.terminate).not.toHaveBeenCalled();
    expect(complete).toBe(false);
    worker.emit("message", { type: "shutdownComplete" });
    expect(worker.terminate).toHaveBeenCalledOnce();
    worker.emit("exit", 0);
    await tick();
    expect(complete).toBe(false);
    worker.finishTermination(0);
    await stopped;
  });

  test("native shutdown transport failure rejects without terminating a live thread", async () => {
    vi.useFakeTimers();
    const worker = new DeferredWorker();
    const warning = vi.fn();
    const stopped = shutdownWorker(
      worker.asWorker(),
      () => {
        throw new Error("scripted transport failure");
      },
      warning,
      { waitForNativeDrain: true },
    );
    await expect(stopped).rejects.toThrow("scripted transport failure");
    await vi.advanceTimersByTimeAsync(5_001);
    expect(worker.terminate).not.toHaveBeenCalled();
    expect(warning).not.toHaveBeenCalled();
    expect(worker.threadId).toBe(1);
    expect(worker.listenerCount("exit")).toBe(0);
  });

  test("early exit settles without waiting for acknowledgement", async () => {
    const worker = new DeferredWorker();
    const stopped = shutdownWorker(
      worker.asWorker(),
      () => {},
      () => {},
    );
    worker.emit("exit", 1);
    await stopped;
    expect(worker.terminate).not.toHaveBeenCalled();
  });

  test("termination errors reject disposal and release listeners", async () => {
    const worker = new DeferredWorker();
    worker.terminate.mockImplementation(() => Promise.reject(new Error("termination refused")));
    const stopped = shutdownWorker(
      worker.asWorker(),
      () => {},
      () => {},
    );
    worker.emit("message", { type: "shutdownComplete" });
    await expect(stopped).rejects.toThrow("termination refused");
    expect(worker.listenerCount("exit")).toBe(0);
  });

  test("a real acknowledged worker has exited when disposal completes", async () => {
    const worker = new Worker(
      new URL(
        `data:text/javascript,${encodeURIComponent(`
      import { parentPort } from 'node:worker_threads';
      parentPort.on('message', () => parentPort.postMessage({ type: 'shutdownComplete' }));
      parentPort.postMessage({ type: 'ready' });
    `)}`,
      ),
    );
    try {
      await once(worker, "message");
      await shutdownWorker(
        worker,
        () => worker.postMessage({ type: "shutdown" }),
        () => {},
      );
      expect(worker.threadId).toBe(-1);
    } finally {
      await worker.terminate();
    }
  });
});
