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

import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
  rmSync(dir, { recursive: true, force: true });
});

/** A fake member runtime whose turn resolves only when the test releases it,
 *  so we can hold N turns "in flight" and observe how the pool spreads them. */
class FakeRuntime implements PoolMemberRuntime {
  turns = 0;
  private releases: Array<() => void> = [];
  async *runTurn(): AsyncIterable<AgentEvent> {
    this.turns += 1;
    await new Promise<void>((resolve) => this.releases.push(resolve));
    yield* [] as AgentEvent[]; // completes with no events once released
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

  it("queues the (N+1)th turn onto a member instead of rejecting", async () => {
    const fakes: FakeRuntime[] = [];
    const pool = makePool(2, fakes);

    const runs = [0, 1, 2].map(async () => {
      for await (const _ of pool.runTurn(turnOpts())) void _;
    });
    await tick();

    // Two members, three turns: the pool never rejects; the extra turn piles on
    // the least-busy member, so total in-flight is 3 across 2 members.
    expect(pool.describe().inFlight.reduce((a, b) => a + b, 0)).toBe(3);
    expect(Math.max(...pool.describe().inFlight)).toBe(2);

    for (const f of fakes) {
      f.releaseOne();
      f.releaseOne();
    }
    await Promise.all(runs);
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
