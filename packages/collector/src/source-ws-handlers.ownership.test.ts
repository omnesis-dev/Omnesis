// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { makeCommand } from "@omnesis/core";
import { createSourceWsHandlers } from "./source-ws-handlers.js";
import type { GatewayClient, ImportCallbacks, ImportSummary } from "@omnesis/source-sdk";
import type { SourceManager } from "./source-manager.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const configDirs: string[] = [];
afterEach(() => {
  for (const configDir of configDirs.splice(0)) rmSync(configDir, { recursive: true, force: true });
});

function fixture(overrides: Partial<SourceManager> = {}) {
  const configDir = mkdtempSync(join(tmpdir(), "omnesis-source-ownership-"));
  configDirs.push(configDir);
  const events: Array<{ type: string; payload: unknown }> = [];
  const handlers = createSourceWsHandlers({
    sourceManager: {
      getDescriptors: () => [],
      getConfigDir: () => configDir,
      ...overrides,
    } as SourceManager,
    gateway: {} as GatewayClient,
    emitEvent: (type, payload) => events.push({ type, payload }),
  });
  return { handlers, events };
}

test("shutdown closes source-command admission", async () => {
  const { handlers } = fixture();
  await handlers.shutdown();
  await expect(
    Promise.resolve().then(() => handlers.handle(makeCommand("source.descriptors", {}))),
  ).rejects.toThrow(/closed|shut/i);
});

test("shutdown joins a source RPC accepted before admission closed", async () => {
  const entered = deferred<void>();
  const result = deferred<{ sourceIds: string[] }>();
  const { handlers } = fixture({
    reauthProvider: async () => {
      entered.resolve();
      return result.promise;
    },
  });
  const rpc = Promise.resolve(
    handlers.handle(
      makeCommand("source.reauth-finalize", { providerType: "test-provider", accountId: "one" }),
    ),
  );
  await entered.promise;
  let stopped = false;
  const shutdown = handlers.shutdown().then(() => {
    stopped = true;
  });
  try {
    for (let turn = 0; turn < 6; turn++) await Promise.resolve();
    expect(stopped).toBe(false);
  } finally {
    result.resolve({ sourceIds: [] });
    await Promise.all([rpc, shutdown]);
  }
});

test("shutdown aborts an import and joins it even when its worker ignores cancellation", async () => {
  const entered = deferred<ImportCallbacks>();
  const result = deferred<ImportSummary>();
  const { handlers } = fixture({
    importHistory: async (_sourceId, _values, callbacks) => {
      entered.resolve(callbacks);
      return result.promise;
    },
  });
  await handlers.handle(
    makeCommand("import.begin", { flowId: "one", sourceId: "test:one", values: {} }),
  );
  const callbacks = await entered.promise;
  let stopped = false;
  const shutdown = handlers.shutdown().then(() => {
    stopped = true;
  });
  try {
    expect(callbacks.signal?.aborted).toBe(true);
    for (let turn = 0; turn < 6; turn++) await Promise.resolve();
    expect(stopped).toBe(false);
  } finally {
    result.resolve({ imported: 0, merged: 0, skipped: 0 });
    await shutdown;
  }
});

test.each([false, true])("uncertain import cleanup remains owned (nested=%s)", async (nested) => {
  const entered = deferred<void>();
  const result = deferred<ImportSummary>();
  const marker = Object.assign(new Error("invented unconfirmed worker cleanup"), {
    cleanupFailure: undefined,
  });
  const failure = nested ? new Error("invented import failure", { cause: marker }) : marker;
  const { handlers, events } = fixture({
    importHistory: async () => {
      entered.resolve();
      return result.promise;
    },
  });
  await handlers.handle(
    makeCommand("import.begin", { flowId: "one", sourceId: "test:one", values: {} }),
  );
  await entered.promise;
  result.reject(failure);
  // Shutdown must join the producer's rejection before deciding whether it is safe to exit.
  await expect(handlers.shutdown()).rejects.toThrow(/cleanup|import failure/);
  expect(events.filter((event) => event.type === "import.complete")).toEqual([]);
});

test("a duplicate import flow cannot replace the first worker's cancellation handle", async () => {
  const entered = deferred<ImportCallbacks>();
  const result = deferred<ImportSummary>();
  const { handlers } = fixture({
    importHistory: async (_sourceId, _values, callbacks) => {
      entered.resolve(callbacks);
      return result.promise;
    },
  });
  const begin = () =>
    handlers.handle(
      makeCommand("import.begin", { flowId: "one", sourceId: "test:one", values: {} }),
    );
  await begin();
  const callbacks = await entered.promise;
  try {
    await expect(begin()).rejects.toThrow(/already active/);
    await handlers.handle(makeCommand("import.cancel", { flowId: "one" }));
    expect(callbacks.signal?.aborted).toBe(true);
  } finally {
    result.resolve({ imported: 0, merged: 0, skipped: 0 });
    await handlers.shutdown();
  }
});
