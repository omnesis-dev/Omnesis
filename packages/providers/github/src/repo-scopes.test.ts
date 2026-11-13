// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { ProviderId, SourceId } from "@omnesis/types";
import { GithubClient } from "./client.js";
import { GithubCommitsSource } from "./commits.js";
import { FakeGithub } from "./fake-github.js";
import {
  isRepoScopeCursor,
  ownerScopeId,
  repoDocumentScope,
  repoScopeCatalogue,
  repoScopeId,
} from "./repo-scopes.js";
import { scopeContracts } from "./scope-contracts.js";
import { GithubThreadsSource } from "./threads.js";
import type { SourceConfig } from "@omnesis/core";
import type { SyncOptions, SyncResult } from "@omnesis/source-sdk";
import type { DocumentInput, SourceScopeUpdates } from "@omnesis/types";
import type { FakeCommit, FakeRepo, FakeThread } from "./fake-github.js";
import type { GithubCommitsCursor, GithubThreadsCursor } from "./types.js";

const NORTHSTAR = { id: 9001, login: "northstar-labs" };
const MAYA = { id: 7001, login: "maya-reeves" };
const ATLAS = "northstar-labs/atlas-api";
const BEACON = "northstar-labs/beacon-web";
const GARDEN = "maya-reeves/garden-notes";
const NOW = "2026-05-01T00:00:00Z";
const DAY_MS = 24 * 60 * 60 * 1000;

const sha = (seed: number) => seed.toString(16).padStart(12, "0").padEnd(40, "a");
const commit = (seed: number, day = 1): FakeCommit => ({
  sha: sha(seed),
  message: `Invented change ${seed}`,
  authorEmail: "maya@example.org",
  authorLogin: "maya-reeves",
  date: `2026-04-${String(day).padStart(2, "0")}T10:00:00Z`,
});
const issue = (number: number): FakeThread => ({
  number,
  kind: "issue",
  title: `Invented issue ${number}`,
  body: `Body of invented issue ${number}.`,
  createdAt: "2026-04-01T10:00:00Z",
  updatedAt: "2026-04-01T10:00:00Z",
  author: { login: "maya-reeves" },
});

/**
 * The gateway's side of the filter protocol, reduced to what a source can
 * observe: the epoch it requires, the catalogue and its snapshots, and which
 * documents are attributed under the epoch in force.
 */
class ScopeGateway {
  epoch?: string;
  requestId?: string;
  refreshing = false;
  ready = false;
  nodes = new Map<string, { label: string; parentIds: string[]; complete: boolean }>();
  documents = new Map<string, { parentIds: string[]; complete: boolean; epoch?: string }>();
  pages: SourceScopeUpdates[] = [];
  private seen?: { id: string; nodes: Set<string> };
  private issued = 0;

  options(extra: Partial<SyncOptions> = {}): SyncOptions {
    return {
      scopeFactsSupported: true,
      scopeHierarchySupported: true,
      scopeRefreshEpochsSupported: true,
      ...(this.epoch ? { scopeRefreshEpochs: { folder: this.epoch } } : {}),
      ...(this.requestId ? { scopeRefreshRequestIds: { folder: this.requestId } } : {}),
      scopeRefreshActorId: "device-one",
      ...extra,
    };
  }

  /** Require a new refresh, as the gateway does when its stored facts are no longer trusted. */
  rotate(): void {
    this.epoch = `epoch-${++this.issued}`;
    this.requestId = undefined;
    this.refreshing = true;
    this.ready = false;
  }

  accept(result: SyncResult): void {
    for (const document of result.documents) {
      const scope = document.metadata.scopeHierarchy?.[0];
      this.documents.set(document.externalId, {
        parentIds: scope?.parentIds ?? [],
        complete: scope?.complete === true,
        epoch: scope?.refreshEpoch,
      });
    }
    const updates = result.scopeUpdates;
    if (!updates) return;
    this.pages.push(updates);
    expect(updates.hierarchy?.nodes?.length ?? 0).toBeLessThanOrEqual(256);
    expect(updates.hierarchy?.documents?.length ?? 0).toBeLessThanOrEqual(256);
    for (const refresh of updates.refreshes ?? []) {
      if (!refresh.active) continue;
      if (this.epoch && refresh.epoch !== undefined && refresh.epoch !== this.epoch) continue;
      if (this.epoch && this.refreshing && !refresh.restart) continue;
      this.epoch = `epoch-${++this.issued}`;
      this.requestId = refresh.requestId;
      this.refreshing = true;
    }
    const hierarchy = updates.hierarchy;
    if (hierarchy && (!this.epoch || hierarchy.refreshEpoch === this.epoch)) {
      if (hierarchy.snapshot?.phase === "begin")
        this.seen = { id: hierarchy.snapshot.id, nodes: new Set() };
      if (hierarchy.snapshot) expect(hierarchy.snapshot.id).toBe(this.seen?.id);
      for (const node of hierarchy.nodes ?? []) {
        if (node.deleted) this.nodes.delete(node.id);
        else {
          this.nodes.set(node.id, {
            label: node.label,
            parentIds: node.parentIds,
            complete: node.complete,
          });
          this.seen?.nodes.add(node.id);
        }
      }
      for (const patch of hierarchy.documents ?? [])
        if (this.documents.has(patch.externalId))
          this.documents.set(patch.externalId, {
            parentIds: patch.parentIds,
            complete: patch.complete,
            epoch: patch.refreshEpoch,
          });
      if (hierarchy.snapshot?.phase === "end") {
        for (const id of [...this.nodes.keys()])
          if (!this.seen!.nodes.has(id)) this.nodes.delete(id);
        this.seen = undefined;
      }
    }
    for (const refresh of updates.refreshes ?? [])
      if (!refresh.active && refresh.epoch === this.epoch) this.refreshing = false;
    for (const state of updates.readiness ?? [])
      if (state.kind === "folder") this.ready = state.complete;
  }

  /**
   * The labels a filter could match the document by: its repository and that
   * repository's owner. Null while the document is withheld from any filter.
   */
  attribution(externalId: string): string[] | null {
    const document = this.documents.get(externalId);
    if (!document?.complete || this.refreshing || !this.ready) return null;
    if (this.epoch && document.epoch !== this.epoch) return null;
    const labels: string[] = [];
    let ids = document.parentIds;
    for (let depth = 0; ids.length && depth < 4; depth++) {
      const next: string[] = [];
      for (const id of ids) {
        const node = this.nodes.get(id);
        if (!node?.complete) return null;
        labels.push(node.label);
        next.push(...node.parentIds);
      }
      ids = next;
    }
    return labels;
  }
}

function client(fake: FakeGithub, now: () => number) {
  return new GithubClient("github_pat_test", {
    fetchImpl: fake.fetchImpl,
    sleep: async () => {},
    now,
  });
}
function commitsSource(
  fake: FakeGithub,
  now: () => number,
  sourceConfig?: Record<string, unknown>,
) {
  return new GithubCommitsSource({
    client: client(fake, now),
    providerId: ProviderId("github:tester"),
    sourceId: SourceId("github-commits:tester"),
    now,
    sourceConfig: sourceConfig as SourceConfig | undefined,
  });
}
function threadsSource(fake: FakeGithub, now: () => number) {
  return new GithubThreadsSource({
    client: client(fake, now),
    providerId: ProviderId("github:tester"),
    sourceId: SourceId("github:tester"),
    commitsSourceId: SourceId("github-commits:tester"),
    accountId: "tester",
    now,
  });
}

/** Run sync pages until the source rests, handing each to the gateway as it lands. */
async function settle<TCursor extends GithubCommitsCursor | GithubThreadsCursor>(
  source: { sync(cursor: TCursor | null, opts?: SyncOptions): Promise<SyncResult<TCursor>> },
  cursor: TCursor | null,
  gateway: ScopeGateway | undefined,
  options?: () => SyncOptions | undefined,
): Promise<{ cursor: TCursor; docs: DocumentInput[]; pages: SyncResult<TCursor>[] }> {
  const docs: DocumentInput[] = [];
  const pages: SyncResult<TCursor>[] = [];
  let current = cursor;
  for (let page = 0; page < 400; page++) {
    const result = await source.sync(current, options ? options() : gateway?.options());
    // A page is committed as JSON; what does not survive that is not state.
    current = JSON.parse(JSON.stringify(result.cursor)) as TCursor;
    gateway?.accept(result);
    docs.push(...result.documents);
    pages.push(result);
    if (!result.hasMore) return { cursor: current, docs, pages };
  }
  throw new Error("sync did not settle in 400 pages");
}

function account(fake: FakeGithub, repos: Record<string, Partial<FakeRepo>>): void {
  for (const [name, repo] of Object.entries(repos)) fake.addRepo(name, repo);
}
function workAndPersonal(fake: FakeGithub): void {
  account(fake, {
    [ATLAS]: { id: 101, owner: NORTHSTAR, commits: [commit(1), commit(2)] },
    [BEACON]: { id: 102, owner: NORTHSTAR, commits: [commit(3)] },
    [GARDEN]: { id: 201, owner: MAYA, commits: [commit(4)] },
  });
}
const commitId = (repo: string, seed: number) => `${repo}/commit/${sha(seed)}`;

describe("the GitHub filter declaration", () => {
  it("names a tree of owners and repositories for both sources", () => {
    for (const type of ["github", "github-commits"] as const)
      expect(scopeContracts[type].items).toEqual([
        {
          kind: "folder",
          noun: { one: "repository or owner", many: "repositories and owners" },
          levels: [
            { one: "owner", many: "owners" },
            { one: "repository", many: "repositories" },
          ],
          picker: "tree",
          link: "hierarchy",
        },
      ]);
  });
});

describe("repoScopeCatalogue", () => {
  it("puts each repository under its owner by GitHub's ids, owners first and once each", () => {
    const { nodes, ids } = repoScopeCatalogue([
      { full_name: ATLAS, id: 101, owner: NORTHSTAR },
      { full_name: GARDEN, id: 201, owner: MAYA },
      { full_name: BEACON, id: 102, owner: NORTHSTAR },
    ]);
    expect(nodes).toEqual([
      { id: "owner:9001", label: "northstar-labs", parentIds: [], complete: true },
      { id: "owner:7001", label: "maya-reeves", parentIds: [], complete: true },
      { id: "repo:101", label: ATLAS, parentIds: ["owner:9001"], complete: true },
      { id: "repo:201", label: GARDEN, parentIds: ["owner:7001"], complete: true },
      { id: "repo:102", label: BEACON, parentIds: ["owner:9001"], complete: true },
    ]);
    expect(ids).toEqual({ [ATLAS]: "repo:101", [GARDEN]: "repo:201", [BEACON]: "repo:102" });
    expect([ownerScopeId(9001), repoScopeId(101)]).toEqual(["owner:9001", "repo:101"]);
  });

  it("files a fork under the account that holds it, not under the repository it was forked from", () => {
    const { nodes } = repoScopeCatalogue([
      { full_name: ATLAS, id: 101, owner: NORTHSTAR },
      { full_name: "maya-reeves/atlas-api", id: 202, owner: MAYA },
    ]);
    expect(nodes.find((node) => node.id === "repo:202")).toEqual({
      id: "repo:202",
      label: "maya-reeves/atlas-api",
      parentIds: ["owner:7001"],
      complete: true,
    });
  });

  it("keys repositories case-insensitively and keeps the spelling GitHub reports as the label", () => {
    const { nodes, ids } = repoScopeCatalogue([
      {
        full_name: "Northstar-Labs/Atlas-API",
        id: 101,
        owner: { id: 9001, login: "Northstar-Labs" },
      },
    ]);
    expect(ids).toEqual({ "northstar-labs/atlas-api": "repo:101" });
    expect(nodes.map((node) => node.label)).toEqual(["Northstar-Labs", "Northstar-Labs/Atlas-API"]);
    expect(repoDocumentScope(ids, "NORTHSTAR-LABS/atlas-api").parentIds).toEqual(["repo:101"]);
  });

  it("leaves a repository whose owner is unnamed with its place unknown, never as a root", () => {
    const { nodes, ids } = repoScopeCatalogue([
      { full_name: ATLAS, id: 101 },
      { full_name: BEACON, id: 102, owner: { login: "northstar-labs" } },
      { full_name: GARDEN, id: 201, owner: null },
    ]);
    expect(nodes).toEqual([
      { id: "repo:101", label: ATLAS, parentIds: [], complete: false },
      { id: "repo:102", label: BEACON, parentIds: [], complete: false },
      { id: "repo:201", label: GARDEN, parentIds: [], complete: false },
    ]);
    expect(Object.keys(ids)).toHaveLength(3);
  });

  it("gives a row without a usable id no entry at all", () => {
    for (const id of [undefined, 0, -4, 1.5, Number.NaN, "101" as unknown as number]) {
      const { nodes, ids } = repoScopeCatalogue([{ full_name: ATLAS, id, owner: NORTHSTAR }]);
      expect(nodes).toEqual([]);
      expect(ids).toEqual({});
    }
  });

  it("names an owner by the login in the repository's name when the row carries none", () => {
    const { nodes } = repoScopeCatalogue([{ full_name: ATLAS, id: 101, owner: { id: 9001 } }]);
    expect(nodes[0]).toMatchObject({ id: "owner:9001", label: "northstar-labs" });
  });
});

describe("repoDocumentScope", () => {
  const ids = { [ATLAS]: "repo:101" };
  it("names the repository alone, and carries the refresh it was observed under", () => {
    expect(repoDocumentScope(ids, ATLAS)).toEqual({
      kind: "folder",
      parentIds: ["repo:101"],
      complete: true,
    });
    expect(repoDocumentScope(ids, ATLAS, "epoch-1").refreshEpoch).toBe("epoch-1");
  });
  it("says so when the repository is not one this source can identify", () => {
    const unknown = { kind: "folder", parentIds: [], complete: false };
    expect(repoDocumentScope(ids, GARDEN)).toEqual(unknown);
    expect(repoDocumentScope(undefined, ATLAS)).toEqual(unknown);
    expect(repoDocumentScope(ids, "northstar-labs/atlas")).toEqual(unknown);
    expect(repoDocumentScope(ids, "northstar-labs/atlas-api-v2")).toEqual(unknown);
    expect(repoDocumentScope(ids, "__proto__")).toEqual(unknown);
    expect(repoDocumentScope(ids, "constructor")).toEqual(unknown);
  });
});

describe("isRepoScopeCursor", () => {
  it("accepts the fields a page writes and refuses each malformed one", () => {
    expect(isRepoScopeCursor({})).toBe(true);
    expect(
      isRepoScopeCursor({
        scopeReposCut: { epoch: "epoch-1", authority: "holder", after: "scan" },
        scopeReposAsked: true,
        scopeReposSnapshot: "snapshot-1",
        scopeReposNodes: { "repo:101": "digest" },
        scopeReposIds: { [ATLAS]: "repo:101" },
        scopeReposUnlisted: [GARDEN],
      }),
    ).toBe(true);
    for (const bad of [
      { scopeReposCut: { epoch: "" } },
      { scopeReposAsked: "yes" },
      { scopeReposSnapshot: "" },
      { scopeReposNodes: { "repo:101": 4 } },
      { scopeReposNodes: [] },
      { scopeReposIds: { [ATLAS]: null } },
      { scopeReposUnlisted: [4] },
      { scopeReposUnlisted: "all" },
    ])
      expect(isRepoScopeCursor(bad), JSON.stringify(bad)).toBe(false);
  });
});

describe("GitHub sources and a gateway that takes filter facts", () => {
  it("says nothing about repositories to a gateway that did not ask", async () => {
    const fake = new FakeGithub();
    workAndPersonal(fake);
    const now = () => Date.parse(NOW);
    const { cursor, docs, pages } = await settle(commitsSource(fake, now), null, undefined);
    expect(docs).toHaveLength(4);
    for (const doc of docs) expect(doc.metadata.scopeHierarchy).toBeUndefined();
    for (const page of pages) expect(page.scopeUpdates).toBeUndefined();
    expect(Object.keys(cursor).filter((key) => key.startsWith("scopeRepos"))).toEqual([]);
  });

  it("keeps the filter closed on a gateway that takes facts but no tree", async () => {
    const fake = new FakeGithub();
    workAndPersonal(fake);
    const now = () => Date.parse(NOW);
    const { cursor, docs, pages } = await settle(commitsSource(fake, now), null, undefined, () => ({
      scopeFactsSupported: true,
    }));
    for (const doc of docs) expect(doc.metadata.scopeHierarchy).toBeUndefined();
    for (const page of pages)
      expect(page.scopeUpdates).toEqual({
        refreshes: [{ kind: "folder", active: true }],
        readiness: [{ kind: "folder", complete: false }],
      });
    expect(Object.keys(cursor).filter((key) => key.startsWith("scopeRepos"))).toEqual([]);
  });

  it("opens a refresh, publishes the tree, and attributes every commit to its repository and owner", async () => {
    const fake = new FakeGithub();
    workAndPersonal(fake);
    const gateway = new ScopeGateway();
    const now = () => Date.parse(NOW);
    const { cursor, docs } = await settle(commitsSource(fake, now), null, gateway);

    expect(docs).toHaveLength(4);
    expect(gateway.ready).toBe(true);
    expect(gateway.refreshing).toBe(false);
    expect(Object.fromEntries(gateway.nodes)).toEqual({
      "owner:9001": { label: "northstar-labs", parentIds: [], complete: true },
      "owner:7001": { label: "maya-reeves", parentIds: [], complete: true },
      "repo:101": { label: ATLAS, parentIds: ["owner:9001"], complete: true },
      "repo:102": { label: BEACON, parentIds: ["owner:9001"], complete: true },
      "repo:201": { label: GARDEN, parentIds: ["owner:7001"], complete: true },
    });
    expect(gateway.attribution(commitId(ATLAS, 1))).toEqual([ATLAS, "northstar-labs"]);
    expect(gateway.attribution(commitId(ATLAS, 2))).toEqual([ATLAS, "northstar-labs"]);
    expect(gateway.attribution(commitId(BEACON, 3))).toEqual([BEACON, "northstar-labs"]);
    expect(gateway.attribution(commitId(GARDEN, 4))).toEqual([GARDEN, "maya-reeves"]);
    // The handshake: ask for a refresh, restart it under a request of its own, then scan.
    expect(gateway.pages.slice(0, 2).map((page) => page.refreshes?.[0])).toMatchObject([
      { kind: "folder", active: true },
      { kind: "folder", active: true, restart: true, epoch: "epoch-1" },
    ]);
    expect(gateway.pages[2]?.hierarchy?.snapshot?.phase).toBe("begin");
    expect(gateway.pages.at(-1)).toMatchObject({
      hierarchy: { snapshot: { phase: "end" } },
      refreshes: [{ kind: "folder", active: false, epoch: gateway.epoch }],
      readiness: [{ kind: "folder", complete: true }],
    });
    expect(cursor.scopeReposCut).toMatchObject({ epoch: gateway.epoch, completed: true });
    expect(cursor.scopeReposSnapshot).toBeUndefined();

    // A settled source says nothing more until something changes.
    const quiet = await settle(
      commitsSource(fake, () => Date.parse(NOW) + 60_000),
      cursor,
      gateway,
    );
    for (const page of quiet.pages) expect(page.scopeUpdates).toBeUndefined();
  });

  it("attributes issues, pull requests and discussions the same way", async () => {
    const fake = new FakeGithub();
    account(fake, {
      [ATLAS]: {
        id: 101,
        owner: NORTHSTAR,
        threads: [issue(1), { ...issue(2), kind: "pull", title: "Invented pull request" }],
        discussions: [
          {
            number: 3,
            title: "Invented discussion",
            createdAt: "2026-04-01T10:00:00Z",
            updatedAt: "2026-04-01T10:00:00Z",
            author: { login: "maya-reeves" },
          },
        ],
      },
      [GARDEN]: { id: 201, owner: MAYA, threads: [issue(1)] },
    });
    const gateway = new ScopeGateway();
    const { docs } = await settle(
      threadsSource(fake, () => Date.parse(NOW)),
      null,
      gateway,
    );
    expect(docs.map((doc) => doc.externalId).sort()).toEqual([
      `${GARDEN}/issues/1`,
      `${ATLAS}/discussions/3`,
      `${ATLAS}/issues/1`,
      `${ATLAS}/pull/2`,
    ]);
    for (const doc of docs)
      expect(doc.metadata.scopeHierarchy).toEqual([
        {
          kind: "folder",
          parentIds: [doc.externalId.startsWith(ATLAS) ? "repo:101" : "repo:201"],
          complete: true,
          refreshEpoch: gateway.epoch,
        },
      ]);
    expect(gateway.attribution(`${ATLAS}/pull/2`)).toEqual([ATLAS, "northstar-labs"]);
    expect(gateway.attribution(`${ATLAS}/discussions/3`)).toEqual([ATLAS, "northstar-labs"]);
    expect(gateway.attribution(`${GARDEN}/issues/1`)).toEqual([GARDEN, "maya-reeves"]);
  });

  it("attributes documents stored before the gateway asked, without fetching one of them again", async () => {
    const fake = new FakeGithub();
    workAndPersonal(fake);
    const gateway = new ScopeGateway();
    let clock = Date.parse(NOW);
    const before = await settle(
      commitsSource(fake, () => clock),
      null,
      undefined,
    );
    for (const doc of before.docs)
      gateway.accept({ documents: [doc], deletedExternalIds: [], cursor: {}, hasMore: false });
    expect(gateway.attribution(commitId(ATLAS, 1))).toBeNull();

    clock += 60_000;
    fake.requests.length = 0;
    const after = await settle(
      commitsSource(fake, () => clock),
      before.cursor,
      gateway,
    );
    expect(after.docs).toEqual([]);
    expect(fake.requests.filter((request) => /\/commits\/[0-9a-f]{40}/.test(request))).toEqual([]);
    expect(gateway.attribution(commitId(ATLAS, 1))).toEqual([ATLAS, "northstar-labs"]);
    expect(gateway.attribution(commitId(GARDEN, 4))).toEqual([GARDEN, "maya-reeves"]);
    expect(gateway.ready).toBe(true);
  });

  it("answers a refresh the gateway requires later by attributing everything again under it", async () => {
    const fake = new FakeGithub();
    workAndPersonal(fake);
    const gateway = new ScopeGateway();
    let clock = Date.parse(NOW);
    const first = await settle(
      commitsSource(fake, () => clock),
      null,
      gateway,
    );
    const settled = gateway.epoch;
    gateway.rotate();
    expect(gateway.attribution(commitId(ATLAS, 1))).toBeNull();
    clock += 60_000;
    const second = await settle(
      commitsSource(fake, () => clock),
      first.cursor,
      gateway,
    );
    expect(second.docs).toEqual([]);
    expect(gateway.epoch).not.toBe(settled);
    expect(gateway.refreshing).toBe(false);
    expect(gateway.attribution(commitId(ATLAS, 1))).toEqual([ATLAS, "northstar-labs"]);
    expect(gateway.attribution(commitId(GARDEN, 4))).toEqual([GARDEN, "maya-reeves"]);
  });

  it("keeps a completed refresh through a page on which the gateway could not be asked", async () => {
    const fake = new FakeGithub();
    workAndPersonal(fake);
    const gateway = new ScopeGateway();
    let clock = Date.parse(NOW);
    const first = await settle(
      commitsSource(fake, () => clock),
      null,
      gateway,
    );
    const settled = gateway.epoch;
    clock += 60_000;
    // The negotiation answers that hierarchy facts are taken, but not which refresh is required.
    const unanswered = await settle(
      commitsSource(fake, () => clock),
      first.cursor,
      gateway,
      () => ({
        scopeFactsSupported: true,
        scopeHierarchySupported: true,
        scopeRefreshEpochsSupported: true,
      }),
    );
    for (const page of unanswered.pages) expect(page.scopeUpdates).toBeUndefined();
    expect(unanswered.cursor.scopeReposCut).toEqual(first.cursor.scopeReposCut);
    // What such a page does send stays under the refresh last answered, so it is not lost.
    fake.repo(ATLAS).commits.push(commit(9, 9));
    fake.addRepo("northstar-labs/compass", { id: 103, owner: NORTHSTAR, commits: [commit(10)] });
    clock += 60_000;
    const blind = await settle(
      commitsSource(fake, () => clock),
      unanswered.cursor,
      gateway,
      () => ({
        scopeFactsSupported: true,
        scopeHierarchySupported: true,
        scopeRefreshEpochsSupported: true,
      }),
    );
    expect(blind.docs).toHaveLength(2);
    expect(gateway.attribution(commitId(ATLAS, 9))).toEqual([ATLAS, "northstar-labs"]);
    expect(gateway.attribution(commitId("northstar-labs/compass", 10))).toEqual([
      "northstar-labs/compass",
      "northstar-labs",
    ]);
    clock += 60_000;
    const answered = await settle(
      commitsSource(fake, () => clock),
      blind.cursor,
      gateway,
    );
    for (const page of answered.pages) expect(page.scopeUpdates).toBeUndefined();
    expect(gateway.epoch).toBe(settled);
    expect(gateway.attribution(commitId(ATLAS, 1))).toEqual([ATLAS, "northstar-labs"]);
  });

  it("goes on with a scan through a page on which the gateway could not be asked", async () => {
    const fake = new FakeGithub();
    workAndPersonal(fake);
    // Enough history that listing it for a refresh takes several pages.
    for (let seed = 20; seed < 400; seed++) fake.repo(ATLAS).commits.push(commit(seed, 2));
    const gateway = new ScopeGateway();
    let clock = Date.parse(NOW);
    const first = await settle(
      commitsSource(fake, () => clock),
      null,
      gateway,
    );
    gateway.rotate();
    clock += 60_000;
    const source = commitsSource(fake, () => clock);
    let cursor = first.cursor;
    let blind = 0;
    for (let page = 0; page < 400; page++) {
      const scanning =
        cursor.scopeReposCut?.after === "scan" && cursor.scopeReposCut.completed !== true;
      // Once the scan is under way, one page in two cannot learn the refresh.
      const unanswered = scanning && page % 2 === 0;
      if (unanswered) blind++;
      const result = await source.sync(
        cursor,
        unanswered
          ? {
              scopeFactsSupported: true,
              scopeHierarchySupported: true,
              scopeRefreshEpochsSupported: true,
            }
          : gateway.options(),
      );
      cursor = JSON.parse(JSON.stringify(result.cursor)) as GithubCommitsCursor;
      gateway.accept(result);
      if (!result.hasMore) break;
    }
    expect(blind).toBeGreaterThan(0);
    expect(gateway.refreshing).toBe(false);
    for (const seed of [1, 2, 20, 150, 399])
      expect(gateway.attribution(commitId(ATLAS, seed)), `commit ${seed}`).toEqual([
        ATLAS,
        "northstar-labs",
      ]);
    expect(gateway.attribution(commitId(GARDEN, 4))).toEqual([GARDEN, "maya-reeves"]);
  });

  it("opens no second refresh when the gateway named one at first contact and then could not be asked", async () => {
    const fake = new FakeGithub();
    workAndPersonal(fake);
    const gateway = new ScopeGateway();
    gateway.rotate();
    let clock = Date.parse(NOW);
    const first = await settle(
      commitsSource(fake, () => clock),
      null,
      gateway,
    );
    const settled = gateway.epoch;
    expect(gateway.attribution(commitId(ATLAS, 1))).toEqual([ATLAS, "northstar-labs"]);
    clock += 60_000;
    const unanswered = await settle(
      commitsSource(fake, () => clock),
      first.cursor,
      gateway,
      () => ({
        scopeFactsSupported: true,
        scopeHierarchySupported: true,
        scopeRefreshEpochsSupported: true,
      }),
    );
    for (const page of unanswered.pages) expect(page.scopeUpdates?.refreshes).toBeUndefined();
    expect(gateway.epoch).toBe(settled);
    expect(gateway.attribution(commitId(ATLAS, 1))).toEqual([ATLAS, "northstar-labs"]);
  });

  it("starts over when another device takes the source, so a scan is never shared between two", async () => {
    const fake = new FakeGithub();
    workAndPersonal(fake);
    const gateway = new ScopeGateway();
    let clock = Date.parse(NOW);
    const first = await settle(
      commitsSource(fake, () => clock),
      null,
      gateway,
    );
    const settled = gateway.epoch;
    clock += 60_000;
    await settle(
      commitsSource(fake, () => clock),
      first.cursor,
      gateway,
      () => gateway.options({ scopeRefreshActorId: "device-two" }),
    );
    expect(gateway.epoch).not.toBe(settled);
    expect(gateway.ready).toBe(true);
    expect(gateway.attribution(commitId(BEACON, 3))).toEqual([BEACON, "northstar-labs"]);
  });

  it("keeps a filter on a renamed repository and a renamed organization, by their ids", async () => {
    const fake = new FakeGithub();
    workAndPersonal(fake);
    const gateway = new ScopeGateway();
    let clock = Date.parse(NOW);
    const first = await settle(
      commitsSource(fake, () => clock),
      null,
      gateway,
    );

    const atlas = fake.repo(ATLAS);
    fake.repos.delete(ATLAS);
    fake.addRepo("northstar-labs/atlas-core", atlas);
    const renamedOrg = { id: NORTHSTAR.id, login: "northstar-systems" };
    fake.repo(BEACON).owner = renamedOrg;
    fake.repo("northstar-labs/atlas-core").owner = renamedOrg;
    clock += 60_000;
    const second = await settle(
      commitsSource(fake, () => clock),
      first.cursor,
      gateway,
    );

    expect(gateway.nodes.get("repo:101")).toEqual({
      label: "northstar-labs/atlas-core",
      parentIds: ["owner:9001"],
      complete: true,
    });
    expect(gateway.nodes.get("owner:9001")?.label).toBe("northstar-systems");
    // The commits listed under the new name land under the same repository id.
    expect(second.docs.map((doc) => doc.metadata.scopeHierarchy?.[0]?.parentIds)).toEqual([
      ["repo:101"],
      ["repo:101"],
    ]);
    // The documents stored under the old name stay attributed to it until the source sweeps them.
    expect(gateway.attribution(commitId(ATLAS, 1))).toEqual([
      "northstar-labs/atlas-core",
      "northstar-systems",
    ]);
  });

  it("moves a transferred repository under its new owner at once, for every document it holds", async () => {
    const fake = new FakeGithub();
    workAndPersonal(fake);
    const gateway = new ScopeGateway();
    let clock = Date.parse(NOW);
    const first = await settle(
      commitsSource(fake, () => clock),
      null,
      gateway,
    );

    const garden = fake.repo(GARDEN);
    fake.repos.delete(GARDEN);
    fake.addRepo("northstar-labs/garden-notes", { ...garden, owner: NORTHSTAR });
    clock += 60_000;
    const page = await commitsSource(fake, () => clock).sync(first.cursor, gateway.options());
    gateway.accept(page);
    expect(page.scopeUpdates?.hierarchy?.nodes).toEqual([
      {
        id: "repo:201",
        label: "northstar-labs/garden-notes",
        parentIds: ["owner:9001"],
        complete: true,
      },
      { id: "owner:7001", label: "owner:7001", parentIds: [], complete: false, deleted: true },
    ]);
    // Before any commit is listed again, the stored one already follows the repository.
    expect(gateway.attribution(commitId(GARDEN, 4))).toEqual([
      "northstar-labs/garden-notes",
      "northstar-labs",
    ]);
  });

  it("withdraws a repository taken off the source's list, and the owner with its last repository", async () => {
    const fake = new FakeGithub();
    workAndPersonal(fake);
    const gateway = new ScopeGateway();
    let clock = Date.parse(NOW);
    const first = await settle(
      commitsSource(fake, () => clock),
      null,
      gateway,
    );
    clock += 60_000;
    const second = await settle(
      commitsSource(fake, () => clock, { params: { repos: `${ATLAS}, ${BEACON}` } }),
      first.cursor,
      gateway,
    );
    expect([...gateway.nodes.keys()].sort()).toEqual(["owner:9001", "repo:101", "repo:102"]);
    expect(gateway.attribution(commitId(GARDEN, 4))).toBeNull();
    expect(gateway.attribution(commitId(ATLAS, 1))).toEqual([ATLAS, "northstar-labs"]);

    // Put back on the list, it is published again and its stored commit is attributed again.
    clock += 60_000;
    await settle(
      commitsSource(fake, () => clock),
      second.cursor,
      gateway,
    );
    expect(gateway.attribution(commitId(GARDEN, 4))).toEqual([GARDEN, "maya-reeves"]);
  });

  it("publishes only the repositories the source indexes", async () => {
    const fake = new FakeGithub();
    workAndPersonal(fake);
    const gateway = new ScopeGateway();
    await settle(
      commitsSource(fake, () => Date.parse(NOW), { params: { excludeRepos: GARDEN } }),
      null,
      gateway,
    );
    expect([...gateway.nodes.values()].map((node) => node.label).sort()).toEqual([
      "northstar-labs",
      ATLAS,
      BEACON,
    ]);
  });

  it("leaves a commit of a repository without GitHub ids unattributed", async () => {
    const fake = new FakeGithub();
    account(fake, {
      [ATLAS]: { id: 101, owner: NORTHSTAR, commits: [commit(1)] },
      [GARDEN]: { commits: [commit(4)] },
    });
    const gateway = new ScopeGateway();
    const { docs } = await settle(
      commitsSource(fake, () => Date.parse(NOW)),
      null,
      gateway,
    );
    expect(
      docs.find((doc) => doc.externalId === commitId(GARDEN, 4))?.metadata.scopeHierarchy,
    ).toEqual([{ kind: "folder", parentIds: [], complete: false, refreshEpoch: gateway.epoch }]);
    expect(gateway.attribution(commitId(GARDEN, 4))).toBeNull();
    expect(gateway.attribution(commitId(ATLAS, 1))).toEqual([ATLAS, "northstar-labs"]);
  });

  it("adds a repository that appears later without another refresh", async () => {
    const fake = new FakeGithub();
    account(fake, { [ATLAS]: { id: 101, owner: NORTHSTAR, commits: [commit(1)] } });
    const gateway = new ScopeGateway();
    let clock = Date.parse(NOW);
    const first = await settle(
      commitsSource(fake, () => clock),
      null,
      gateway,
    );
    const settled = gateway.epoch;
    fake.addRepo(GARDEN, { id: 201, owner: MAYA, commits: [commit(4)] });
    clock += 60_000;
    await settle(
      commitsSource(fake, () => clock),
      first.cursor,
      gateway,
    );
    expect(gateway.epoch).toBe(settled);
    expect(gateway.attribution(commitId(GARDEN, 4))).toEqual([GARDEN, "maya-reeves"]);
  });

  it("stamps documents but leaves the tree and the refresh to the device that holds the source", async () => {
    const fake = new FakeGithub();
    workAndPersonal(fake);
    const gateway = new ScopeGateway();
    gateway.rotate();
    const { docs, pages } = await settle(
      commitsSource(fake, () => Date.parse(NOW)),
      null,
      undefined,
      () => gateway.options({ run: { role: "member" } as SyncOptions["run"] }),
    );
    for (const page of pages) expect(page.scopeUpdates).toBeUndefined();
    expect(docs).toHaveLength(4);
    for (const doc of docs)
      expect(doc.metadata.scopeHierarchy?.[0]).toMatchObject({
        complete: true,
        refreshEpoch: "epoch-1",
      });
  });

  it("completes a refresh that could not list one repository, and attributes it when it lists again", async () => {
    const fake = new FakeGithub();
    workAndPersonal(fake);
    let clock = Date.parse(NOW);
    const before = await settle(
      commitsSource(fake, () => clock),
      null,
      undefined,
    );
    const gateway = new ScopeGateway();
    for (const doc of before.docs)
      gateway.accept({ documents: [doc], deletedExternalIds: [], cursor: {}, hasMore: false });

    fake.repo(GARDEN).gone404 = true;
    clock += 60_000;
    const during = await settle(
      commitsSource(fake, () => clock),
      before.cursor,
      gateway,
    );
    expect(gateway.ready).toBe(true);
    expect(during.cursor.scopeReposUnlisted).toEqual([GARDEN]);
    expect(gateway.attribution(commitId(ATLAS, 1))).toEqual([ATLAS, "northstar-labs"]);
    expect(gateway.attribution(commitId(GARDEN, 4))).toBeNull();

    fake.repo(GARDEN).gone404 = false;
    clock += DAY_MS + 60_000;
    const after = await settle(
      commitsSource(fake, () => clock),
      during.cursor,
      gateway,
    );
    expect(after.cursor.scopeReposUnlisted).toBeUndefined();
    expect(gateway.attribution(commitId(GARDEN, 4))).toEqual([GARDEN, "maya-reeves"]);
    // Only the repository that was missed is sent again.
    const resent = after.pages.flatMap((page) => page.scopeUpdates?.hierarchy?.documents ?? []);
    expect(resent.map((patch) => patch.externalId)).toEqual([commitId(GARDEN, 4)]);
  });

  it("publishes a large account's tree over several pages before the cycle starts, and bounds every page", async () => {
    const fake = new FakeGithub();
    for (let index = 0; index < 230; index++)
      fake.addRepo(`northstar-labs/service-${String(index).padStart(3, "0")}`, {
        id: 1000 + index,
        owner: NORTHSTAR,
        commits:
          index < 3 ? Array.from({ length: 120 }, (_, n) => commit(index * 1000 + n + 1)) : [],
      });
    const gateway = new ScopeGateway();
    let clock = Date.parse(NOW);
    const before = await settle(
      commitsSource(fake, () => clock),
      null,
      undefined,
    );
    for (const doc of before.docs)
      gateway.accept({ documents: [doc], deletedExternalIds: [], cursor: {}, hasMore: false });
    clock += 60_000;
    await settle(
      commitsSource(fake, () => clock),
      before.cursor,
      gateway,
    );
    expect(gateway.nodes.size).toBe(231);
    const catalogue = gateway.pages.filter((page) => page.hierarchy?.nodes?.length);
    expect(catalogue.map((page) => page.hierarchy!.nodes!.length)).toEqual([200, 31]);
    expect(catalogue[0]!.hierarchy!.snapshot?.phase).toBe("begin");
    expect(catalogue[0]!.hierarchy!.documents).toBeUndefined();
    expect(before.docs).toHaveLength(360);
    expect(gateway.attribution(commitId("northstar-labs/service-002", 2120))).toEqual([
      "northstar-labs/service-002",
      "northstar-labs",
    ]);
    expect(before.docs.every((doc) => gateway.attribution(doc.externalId) !== null)).toBe(true);
  });

  it("an account with no repositories still completes its refresh", async () => {
    const gateway = new ScopeGateway();
    const { cursor } = await settle(
      commitsSource(new FakeGithub(), () => Date.parse(NOW)),
      null,
      gateway,
    );
    expect(gateway.ready).toBe(true);
    expect(gateway.refreshing).toBe(false);
    expect(cursor.scopeReposCut?.completed).toBe(true);
  });

  it("discards scope state it cannot read and rebuilds it, keeping the content cursor", async () => {
    const fake = new FakeGithub();
    workAndPersonal(fake);
    const gateway = new ScopeGateway();
    let clock = Date.parse(NOW);
    const first = await settle(
      commitsSource(fake, () => clock),
      null,
      gateway,
    );
    clock += 60_000;
    const second = await settle(
      commitsSource(fake, () => clock),
      { ...first.cursor, scopeReposNodes: { "repo:101": 4 } } as unknown as GithubCommitsCursor,
      gateway,
    );
    expect(second.docs).toEqual([]);
    expect(second.cursor.repos).toEqual(first.cursor.repos);
    expect(gateway.ready).toBe(true);
    expect(gateway.attribution(commitId(ATLAS, 1))).toEqual([ATLAS, "northstar-labs"]);
  });
});
