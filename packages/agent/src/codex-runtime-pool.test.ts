// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createLogger } from "@omnesis/core";
import {
  CodexRuntimePool,
  reconcileMemberAuth,
  type PoolMemberRuntime,
} from "./codex-runtime-pool.js";
import type { AgentEvent } from "@omnesis/core";

const log = createLogger("test:codex-pool");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codex-pool-"));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

/** A fake member runtime whose turn resolves only when the test releases it,
 *  so we can hold N turns "in flight" and observe how the pool spreads them. */
class FakeRuntime implements PoolMemberRuntime {
  turns = 0;
  events: AgentEvent[] = [];
  private releases: Array<() => void> = [];
  async *runTurn(): AsyncIterable<AgentEvent> {
    this.turns += 1;
    await new Promise<void>((resolve) => this.releases.push(resolve));
    yield* this.events;
  }
  releaseOne(): void {
    this.releases.shift()?.();
  }
  async dispose(): Promise<void> {}
}

function makePool(size: number, fakes: FakeRuntime[]): CodexRuntimePool {
  mkdirSync(join(dir, "owner"), { recursive: true });
  writeFileSync(join(dir, "owner", "auth.json"), "{}");
  return new CodexRuntimePool({
    runtimeOptions: {},
    sharedHome: join(dir, "owner"),
    poolHomeBase: join(dir, "pool"),
    poolWorkspaceBase: join(dir, "ws"),
    size,
    logger: log,
    createRuntime: () => {
      const f = new FakeRuntime();
      fakes.push(f);
      return f;
    },
  });
}

describe("CodexRuntimePool routing", () => {
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid capacity %s",
    (size) => {
      expect(() => makePool(size, [])).toThrow("positive integer");
    },
  );

  it("refuses work after disposal", async () => {
    const fakes: FakeRuntime[] = [];
    const pool = makePool(1, fakes);
    await pool.dispose();
    await expect(
      (async () => {
        for await (const event of pool.runTurn(turnOpts())) void event;
      })(),
    ).rejects.toThrow("disposed");
    expect(fakes[0].turns).toBe(0);
  });

  it("spreads concurrent turns one-per-member across an idle pool", async () => {
    const fakes: FakeRuntime[] = [];
    const pool = makePool(3, fakes);

    // Start three concurrent turns; each drives the generator to its first await.
    const runs = [0, 1, 2].map(async () => {
      for await (const _ of pool.runTurn(turnOpts())) void _;
    });
    await tick();

    // Each member took exactly one turn — genuine 3-way concurrency.
    expect(fakes.map((f) => f.turns).sort()).toEqual([1, 1, 1]);
    expect(pool.describe().inFlight.filter((n) => n === 1)).toHaveLength(3);

    for (const f of fakes) f.releaseOne();
    await Promise.all(runs);
    expect(pool.describe().inFlight).toEqual([0, 0, 0]);
  });

  it("assigns queued turns to the next idle member without waiting for a slow sibling", async () => {
    const fakes: FakeRuntime[] = [];
    const pool = makePool(2, fakes);
    const runs = [0, 1, 2, 3].map(async () => {
      for await (const event of pool.runTurn(turnOpts())) void event;
    });
    await tick();
    expect(pool.describe()).toEqual({ size: 2, inFlight: [1, 1], queued: 2 });
    expect(fakes.map((f) => f.turns)).toEqual([1, 1]);

    fakes[1].releaseOne();
    await tick();
    expect(fakes.map((f) => f.turns)).toEqual([1, 2]);
    expect(pool.describe().queued).toBe(1);
    fakes[1].releaseOne();
    await tick();
    expect(fakes.map((f) => f.turns)).toEqual([1, 3]);
    expect(pool.describe().queued).toBe(0);
    fakes[0].releaseOne();
    fakes[1].releaseOne();
    await Promise.all(runs);
    expect(pool.describe().inFlight).toEqual([0, 0]);
  });

  it("cancels a FIFO waiter without consuming a member or blocking its successor", async () => {
    const fakes: FakeRuntime[] = [];
    const pool = makePool(1, fakes);
    const consume = async (signal?: AbortSignal): Promise<void> => {
      for await (const event of pool.runTurn({ ...turnOpts(), signal })) void event;
    };
    const running = consume();
    const controller = new AbortController();
    const canceled = consume(controller.signal);
    const successor = consume();
    await tick();
    const rejected = expect(canceled).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejected;
    expect(pool.describe().queued).toBe(1);
    fakes[0].releaseOne();
    await tick();
    expect(fakes[0].turns).toBe(2);
    fakes[0].releaseOne();
    await Promise.all([running, successor]);
  });

  it("rejects every queued waiter on disposal", async () => {
    const fakes: FakeRuntime[] = [];
    const pool = makePool(1, fakes);
    const consume = async (): Promise<void> => {
      for await (const event of pool.runTurn(turnOpts())) void event;
    };
    const running = consume();
    const waiting = [consume(), consume()];
    const rejected = waiting.map((promise) => expect(promise).rejects.toThrow("disposed"));
    await tick();
    await pool.dispose();
    await Promise.all(rejected);
    expect(pool.describe().queued).toBe(0);
    expect(fakes[0].turns).toBe(1);
    fakes[0].releaseOne();
    await running;
  });
});

describe("CodexRuntimePool per-lease auth", () => {
  it("materializes a member home and shares the owner token on its first turn", async () => {
    const fakes: FakeRuntime[] = [];
    const pool = makePool(1, fakes);
    const member0 = join(dir, "pool", "0", "auth.json");
    expect(existsSync(member0)).toBe(false); // not created until leased

    const run = (async () => {
      for await (const _ of pool.runTurn(turnOpts())) void _;
    })();
    await tick();

    expect(lstatSync(member0).isSymbolicLink()).toBe(true);
    expect(readlinkSync(member0)).toBe(join(dir, "owner", "auth.json"));
    fakes[0].releaseOne();
    await run;
  });

  it("heals a member that diverged (a real refreshed token) on its next idle lease", async () => {
    const fakes: FakeRuntime[] = [];
    const pool = makePool(1, fakes);
    const member0 = join(dir, "pool", "0", "auth.json");

    // First turn shares the token.
    let run = (async () => {
      for await (const _ of pool.runTurn(turnOpts())) void _;
    })();
    await tick();
    fakes[0].releaseOne();
    await run;

    // Simulate codex refreshing on the member: its atomic rename left a newer
    // real file where the symlink was, and the owner token is stale.
    rmSync(member0);
    writeFileSync(member0, '{"token":"fresh"}');
    const older = Date.now() / 1000 - 100;
    utimesSync(join(dir, "owner", "auth.json"), older, older);

    // Next idle lease reconciles: newest-wins promotes the member token to the
    // owner and re-shares, so the shared login converges without a login/logout.
    run = (async () => {
      for await (const _ of pool.runTurn(turnOpts())) void _;
    })();
    await tick();
    expect(readFileSync(join(dir, "owner", "auth.json"), "utf8")).toBe('{"token":"fresh"}');
    expect(lstatSync(member0).isSymbolicLink()).toBe(true);
    fakes[0].releaseOne();
    await run;
  });

  it("does not memoize a prepare failure — a later turn recovers", async () => {
    const fakes: FakeRuntime[] = [];
    const pool = makePool(1, fakes);
    // Block member-0's home path with a FILE so mkdirSync(recursive) throws.
    mkdirSync(join(dir, "pool"), { recursive: true });
    writeFileSync(join(dir, "pool", "0"), "not a dir");

    await expect(async () => {
      for await (const _ of pool.runTurn(turnOpts())) void _;
    }).rejects.toBeTruthy();

    // Clear the blocker; the next turn must retry prepare and succeed.
    rmSync(join(dir, "pool", "0"));
    const run = (async () => {
      for await (const _ of pool.runTurn(turnOpts())) void _;
    })();
    await tick();
    expect(existsSync(join(dir, "pool", "0", "auth.json"))).toBe(true);
    fakes[0].releaseOne();
    await run;
  });
});

describe("reconcileMemberAuth", () => {
  const owner = () => join(dir, "owner", "auth.json");
  const member = () => join(dir, "member");
  const memberAuth = () => join(member(), "auth.json");

  beforeEach(() => {
    mkdirSync(join(dir, "owner"), { recursive: true });
    mkdirSync(member(), { recursive: true });
  });

  it("symlinks a member with no auth to the shared owner token", () => {
    writeFileSync(owner(), '{"token":"shared"}');
    reconcileMemberAuth(member(), owner(), log);
    expect(lstatSync(memberAuth()).isSymbolicLink()).toBe(true);
    expect(readlinkSync(memberAuth())).toBe(owner());
    expect(readFileSync(memberAuth(), "utf8")).toBe('{"token":"shared"}');
  });

  it("promotes a member's newer token to the shared owner (newest-wins), then re-shares", () => {
    writeFileSync(owner(), '{"token":"old"}');
    // codex refreshed on the member and its rename left a real, newer file.
    writeFileSync(memberAuth(), '{"token":"fresh"}');
    const older = Date.now() / 1000 - 100;
    utimesSync(owner(), older, older);

    reconcileMemberAuth(member(), owner(), log);

    expect(readFileSync(owner(), "utf8")).toBe('{"token":"fresh"}');
    expect(lstatSync(memberAuth()).isSymbolicLink()).toBe(true);
    expect(readFileSync(memberAuth(), "utf8")).toBe('{"token":"fresh"}');
  });

  it("keeps the shared token when it is newer than a member's stale file", () => {
    writeFileSync(memberAuth(), '{"token":"stale"}');
    const older = Date.now() / 1000 - 100;
    utimesSync(memberAuth(), older, older);
    writeFileSync(owner(), '{"token":"current"}');

    reconcileMemberAuth(member(), owner(), log);

    expect(readFileSync(owner(), "utf8")).toBe('{"token":"current"}');
    expect(lstatSync(memberAuth()).isSymbolicLink()).toBe(true);
    expect(readFileSync(memberAuth(), "utf8")).toBe('{"token":"current"}');
  });

  it("clears a stale member token when the owner is logged out", () => {
    writeFileSync(memberAuth(), '{"token":"leftover"}');
    reconcileMemberAuth(member(), owner(), log); // owner auth.json absent
    expect(existsSync(memberAuth())).toBe(false);
  });

  it("is idempotent on an already-shared member", () => {
    writeFileSync(owner(), '{"token":"shared"}');
    symlinkSync(owner(), memberAuth());
    reconcileMemberAuth(member(), owner(), log);
    expect(lstatSync(memberAuth()).isSymbolicLink()).toBe(true);
    expect(readlinkSync(memberAuth())).toBe(owner());
  });
});

function turnOpts() {
  return {
    model: "gpt-x",
    input: {
      sessionId: "s",
      messageId: "m",
      systemPrompt: "",
      history: [],
      userMessage: "hi",
      tools: [],
    },
    toolTimeoutMs: 1000,
    maxToolIterations: 1,
  } as unknown as Parameters<CodexRuntimePool["runTurn"]>[0];
}

const tick = () => new Promise((r) => setTimeout(r, 5));

it("logs bounded content-free timing for a contended lease without changing FIFO", async () => {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const info = vi.spyOn(log, "info").mockImplementation(() => {});
  vi.spyOn(log, "debug").mockImplementation(() => {});
  const fakes: FakeRuntime[] = [];
  const pool = makePool(1, fakes);
  const consume = async () => {
    for await (const event of pool.runTurn(turnOpts())) void event;
  };
  const first = consume();
  await tick();
  now = 10;
  const second = consume();
  await tick();
  now = 40;
  fakes[0]!.releaseOne();
  await first;
  await tick();
  expect(info.mock.calls[0]![0]).toMatch(
    /request=[a-f0-9-]+ status=leased member=0 waitMs=30 granted=true$/,
  );
  fakes[0]!.events = [
    {
      type: "agent.text.delta",
      payload: {
        sessionId: "secret-session",
        messageId: "secret-message",
        delta: "private response",
      },
    },
  ];
  now = 65;
  fakes[0]!.releaseOne();
  await second;
  expect(info.mock.calls[1]![0]).toMatch(/status=completed member=0 waitMs=30 leaseMs=25$/);
  expect(info.mock.calls[1]![0].split(" ")[3]).toBe(info.mock.calls[0]![0].split(" ")[3]);
  expect(JSON.stringify(info.mock.calls)).not.toMatch(/secret|private|gpt-x/);
  expect(pool.describe()).toEqual({ size: 1, inFlight: [0], queued: 0 });
});

it.each(["abort", "dispose"])(
  "reports %s of an ungranted waiter without claiming a lease",
  async (mode) => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const info = vi.spyOn(log, "info").mockImplementation(() => {});
    vi.spyOn(log, "debug").mockImplementation(() => {});
    const fakes: FakeRuntime[] = [];
    const pool = makePool(1, fakes);
    const consume = async (signal?: AbortSignal) => {
      for await (const event of pool.runTurn({ ...turnOpts(), signal })) void event;
    };
    const first = consume();
    await tick();
    const controller = new AbortController();
    now = 5;
    const waiter = consume(controller.signal);
    const failure = expect(waiter).rejects.toThrow();
    now = 25;
    if (mode === "abort") controller.abort();
    else await pool.dispose();
    await failure;
    expect(info.mock.calls).toHaveLength(1);
    expect(info.mock.calls[0]![0]).toContain(
      `status=${mode === "abort" ? "aborted" : "disposed"} waitMs=20 granted=false`,
    );
    expect(fakes[0]!.turns).toBe(1);
    fakes[0]!.releaseOne();
    await first;
    expect(pool.describe().queued).toBe(0);
  },
);

it("releases a contended member even when the timing logger throws", async () => {
  vi.spyOn(log, "info").mockImplementation(() => {
    throw new Error("sink failure");
  });
  vi.spyOn(log, "debug").mockImplementation(() => {
    throw new Error("sink failure");
  });
  const fakes: FakeRuntime[] = [];
  const pool = makePool(1, fakes);
  const consume = async () => {
    for await (const event of pool.runTurn(turnOpts())) void event;
  };
  const first = consume();
  const second = consume();
  await tick();
  fakes[0]!.releaseOne();
  await first;
  await tick();
  fakes[0]!.releaseOne();
  await second;
  expect(fakes[0]!.turns).toBe(2);
  expect(pool.describe()).toEqual({ size: 1, inFlight: [0], queued: 0 });
});

it("preserves delegated consumer return and releases its lease", async () => {
  vi.spyOn(log, "debug").mockImplementation(() => {});
  const fakes: FakeRuntime[] = [];
  const pool = makePool(1, fakes);
  fakes[0]!.events = [
    { type: "agent.text.delta", payload: { sessionId: "s", messageId: "m", delta: "fixture" } },
  ];
  const iterator = pool.runTurn(turnOpts())[Symbol.asyncIterator]();
  const next = iterator.next();
  await tick();
  fakes[0]!.releaseOne();
  expect((await next).done).toBe(false);
  await iterator.return?.();
  expect(pool.describe()).toEqual({ size: 1, inFlight: [0], queued: 0 });
});
