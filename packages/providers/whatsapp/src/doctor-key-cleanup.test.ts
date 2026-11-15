// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
const { readKey, readKeySync } = vi.hoisted(() => {
  const readKey = vi.fn();
  return { readKey, readKeySync: vi.fn((...args) => readKey(...args)) };
});
vi.mock("@omnesis/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@omnesis/core")>()),
  readStorageKeySync: readKeySync,
  readStorageKey: readKey,
}));
import { inspectMessageStore } from "./message-store.js";
const probe = async (root: string, signal?: AbortSignal) => {
  writeFileSync(join(root, "store.db"), Buffer.alloc(64, 7));
  return inspectMessageStore(root, signal);
};
let root: string;
beforeEach(() => {
  readKey.mockReset();
  readKeySync.mockClear();
  root = mkdtempSync(join(tmpdir(), "provider-doctor-key-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test.each([false, true])(
  "explicit key-read cleanup uncertainty is not projected as a locked store (nested:%s)",
  async (nested) => {
    const cause = Object.assign(new Error("invented key operation"), { cleanupFailure: undefined });
    const marker = nested ? new Error("invented wrapped key operation", { cause }) : cause;
    readKey.mockImplementation(() => {
      throw marker;
    });
    await expect(probe(root)).rejects.toBe(marker);
    expect(readKey).toHaveBeenCalledOnce();
  },
);

test("ordinary joined key-read failure remains a locked-store result", async () => {
  readKey.mockImplementation(() => {
    throw Object.assign(new Error("invented unavailable key"), { code: "EACCES" });
  });
  await expect(probe(root)).resolves.toMatchObject({ state: "locked" });
  expect(readKey).toHaveBeenCalledOnce();
});

test("the health probe awaits the asynchronous key operation without invoking its synchronous counterpart", async () => {
  let release!: (key: null) => void;
  const gate = new Promise<null>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  readKey.mockImplementation(() => {
    entered();
    return gate;
  });
  let settled = false;
  const inspection = probe(root).finally(() => {
    settled = true;
  });
  try {
    await started;
    expect(readKey).toHaveBeenCalledOnce();
    expect(readKeySync).not.toHaveBeenCalled();
    expect(settled).toBe(false);
  } finally {
    release(null);
    await inspection;
  }
  expect(settled).toBe(true);
});

test("cancellation during a key read joins that operation and clears its key without opening a database", async () => {
  let release!: (key: Buffer) => void, entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<Buffer>((resolve) => {
    release = resolve;
  });
  readKey.mockImplementation(() => {
    entered();
    return gate;
  });
  const key = Buffer.alloc(32, 17);
  const controller = new AbortController();
  const inspection = probe(root, controller.signal);
  const refused = expect(inspection).rejects.toMatchObject({ name: "AbortError" });
  try {
    await started;
    controller.abort();
    release(key);
    await refused;
    expect(key).toEqual(Buffer.alloc(32));
    expect(readKey).toHaveBeenCalledOnce();
  } finally {
    release(key);
    await Promise.allSettled([inspection, refused]);
  }
});
