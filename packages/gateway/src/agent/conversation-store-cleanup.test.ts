// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import * as core from "@omnesis/core";
import { FsConversationStore, type ConversationRecord } from "./conversation-store.js";

const roots: string[] = [];
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(async () => {
  Object.defineProperty(process, "platform", platform);
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function record(title: string): ConversationRecord {
  return {
    id: "invented-conversation",
    callerId: "device:example",
    model: "scripted",
    backend: "scripted",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    title,
    pinned: false,
    messages: [],
  };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "conversation-publication-"));
  roots.push(root);
  const store = new FsConversationStore(root);
  // The mock is the production Native publication seam; no Native child is launched.
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  const writer = vi.spyOn(core, "atomicWriteFile").mockImplementation(async (path, body) => {
    await writeFile(path, body);
  });
  return { store, writer };
}
function ownership(store: FsConversationStore) {
  return store as FsConversationStore & {
    cleanupFailure?: () => unknown;
    close?: () => Promise<void>;
  };
}

test.each([false, true])(
  "an unconfirmed summary publication stops queued and future writes (nested=%s)",
  async (nested) => {
    const { store, writer } = await fixture();
    let entered!: () => void, reject!: (error: unknown) => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const publication = new Promise<void>((_resolve, fail) => {
      reject = fail;
    });
    writer.mockImplementation(async (path, body) => {
      if (String(path).endsWith(".summary-index.v4")) {
        entered();
        await publication;
      } else await writeFile(path, body);
    });
    const marker = Object.assign(new Error("invented publication uncertainty"), {
      cleanupFailure: undefined,
    });
    const error = nested ? new Error("invented wrapper", { cause: marker }) : marker;
    const first = store.save(record("first"));
    const firstVerdict = expect(first).rejects.toBe(error);
    await started;
    const queued = store.save(record("queued"));
    const queuedVerdict = expect(queued).rejects.toBe(error);
    try {
      reject(error);
      await Promise.all([firstVerdict, queuedVerdict]);
      expect(writer).toHaveBeenCalledTimes(2);
      expect(ownership(store).cleanupFailure?.()).toBe(error);
      await expect(store.save(record("future"))).rejects.toBe(error);
      expect(writer).toHaveBeenCalledTimes(2);
      expect(ownership(store).close).toBeTypeOf("function");
      const closing = ownership(store).close!();
      expect(ownership(store).close!()).toBe(closing);
      await expect(closing).rejects.toBe(error);
    } finally {
      reject(error);
      await Promise.allSettled([first, queued, firstVerdict, queuedVerdict]);
      await Promise.allSettled([ownership(store).close?.()]);
    }
  },
);

test("close retains a pending accepted publication until its actual settlement", async () => {
  const { store, writer } = await fixture();
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  writer.mockImplementation(async (path, body) => {
    entered();
    await gate;
    await writeFile(path, body);
  });
  const saving = store.save(record("accepted"));
  let closing: Promise<void> | undefined;
  try {
    await started;
    expect(core.ownedProcessCleanupReceipt(ownership(store).cleanupFailure?.())?.pending).toBe(
      true,
    );
    expect(ownership(store).close).toBeTypeOf("function");
    closing = ownership(store).close!();
    let settled = false;
    void closing.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await Promise.all([saving, closing]);
    expect(ownership(store).cleanupFailure?.()).toBeUndefined();
    await expect(store.save(record("too late"))).rejects.toThrow();
  } finally {
    release();
    await Promise.allSettled([saving, closing]);
    await Promise.allSettled([ownership(store).close?.()]);
  }
});

test("an ordinary joined summary write failure remains recoverable", async () => {
  const { store, writer } = await fixture();
  writer
    .mockImplementationOnce(async (path, body) => {
      await writeFile(path, body);
    })
    .mockRejectedValueOnce(new Error("invented joined disk failure"));
  await store.save(record("first"));
  expect(ownership(store).cleanupFailure?.()).toBeUndefined();
  await store.save(record("retry"));
  expect((await store.load("invented-conversation"))?.title).toBe("retry");
});
