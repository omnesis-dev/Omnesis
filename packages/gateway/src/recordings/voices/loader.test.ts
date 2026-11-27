// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { ConfigStore } from "../../config-store.js";
import {
  bindVoiceSeparatorPolicy,
  createVoiceSeparatorSource,
  type VoiceSeparatorPolicy,
} from "./loader.js";
import { LocalVoiceSeparator, type VoiceWorkerProcess } from "./local-voice-separator.js";
import type { VoiceWorkerMessage } from "./voice-worker-protocol.js";
import type { VoiceSeparator } from "./voices.js";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function separator(): VoiceSeparator {
  return {
    name: "invented-scripted",
    model: "invented-scripted-model",
    separate: vi.fn(async () => ({ windows: [], vectors: [] })),
    group: vi.fn(async () => []),
    dispose: vi.fn(async () => {}),
  };
}
async function fixture() {
  const modelsDir = await mkdtemp(join(tmpdir(), "omnesis-voice-policy-"));
  let policy: VoiceSeparatorPolicy = { mode: "local", reviewRequired: true };
  const created = separator(),
    available = vi.fn(async () => true),
    download = vi.fn(async () => {}),
    create = vi.fn(() => created);
  const source = createVoiceSeparatorSource({
    modelsDir,
    policy: () => policy,
    available,
    download,
    create,
  });
  return {
    modelsDir,
    source,
    created,
    available,
    download,
    create,
    set: (next: VoiceSeparatorPolicy) => {
      policy = next;
      source.refresh();
    },
    cleanup: async () => {
      await source.dispose();
      await rm(modelsDir, { recursive: true, force: true });
    },
  };
}

test("paused local boot performs zero availability, download or creation; resume follows current choice", async () => {
  const f = await fixture();
  try {
    expect(await f.source.settled()).toBe("superseded");
    expect(f.source.current()).toBeNull();
    expect(f.available).not.toHaveBeenCalled();
    expect(f.download).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled();
    f.set({ mode: "off", reviewRequired: true });
    f.set({ mode: "off", reviewRequired: false });
    expect(await f.source.settled()).toBe("off");
    expect(f.available).not.toHaveBeenCalled();
    f.set({ mode: "local", reviewRequired: false });
    expect(await f.source.settled()).toBe("ready");
    expect(f.available).toHaveBeenCalledTimes(1);
    expect(f.download).toHaveBeenCalledTimes(2);
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.source.current()).toBe(f.created);
    f.set({ mode: "off", reviewRequired: false });
    expect(f.source.current()).toBeNull();
    expect(await f.source.settled()).toBe("off");
    expect(f.created.dispose).toHaveBeenCalledTimes(1);
  } finally {
    await f.cleanup();
  }
});

test("pause during availability prevents every download and creation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omnesis-voice-availability-"));
  const held = deferred<boolean>();
  let policy: VoiceSeparatorPolicy = { mode: "local", reviewRequired: false };
  const available = vi.fn(() => held.promise),
    download = vi.fn(async () => {}),
    create = vi.fn(() => separator());
  const source = createVoiceSeparatorSource({
    modelsDir: dir,
    policy: () => policy,
    available,
    download,
    create,
  });
  try {
    await vi.waitFor(() => expect(available).toHaveBeenCalledOnce());
    policy = { ...policy, reviewRequired: true };
    source.refresh();
    held.resolve(true);
    expect(await source.settled()).toBe("superseded");
    expect(download).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  } finally {
    held.resolve(true);
    await source.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("cancelled download is physically joined before a resumed generation can prepare", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omnesis-voice-download-"));
  const held = deferred<void>();
  let first = true,
    aborted = false;
  let policy: VoiceSeparatorPolicy = { mode: "local", reviewRequired: false };
  const available = vi.fn(async () => true);
  const download = vi.fn(async (_model: unknown, _dir: string, signal: AbortSignal) => {
    if (first) {
      first = false;
      signal.addEventListener(
        "abort",
        () => {
          aborted = true;
        },
        { once: true },
      );
      await held.promise;
      signal.throwIfAborted();
    }
  });
  const source = createVoiceSeparatorSource({
    modelsDir: dir,
    policy: () => policy,
    available,
    download,
    create: () => separator(),
  });
  try {
    await vi.waitFor(() => expect(download).toHaveBeenCalledOnce());
    policy = { ...policy, reviewRequired: true };
    source.refresh();
    expect(aborted).toBe(true);
    policy = { ...policy, reviewRequired: false };
    source.refresh();
    await Promise.resolve();
    expect(available).toHaveBeenCalledTimes(1);
    held.resolve();
    expect(await source.settled()).toBe("ready");
    expect(available).toHaveBeenCalledTimes(2);
    expect(download).toHaveBeenCalledTimes(3);
  } finally {
    held.resolve();
    await source.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("superseded asynchronous creation is disposed without publication and disposal waits actual ownership", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omnesis-voice-create-"));
  const created = separator(),
    creation = deferred<VoiceSeparator>(),
    joined = deferred<void>();
  created.dispose = vi.fn(() => joined.promise);
  let policy: VoiceSeparatorPolicy = { mode: "local", reviewRequired: false };
  const create = vi.fn(() => creation.promise);
  const source = createVoiceSeparatorSource({
    modelsDir: dir,
    policy: () => policy,
    available: async () => true,
    download: async () => {},
    create,
  });
  try {
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    policy = { mode: "off", reviewRequired: false };
    source.refresh();
    creation.resolve(created);
    await vi.waitFor(() => expect(created.dispose).toHaveBeenCalledOnce());
    let finished = false;
    const waiting = source.settled().then((value) => {
      finished = true;
      return value;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    expect(source.current()).toBeNull();
    joined.resolve();
    expect(await waiting).toBe("off");
  } finally {
    creation.resolve(created);
    joined.resolve();
    await source.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("current-mode revocation joins an actual LocalVoiceSeparator's active worker before replacement preparation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omnesis-voice-live-owner-"));
  const joined = deferred<void>();
  let message: ((value: VoiceWorkerMessage) => void) | undefined,
    exit: ((value: { code: number | null; signal: string | null }) => void) | undefined;
  const write = vi.fn();
  const stop = vi.fn(() => joined.promise);
  const worker: VoiceWorkerProcess = {
    joined: joined.promise,
    write,
    stop,
    onMessage: (handler) => {
      message = handler;
    },
    onExit: (handler) => {
      exit = handler;
    },
  };
  let policy: VoiceSeparatorPolicy = { mode: "local", reviewRequired: false };
  const available = vi.fn(async () => true);
  const source = createVoiceSeparatorSource({
    modelsDir: directory,
    policy: () => policy,
    available,
    download: async () => {},
    create: (models) =>
      new LocalVoiceSeparator({
        models,
        model: "invented-worker-model",
        spawnWorker: () => worker,
      }),
  });
  try {
    expect(await source.settled()).toBe("ready");
    const active = source.current()!.group([new Float32Array([1, 0])], [1]);
    const rejected = expect(active).rejects.toThrow("disposed");
    await vi.waitFor(() => expect(message).toBeDefined());
    message!({ type: "ready" });
    await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
    policy = { mode: "off", reviewRequired: false };
    source.refresh();
    await rejected;
    policy = { mode: "local", reviewRequired: false };
    source.refresh();
    let ready = false;
    const settled = source.settled().then((value) => {
      ready = true;
      return value;
    });
    await Promise.resolve();
    expect(ready).toBe(false);
    expect(available).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledOnce();
    exit!({ code: null, signal: "SIGKILL" });
    joined.resolve();
    expect(await settled).toBe("ready");
    expect(available).toHaveBeenCalledTimes(2);
  } finally {
    joined.resolve();
    await source.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("disabled feature does not load models or masquerade as an explicit off choice", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omnesis-voice-disabled-"));
  let enabled = false;
  const available = vi.fn(async () => true),
    download = vi.fn(async () => {}),
    create = vi.fn(() => separator());
  const source = createVoiceSeparatorSource({
    modelsDir: directory,
    policy: () => ({ mode: "local", reviewRequired: false, enabled }),
    available,
    download,
    create,
  });
  try {
    expect(await source.settled()).toBe("unavailable");
    expect(source.current()).toBeNull();
    expect(available).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    enabled = true;
    source.refresh();
    expect(await source.settled()).toBe("ready");
    expect(create).toHaveBeenCalledOnce();
  } finally {
    await source.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("committed review ABA revokes the voice source while older change listeners are held", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omnesis-voice-commit-"));
  const store = new ConfigStore({ filePath: join(directory, "config.json") });
  const slow = deferred<void>(),
    firstNotified = deferred<void>(),
    secondNotified = deferred<void>();
  const observedReview: boolean[] = [];
  let stopSlow = () => {},
    stopBinding = () => {},
    stopProbe = () => {};
  let source: ReturnType<typeof createVoiceSeparatorSource> | undefined;
  let committed = 0,
    heard = 0;
  try {
    await store.load();
    const initial = await store.patch({
      inference: { recordings: { speakers: "replay", restoreReviewRequired: false } },
    });
    expect(initial).toMatchObject({
      ok: true,
      config: { inference: { recordings: { speakers: "replay", restoreReviewRequired: false } } },
    });
    source = createVoiceSeparatorSource({
      modelsDir: join(directory, "models"),
      policy: () => ({
        mode: store.get().inference?.recordings?.speakers ?? "off",
        reviewRequired: store.get().inference?.recordings?.restoreReviewRequired === true,
      }),
    });
    expect(await source.settled()).toBe("ready");
    const before = source.revision(),
      original = source.current();
    expect(original).not.toBeNull();
    const retired = vi.spyOn(original!, "dispose");
    stopSlow = store.onChange(() => slow.promise);
    // This is the same production binding used by runtime.ts, not a test callback copy.
    stopBinding = bindVoiceSeparatorPolicy(store, source);
    stopProbe = store.onChange((_before, after) => {
      observedReview.push(after.inference?.recordings?.restoreReviewRequired === true);
      heard += 1;
      if (heard === 1) firstNotified.resolve();
      if (heard === 2) secondNotified.resolve();
    });
    const enabled = await store.patch({
      inference: { recordings: { restoreReviewRequired: true } },
    });
    if (enabled.ok && enabled.changedPaths.length > 0) committed += 1;
    expect(enabled).toMatchObject({
      ok: true,
      config: { inference: { recordings: { restoreReviewRequired: true } } },
    });
    if (!enabled.ok) throw new Error("Review mutation refused");
    expect(enabled.changedPaths).toContain("/inference/recordings/restoreReviewRequired");
    // No source getter/manual refresh between the two commits: that could hide a broken binding.
    const disabled = await store.patch({
      inference: { recordings: { restoreReviewRequired: false } },
    });
    if (disabled.ok && disabled.changedPaths.length > 0) committed += 1;
    expect(disabled).toMatchObject({
      ok: true,
      config: { inference: { recordings: { restoreReviewRequired: false } } },
    });
    if (!disabled.ok) throw new Error("Review mutation refused");
    expect(disabled.changedPaths).toContain("/inference/recordings/restoreReviewRequired");
    expect(heard).toBe(0);
    expect(source.revision()).toBe(before + 2);
    expect(await source.settled()).toBe("ready");
    expect(source.current()).not.toBe(original);
    expect(retired).toHaveBeenCalledOnce();
    slow.resolve();
    await firstNotified.promise;
    await secondNotified.promise;
    expect(observedReview).toEqual([true, false]);
  } finally {
    slow.resolve();
    if (committed >= 1) await firstNotified.promise;
    if (committed >= 2) await secondNotified.promise;
    stopProbe();
    stopBinding();
    stopSlow();
    try {
      await source?.dispose();
    } finally {
      store.stop();
    }
    await rm(directory, { recursive: true, force: true });
  }
});
