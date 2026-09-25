// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { acquireStateLock, githubHolderRetirer, releaseStateLock } from "./state-lock.mjs";

const execFile = promisify(execFileCallback);
const temporary = [];
afterEach(async () =>
  Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))),
);

async function git(repository, ...args) {
  const result = await execFile("git", ["-C", repository, ...args], { encoding: "utf8" });
  return result.stdout.trim();
}

async function fixtureRepository() {
  const root = await mkdtemp(join(tmpdir(), "ci-state-lock-"));
  temporary.push(root);
  const remote = join(root, "remote.git");
  const checkout = join(root, "checkout");
  await execFile("git", ["init", "--bare", remote]);
  await execFile("git", ["init", "--initial-branch=main", checkout]);
  await git(checkout, "config", "user.name", "fixture-author");
  await git(checkout, "config", "user.email", "fixture@example.com");
  await git(checkout, "commit", "--allow-empty", "-m", "fixture");
  await git(checkout, "remote", "add", "origin", remote);
  await git(checkout, "push", "-u", "origin", "main");
  return checkout;
}

describe("CI admission state lock", () => {
  it("serializes writers and releases only the owning lease", async () => {
    const repository = await fixtureRepository();
    const first = await acquireStateLock({ repository, owner: "run:1", pollMs: 1 });
    await expect(
      acquireStateLock({ repository, owner: "run:2", timeoutMs: 1, staleMs: 60_000, pollMs: 1 }),
    ).rejects.toThrow("timed out waiting");
    await expect(releaseStateLock({ repository, oid: "f".repeat(40) })).rejects.toThrow(
      "owned by another run",
    );
    await expect(releaseStateLock({ repository, oid: first })).resolves.toBe(true);
    const second = await acquireStateLock({ repository, owner: "run:2", pollMs: 1 });
    await expect(releaseStateLock({ repository, oid: second })).resolves.toBe(true);
  });

  it("steals an expired lease with compare-and-swap protection", async () => {
    const repository = await fixtureRepository();
    const first = await acquireStateLock({ repository, owner: "run:1", pollMs: 1 });
    const second = await acquireStateLock({
      repository,
      owner: "run:2",
      // The lease, not the wait, is what this pins: a budget that a slow
      // `git` spawn can exhaust would fail the steal for the wrong reason.
      timeoutMs: 30 * 60_000,
      staleMs: 1,
      pollMs: 1,
      now: () => Date.now() + 2_000,
      retireHolder: async () => true,
    });
    expect(second).not.toBe(first);
    await expect(releaseStateLock({ repository, oid: first })).rejects.toThrow(
      "owned by another run",
    );
    await expect(releaseStateLock({ repository, oid: second })).resolves.toBe(true);
  });

  it("dates the lease when a waiter acquires it rather than when waiting began", async () => {
    const repository = await fixtureRepository();
    let clock = Date.now();
    const first = await acquireStateLock({ repository, owner: "run:1", now: () => clock });
    const second = await acquireStateLock({
      repository,
      owner: "run:2",
      timeoutMs: 30 * 60_000,
      staleMs: 30 * 60_000,
      pollMs: 1,
      now: () => clock,
      sleep: async () => {
        clock += 19 * 60_000;
        await releaseStateLock({ repository, oid: first });
      },
    });
    const createdAt = Number(await git(repository, "show", "-s", "--format=%ct", second)) * 1_000;
    expect(Math.abs(createdAt - clock)).toBeLessThan(1_000);
    await expect(releaseStateLock({ repository, oid: second })).resolves.toBe(true);
  });

  it("does not steal a stale lease until its workflow holder is terminal", async () => {
    const repository = await fixtureRepository();
    const first = await acquireStateLock({ repository, owner: "1:1", pollMs: 1 });
    let inspections = 0;
    const second = await acquireStateLock({
      repository,
      owner: "2:1",
      // Two polls have to land inside this budget, each spending several
      // `git` spawns, so it is sized for the retirement rule rather than
      // for the clock.
      timeoutMs: 30 * 60_000,
      staleMs: 1,
      pollMs: 1,
      now: () => Date.now() + 2_000,
      retireHolder: async () => {
        inspections += 1;
        return inspections > 1;
      },
    });
    expect(inspections).toBe(2);
    await expect(releaseStateLock({ repository, oid: first })).rejects.toThrow(
      "owned by another run",
    );
    await expect(releaseStateLock({ repository, oid: second })).resolves.toBe(true);
  });

  it("cancels an active stale holder once and fences on its terminal run attempt", async () => {
    const calls = [];
    let inspection = 0;
    const retire = githubHolderRetirer({
      repository: "example/project",
      token: "test-token",
      fetchImpl: async (url, options = {}) => {
        calls.push({ url, method: options.method ?? "GET" });
        if (options.method === "POST") return { status: 202 };
        inspection += 1;
        return {
          ok: true,
          json: async () => ({
            run_attempt: 3,
            status: inspection === 1 ? "in_progress" : "completed",
          }),
        };
      },
    });
    await expect(retire("42:3")).resolves.toBe(false);
    await expect(retire("42:3")).resolves.toBe(true);
    expect(calls.map(({ method }) => method)).toEqual(["GET", "POST", "GET"]);
  });
});
