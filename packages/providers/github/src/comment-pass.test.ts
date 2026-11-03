// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { withVersionedState } from "@omnesis/source-sdk";
import { SourceId, ProviderId } from "@omnesis/types";
import { GithubClient } from "./client.js";
import { FakeGithub } from "./fake-github.js";
import { GithubThreadsSource } from "./threads.js";
import { githubThreadsStateSpec } from "./state.js";
import type { GithubThreadsCursor } from "./types.js";
import type { SourceInstance, SourceState } from "@omnesis/source-sdk";

const repo = "fixture-project/widgets";
const start = "2026-06-01T12:00:00.000Z";
const old = "2026-05-01T00:00:00Z";

function setup(count = 2) {
  const fake = new FakeGithub();
  const comment = {
    author: { login: "fixture-author" },
    body: "Original comment",
    createdAt: old,
    updatedAt: old,
  };
  const review = { ...comment, body: "Original review remark" };
  fake.addRepo(repo, {
    threads: [
      {
        number: 1,
        kind: "issue",
        title: "Fixture issue",
        body: "Issue body",
        createdAt: old,
        updatedAt: old,
        author: null,
        comments: [comment],
      },
      {
        number: 2,
        kind: "pull",
        title: "Fixture pull",
        body: "Pull body",
        createdAt: old,
        updatedAt: old,
        author: null,
        reviews: [{ author: null, state: "COMMENTED", submittedAt: old, comments: [review] }],
      },
    ],
  });
  for (let number = 3; number <= count; number++) {
    fake.repo(repo).threads.push({
      number,
      kind: "issue",
      title: `Fixture ${number}`,
      body: "Body",
      createdAt: old,
      updatedAt: old,
      author: null,
    });
  }
  let now = start;
  const source = new GithubThreadsSource({
    client: new GithubClient("fixture-token", { fetchImpl: fake.fetchImpl, sleep: async () => {} }),
    sourceId: SourceId("github:fixture"),
    providerId: ProviderId("github:fixture"),
    accountId: "fixture",
    now: () => Date.parse(now),
  });
  const host = withVersionedState(
    { sync: (cursor) => source.sync(cursor as GithubThreadsCursor) },
    githubThreadsStateSpec,
    { sourceId: "github:fixture" },
  );
  return {
    host,
    source,
    comment,
    review,
    setNow: (value: string) => {
      now = value;
    },
  };
}
async function finish(host: SourceInstance, initial: SourceState | null) {
  const docs = [];
  let cursor = initial;
  for (let i = 0; i < 30; i++) {
    const result = await host.sync(cursor);
    docs.push(...result.documents);
    cursor = result.cursor;
    if (!result.hasMore) return { cursor, docs, presentExternalIds: result.presentExternalIds };
  }
  throw new Error("fixture pass did not finish");
}

describe("GitHub initial comment checkpoints", () => {
  it("pins both comment lanes before the first discovery page and replays later edits", async () => {
    const { host, comment, review, setNow } = setup(12);
    const begin = await host.sync(null);
    const firstPage = await host.sync(begin.cursor);
    expect(firstPage.cursor).toMatchObject({
      state: { repos: { [repo]: { commentsWm: start, reviewCommentsWm: start } } },
    });
    let paused = firstPage;
    for (let i = 0; i < 15 && paused.documents.length === 0; i++)
      paused = await host.sync(paused.cursor);
    expect(paused.documents.find((doc) => doc.externalId.endsWith("issues/1"))?.content).toContain(
      "Original comment",
    );
    expect(paused.hasMore).toBe(true);
    comment.body = "Edited during the long pass";
    comment.updatedAt = "2026-06-01T12:10:00Z";
    review.body = "Review edited during the long pass";
    review.updatedAt = comment.updatedAt;
    setNow("2026-06-01T12:20:00Z");
    const complete = await finish(host, paused.cursor);
    expect(complete.presentExternalIds).toHaveLength(12);
    const replay = await finish(host, complete.cursor);
    expect(replay.docs.find((doc) => doc.externalId.endsWith("issues/1"))?.content).toContain(
      comment.body,
    );
    expect(replay.docs.find((doc) => doc.externalId.endsWith("pull/2"))?.content).toContain(
      review.body,
    );
    const idle = await finish(host, replay.cursor);
    expect(idle.docs).toEqual([]);
    expect(idle.presentExternalIds).toBeUndefined();
  });

  it("re-fetches a comment edited after a capped pending queue materializes its thread", async () => {
    const { host, source, comment, setNow } = setup(152);
    const begin = await host.sync(null);
    const first = await host.sync(begin.cursor);
    const state = (first.cursor as { state: GithubThreadsCursor }).state;
    // Seed the real queue ceiling at a saved discovery page, avoiding tens
    // of thousands of irrelevant fixture payloads. Missing batch nodes are
    // legitimate deleted threads and drain through the production path.
    state.pending = Array.from({ length: 50_000 }, (_, i) => `${repo}#${i + 1}`);
    expect(state.lane?.kind).toBe("issues");
    const drain = await source.sync(state);
    expect(drain.documents.find((doc) => doc.externalId.endsWith("issues/1"))?.content).toContain(
      "Original comment",
    );
    expect(drain.cursor.lane?.kind).toBe("issues");
    comment.body = "Changed while remaining discovery ran";
    comment.updatedAt = "2026-06-01T12:10:00Z";
    setNow("2026-06-01T12:20:00Z");
    let cursor = drain.cursor;
    let replayed = false;
    let finished = false;
    for (let i = 0; i < 5_100; i++) {
      const result = await source.sync(cursor);
      replayed ||= result.documents.some(
        (doc) => doc.externalId.endsWith("issues/1") && doc.content.includes(comment.body),
      );
      cursor = result.cursor;
      if (!result.hasMore) {
        finished = true;
        break;
      }
    }
    expect(finished).toBe(true);
    const incremental = await finish(host, { e: 1, v: 2, state: cursor });
    replayed ||= incremental.docs.some(
      (doc) => doc.externalId.endsWith("issues/1") && doc.content.includes(comment.body),
    );
    expect(replayed).toBe(true);
  }, 120_000);

  it.each([false, true])(
    "replays unpinned installed walks after an early materialization (envelope: %s)",
    async (enveloped) => {
      const { host, comment, review, setNow } = setup();
      // A capped discovery drains its pending references while keeping its
      // lane checkpoint. Exercise that materialization separately, then resume
      // discovery with the same parent watermarks and no comment pin.
      const materialized = await finish(host, {
        repos: { [repo]: {} },
        discoveryQueue: [],
        pending: [`${repo}#1`, `${repo}#2`],
        lastSnapshotAt: start,
      });
      expect(materialized.docs).toHaveLength(2);
      comment.body = "Comment changed after materialization";
      comment.updatedAt = "2026-06-01T12:10:00Z";
      review.body = "Review changed after materialization";
      review.updatedAt = comment.updatedAt;
      setNow("2026-06-01T12:20:00Z");
      const state = {
        repos: { [repo]: { issuesWm: old, issuesAtWm: [1], pullsWm: old, pullsAtWm: [2] } },
        lane: { repo, kind: "pulls", cutoff: old, cutoffIds: [2] },
        discoveryQueue: [],
        pending: [],
        lastSnapshotAt: start,
      };
      const replay = await finish(host, enveloped ? { e: 1, v: 2, state } : state);
      expect(replay.docs.find((doc) => doc.externalId.endsWith("issues/1"))?.content).toContain(
        comment.body,
      );
      expect(replay.docs.find((doc) => doc.externalId.endsWith("pull/2"))?.content).toContain(
        review.body,
      );
      expect(replay.presentExternalIds).toBeUndefined();
      const idle = await finish(host, replay.cursor);
      expect(idle.docs).toEqual([]);
    },
  );
});
