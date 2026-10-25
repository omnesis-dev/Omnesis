// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test, vi } from "vitest";
import { setLogLevel, LogLevel, type EntailCapability, type EntailVerdict } from "@omnesis/core";
import * as loader from "./entailment-loader.js";
import { EntailmentVerifierService } from "./entailment-service.js";
import type { ChatBackend } from "@omnesis/agent";

test("Codex entailment reports usage and revokes a cached verifier when cloud egress is disabled", async () => {
  let allowRemoteInference = true;
  const backend: ChatBackend = {
    name: "codex",
    model: "example-model",
    async *runTurn(input) {
      const ids = { sessionId: input.sessionId, messageId: input.messageId };
      yield { type: "agent.text.delta", payload: { ...ids, delta: "NEUTRAL" } };
      yield {
        type: "agent.message.end",
        payload: { ...ids, stopReason: "end_turn", usage: { inputTokens: 31, outputTokens: 2 } },
      };
    },
  };
  const createBackend = vi.fn().mockReturnValue(backend);
  const recordUsage = vi.fn();
  const service = new EntailmentVerifierService({
    resolveAssignment: () => ({
      role: "entailment-verifier",
      kind: "codex",
      model: "example-model",
      available: true,
      allowRemoteInference,
    }),
    deps: {
      configDir: "/unused",
      getPromptStyle: () => "judge",
      codexRuntimeService: { createBackend },
      recordUsage,
    },
  });
  const verifier = await service.get();
  expect(
    await verifier!.verify({ claim: "The task finished", evidence: "The task was planned" }),
  ).toMatchObject({ label: "neutral" });
  expect(recordUsage).toHaveBeenCalledWith({
    promptTokens: 31,
    completionTokens: 2,
    modelId: "example-model",
  });
  allowRemoteInference = false;
  await expect(verifier!.verify({ claim: "A", evidence: "B" })).rejects.toThrow("unavailable");
  expect(await service.get()).toBeNull();
  expect(createBackend).toHaveBeenCalledTimes(1);
  allowRemoteInference = true;
  expect(await service.get()).not.toBeNull();
  expect(createBackend).toHaveBeenCalledTimes(2);
  await service.dispose();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixtureService() {
  let model = "first";
  const resolveAssignment = vi.fn(() => ({
    role: "entailment-verifier" as const,
    kind: "local" as const,
    catalogId: model,
    modelPath: "/fictional/model",
    available: true,
  }));
  return {
    service: new EntailmentVerifierService({
      resolveAssignment,
      deps: { configDir: "/unused", getPromptStyle: () => "judge" },
    }),
    resolveAssignment,
    swap: () => {
      model = "second";
    },
  };
}

test("expired queued get and verify skip resolution and inference while the next waiter progresses", async () => {
  const completion = deferred<EntailVerdict>();
  const started = deferred<void>();
  const verify = vi.fn(async () => {
    started.resolve();
    return completion.promise;
  });
  const load = vi
    .spyOn(loader, "loadEntailmentFromResolved")
    .mockResolvedValue({ verify, dispose() {} });
  const { service, resolveAssignment } = fixtureService();
  try {
    const facade = (await service.get())!;
    const first = facade.verify({ claim: "A", evidence: "B" });
    await started.promise;
    const cancelled = new AbortController();
    const get = service.get(cancelled.signal);
    const check = facade.verify({ claim: "C", evidence: "D", signal: cancelled.signal });
    const refused = Promise.all([
      expect(get).rejects.toThrow("cancelled fixture"),
      expect(check).rejects.toThrow("cancelled fixture"),
    ]);
    cancelled.abort(new Error("cancelled fixture"));
    await refused;
    const resolutions = resolveAssignment.mock.calls.length;
    const next = service.get();
    completion.resolve({ label: "neutral" });
    await first;
    await expect(next).resolves.toBe(facade);
    expect(resolveAssignment).toHaveBeenCalledTimes(resolutions + 1);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(1);
    await service.dispose();
  } finally {
    load.mockRestore();
  }
});

test("caller-visible cancellation retains the native-like settlement fence across config swap and disposal", async () => {
  const completion = deferred<EntailVerdict>(),
    started = deferred<void>();
  const order: string[] = [];
  const load = vi
    .spyOn(loader, "loadEntailmentFromResolved")
    .mockResolvedValueOnce({
      verify: async () => {
        started.resolve();
        const value = await completion.promise;
        order.push("settled");
        return value;
      },
      dispose() {
        order.push("old-disposed");
      },
    })
    .mockResolvedValueOnce({
      verify: async () => ({ label: "neutral" }),
      dispose() {
        order.push("new-disposed");
      },
    });
  const { service, swap } = fixtureService();
  try {
    const facade = (await service.get())!;
    const controller = new AbortController();
    const pending = facade.verify({ claim: "A", evidence: "B", signal: controller.signal });
    const refused = expect(pending).rejects.toThrow("cancelled fixture");
    await started.promise;
    controller.abort(new Error("cancelled fixture"));
    await refused;
    swap();
    const next = service.get();
    const disposal = service.dispose();
    await Promise.resolve();
    expect(order).toEqual([]);
    expect(load).toHaveBeenCalledTimes(1);
    completion.resolve({ label: "entailment" });
    await next;
    await disposal;
    expect(order).toEqual(["settled", "old-disposed", "new-disposed"]);
  } finally {
    load.mockRestore();
  }
});

test("aborting while loading prevents inference without disposing shared capability", async () => {
  const loading = deferred<EntailCapability | null>(),
    started = deferred<void>();
  const verify = vi.fn(async () => ({ label: "neutral" as const })),
    dispose = vi.fn();
  const load = vi.spyOn(loader, "loadEntailmentFromResolved").mockImplementation(async () => {
    started.resolve();
    return loading.promise;
  });
  const { service } = fixtureService();
  try {
    const controller = new AbortController();
    const pending = service.get(controller.signal);
    const refused = expect(pending).rejects.toThrow("cancelled fixture");
    await started.promise;
    controller.abort(new Error("cancelled fixture"));
    await refused;
    loading.resolve({ verify, dispose });
    expect(await service.get()).not.toBeNull();
    expect(verify).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
    await service.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  } finally {
    load.mockRestore();
  }
});

test("reports bounded service-stage timings without input or provider error text", async () => {
  setLogLevel(LogLevel.INFO);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const clock = vi.spyOn(performance, "now");
  let now = 0;
  clock.mockImplementation(() => now);
  const completion = deferred<EntailVerdict>();
  const started = deferred<void>();
  const load = vi.spyOn(loader, "loadEntailmentFromResolved").mockResolvedValue({
    verify: async () => {
      started.resolve();
      return completion.promise;
    },
    dispose() {},
  });
  const { service } = fixtureService();
  try {
    const facade = (await service.get())!;
    const first = facade.verify({ claim: "private candidate", evidence: "private source" });
    await started.promise;
    const controller = new AbortController();
    const next = expect(
      facade.verify({
        claim: "private second",
        evidence: "private context",
        signal: controller.signal,
      }),
    ).rejects.toThrow("private provider failure");
    now = 30;
    controller.abort(new Error("private provider failure"));
    await next;
    completion.resolve({ label: "neutral" });
    await first;
    await service.dispose();
    const output = stderr.mock.calls.map(([value]) => String(value)).join("\n");
    expect(output).toContain(
      "operation=verify contended=true boundary=caller status=cancelled stage=queued queueWaitMs=30 loadMs=0 verifyMs=0",
    );
    expect(output).toContain("boundary=operation status=cancelled stage=queued");
    expect(output).toMatch(/id=[a-f0-9-]{36}/);
    expect(output).not.toContain("private");
  } finally {
    load.mockRestore();
    clock.mockRestore();
    stderr.mockRestore();
  }
});

test("propagates facade cancellation to the Codex backend and releases the next operation", async () => {
  const started = deferred<void>();
  let received: AbortSignal | undefined;
  let closed = false;
  const backend: ChatBackend = {
    name: "codex",
    model: "fixture",
    async *runTurn(_input, signal) {
      if (!signal) throw new Error("Cancellation signal required");
      received = signal;
      try {
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
          started.resolve();
        });
        yield* [];
      } finally {
        closed = true;
      }
    },
  };
  const service = new EntailmentVerifierService({
    resolveAssignment: () => ({
      role: "entailment-verifier",
      kind: "codex",
      model: "fixture",
      available: true,
      allowRemoteInference: true,
    }),
    deps: {
      configDir: "/unused",
      getPromptStyle: () => "judge",
      codexRuntimeService: { createBackend: vi.fn().mockReturnValue(backend) },
    },
  });
  const facade = (await service.get())!;
  const controller = new AbortController();
  const checking = expect(
    facade.verify({ claim: "fixture", evidence: "fixture", signal: controller.signal }),
  ).rejects.toThrow("caller stopped");
  await started.promise;
  controller.abort(new Error("caller stopped"));
  await checking;
  expect(received?.aborted).toBe(true);
  await service.get();
  expect(closed).toBe(true);
  await service.dispose();
});

test.each(["http", "anthropic", "codex"] as const)(
  "bounds %s operations at two and drains the whole generation",
  async (kind) => {
    let model = "first";
    const entered: string[] = [];
    const releases = new Map<string, ReturnType<typeof deferred<EntailVerdict>>>();
    const disposed: string[] = [];
    const load = vi.spyOn(loader, "loadEntailmentFromResolved").mockImplementation(async () => {
      const generation = model;
      return {
        verify: async ({ claim }) => {
          entered.push(claim);
          const done = deferred<EntailVerdict>();
          releases.set(claim, done);
          return done.promise;
        },
        dispose: () => {
          disposed.push(generation);
        },
      };
    });
    const service = new EntailmentVerifierService({
      resolveAssignment: () =>
        kind === "http"
          ? {
              role: "entailment-verifier",
              kind,
              backendKey: "test",
              url: "https://example.org",
              model,
              available: true,
              allowRemoteInference: true,
            }
          : kind === "anthropic"
            ? {
                role: "entailment-verifier",
                kind,
                catalogId: model,
                apiModelId: model,
                available: true,
                allowRemoteInference: true,
              }
            : {
                role: "entailment-verifier",
                kind,
                model,
                available: true,
                allowRemoteInference: true,
              },
      deps: { configDir: "/unused", getPromptStyle: () => "judge" },
    });
    try {
      const facade = (await service.get())!;
      const a = facade.verify({ claim: "a", evidence: "e" });
      const b = facade.verify({ claim: "b", evidence: "e" });
      await vi.waitFor(() => expect(entered).toEqual(["a", "b"]));
      expect(await service.get()).toBe(facade);
      const cancelled = new AbortController();
      const c = expect(
        facade.verify({ claim: "c", evidence: "e", signal: cancelled.signal }),
      ).rejects.toThrow("stop");
      cancelled.abort(new Error("stop"));
      await c;
      model = "second";
      const next = service.get();
      await Promise.resolve();
      expect(disposed).toEqual([]);
      releases.get("a")!.resolve({ label: "neutral" });
      await a;
      await Promise.resolve();
      expect(disposed).toEqual([]);
      releases.get("b")!.resolve({ label: "entailment" });
      await expect(b).resolves.toMatchObject({ label: "entailment" });
      await next;
      expect(disposed).toEqual(["first"]);
      expect(entered).toEqual(["a", "b"]);
      await service.dispose();
      expect(disposed).toEqual(["first", "second"]);
    } finally {
      for (const done of releases.values()) done.resolve({ label: "neutral" });
      await service.dispose();
      load.mockRestore();
    }
  },
);

test("Codex verifier cancellation retains its own cleanup lease without coupling the sibling", async () => {
  const started = deferred<void>();
  const cleanup = deferred<void>();
  const closing = deferred<void>();
  let calls = 0;
  const usage = vi.fn();
  const backend: ChatBackend = {
    name: "codex",
    model: "example-model",
    async *runTurn(input, signal) {
      const call = ++calls;
      if (call === 1) {
        started.resolve();
        try {
          await new Promise<void>((resolve) =>
            signal!.addEventListener("abort", () => resolve(), { once: true }),
          );
          signal!.throwIfAborted();
        } finally {
          closing.resolve();
          await cleanup.promise;
        }
      }
      const ids = { sessionId: input.sessionId, messageId: input.messageId };
      yield { type: "agent.text.delta", payload: { ...ids, delta: "NEUTRAL" } };
      yield {
        type: "agent.message.end",
        payload: { ...ids, stopReason: "end_turn", usage: { inputTokens: call, outputTokens: 1 } },
      };
    },
  };
  const service = new EntailmentVerifierService({
    resolveAssignment: () => ({
      role: "entailment-verifier",
      kind: "codex",
      model: "example-model",
      available: true,
      allowRemoteInference: true,
    }),
    deps: {
      configDir: "/unused",
      getPromptStyle: () => "judge",
      codexRuntimeService: { createBackend: vi.fn().mockReturnValue(backend) },
      recordUsage: usage,
    },
  });
  const facade = (await service.get())!;
  const controller = new AbortController();
  const first = expect(
    facade.verify({ claim: "first", evidence: "first", signal: controller.signal }),
  ).rejects.toThrow("stop");
  await started.promise;
  controller.abort(new Error("stop"));
  await first;
  await closing.promise;
  await expect(facade.verify({ claim: "second", evidence: "second" })).resolves.toMatchObject({
    label: "neutral",
  });
  expect(usage).toHaveBeenCalledExactlyOnceWith({
    modelId: "example-model",
    promptTokens: 2,
    completionTokens: 1,
  });
  let disposed = false;
  const disposal = service.dispose().then(() => {
    disposed = true;
  });
  await Promise.resolve();
  expect(disposed).toBe(false);
  cleanup.resolve();
  await disposal;
  expect(disposed).toBe(true);
});

test("remote admission refills one settled slot without waiting for its sibling", async () => {
  const slots = new Map<string, ReturnType<typeof deferred<EntailVerdict>>>();
  const load = vi.spyOn(loader, "loadEntailmentFromResolved").mockResolvedValue({
    verify: ({ claim }) => {
      const slot = deferred<EntailVerdict>();
      slots.set(claim, slot);
      return slot.promise;
    },
    dispose() {},
  });
  const service = new EntailmentVerifierService({
    resolveAssignment: () => ({
      role: "entailment-verifier",
      kind: "codex",
      model: "fixture",
      available: true,
      allowRemoteInference: true,
    }),
    deps: { configDir: "/unused", getPromptStyle: () => "judge" },
  });
  try {
    const facade = (await service.get())!;
    const first = facade.verify({ claim: "one", evidence: "e" });
    const second = facade.verify({ claim: "two", evidence: "e" });
    const third = facade.verify({ claim: "three", evidence: "e" });
    await vi.waitFor(() => expect([...slots.keys()]).toEqual(["one", "two"]));
    slots.get("one")!.resolve({ label: "neutral" });
    await first;
    await vi.waitFor(() => expect([...slots.keys()]).toEqual(["one", "two", "three"]));
    slots.get("three")!.resolve({ label: "entailment" });
    await expect(third).resolves.toMatchObject({ label: "entailment" });
    slots.get("two")!.resolve({ label: "neutral" });
    await second;
  } finally {
    for (const slot of slots.values()) slot.resolve({ label: "neutral" });
    await service.dispose();
    load.mockRestore();
  }
});

test("re-resolves an assignment changed again while the prior generation drains", async () => {
  let model = "initial";
  const held = deferred<EntailVerdict>();
  const started = deferred<void>();
  const loaded: string[] = [];
  const load = vi.spyOn(loader, "loadEntailmentFromResolved").mockImplementation(async () => {
    loaded.push(model);
    return {
      verify: () => {
        started.resolve();
        return held.promise;
      },
      dispose() {},
    };
  });
  const service = new EntailmentVerifierService({
    resolveAssignment: () => ({
      role: "entailment-verifier",
      kind: "codex",
      model,
      available: true,
      allowRemoteInference: true,
    }),
    deps: { configDir: "/unused", getPromptStyle: () => "judge" },
  });
  try {
    const facade = (await service.get())!;
    const running = facade.verify({ claim: "c", evidence: "e" });
    await started.promise;
    model = "intermediate";
    const next = service.get();
    await new Promise<void>((resolve) => setImmediate(resolve));
    model = "final";
    held.resolve({ label: "neutral" });
    await running;
    await next;
    expect(loaded).toEqual(["initial", "final"]);
  } finally {
    held.resolve({ label: "neutral" });
    await service.dispose();
    load.mockRestore();
  }
});

test("cancellation during generation disposal does not load a replacement", async () => {
  const disposing = deferred<void>();
  const disposed = deferred<void>();
  const load = vi.spyOn(loader, "loadEntailmentFromResolved").mockResolvedValue({
    verify: async () => ({ label: "neutral" }),
    dispose: async () => {
      disposing.resolve();
      await disposed.promise;
    },
  });
  const { service, swap } = fixtureService();
  try {
    await service.get();
    swap();
    const controller = new AbortController();
    const next = expect(service.get(controller.signal)).rejects.toThrow("stop during disposal");
    await disposing.promise;
    controller.abort(new Error("stop during disposal"));
    await next;
    disposed.resolve();
    await service.dispose();
    expect(load).toHaveBeenCalledTimes(1);
  } finally {
    disposed.resolve();
    await service.dispose();
    load.mockRestore();
  }
});

test("native generation admits one healthy verification at a time", async () => {
  const first = deferred<EntailVerdict>();
  const started = deferred<void>();
  const verify = vi.fn(async () => {
    if (verify.mock.calls.length === 1) {
      started.resolve();
      return first.promise;
    }
    return { label: "neutral" as const };
  });
  const load = vi
    .spyOn(loader, "loadEntailmentFromResolved")
    .mockResolvedValue({ verify, dispose() {} });
  const { service } = fixtureService();
  try {
    const facade = (await service.get())!;
    const a = facade.verify({ claim: "a", evidence: "e" });
    await started.promise;
    const b = facade.verify({ claim: "b", evidence: "e" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(verify).toHaveBeenCalledTimes(1);
    first.resolve({ label: "entailment" });
    await expect(a).resolves.toMatchObject({ label: "entailment" });
    await expect(b).resolves.toMatchObject({ label: "neutral" });
    expect(verify).toHaveBeenCalledTimes(2);
  } finally {
    first.resolve({ label: "neutral" });
    await service.dispose();
    load.mockRestore();
  }
});
