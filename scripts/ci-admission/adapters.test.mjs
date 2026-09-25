// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitHubApiError, GitHubClient, parseTrustedIds } from "./github.mjs";
import { discoverReachable, isAncestorInRepository, mapIntegrationTargets } from "./git-graph.mjs";
import { createLedger } from "./model.mjs";
import { FileLedgerStore } from "./state-store.mjs";

const temporary = [];
afterEach(async () =>
  Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))),
);
const sha = (number) => number.toString(16).padStart(40, "0");

describe("graph discovery abstraction", () => {
  it("maps every commit in histories larger than a webhook payload", () => {
    const all = Array.from({ length: 2_101 }, (_, index) => sha(index + 1));
    const mapped = mapIntegrationTargets({
      all,
      firstParent: all,
      isAncestor: (left, right) => left === right,
    });
    expect(mapped).toHaveLength(2_101);
    expect(mapped.at(-1)).toEqual({ sha: all.at(-1), integrationTargetSha: all.at(-1) });
  });

  it("maps merge-side commits to their earliest first-parent integration revision", () => {
    const sideA = sha(2),
      sideB = sha(3),
      merge = sha(4);
    const ancestry = new Set([`${sideA}:${merge}`, `${sideB}:${merge}`, `${merge}:${merge}`]);
    expect(
      mapIntegrationTargets({
        all: [sideA, sideB, merge],
        firstParent: [merge],
        isAncestor: (left, right) => ancestry.has(`${left}:${right}`),
      }),
    ).toEqual([
      { sha: sideA, integrationTargetSha: merge },
      { sha: sideB, integrationTargetSha: merge },
      { sha: merge, integrationTargetSha: merge },
    ]);
  });

  it("fails explicitly when main was force-pushed behind its durable frontier", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ci-graph-"));
    temporary.push(directory);
    const git = (...args) =>
      execFileSync("git", ["-C", directory, ...args], { encoding: "utf8" }).trim();
    git("init", "-q", "-b", "main");
    git("config", "user.name", "fixture-author");
    git("config", "user.email", "maya.reeves@example.com");
    await writeFile(join(directory, "fixture"), "first\n");
    git("add", "fixture");
    git("commit", "-qm", "first");
    const frontier = git("rev-parse", "HEAD");
    await writeFile(join(directory, "fixture"), "second\n");
    git("add", "fixture");
    git("commit", "-qm", "second");
    const descendant = git("rev-parse", "HEAD");
    expect(isAncestorInRepository(directory, frontier, descendant)).toBe(true);
    git("checkout", "-q", "--orphan", "replacement");
    git("rm", "-q", "-rf", ".");
    await writeFile(join(directory, "fixture"), "replacement\n");
    git("add", "fixture");
    git("commit", "-qm", "replacement");
    const replacement = git("rev-parse", "HEAD");
    expect(isAncestorInRepository(directory, frontier, replacement)).toBe(false);
    expect(() => discoverReachable(directory, frontier, replacement)).toThrow(/force-pushed/u);
  });
});

describe("GitHub adapter", () => {
  it("follows every Link page", async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      const second = url.includes("page=2");
      return new Response(JSON.stringify(second ? [{ id: 2 }] : [{ id: 1 }]), {
        status: 200,
        headers: second ? {} : { link: '<https://api.github.test/page=2>; rel="next"' },
      });
    };
    const client = new GitHubClient({
      repository: "example/project",
      token: "fixture",
      fetchImpl,
      apiUrl: "https://api.github.test",
    });
    expect(await client.associatedPullRequests(sha(1))).toEqual([{ id: 1 }, { id: 2 }]);
    expect(calls).toHaveLength(2);
  });

  it("paginates workflow run and job collection envelopes", async () => {
    const fetchImpl = async (url) => {
      const field = url.includes("/jobs") ? "jobs" : "workflow_runs";
      const second = url.includes("page=2");
      return new Response(JSON.stringify({ total_count: 2, [field]: [{ id: second ? 2 : 1 }] }), {
        status: 200,
        headers: second ? {} : { link: `<https://api.github.test/page=2/${field}>; rel="next"` },
      });
    };
    const client = new GitHubClient({
      repository: "example/project",
      token: "fixture",
      fetchImpl,
      apiUrl: "https://api.github.test",
    });

    await expect(client.workflowRuns("full-validation.yml")).resolves.toEqual([
      { id: 1 },
      { id: 2 },
    ]);
    await expect(client.workflowJobs(42)).resolves.toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("refuses pagination links on another origin before sending credentials", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return new Response("[]", {
        status: 200,
        headers: { link: '<https://attacker.example/page/2>; rel="next"' },
      });
    };
    const client = new GitHubClient({ repository: "example/project", token: "secret", fetchImpl });

    await expect(client.paginate("/commits?per_page=100")).rejects.toThrow(
      "refusing to send GitHub credentials to a different origin",
    );
    expect(calls).toBe(1);
  });

  it("fails closed on rate limits, server failures and malformed responses", async () => {
    for (const response of [
      new Response("{}", { status: 403 }),
      new Response("{}", { status: 503 }),
      new Response("not-json", { status: 200 }),
    ]) {
      const client = new GitHubClient({
        repository: "example/project",
        token: "fixture",
        fetchImpl: async () => response.clone(),
      });
      await expect(client.commit(sha(1))).rejects.toBeInstanceOf(GitHubApiError);
    }
    expect(() => parseTrustedIds("12,not-an-id")).toThrow("positive integers");
  });

  it("carries GitHub retry timing into retryable API failures", async () => {
    const client = new GitHubClient({
      repository: "example/project",
      token: "fixture",
      fetchImpl: async () =>
        new Response("{}", {
          status: 429,
          headers: { "retry-after": "120" },
        }),
    });
    const before = Date.now() + 119_000;
    await expect(client.commit(sha(1))).rejects.toMatchObject({
      status: 429,
      retryable: true,
      retryAt: expect.any(String),
    });
    try {
      await client.commit(sha(1));
    } catch (error) {
      expect(new Date(error.retryAt).valueOf()).toBeGreaterThanOrEqual(before);
    }
  });
});

describe("durable file adapter", () => {
  it("writes atomically and detects stale writers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ci-admission-"));
    temporary.push(directory);
    const store = new FileLedgerStore(directory);
    const ledger = createLedger(sha(1));
    await store.write(ledger);
    ledger.frontier.scannedHeadSha = sha(2);
    await store.write(ledger, sha(1));
    await expect(store.write(ledger, sha(1))).rejects.toThrow("compare-and-swap");
  });
});
