// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it, vi } from "vitest";
import {
  watchCompleterCache,
  watchCompleterIdentity,
  watchCompleterKeyResolver,
} from "./engine-task.js";

function provider(name: string) {
  return {
    name,
    modelId: name,
    complete: vi.fn(async () => name),
    dispose: vi.fn(async () => {}),
  };
}

describe("Watch judge provider cache", () => {
  it("changes the production identity when HTTP or Anthropic credentials rotate", () => {
    const resolved = {
      role: "watch-judge",
      kind: "http",
      backendKey: "fictional",
      url: "https://example.com/v1",
      model: "judge-model",
      allowRemoteInference: true,
      available: true,
    } as const;
    const first = watchCompleterIdentity(resolved, "credential-a");
    const second = watchCompleterIdentity(resolved, "credential-b");
    expect(first).not.toBe(second);
    expect(first).not.toContain("credential-a");
    expect(JSON.parse(first)[1]).toHaveLength(64);
  });

  it("does not resolve or read credentials again until the mutation revision changes", () => {
    let revision = "1:0";
    const resolved = {
      role: "watch-judge",
      kind: "anthropic",
      catalogId: "anthropic/fictional-model",
      apiModelId: "fictional-model",
      allowRemoteInference: true,
      available: true,
    } as const;
    const resolve = vi.fn(() => resolved);
    const credentialIdentity = vi.fn(() => "0");
    const key = watchCompleterKeyResolver({
      revision: () => revision,
      resolve,
      credentialIdentity,
    });

    expect(key()).toBe(key());
    expect(resolve).toHaveBeenCalledOnce();
    expect(credentialIdentity).toHaveBeenCalledOnce();
    revision = "1:1";
    expect(key()).not.toBeUndefined();
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(credentialIdentity).toHaveBeenCalledTimes(2);
  });
  it("retries an unavailable assignment without a key", () => {
    const ready = provider("ready");
    const resolve = vi.fn().mockReturnValueOnce(null).mockReturnValue(ready);
    const cache = watchCompleterCache(resolve);

    expect(cache.get()).toBeNull();
    expect(cache.get()?.name).toBe("ready");
    expect(cache.get()?.name).toBe("ready");
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("replaces and disposes a provider when its assignment changes", async () => {
    let assignment = "judge/a";
    const first = provider("first");
    const second = provider("second");
    const resolve = vi.fn(() => (assignment === "judge/a" ? first : second));
    const cache = watchCompleterCache(resolve, () => assignment);

    expect(cache.get()?.name).toBe("first");
    expect(cache.get()?.name).toBe("first");
    expect(resolve).toHaveBeenCalledTimes(1);

    assignment = "judge/b";
    expect(cache.get()?.name).toBe("second");
    await vi.waitFor(() => expect(first.dispose).toHaveBeenCalledOnce());
    expect(resolve).toHaveBeenCalledTimes(2);

    await cache.dispose();
    expect(second.dispose).toHaveBeenCalledOnce();
  });

  it("rebuilds the provider when credentials rotate under the same assignment", async () => {
    let credentialFingerprint = "credential-a";
    const first = provider("first");
    const second = provider("second");
    const resolve = vi.fn().mockReturnValueOnce(first).mockReturnValue(second);
    const cache = watchCompleterCache(resolve, () =>
      JSON.stringify(["judge/model", credentialFingerprint]),
    );

    expect(cache.get()?.name).toBe("first");
    credentialFingerprint = "credential-b";
    expect(cache.get()?.name).toBe("second");
    await vi.waitFor(() => expect(first.dispose).toHaveBeenCalledOnce());
    expect(resolve).toHaveBeenCalledTimes(2);
    await cache.dispose();
  });

  it("drops an active provider when the role becomes unavailable", async () => {
    let assignment = "judge/a";
    const active = provider("active");
    const cache = watchCompleterCache(
      () => (assignment === "disabled" ? null : active),
      () => assignment,
    );

    expect(cache.get()?.name).toBe("active");
    assignment = "disabled";
    expect(cache.get()).toBeNull();
    await vi.waitFor(() => expect(active.dispose).toHaveBeenCalledOnce());
  });

  it("retries a provider construction that throws without losing the known-good generation", async () => {
    let assignment = "judge/a";
    let attempts = 0;
    const first = provider("first");
    const second = provider("second");
    const cache = watchCompleterCache(
      () => {
        if (assignment === "judge/a") return first;
        attempts += 1;
        if (attempts === 1) throw new Error("synthetic construction failure");
        return second;
      },
      () => assignment,
    );

    expect(cache.get()?.name).toBe("first");
    assignment = "judge/b";
    expect(() => cache.get()).toThrow(/synthetic construction failure/);
    expect(first.dispose).not.toHaveBeenCalled();
    expect(cache.get()?.name).toBe("second");
    await vi.waitFor(() => expect(first.dispose).toHaveBeenCalledOnce());
    await cache.dispose();
  });

  it("holds one provider lease across both calls of a body-backed judgement", async () => {
    let assignment = "judge/a";
    const first = provider("first");
    const second = provider("second");
    const cache = watchCompleterCache(
      () => (assignment === "judge/a" ? first : second),
      () => assignment,
    );
    const lease = cache.acquire()!;

    first.complete.mockResolvedValueOnce('{"decision":"matched"}');
    await lease.completer.complete("portable evidence");
    assignment = "judge/b";
    expect(cache.get()?.name).toBe("second");
    expect(first.dispose).not.toHaveBeenCalled();
    first.complete.mockResolvedValueOnce('{"decision":"confirm"}');
    await lease.completer.complete("body review");
    expect(first.dispose).not.toHaveBeenCalled();

    lease.release();
    await vi.waitFor(() => expect(first.dispose).toHaveBeenCalledOnce());
    await cache.dispose();
  });

  it("does not dispose a retired provider until its completion settles", async () => {
    let assignment = "judge/a";
    let finish = () => {};
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const first = provider("first");
    first.complete.mockImplementation(async () => {
      await pending;
      return "first";
    });
    const second = provider("second");
    const cache = watchCompleterCache(
      () => (assignment === "judge/a" ? first : second),
      () => assignment,
    );

    const completion = cache.get()!.complete("prompt");
    assignment = "judge/b";
    expect(cache.get()?.name).toBe("second");
    expect(first.dispose).not.toHaveBeenCalled();

    finish();
    await expect(completion).resolves.toBe("first");
    await vi.waitFor(() => expect(first.dispose).toHaveBeenCalledOnce());
    await cache.dispose();
  });

  it("contains synchronous and asynchronous disposal failures", async () => {
    const sync = provider("sync");
    sync.dispose.mockImplementation(() => {
      throw new Error("sync disposal failed");
    });
    const syncCache = watchCompleterCache(() => sync);
    syncCache.get();
    await expect(syncCache.dispose()).resolves.toBeUndefined();

    const asyncFailure = provider("async");
    asyncFailure.dispose.mockRejectedValue(new Error("async disposal failed"));
    const asyncCache = watchCompleterCache(() => asyncFailure);
    asyncCache.get();
    await expect(asyncCache.dispose()).resolves.toBeUndefined();
  });
});
