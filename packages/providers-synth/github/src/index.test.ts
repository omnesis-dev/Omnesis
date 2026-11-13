// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { collectFilterList, type SourceInstance, type SyncCursor } from "@omnesis/source-sdk";
import { ProviderId, SourceId, type DocumentInput } from "@omnesis/types";

const state = vi.hoisted(() => ({ threads: {} as unknown, commits: {} as unknown }));
vi.mock("@omnesis/providers-synth-common", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@omnesis/providers-synth-common")>()),
  loadSourceFixtureJson: (_universe: unknown, source: string) =>
    source === "github" ? state.threads : state.commits,
  loadActiveUniverse: () => ({}),
  selfAccountId: () => "maya-reeves",
}));
import realGithub, { REPOSITORY_FIELD } from "@omnesis/provider-github";
import { resetFixtureCache } from "./fixtures.js";
import provider, { getGithubAccount } from "./index.js";

const THREADS = "github:maya-reeves";
const COMMITS = "github-commits:maya-reeves";
const NORTHSTAR = { id: 9001, login: "northstar-labs" };
const MAYA = { id: 7001, login: "maya-reeves" };
const maya = { __typename: "User", login: "maya-reeves" };

const issue = (repo: string, number: number) => ({
  __typename: "Issue",
  number,
  title: `Issue ${number} of ${repo}`,
  body: "An invented record.",
  state: "OPEN",
  createdAt: "2026-05-11T09:12:00Z",
  updatedAt: "2026-05-12T10:00:00Z",
  url: `https://github.com/${repo}/issues/${number}`,
  author: maya,
  labels: { nodes: [] },
  assignees: { nodes: [] },
  comments: { totalCount: 0, nodes: [] },
});
const pull = (repo: string, number: number) => ({
  ...issue(repo, number),
  __typename: "PullRequest",
  url: `https://github.com/${repo}/pull/${number}`,
  merged: false,
});
const discussion = (repo: string, number: number) => ({
  number,
  title: `Discussion ${number} of ${repo}`,
  body: "An invented record.",
  createdAt: "2026-05-11T09:12:00Z",
  updatedAt: "2026-05-12T10:00:00Z",
  url: `https://github.com/${repo}/discussions/${number}`,
  author: maya,
  comments: { totalCount: 0, nodes: [] },
});
const commit = (repo: string, sha: string) => ({
  sha,
  html_url: `https://github.com/${repo}/commit/${sha}`,
  commit: {
    message: `Commit in ${repo}`,
    author: { email: "maya.reeves@example.org", date: "2026-05-15T11:22:00Z" },
    committer: { email: "maya.reeves@example.org", date: "2026-05-15T11:22:00Z" },
  },
  author: { login: "maya-reeves", type: "User" },
  committer: { login: "maya-reeves", type: "User" },
  parents: [],
});

const instances: SourceInstance[] = [];

async function create(sourceId: string): Promise<SourceInstance> {
  const entry = provider.sources.find((source) => source.id === sourceId.split(":")[0])!;
  const instance = await entry.create!(
    {
      sourceId: SourceId(sourceId),
      providerId: ProviderId(THREADS),
      accountId: "maya-reeves",
    } as never,
    {},
  );
  instances.push(instance);
  return instance;
}

async function drain(instance: SourceInstance): Promise<DocumentInput[]> {
  const documents: DocumentInput[] = [];
  let cursor: SyncCursor | null = null;
  let result;
  do {
    result = await instance.sync(cursor);
    documents.push(...result.documents);
    cursor = result.cursor;
  } while (result.hasMore);
  return documents;
}

const filed = (documents: DocumentInput[]): Record<string, unknown> =>
  Object.fromEntries(documents.map((doc) => [doc.externalId, doc.metadata.extra?.repositoryIds]));
const list = (instance: SourceInstance) =>
  collectFilterList(instance.filterLists![REPOSITORY_FIELD]!, {
    signal: new AbortController().signal,
  });

beforeEach(() => {
  resetFixtureCache();
  state.threads = {
    repositories: [
      {
        repo: "northstar-labs/atlas-api",
        id: 4101,
        owner: NORTHSTAR,
        threads: [issue("northstar-labs/atlas-api", 1), pull("northstar-labs/atlas-api", 2)],
        discussions: [discussion("northstar-labs/atlas-api", 3)],
      },
      {
        repo: "maya-reeves/atlas-api",
        id: 5202,
        owner: MAYA,
        threads: [pull("maya-reeves/atlas-api", 1)],
        discussions: [],
      },
      {
        repo: "maya-reeves/sketches",
        threads: [issue("maya-reeves/sketches", 1)],
        discussions: [],
      },
    ],
  };
  state.commits = {
    repo: "northstar-labs/atlas-api",
    id: 4101,
    owner: NORTHSTAR,
    commits: [commit("northstar-labs/atlas-api", "c".repeat(40))],
  };
});

afterEach(async () => {
  for (const instance of instances.splice(0)) await instance.dispose?.();
});

describe("the GitHub twin", () => {
  test("writes at the real sources' version and declares their filterable field", () => {
    for (const real of realGithub.sources) {
      const twin = provider.sources.find((source) => source.id === real.id)!;
      expect(twin.contract).toEqual({ outputRevision: real.contract?.outputRevision });
      expect(twin.contract?.outputRevision).toBe(2);
      expect(twin.documentEventProfile).toBe(real.documentEventProfile);
      expect(twin.resyncCost).toBe(real.resyncCost);
    }
  });

  test("files every thread, discussion and commit under its repository's id", async () => {
    expect(filed(await drain(await create(THREADS)))).toEqual({
      "northstar-labs/atlas-api/issues/1": ["4101"],
      "northstar-labs/atlas-api/pull/2": ["4101"],
      "northstar-labs/atlas-api/discussions/3": ["4101"],
      "maya-reeves/atlas-api/pull/1": ["5202"],
      // No id in the fixture: nothing is written, as on the live source.
      "maya-reeves/sketches/issues/1": undefined,
    });
    expect(filed(await drain(await create(COMMITS)))).toEqual({
      [`northstar-labs/atlas-api/commit/${"c".repeat(40)}`]: ["4101"],
    });
  });

  test("lists owners as roots and repositories beneath their holder", async () => {
    expect(await list(await create(THREADS))).toEqual([
      { id: "4101", label: "northstar-labs/atlas-api", parentId: "owner:9001" },
      { id: "5202", label: "maya-reeves/atlas-api", parentId: "owner:7001" },
      { id: "owner:7001", label: "maya-reeves" },
      { id: "owner:9001", label: "northstar-labs" },
    ]);
    // A fixture in the single-repository form lists that one repository.
    expect(await list(await create(COMMITS))).toEqual([
      { id: "4101", label: "northstar-labs/atlas-api", parentId: "owner:9001" },
      { id: "owner:9001", label: "northstar-labs" },
    ]);
  });

  test("a rename, a transfer and a removal change the list and no document", async () => {
    const instance = await create(THREADS);
    const before = await drain(instance);
    const account = getGithubAccount(THREADS)!;

    account.rename(4101, "atlas-core");
    account.transfer(5202, { id: 9300, login: "globex" });
    expect(await list(instance)).toEqual([
      { id: "4101", label: "northstar-labs/atlas-core", parentId: "owner:9001" },
      { id: "5202", label: "globex/atlas-api", parentId: "owner:9300" },
      { id: "owner:9001", label: "northstar-labs" },
      { id: "owner:9300", label: "globex" },
    ]);
    account.remove(4101);
    expect((await list(instance)).map((item) => item.id)).toEqual(["5202", "owner:9300"]);

    expect(await drain(instance)).toEqual(before);
    expect(account.listings).toBe(2);
  });

  test("a listing that fails throws, and the account is forgotten on dispose", async () => {
    const instance = await create(THREADS);
    getGithubAccount(THREADS)!.failListings(true);
    await expect(list(instance)).rejects.toThrow(/could not be listed/);
    await instance.dispose?.();
    expect(getGithubAccount(THREADS)).toBeUndefined();
  });
});
