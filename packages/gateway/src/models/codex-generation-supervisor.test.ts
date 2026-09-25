// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";

import { z } from "zod";
import {
  CodexGenerationSupervisor,
  type CodexRuntimeGeneration,
} from "./codex-generation-supervisor.js";
import type {
  CodexAppServerRuntime,
  CodexRuntimePool,
  CodexRuntimeTurnOptions,
} from "@omnesis/agent";
import type { AgentEvent } from "@omnesis/core";

function generation(): CodexRuntimeGeneration {
  return {
    runtime: { dispose: async () => {} } as unknown as CodexAppServerRuntime,
    interactivePool: null,
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("CodexGenerationSupervisor", () => {
  it("serializes generation switches and keeps admission closed across queued switches", async () => {
    const firstGeneration = generation();
    const secondGeneration = generation();
    const thirdGeneration = generation();
    const supervisor = new CodexGenerationSupervisor(firstGeneration);
    const activeTurn = deferred();
    const entered: string[] = [];

    const active = supervisor.use(async (selected) => {
      expect(selected).toBe(firstGeneration);
      await activeTurn.promise;
    });
    await Promise.resolve();

    const firstSwitch = supervisor.exclusive(async (_selected, replace) => {
      entered.push("first");
      replace(secondGeneration);
    });
    const secondSwitch = supervisor.exclusive(async (selected, replace) => {
      entered.push("second");
      expect(selected).toBe(secondGeneration);
      replace(thirdGeneration);
    });
    let admitted = false;
    const waitingUse = supervisor.use(async (selected) => {
      admitted = true;
      expect(selected).toBe(thirdGeneration);
    });

    await Promise.resolve();
    expect(entered).toEqual([]);
    expect(admitted).toBe(false);

    activeTurn.resolve();
    await Promise.all([active, firstSwitch, secondSwitch, waitingUse]);
    expect(entered).toEqual(["first", "second"]);
    expect(admitted).toBe(true);
  });

  it("abandons a queued switch when its owner shuts down", async () => {
    const supervisor = new CodexGenerationSupervisor(generation());
    const activeTurn = deferred();
    const active = supervisor.use(async () => activeTurn.promise);
    await Promise.resolve();
    const abort = new AbortController();
    const switching = supervisor.exclusive(async () => {
      throw new Error("must not activate");
    }, abort.signal);

    abort.abort();
    await expect(switching).rejects.toMatchObject({ name: "AbortError" });
    activeTurn.resolve();
    await active;
    await expect(supervisor.use(async () => "ready")).resolves.toBe("ready");
  });

  it("does not let a successor overtake an aborted middle switch", async () => {
    const supervisor = new CodexGenerationSupervisor(generation());
    const firstGate = deferred();
    const firstEntered = deferred();
    const entered: string[] = [];
    const first = supervisor.exclusive(async () => {
      entered.push("first");
      firstEntered.resolve();
      await firstGate.promise;
    });
    await firstEntered.promise;

    const abort = new AbortController();
    const middle = supervisor.exclusive(async () => {
      entered.push("middle");
    }, abort.signal);
    const last = supervisor.exclusive(async () => {
      entered.push("last");
    });
    abort.abort();
    await Promise.resolve();
    expect(entered).toEqual(["first"]);

    firstGate.resolve();
    await first;
    await expect(middle).rejects.toMatchObject({ name: "AbortError" });
    await last;
    expect(entered).toEqual(["first", "last"]);
  });
});

function turnOptions(): CodexRuntimeTurnOptions {
  return {
    model: "gpt-example",
    maxToolIterations: 4,
    toolTimeoutMs: 1000,
    input: {
      sessionId: "synthetic-session",
      messageId: "synthetic-message",
      userMessage: "Review invented facts",
      history: [],
      systemPrompt: "Use provided facts",
      tools: [],
    },
  };
}

async function consume(events: AsyncIterable<AgentEvent>): Promise<void> {
  for await (const event of events) void event;
}

describe("Codex nested execution admission", () => {
  it("allows a parent's child through a pending generation drain while keeping unrelated arrivals queued", async () => {
    const selected = generation();
    const entered = deferred();
    const invokeChild = deferred();
    const childEntered = deferred();
    const finishChild = deferred();
    const depths: number[] = [];
    selected.runtime.runTurn = async function* (options) {
      yield* [];
      entered.resolve();
      await invokeChild.promise;
      await options.input.tools[0].invoke(
        {},
        { sessionId: "synthetic-session", messageId: "synthetic-message" },
      );
    };
    selected.nestedPool = (depth) => {
      depths.push(depth);
      return {
        runTurn: async function* () {
          yield* [];
          childEntered.resolve();
          await finishChild.promise;
        },
      } as unknown as CodexRuntimePool;
    };
    const supervisor = new CodexGenerationSupervisor(selected);
    const opts = turnOptions();
    opts.input.tools = [
      {
        name: "review",
        description: "Review facts",
        schema: z.object({}),
        invoke: async () => {
          await consume(supervisor.runner("inference").runTurn(turnOptions()));
          return { kind: "error", code: "synthetic", message: "done" };
        },
        summarize: () => "review",
      },
    ];
    const parent = consume(supervisor.runner("background").runTurn(opts));
    await entered.promise;
    let switched = false;
    const switching = supervisor.exclusive(async () => {
      switched = true;
    });
    let unrelatedEntered = false;
    const unrelated = supervisor.use(async () => {
      unrelatedEntered = true;
    });
    invokeChild.resolve();
    await childEntered.promise;
    expect(depths).toEqual([1]);
    expect(supervisor.activeUses).toBe(2);
    expect(switched).toBe(false);
    expect(unrelatedEntered).toBe(false);
    finishChild.resolve();
    await Promise.all([parent, switching, unrelated]);
    expect(switched).toBe(true);
    expect(unrelatedEntered).toBe(true);
  });

  it("uses separate depths for grandchildren even when their parents occupy the available pool", async () => {
    const selected = generation();
    const supervisor = new CodexGenerationSupervisor(selected);
    const depths: number[] = [];
    const invoke = async function* (opts: CodexRuntimeTurnOptions): AsyncIterable<AgentEvent> {
      yield* [];
      await opts.input.tools[0]?.invoke(
        {},
        { sessionId: "synthetic-session", messageId: "synthetic-message" },
      );
    };
    selected.runtime.runTurn = invoke;
    selected.nestedPool = (depth) => {
      depths.push(depth);
      return { runTurn: invoke } as unknown as CodexRuntimePool;
    };
    const nested = (remaining: number): CodexRuntimeTurnOptions => {
      const opts = turnOptions();
      if (remaining > 0)
        opts.input.tools = [
          {
            name: "child",
            description: "Run child",
            schema: z.object({}),
            summarize: () => "child",
            invoke: async () => {
              await consume(supervisor.runner("interactive").runTurn(nested(remaining - 1)));
              return { kind: "error", code: "synthetic", message: "done" };
            },
          },
        ];
      return opts;
    };
    await consume(supervisor.runner("background").runTurn(nested(2)));
    expect(depths).toEqual([1, 2]);
    expect(supervisor.activeUses).toBe(0);
  });

  it("does not admit delayed work through an already released parent lease", async () => {
    const selected = generation();
    const replacement = generation();
    const supervisor = new CodexGenerationSupervisor(selected);
    const childStart = deferred();
    const switchEntered = deferred();
    const finishSwitch = deferred();
    let child: Promise<void> | undefined;
    let entered = false;
    replacement.nestedPool = () =>
      ({
        runTurn: async function* () {
          yield* [];
          entered = true;
        },
      }) as unknown as CodexRuntimePool;
    selected.runtime.runTurn = async function* (opts) {
      yield* [];
      await opts.input.tools[0].invoke(
        {},
        { sessionId: "synthetic-session", messageId: "synthetic-message" },
      );
    };
    const opts = turnOptions();
    opts.input.tools = [
      {
        name: "launch",
        description: "Launch delayed work",
        schema: z.object({}),
        summarize: () => "launch",
        invoke: async () => {
          child = childStart.promise.then(() =>
            consume(supervisor.runner("interactive").runTurn(turnOptions())),
          );
          return { kind: "error", code: "synthetic", message: "done" };
        },
      },
    ];
    await consume(supervisor.runner("background").runTurn(opts));
    const switching = supervisor.exclusive(async (_previous, replace) => {
      switchEntered.resolve();
      await finishSwitch.promise;
      replace(replacement);
    });
    await switchEntered.promise;
    childStart.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(entered).toBe(false);
    finishSwitch.resolve();
    await Promise.all([switching, child]);
    expect(entered).toBe(true);
  });

  it("disposes the owner, inference, interactive, and lazily allocated nested pools", async () => {
    const selected = generation();
    const disposed: string[] = [];
    const pool = (name: string) =>
      ({
        dispose: async () => {
          disposed.push(name);
        },
      }) as unknown as CodexRuntimePool;
    selected.runtime.dispose = async () => {
      disposed.push("owner");
    };
    selected.interactivePool = pool("interactive");
    selected.inferencePool = pool("inference");
    selected.nestedPools = new Map([
      [1, pool("child")],
      [2, pool("grandchild")],
    ]);
    await new CodexGenerationSupervisor(selected).dispose();
    expect(disposed.sort()).toEqual(["child", "grandchild", "inference", "interactive", "owner"]);
  });

  it("cancels an admission waiter without waiting for a generation switch", async () => {
    const supervisor = new CodexGenerationSupervisor(generation());
    const gate = deferred();
    const entered = deferred();
    const switching = supervisor.exclusive(async () => {
      entered.resolve();
      await gate.promise;
    });
    await entered.promise;
    const controller = new AbortController();
    const pending = consume(
      supervisor.runner("interactive").runTurn({ ...turnOptions(), signal: controller.signal }),
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(supervisor.activeUses).toBe(0);
    gate.resolve();
    await switching;
  });
});
