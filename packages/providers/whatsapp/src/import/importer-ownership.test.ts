// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { EventEmitter } from "node:events";
import { existsSync, rmSync } from "node:fs";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ownedProcessCleanupReceipt } from "@omnesis/core";
import { importWhatsAppHistory } from "./importer.js";
import type { MessageStore } from "../message-store.js";
import type { ImportSummary } from "@omnesis/source-sdk";

const boundary = vi.hoisted(() => ({
  spawn: undefined as (() => unknown) | undefined,
  scratches: [] as string[],
}));
vi.mock("node:worker_threads", () => ({
  Worker: vi.fn(function () {
    if (!boundary.spawn) throw new Error("Worker fixture is not configured");
    return boundary.spawn();
  }),
}));
vi.mock("@omnesis/core", async (original) => {
  const actual = await original<typeof import("@omnesis/core")>();
  return {
    ...actual,
    createPrivateScratch: (...args: Parameters<typeof actual.createPrivateScratch>) => {
      const scratch = actual.createPrivateScratch(...args);
      boundary.scratches.push(scratch.path);
      return scratch;
    },
  };
});

type Outcome = { ok: true; summary: ImportSummary } | { ok: false; error: unknown };
const workers: Array<EventEmitter & { terminate: ReturnType<typeof vi.fn> }> = [];
const tasks: Array<Promise<void>> = [];
beforeEach(() => {
  boundary.spawn = () => {
    const worker = Object.assign(new EventEmitter(), {
      terminate: vi.fn(() => {
        worker.emit("exit", 0);
        return Promise.resolve(0);
      }),
    });
    workers.push(worker);
    return worker;
  };
});
afterEach(async () => {
  for (const worker of workers.splice(0)) {
    worker.emit("message", { type: "error", message: "Fixture cleanup" });
    worker.emit("exit", 0);
  }
  await Promise.all(tasks.splice(0));
  vi.useRealTimers();
  for (const path of boundary.scratches.splice(0)) rmSync(path, { recursive: true, force: true });
});

function begin(signal?: AbortSignal) {
  const store = { importMessages: vi.fn(() => ({ imported: 1, merged: 0 })) };
  const result: { outcome?: Outcome; done: Promise<void> } = { done: Promise.resolve() };
  result.done = importWhatsAppHistory({
    backupKind: "android",
    backupPath: "unused-fixture-backup",
    passphrase: "invented-fixture-key",
    store: store as unknown as MessageStore,
    own: { jid: "fixture-owner@example.com", name: "Fixture owner" },
    callbacks: { signal },
  }).then(
    (summary) => {
      result.outcome = { ok: true, summary };
    },
    (error: unknown) => {
      result.outcome = { ok: false, error };
    },
  );
  tasks.push(result.done);
  return { result, store, worker: workers.at(-1)!, scratch: boundary.scratches.at(-1)! };
}

test("a worker that exits cleanly without a terminal result fails instead of hanging", async () => {
  const { result, worker, scratch } = begin();
  worker.emit("exit", 0);
  await vi.waitFor(() => expect(result.outcome).toBeDefined(), { timeout: 1_000 });
  expect(result.outcome).toMatchObject({ ok: false, error: expect.any(Error) });
  expect(existsSync(scratch)).toBe(false);
});

test("cancellation closes batch admission before the worker finishes", async () => {
  const controller = new AbortController();
  const { result, store, worker, scratch } = begin(controller.signal);
  controller.abort();
  worker.emit("message", { type: "batch", messages: [] });
  expect(store.importMessages).not.toHaveBeenCalled();
  expect(existsSync(scratch)).toBe(true);
  worker.emit("exit", 0);
  await result.done;
  expect(result.outcome).toMatchObject({ ok: false });
  expect(existsSync(scratch)).toBe(false);
});

test.each([undefined, new Error("Invented worker termination failure")])(
  "unconfirmed worker termination retains scratch and an explicit cleanup marker (%s)",
  async (failure) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const controller = new AbortController();
    const { result, worker, scratch } = begin(controller.signal);
    worker.terminate.mockImplementation(() => Promise.reject(failure));
    controller.abort();
    await vi.advanceTimersByTimeAsync(10_001);
    await result.done;
    expect(result.outcome?.ok).toBe(false);
    if (result.outcome?.ok !== false) throw new Error("Expected cancelled import failure");
    expect(ownedProcessCleanupReceipt(result.outcome.error)).toEqual({ failure, pending: false });
    expect(existsSync(scratch)).toBe(true);
  },
);

test("a terminal result retains scratch until the worker actually joins", async () => {
  const { result, worker, scratch } = begin();
  worker.emit("message", { type: "done", skipped: 2 });
  for (let turn = 0; turn < 6; turn++) await Promise.resolve();
  expect(result.outcome).toBeUndefined();
  expect(existsSync(scratch)).toBe(true);
  worker.emit("exit", 0);
  await result.done;
  expect(result.outcome).toEqual({ ok: true, summary: { imported: 0, merged: 0, skipped: 2 } });
  expect(existsSync(scratch)).toBe(false);
});
