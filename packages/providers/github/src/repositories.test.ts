// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import {
  collectFilterList,
  documentFieldFilterProblem,
  validateDocumentEventProfile,
} from "@omnesis/source-sdk";
import { ProviderId, SourceId } from "@omnesis/types";
import { GithubClient } from "./client.js";
import { GithubCommitsSource } from "./commits.js";
import { githubCommitsDocumentProfile, githubThreadsDocumentProfile } from "./document-profiles.js";
import { FakeGithub } from "./fake-github.js";
import {
  REPOSITORY_FIELD,
  Repositories,
  inRepository,
  ownerItemId,
  repositoryItemId,
  repositoryList,
} from "./repositories.js";
import { GithubThreadsSource } from "./threads.js";
import githubProvider from "./index.js";
import type { SourceConfig } from "@omnesis/core";
import type { SyncCursor, SyncResult } from "@omnesis/source-sdk";
import type { DocumentInput, FilterListItem } from "@omnesis/types";
import type { FakeRepo } from "./fake-github.js";

const NOW = "2026-05-01T00:00:00Z";
const maya = { login: "maya-reeves" };

const NORTHSTAR = { id: 9001, login: "northstar-labs" };
const MAYA = { id: 9100, login: "maya-reeves" };
const ATLAS = "northstar-labs/atlas-api";
const FORK = "maya-reeves/atlas-api";
const UNNUMBERED = "maya-reeves/scratchpad";

function clientFor(fake: FakeGithub, clock: { now: number } = { now: Date.parse(NOW) }) {
  return new GithubClient("github_pat_test", {
    fetchImpl: fake.fetchImpl,
    sleep: async () => {},
    now: () => clock.now,
  });
}

function threadsSource(
  fake: FakeGithub,
  clock: { now: number } = { now: Date.parse(NOW) },
  sourceConfig?: SourceConfig,
) {
  return new GithubThreadsSource({
    client: clientFor(fake, clock),
    providerId: ProviderId("github:tester"),
    sourceId: SourceId("github:tester"),
    commitsSourceId: SourceId("github-commits:tester"),
    accountId: "tester",
    now: () => clock.now,
    sourceConfig,
  });
}

function commitsSource(fake: FakeGithub, clock: { now: number } = { now: Date.parse(NOW) }) {
  return new GithubCommitsSource({
    client: clientFor(fake, clock),
    providerId: ProviderId("github:tester"),
    sourceId: SourceId("github-commits:tester"),
    now: () => clock.now,
  });
}

/** One issue, one pull request, one discussion and one commit, all the repository's own. */
function contents(prefix: string): Pick<FakeRepo, "threads" | "discussions" | "commits"> {
  return {
    threads: [
      {
        number: 1,
        kind: "issue",
        title: `${prefix} issue`,
        createdAt: "2026-04-01T10:00:00Z",
        updatedAt: "2026-04-02T10:00:00Z",
        author: maya,
        comments: [{ author: maya, body: "A comment.", createdAt: "2026-04-02T10:00:00Z" }],
      },
      {
        number: 2,
        kind: "pull",
        title: `${prefix} pull request`,
        createdAt: "2026-04-03T10:00:00Z",
        updatedAt: "2026-04-03T10:00:00Z",
        author: maya,
      },
    ],
    discussions: [
      {
        number: 3,
        title: `${prefix} discussion`,
        createdAt: "2026-04-04T10:00:00Z",
        updatedAt: "2026-04-04T10:00:00Z",
        author: maya,
      },
    ],
    commits: [
      {
        sha: (prefix.charCodeAt(0) % 16).toString(16).repeat(40),
        message: `${prefix} commit`,
        authorName: "maya-reeves",
        authorEmail: "maya.reeves@example.org",
        authorLogin: "maya-reeves",
        date: "2026-04-05T10:00:00Z",
      },
    ],
  };
}

/**
 * An organization's repository, a personal fork of it, and a repository the
 * listing gives no id for.
 */
function seed(fake: FakeGithub) {
  fake.addRepo(ATLAS, { id: 4101, owner: NORTHSTAR, ...contents("atlas") });
  fake.addRepo(FORK, { id: 4201, owner: MAYA, ...contents("fork") });
  fake.addRepo(UNNUMBERED, { ...contents("scratch") });
}

async function runToCompletion<TCursor extends SyncCursor>(
  source: { sync(cursor: TCursor | null): Promise<SyncResult<TCursor>> },
  cursor: TCursor | null,
) {
  const docs: DocumentInput[] = [];
  let current = cursor;
  for (let i = 0; i < 300; i++) {
    const result = await source.sync(current);
    docs.push(...result.documents);
    current = result.cursor;
    if (!result.hasMore) return { docs, cursor: current };
  }
  throw new Error("sync did not converge in 300 iterations");
}

const repositoryIds = (doc: DocumentInput): unknown => doc.metadata.extra?.repositoryIds;
/** Each document's repository detail, keyed by its external id. */
const filed = (docs: DocumentInput[]): Record<string, unknown> =>
  Object.fromEntries(docs.map((doc) => [doc.externalId, repositoryIds(doc)]));

const list = (source: { repositories: Repositories }): Promise<FilterListItem[]> =>
  collectFilterList(source.repositories.filterList, { signal: new AbortController().signal });
const listingRequests = (fake: FakeGithub): number =>
  fake.requests.filter((request) => request.startsWith("GET /user/repos")).length;

describe("the repository on every document", () => {
  it("files every issue, pull request and discussion under its repository's id", async () => {
    const fake = new FakeGithub();
    seed(fake);
    const { docs } = await runToCompletion(threadsSource(fake), null);
    expect(filed(docs)).toEqual({
      [`${ATLAS}/issues/1`]: ["4101"],
      [`${ATLAS}/pull/2`]: ["4101"],
      [`${ATLAS}/discussions/3`]: ["4101"],
      // A fork is its own repository, held by whoever forked it.
      [`${FORK}/issues/1`]: ["4201"],
      [`${FORK}/pull/2`]: ["4201"],
      [`${FORK}/discussions/3`]: ["4201"],
      // No id from GitHub: where the document sits is not known, which is
      // written as nothing at all, never as an empty list.
      [`${UNNUMBERED}/issues/1`]: undefined,
      [`${UNNUMBERED}/pull/2`]: undefined,
      [`${UNNUMBERED}/discussions/3`]: undefined,
    });
    for (const doc of docs) {
      // Only the repository: the owner above it is said by the list.
      expect(Object.keys(doc.metadata.extra ?? {})).not.toContain("ownerId");
      expect(JSON.stringify(repositoryIds(doc) ?? [])).not.toMatch(/owner|northstar|maya/);
    }
  });

  it("files every commit under its repository's id", async () => {
    const fake = new FakeGithub();
    seed(fake);
    const { docs } = await runToCompletion(commitsSource(fake), null);
    expect(docs).toHaveLength(3);
    expect(
      Object.fromEntries(docs.map((doc) => [doc.metadata.extra?.repo, repositoryIds(doc)])),
    ).toEqual({ [ATLAS]: ["4101"], [FORK]: ["4201"], [UNNUMBERED]: undefined });
  });

  it("leaves a document untouched when there is no usable id", () => {
    const doc: DocumentInput = {
      sourceId: SourceId("github:tester"),
      providerId: ProviderId("github:tester"),
      externalId: `${ATLAS}/issues/1`,
      title: "t",
      content: "c",
      contentHash: "h",
      metadata: { documentType: "conversation", extra: { repo: ATLAS } },
      sourceCreatedAt: "2026-04-01T10:00:00Z",
      sourceUpdatedAt: "2026-04-01T10:00:00Z",
    };
    for (const id of [undefined, 0, -4, 1.5, Number.NaN, "4101" as unknown as number]) {
      expect(inRepository(doc, id)).toBe(doc);
    }
    expect(inRepository(doc, 4101).metadata.extra).toEqual({
      repo: ATLAS,
      repositoryIds: ["4101"],
    });
  });

  it("finds a repository whatever the letter case of its name", async () => {
    const fake = new FakeGithub();
    seed(fake);
    const repositories = new Repositories(clientFor(fake), undefined);
    expect(await repositories.idOf("Northstar-Labs/Atlas-API")).toBe(4101);
    expect(await repositories.idOf("northstar-labs/unknown")).toBeUndefined();
    expect(await repositories.idOf(UNNUMBERED)).toBeUndefined();
  });

  it("a cycle resumed by a fresh process still files its documents, after one listing", async () => {
    const fake = new FakeGithub();
    seed(fake);
    const first = threadsSource(fake);
    // Cycle start and discovery, stopping before anything is materialized.
    let cursor = (await first.sync(null)).cursor;
    while ((cursor.pending?.length ?? 0) === 0) cursor = (await first.sync(cursor)).cursor;

    const before = listingRequests(fake);
    const resumed = await runToCompletion(threadsSource(fake), cursor);
    expect(resumed.docs.length).toBeGreaterThan(0);
    for (const doc of resumed.docs) {
      const expected = doc.externalId.startsWith(ATLAS)
        ? ["4101"]
        : doc.externalId.startsWith(FORK)
          ? ["4201"]
          : undefined;
      expect(repositoryIds(doc), doc.externalId).toEqual(expected);
    }
    expect(listingRequests(fake) - before).toBe(1);
  });
});

describe("the list of owners and repositories", () => {
  it("has owners as roots and each repository beneath the owner that holds it", async () => {
    const fake = new FakeGithub();
    seed(fake);
    expect(await list(threadsSource(fake))).toEqual([
      // The fork sits under whoever holds it, not under the organization it was forked from.
      { id: "4101", label: ATLAS, parentId: "owner:9001" },
      { id: "4201", label: FORK, parentId: "owner:9100" },
      { id: "owner:9001", label: "northstar-labs" },
      { id: "owner:9100", label: "maya-reeves" },
      // The repository without an id is not listed: nothing could be filed under it.
    ]);
  });

  it("is the same list for both sources of an account", async () => {
    const fake = new FakeGithub();
    seed(fake);
    expect(await list(commitsSource(fake))).toEqual(await list(threadsSource(fake)));
  });

  it("keeps an owner and a repository with the same number apart", () => {
    const items = repositoryList([
      { full_name: "seven/seven", id: 7, owner: { id: 7, login: "seven" } },
    ]);
    expect(items).toEqual([
      { id: "owner:7", label: "seven" },
      { id: "7", label: "seven/seven", parentId: "owner:7" },
    ]);
    expect(repositoryItemId(7)).not.toBe(ownerItemId(7));
  });

  it("leaves out what GitHub gave no id for, and names a repeated row once", () => {
    expect(
      repositoryList([
        { full_name: "a/one", id: 1, owner: { id: 10, login: "a" } },
        { full_name: "a/one", id: 1, owner: { id: 10, login: "a" } },
        { full_name: "a/no-id", owner: { id: 10, login: "a" } },
        { full_name: "b/no-owner-id", id: 2, owner: { login: "b" } },
        { full_name: "c/no-owner", id: 3, owner: null },
        { full_name: "d/no-login", id: 4, owner: { id: 40 } },
      ]),
    ).toEqual([
      { id: "owner:10", label: "a" },
      { id: "owner:40", label: "d" },
      { id: "1", label: "a/one", parentId: "owner:10" },
      { id: "4", label: "d/no-login", parentId: "owner:40" },
    ]);
  });

  it("a rename or a transfer changes the list and not the id documents carry", async () => {
    const fake = new FakeGithub();
    seed(fake);
    const source = threadsSource(fake);
    const before = await runToCompletion(source, null);
    const atlasBefore = before.docs.filter((doc) => doc.metadata.extra?.repo === ATLAS);

    // Renamed and handed to another organization: GitHub keeps the id.
    const moved = fake.repo(ATLAS);
    fake.repos.delete(ATLAS);
    fake.addRepo("globex/atlas-core", { ...moved, owner: { id: 9300, login: "globex" } });

    const items = await collectFilterList(new Repositories(clientFor(fake), undefined).filterList, {
      signal: new AbortController().signal,
    });
    expect(items).toContainEqual({
      id: "4101",
      label: "globex/atlas-core",
      parentId: "owner:9300",
    });
    expect(items).toContainEqual({ id: "owner:9300", label: "globex" });
    // The organization that no longer holds anything is no longer listed.
    expect(items.map((item) => item.id)).not.toContain("owner:9001");
    // What was written before the move still names the repository that moved.
    expect(atlasBefore.map(repositoryIds)).toEqual([["4101"], ["4101"], ["4101"]]);
  });

  it("drops a repository that left the listing or the configured set", async () => {
    const fake = new FakeGithub();
    seed(fake);
    const clock = { now: Date.parse(NOW) };
    const source = threadsSource(fake, clock);
    await runToCompletion(source, null);
    expect((await list(source)).map((item) => item.id)).toContain("4201");

    fake.repos.delete(FORK);
    clock.now += 15 * 60 * 1000;
    expect(await list(source)).toEqual([
      { id: "4101", label: ATLAS, parentId: "owner:9001" },
      { id: "owner:9001", label: "northstar-labs" },
    ]);

    const excluded = threadsSource(fake, clock, {
      enabled: true,
      params: { excludeRepos: ATLAS },
    });
    expect(await list(excluded)).toEqual([]);
  });

  it("throws rather than publish part of a list when the listing fails", async () => {
    const fake = new FakeGithub();
    seed(fake);
    const failing: typeof fetch = async () => new Response("{}", { status: 500 });
    const repositories = new Repositories(
      new GithubClient("github_pat_test", { fetchImpl: failing, sleep: async () => {} }),
      undefined,
    );
    await expect(
      collectFilterList(repositories.filterList, { signal: new AbortController().signal }),
    ).rejects.toThrow(/GitHub/);
  });
});

describe("what the list costs", () => {
  /** A repository holding `count` issues. */
  function bulk(count: number): Pick<FakeRepo, "threads"> {
    return {
      threads: Array.from({ length: count }, (_, index) => ({
        number: index + 1,
        kind: "issue" as const,
        title: `Issue ${index + 1}`,
        createdAt: "2026-04-01T10:00:00Z",
        updatedAt: "2026-04-01T10:00:00Z",
        author: maya,
      })),
    };
  }

  it("reuses the listing the cycle just read: no request at all", async () => {
    const fake = new FakeGithub();
    seed(fake);
    const source = threadsSource(fake);
    const started = await source.sync(null);
    expect(started.hasMore).toBe(true);
    const requests = fake.requests.length;
    expect(await list(source)).toHaveLength(4);
    expect(fake.requests.length).toBe(requests);
  });

  it("one whole cycle lists the account once, however many documents it writes", async () => {
    for (const count of [3, 250]) {
      const fake = new FakeGithub();
      fake.addRepo(ATLAS, { id: 4101, owner: NORTHSTAR, ...bulk(count) });
      const source = threadsSource(fake);
      const { docs } = await runToCompletion(source, null);
      expect(docs).toHaveLength(count);
      await list(source);
      expect(listingRequests(fake)).toBe(1);
    }
  });

  it("read on its own, costs the listing pages and nothing per repository or document", async () => {
    const fake = new FakeGithub();
    for (let index = 0; index < 150; index++) {
      fake.addRepo(`northstar-labs/service-${String(index).padStart(3, "0")}`, {
        id: 5000 + index,
        owner: NORTHSTAR,
        ...bulk(2),
      });
    }
    const repositories = new Repositories(clientFor(fake), undefined);
    const items = await collectFilterList(repositories.filterList, {
      signal: new AbortController().signal,
    });
    expect(items).toHaveLength(151);
    // 150 repositories are two pages of a hundred.
    expect(fake.requests).toEqual([
      "GET /user/repos?per_page=100&page=1&sort=full_name",
      "GET /user/repos?per_page=100&page=2&sort=full_name",
    ]);
  });

  it("lists again once the cycle's listing is no longer recent", async () => {
    const fake = new FakeGithub();
    seed(fake);
    const clock = { now: Date.parse(NOW) };
    const source = threadsSource(fake, clock);
    await source.sync(null);
    clock.now += 5 * 60 * 1000;
    const before = listingRequests(fake);
    await list(source);
    expect(listingRequests(fake) - before).toBe(1);
  });
});

describe("a read from an empty cursor", () => {
  it("sends every issue, pull request and discussion again, each with its repository", async () => {
    const fake = new FakeGithub();
    seed(fake);
    const source = threadsSource(fake);
    const first = await runToCompletion(source, null);
    expect(first.docs).toHaveLength(9);
    // Nothing changed upstream: an ordinary cycle sends nothing.
    expect((await runToCompletion(source, first.cursor)).docs).toEqual([]);

    const again = await runToCompletion(source, null);
    expect(filed(again.docs)).toEqual(filed(first.docs));
    expect(again.docs.map((doc) => doc.contentHash).sort()).toEqual(
      first.docs.map((doc) => doc.contentHash).sort(),
    );
  });

  it("sends every commit again, each with its repository", async () => {
    const fake = new FakeGithub();
    seed(fake);
    const source = commitsSource(fake);
    const first = await runToCompletion(source, null);
    expect(first.docs).toHaveLength(3);
    expect((await runToCompletion(source, first.cursor)).docs).toEqual([]);

    const again = await runToCompletion(source, null);
    expect(filed(again.docs)).toEqual(filed(first.docs));
  });
});

describe("the declaration", () => {
  const sources = Object.fromEntries(githubProvider.sources.map((source) => [source.id, source]));

  it("both sources write at version 2 and say what a resync costs", () => {
    for (const id of ["github", "github-commits"]) {
      expect(sources[id].contract?.outputRevision, id).toBe(2);
      expect(sources[id].resyncCost, id).toMatch(/GitHub/);
    }
  });

  it("the repository field is a tree of owners and repositories, from version 2", () => {
    for (const profile of [githubThreadsDocumentProfile, githubCommitsDocumentProfile]) {
      const field = profile.metadataFields?.find((f) => f.path === REPOSITORY_FIELD);
      expect(field).toMatchObject({
        type: "string-array",
        filter: {
          capability: "tree",
          minVersion: 2,
          scope: "global",
          noun: { one: "repository", many: "repositories" },
          levels: [
            { one: "owner", many: "owners" },
            { one: "repository", many: "repositories" },
          ],
          picker: "tree",
          inside: { one: "repository", many: "repositories" },
        },
      });
      // Exactly one filterable field, and no person filter.
      expect(profile.metadataFields?.filter((f) => f.filter !== undefined)).toHaveLength(1);
      expect(profile.personFilter).toBeUndefined();
      // The check a gateway applies before it calls the field ready.
      expect(
        documentFieldFilterProblem(field!.type, field!.filter, { outputRevision: 2 }),
      ).toBeNull();
      // A source still at version 1 could not declare it.
      expect(documentFieldFilterProblem(field!.type, field!.filter, { outputRevision: 1 })).toMatch(
        /outputRevision/,
      );
    }
  });

  it("passes the checks a source is defined under", () => {
    for (const [profile, id] of [
      [githubThreadsDocumentProfile, "github"],
      [githubCommitsDocumentProfile, "github-commits"],
    ] as const) {
      expect(() =>
        validateDocumentEventProfile(profile, id, { outputRevision: 2, partitioned: false }),
      ).not.toThrow();
    }
  });

  it("the existing repository name field is unchanged", () => {
    for (const profile of [githubThreadsDocumentProfile, githubCommitsDocumentProfile]) {
      expect(profile.metadataFields?.find((f) => f.path === "extra.repo")).toEqual({
        path: "extra.repo",
        type: "string",
        description:
          "Repository the document belongs to, spelled owner/name exactly as it appears in the GitHub URL (for example acme/widgets).",
        identifiesPeople: true,
      });
    }
  });

  it("each source attaches the producer of its list", async () => {
    const fake = new FakeGithub();
    seed(fake);
    for (const id of ["github", "github-commits"]) {
      const instance = await sources[id].create(
        {
          sourceId: SourceId(`${id}:tester`),
          providerId: ProviderId("github:tester"),
          accountId: "tester",
        } as Parameters<(typeof sources)[string]["create"]>[0],
        { client: clientFor(fake), accountId: "tester" },
      );
      expect(Object.keys(instance.filterLists ?? {})).toEqual([REPOSITORY_FIELD]);
      const items = await collectFilterList(instance.filterLists![REPOSITORY_FIELD], {
        signal: new AbortController().signal,
      });
      expect(items.map((item) => item.id)).toEqual(["4101", "4201", "owner:9001", "owner:9100"]);
    }
  });
});
