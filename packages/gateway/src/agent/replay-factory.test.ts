// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Verifies the directory-mode replay factory re-reads its fixtures
 * directory on every session-create — so demo authors can edit
 * `.jsonl` files, add new scenarios, or remove old ones without
 * restarting the gateway.
 *
 * The boot-time load still happens (early validation pass); after
 * that every invocation of the factory walks the disk fresh and
 * falls back to the last known-good set if the reload throws.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createLogger, type AgentEvent } from "@omnesis/core";
import { createDatabase } from "../db.js";
import { makeReplayBackendFactory } from "./replay-factory.js";
import type { ChatBackend, RoutingReplayBackend, TurnInput } from "@omnesis/agent";
import type Database from "better-sqlite3";

type Db = Database.Database;

interface Harness {
  db: Db;
  dir: string;
  cleanup: () => void;
}

function writeScenario(
  dir: string,
  name: string,
  openingDelta: string,
  role?: string,
  afterMs = 10,
): void {
  const events = [
    {
      afterMs: 0,
      event: {
        type: "agent.message.start",
        payload: { sessionId: "$SESSION", messageId: "$MSG", role: "assistant" },
      },
    },
    {
      afterMs,
      event: {
        type: "agent.text.delta",
        payload: { sessionId: "$SESSION", messageId: "$MSG", delta: openingDelta },
      },
    },
    {
      afterMs,
      event: {
        type: "agent.message.end",
        payload: { sessionId: "$SESSION", messageId: "$MSG", stopReason: "end_turn" },
      },
    },
  ];
  writeFileSync(join(dir, `${name}.jsonl`), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  writeFileSync(
    join(dir, `${name}.meta.json`),
    JSON.stringify(role ? { triggers: [name], role } : { triggers: [name] }) + "\n",
  );
}

function setup(): Harness {
  const tmpRoot = mkdtempSync(join(tmpdir(), "omnesis-replay-factory-test-"));
  const dir = join(tmpRoot, "demos");
  mkdirSync(dir, { recursive: true });
  writeScenario(dir, "alpha", "alpha greeting");
  const db = createDatabase(join(tmpRoot, "test.db"));
  return {
    db,
    dir,
    cleanup: () => {
      db.close();
      rmSync(tmpRoot, { recursive: true, force: true });
    },
  };
}

function scenarioNames(backend: unknown): string[] {
  // The RoutingReplayBackend stores its scenarios on a private field;
  // assert through its public-ish surface by extracting them via the
  // documented `scenarios` getter shape used elsewhere in the agent
  // package. If knip's privacy gate ever hides this we can switch to
  // exercising the backend through a routed call.
  const b = backend as RoutingReplayBackend & {
    scenarios: ReadonlyArray<{ name: string }>;
  };
  return [...b.scenarios].map((s) => s.name).sort();
}

describe("makeReplayBackendFactory — directory mode hot reload", () => {
  let h: Harness;
  beforeEach(() => {
    h = setup();
  });
  afterEach(() => {
    h.cleanup();
  });

  it("picks up new scenarios added to the directory between session-creates", () => {
    const factory = makeReplayBackendFactory({
      fixturePath: h.dir,
      db: h.db,
      log: createLogger("test"),
    });

    expect(scenarioNames(factory())).toEqual(["alpha"]);

    // Author adds a second scenario mid-session — next session-create
    // should see it without a gateway restart.
    writeScenario(h.dir, "beta", "beta greeting");
    expect(scenarioNames(factory())).toEqual(["alpha", "beta"]);

    // …and removing a scenario takes effect on the next call too.
    unlinkSync(join(h.dir, "alpha.jsonl"));
    unlinkSync(join(h.dir, "alpha.meta.json"));
    expect(scenarioNames(factory())).toEqual(["beta"]);
  });

  it("falls back to the last known-good set when reload throws mid-edit", () => {
    const factory = makeReplayBackendFactory({
      fixturePath: h.dir,
      db: h.db,
      log: createLogger("test"),
    });
    expect(scenarioNames(factory())).toEqual(["alpha"]);

    // Simulate an author saving a .jsonl with broken JSON. Reload
    // throws, but the factory must keep the previous scenarios alive.
    writeFileSync(join(h.dir, "alpha.jsonl"), "{not valid json");
    expect(scenarioNames(factory())).toEqual(["alpha"]);

    // Fixed save (back to valid JSON) — the reload picks it up again.
    writeScenario(h.dir, "alpha", "alpha greeting v2");
    expect(scenarioNames(factory())).toEqual(["alpha"]);
  });
});

describe("makeReplayBackendFactory — one directory, several roles", () => {
  let h: Harness;
  beforeEach(() => {
    h = setup();
    writeScenario(h.dir, "review", "a review", "privacy-reviewer");
  });
  afterEach(() => {
    h.cleanup();
  });

  function factoryFor(role?: string) {
    return makeReplayBackendFactory({
      fixturePath: h.dir,
      db: h.db,
      ...(role ? { role } : {}),
      log: createLogger("test"),
    });
  }

  it("gives each role only the scenarios that declare it", () => {
    // A cassette with no `role` is the chat agent's, which is what every
    // scenario written before roles existed relies on.
    expect(scenarioNames(factoryFor()())).toEqual(["alpha"]);
    expect(scenarioNames(factoryFor("agent")())).toEqual(["alpha"]);
    expect(scenarioNames(factoryFor("privacy-reviewer")())).toEqual(["review"]);
  });

  it("refuses to build a backend for a role the directory serves no scenario for", () => {
    expect(() => factoryFor("background-agent")).toThrow(/no scenario for role 'background-agent'/);
  });
});

describe("makeReplayBackendFactory — replay pacing", () => {
  let h: Harness;
  const input = {
    sessionId: "test-session",
    messageId: "test-message",
    history: [],
    userMessage: "alpha",
    tools: [],
    systemPrompt: "",
  } satisfies TurnInput;

  beforeEach(() => {
    h = setup();
    writeScenario(h.dir, "alpha", "alpha greeting", undefined, 1_000);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    h.cleanup();
  });

  function backend(mode: "file" | "directory", pacing?: "immediate"): ChatBackend {
    return makeReplayBackendFactory({
      fixturePath: mode === "file" ? join(h.dir, "alpha.jsonl") : h.dir,
      db: h.db,
      pacing,
      log: createLogger("test"),
    })();
  }

  async function collect(backend: ChatBackend, events: AgentEvent[]): Promise<void> {
    for await (const event of backend.runTurn(input)) events.push(event);
  }

  it.each(["file", "directory"] as const)(
    "%s mode retains demo delays by default and emits the identical chunked stream immediately",
    async (mode) => {
      const paced: AgentEvent[] = [];
      const pacedRun = collect(backend(mode), paced);
      await vi.advanceTimersByTimeAsync(59);
      expect(paced).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(paced.map((event) => event.type)).toEqual(["agent.message.start"]);
      await vi.runAllTimersAsync();
      await pacedRun;

      const immediate: AgentEvent[] = [];
      const started = Date.now();
      const immediateRun = collect(backend(mode, "immediate"), immediate);
      await vi.runAllTimersAsync();
      await immediateRun;

      // Virtual time proves the mode removes both entry delays and demo typing
      // delays, without a flaky real-clock performance assertion.
      expect(Date.now() - started).toBeLessThan(44);
      expect(immediate).toEqual(paced);
      const chunks = immediate.filter((event) => event.type === "agent.text.delta");
      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.map((event) => event.payload.delta).join("")).toBe("alpha greeting");
      expect(immediate.at(-1)?.type).toBe("agent.message.end");
    },
  );

  it("scales scenario entry floors, long waits and typing together without changing events", async () => {
    const normal: AgentEvent[] = [];
    const normalStart = Date.now();
    const normalRun = collect(backend("directory"), normal);
    await vi.runAllTimersAsync();
    await normalRun;
    const normalMs = Date.now() - normalStart;

    writeFileSync(
      join(h.dir, "alpha.meta.json"),
      JSON.stringify({ triggers: ["alpha"], speed: 3 }),
    );
    const fast: AgentEvent[] = [];
    const fastStart = Date.now();
    const fastRun = collect(backend("directory"), fast);
    await vi.advanceTimersByTimeAsync(19);
    expect(fast).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(fast.map((event) => event.type)).toEqual(["agent.message.start"]);
    await vi.runAllTimersAsync();
    await fastRun;
    const fastMs = Date.now() - fastStart;
    expect(fast).toEqual(normal);
    // Node timers truncate fractional milliseconds: allow less than 1 ms per
    // replay wait while proving both fixture and text-chunk delays scale.
    expect(Math.abs(fastMs - normalMs / 3)).toBeLessThan(fast.length);

    const immediate: AgentEvent[] = [];
    const immediateStart = Date.now();
    const immediateRun = collect(backend("directory", "immediate"), immediate);
    await vi.runAllTimersAsync();
    await immediateRun;
    expect(immediate).toEqual(normal);
    expect(Date.now() - immediateStart).toBeLessThan(10);
  });

  it.each([0, -1, "3", null])("rejects invalid scenario speed %s at load", (speed) => {
    writeFileSync(join(h.dir, "alpha.meta.json"), JSON.stringify({ triggers: ["alpha"], speed }));
    expect(() => backend("directory")).toThrow("invalid shape");
  });

  it.each(["file", "directory"] as const)(
    "%s mode lets event-loop cancellation stop an immediate stream between text chunks",
    async (mode) => {
      const controller = new AbortController();
      const events: AgentEvent[] = [];
      const run = (async () => {
        for await (const event of backend(mode, "immediate").runTurn(input, controller.signal)) {
          events.push(event);
          if (event.type === "agent.text.delta") {
            // Cancellation comes from another event-loop task, like an HTTP
            // cancel request, rather than synchronously inside the consumer.
            setTimeout(() => controller.abort(), 0);
          }
        }
      })();
      await vi.runAllTimersAsync();
      await run;
      expect(events.map((event) => event.type)).toEqual([
        "agent.message.start",
        "agent.text.delta",
      ]);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
