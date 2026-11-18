// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { EventEmitter } from "node:events";
import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  embed: vi.fn(),
  query: vi.fn(),
  dispose: vi.fn(),
  post: vi.fn(),
  close: vi.fn(),
}));
const port = new EventEmitter();
Object.assign(port, { postMessage: mocks.post, close: mocks.close });
vi.mock("node:worker_threads", () => ({ parentPort: port }));
vi.mock("../indexer/embedder.js", () => ({
  LlamaCppEmbedder: class {
    embed = mocks.embed;
    embedQuery = mocks.query;
    dispose = mocks.dispose;
  },
}));

function deferred(): {
  promise: Promise<Float32Array[]>;
  resolve: (value: Float32Array[]) => void;
} {
  let resolve!: (value: Float32Array[]) => void;
  const promise = new Promise<Float32Array[]>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function tick(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}
function send(type: string, fields = {}): void {
  port.emit("message", { type, ...fields });
}
function acknowledged(): boolean {
  return mocks.post.mock.calls.some(([message]) => message.type === "shutdownComplete");
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  port.removeAllListeners();
  mocks.embed.mockResolvedValue([new Float32Array([1, 0])]);
  mocks.dispose.mockResolvedValue(undefined);
  await import("./build-embedder-worker.js");
});

test("shutdown during warmup drains initialization before disposing the native owner", async () => {
  const warmup = deferred();
  mocks.embed.mockReturnValueOnce(warmup.promise);
  send("init", { modelPath: "scripted.gguf" });
  send("shutdown");
  await tick();
  expect(mocks.dispose).not.toHaveBeenCalled();
  expect(acknowledged()).toBe(false);
  warmup.resolve([new Float32Array([1, 0])]);
  await tick();
  expect(mocks.dispose).toHaveBeenCalledOnce();
  expect(mocks.post.mock.calls.some(([message]) => message.type === "ready")).toBe(false);
  expect(
    mocks.post.mock.calls.some(
      ([message]) => message.type === "log" && message.message.startsWith("build embedder ready:"),
    ),
  ).toBe(false);
  expect(acknowledged()).toBe(true);
  expect(mocks.close).toHaveBeenCalledOnce();
});

test("shutdown drains in-flight embedding and refuses later work", async () => {
  send("init", { modelPath: "scripted.gguf" });
  await tick();
  const request = deferred();
  mocks.embed.mockReturnValueOnce(request.promise);
  send("embed", { id: 1, texts: ["invented note"] });
  send("shutdown");
  send("embed", { id: 2, texts: ["late note"] });
  await tick();
  expect(mocks.embed).toHaveBeenCalledTimes(2);
  expect(mocks.dispose).not.toHaveBeenCalled();
  request.resolve([new Float32Array([0, 1])]);
  await tick();
  expect(mocks.dispose).toHaveBeenCalledOnce();
  expect(acknowledged()).toBe(true);
});

test("failed warmup releases its partially initialized owner before shutdown", async () => {
  mocks.embed.mockRejectedValueOnce(new Error("scripted initialization failure"));
  send("init", { modelPath: "scripted.gguf" });
  await tick();
  expect(mocks.dispose).toHaveBeenCalledOnce();
  expect(mocks.post).toHaveBeenCalledWith({
    type: "initError",
    error: "scripted initialization failure",
  });
  send("shutdown");
  await tick();
  expect(mocks.dispose).toHaveBeenCalledOnce();
  expect(mocks.close).toHaveBeenCalledOnce();
});

test("shutdown acknowledges only after native context disposal finishes", async () => {
  send("init", { modelPath: "scripted.gguf" });
  await tick();
  let release!: () => void;
  mocks.dispose.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  send("shutdown");
  await tick();
  expect(acknowledged()).toBe(false);
  expect(mocks.close).not.toHaveBeenCalled();
  release();
  await tick();
  expect(acknowledged()).toBe(true);
  expect(mocks.close).toHaveBeenCalledOnce();
});

test("failed native disposal cannot acknowledge safe thread termination", async () => {
  send("init", { modelPath: "scripted.gguf" });
  await tick();
  mocks.dispose.mockRejectedValueOnce(new Error("scripted native cleanup failure"));
  send("shutdown");
  await tick();
  expect(acknowledged()).toBe(false);
  expect(mocks.close).not.toHaveBeenCalled();
});
