// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { ProviderId, SourceId } from "@omnesis/types";
import {
  emptySync,
  isStateEnvelope,
  resolveSourceState,
  withVersionedState,
  type SourceInstance,
  type SourceState,
  type StateOutcome,
} from "@omnesis/source-sdk";
import { GithubClient } from "./client.js";
import { FakeGithub } from "./fake-github.js";
import { GithubThreadsSource } from "./threads.js";
import { GithubCommitsSource } from "./commits.js";
import { githubCommitsStateSpec, githubThreadsStateSpec } from "./state.js";

const NOW_ISO = "2026-05-01T00:00:00Z";

function threadsInstance(fake: FakeGithub): SourceInstance {
  const client = new GithubClient("github_pat_test", {
    fetchImpl: fake.fetchImpl,
    sleep: async () => {},
    now: () => new Date(NOW_ISO).getTime(),
  });
  const source = new GithubThreadsSource({
    client,
    providerId: ProviderId("github:tester"),
    sourceId: SourceId("github:tester"),
    commitsSourceId: SourceId("github-commits:tester"),
    accountId: "tester",
    now: () => new Date(NOW_ISO).getTime(),
  });
  // Driven through `withVersionedState` rather than `source.sync` directly,
  // because resolving the stored value is the host's job — calling `sync`
  // with a raw cursor would test a path production never takes.
  return { sync: (cursor) => source.sync(cursor) };
}

function commitsInstance(fake: FakeGithub): SourceInstance {
  const client = new GithubClient("github_pat_test", {
    fetchImpl: fake.fetchImpl,
    sleep: async () => {},
    now: () => new Date(NOW_ISO).getTime(),
  });
  const source = new GithubCommitsSource({
    client,
    providerId: ProviderId("github-commits:tester"),
    sourceId: SourceId("github-commits:tester"),
    now: () => new Date(NOW_ISO).getTime(),
  });
  return { sync: (cursor) => source.sync(cursor) };
}

describe("githubThreadsStateSpec via the host decorator", () => {
  it("first run resolves fresh and writes back an envelope, then resumes from it", async () => {
    const fake = new FakeGithub(); // no repos: one call settles the cycle
    const outcomes: StateOutcome[] = [];
    const versioned = withVersionedState(threadsInstance(fake), githubThreadsStateSpec, {
      sourceId: "github:tester",
      onResolve: (outcome) => outcomes.push(outcome),
    });

    const result = await versioned.sync(null);
    expect(outcomes[0]?.kind).toBe("fresh");
    expect(isStateEnvelope(result.cursor)).toBe(true);

    const second = await versioned.sync(result.cursor);
    expect(outcomes[1]?.kind).toBe("resume");
    expect(isStateEnvelope(second.cursor)).toBe(true);
  });

  it("a page written under an older render tag rebootstraps rather than reusing it", async () => {
    const fake = new FakeGithub();
    const outcomes: StateOutcome[] = [];
    const versioned = withVersionedState(threadsInstance(fake), githubThreadsStateSpec, {
      sourceId: "github:tester",
      onResolve: (outcome) => outcomes.push(outcome),
    });

    // What a build one render generation behind would have persisted: same
    // JSON shape, an older `renderVersion` tag, and unwrapped since it
    // predates the envelope.
    const result = await versioned.sync({
      repos: {},
      renderVersion: 1,
    } as unknown as Parameters<SourceInstance["sync"]>[0]);

    expect(outcomes[0]?.kind).toBe("rebootstrap");
    expect(isStateEnvelope(result.cursor)).toBe(true);
  });

  it("an untagged cursor resumes instead of re-walking the account", () => {
    // A cursor written before the render tag existed makes no claim about how
    // its documents were rendered, so there is nothing to invalidate. Refusing
    // it would re-enumerate every issue, pull request and discussion against a
    // rate-limited API to answer a question it never asked — which is why the
    // tag check ignores `undefined` and refuses only a *different* value.
    const untagged = { repos: {} };
    expect(githubThreadsStateSpec.decode(untagged)).not.toBeNull();
    expect(githubCommitsStateSpec.decode(untagged)).not.toBeNull();
  });

  it("a different tag is still refused, so a real render change re-walks", () => {
    expect(githubThreadsStateSpec.decode({ repos: {}, renderVersion: 1 })).toBeNull();
    expect(githubCommitsStateSpec.decode({ repos: {}, renderVersion: 999 })).toBeNull();
  });
});

describe("githubCommitsStateSpec via the host decorator", () => {
  it.each([githubThreadsStateSpec, githubCommitsStateSpec])(
    "keeps incremental discovery bookmarks through migration",
    async (stateSpec) => {
      const stored = {
        repos: { "acme/widgets": { wm: "2026-04-01T00:00:00Z" } },
        pending: [],
        discoveryQueue: ["acme/widgets"],
        missingRepos: { "acme/gone": 1 },
        lane: { repo: "acme/widgets", kind: "issues", after: "next-page", page: 3 },
        snapshotMode: false,
      };
      let received: unknown;
      const wrapped = withVersionedState<SourceState>(
        {
          sync: async (cursor) => {
            received = cursor;
            return emptySync(cursor!);
          },
        },
        stateSpec,
        { sourceId: "github:tester" },
      );
      await wrapped.sync(stored);
      expect(received).toEqual(stored);
    },
  );
  it("first run resolves fresh and writes back an envelope, then resumes from it", async () => {
    const fake = new FakeGithub(); // no repos: one call settles the cycle
    const outcomes: StateOutcome[] = [];
    const versioned = withVersionedState(commitsInstance(fake), githubCommitsStateSpec, {
      sourceId: "github-commits:tester",
      onResolve: (outcome) => outcomes.push(outcome),
    });

    const result = await versioned.sync(null);
    expect(outcomes[0]?.kind).toBe("fresh");
    expect(isStateEnvelope(result.cursor)).toBe(true);

    const second = await versioned.sync(result.cursor);
    expect(outcomes[1]?.kind).toBe("resume");
    expect(isStateEnvelope(second.cursor)).toBe(true);
  });

  it("a version-1 cursor mid-snapshot is migrated by ending the snapshot, not resuming it", () => {
    // Version 1 accumulated a snapshot's ids in one flat account-wide list with
    // no record of which repository each came from. Nothing can split that back
    // up, and a snapshot resumed without it would reach the end believing it
    // had read only the repositories walked after the upgrade — and vouch for
    // exactly those. Ending it costs one cycle.
    const stored = {
      renderVersion: undefined,
      repos: { "acme/widgets": { wm: "2026-04-01T00:00:00Z", knownShas: ["a1b2c3d4e5f6"] } },
      pending: [`acme/widgets@${"a".repeat(40)}`],
      discoveryQueue: ["acme/tools"],
      missingRepos: { "acme/gone": 1 },
      lastSnapshotAt: "2026-04-30T00:00:00Z",
      snapshotMode: true,
      snapshotIds: ["acme/widgets/commit/aaa"],
      snapshotIncomplete: true,
      lane: { repo: "acme/tools", page: 3, since: "2026-04-01T00:00:00Z" },
    };

    const outcome = resolveSourceState(githubCommitsStateSpec, stored, {
      sourceId: "github-commits:tester",
    });

    expect(outcome.kind).toBe("migrated");
    if (outcome.kind !== "migrated") return;
    const state = outcome.state;
    expect(state.snapshotMode).toBe(false);
    expect(state.snapshot).toBeUndefined();
    expect(state.snapshotRepos).toBeUndefined();
    expect((state as unknown as { snapshotIds?: unknown }).snapshotIds).toBeUndefined();
    // Everything the snapshot did not own is kept, so the cycle finishes as an
    // ordinary incremental one instead of re-walking the account.
    expect(state.repos?.["acme/widgets"]?.wm).toBe("2026-04-01T00:00:00Z");
    expect(state.pending).toHaveLength(1);
    expect(state.discoveryQueue).toEqual(["acme/tools"]);
    expect(state.missingRepos).toEqual({ "acme/gone": 1 });
    // The lane goes with the snapshot. A thread walk orders on creation date
    // while an incremental one orders on update date, and a GraphQL cursor
    // addresses a position in the ordering that produced it — resuming one
    // under the other skips a prefix, and the lane's watermark would then fold
    // forward past threads nobody enumerated.
    expect(state.lane).toBeUndefined();
    // Unadvanced, so the next snapshot starts as soon as the interval already
    // says it should rather than waiting out another one.
    expect(state.lastSnapshotAt).toBe("2026-04-30T00:00:00Z");
  });
});
