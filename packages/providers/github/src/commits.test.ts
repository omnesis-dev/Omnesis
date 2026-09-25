// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { ProviderId, SourceId } from "@omnesis/types";
import { GithubClient } from "./client.js";
import { FakeGithub } from "./fake-github.js";
import { GithubCommitsSource } from "./commits.js";
import { SNAPSHOT_INTERVAL_MS } from "./threads.js";
import type { DocumentInput } from "@omnesis/types";
import type { SnapshotClaim } from "@omnesis/source-sdk";
import type { GithubCommitsCursor } from "./types.js";

const REPO = "acme/widgets";
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_OLD = "d".repeat(40);

function build(
  fake: FakeGithub,
  nowIso = "2026-05-01T00:00:00Z",
  extra: { dataCutoff?: string } = {},
) {
  const client = new GithubClient("github_pat_test", {
    fetchImpl: fake.fetchImpl,
    sleep: async () => {},
    now: () => new Date(nowIso).getTime(),
  });
  return new GithubCommitsSource({
    client,
    providerId: ProviderId("github:tester"),
    sourceId: SourceId("github-commits:tester"),
    now: () => new Date(nowIso).getTime(),
    ...extra,
  });
}

async function runToCompletion(source: GithubCommitsSource, cursor: GithubCommitsCursor | null) {
  const docs: DocumentInput[] = [];
  let presentExternalIds: string[] | undefined;
  let presentClaims: SnapshotClaim[] | undefined;
  let current = cursor;
  for (let i = 0; i < 300; i++) {
    const result = await source.sync(current);
    docs.push(...result.documents);
    if (result.presentExternalIds) presentExternalIds = result.presentExternalIds;
    if (result.presentClaims) presentClaims = result.presentClaims;
    current = result.cursor;
    if (!result.hasMore) return { docs, presentExternalIds, presentClaims, cursor: current };
  }
  throw new Error("sync did not converge in 300 iterations");
}

function seed(fake: FakeGithub) {
  fake.addRepo(REPO, {
    commits: [
      {
        sha: SHA_A,
        message: "feat(sync): add watermark",
        authorName: "Maya Reeves",
        authorEmail: "maya@example.org",
        authorLogin: "maya-reeves",
        date: "2026-04-01T10:00:00Z",
        files: [{ filename: "src/sync.ts", additions: 10, deletions: 2 }],
        additions: 10,
        deletions: 2,
      },
      {
        sha: SHA_B,
        message: "fix(sync): persist before commit",
        authorName: "Jamie Lopez",
        authorEmail: "jamie@example.org",
        authorLogin: "jlopez-dev",
        date: "2026-04-02T10:00:00Z",
      },
    ],
  });
}

describe("GithubCommitsSource", () => {
  it("bootstraps every commit with details and a snapshot", async () => {
    const fake = new FakeGithub();
    seed(fake);
    const { docs, presentExternalIds, cursor } = await runToCompletion(build(fake), null);
    expect(docs.map((d) => d.externalId).sort()).toEqual([
      `acme/widgets/commit/${SHA_A}`,
      `acme/widgets/commit/${SHA_B}`,
    ]);
    expect(presentExternalIds).toHaveLength(2);
    const first = docs.find((d) => d.externalId.endsWith(SHA_A))!;
    expect(first.content).toContain("- src/sync.ts (+10 −2)");
    expect(first.metadata.people?.[0].emails).toEqual(["maya@example.org"]);
    expect(first.metadata.people?.[0].lids).toEqual(["github:maya-reeves"]);
    expect(cursor?.repos?.[REPO]?.wm).toBe("2026-04-02T10:00:00Z");
  });

  it("an unchanged upstream is a no-op", async () => {
    const fake = new FakeGithub();
    seed(fake);
    const { cursor } = await runToCompletion(build(fake), null);
    const second = await runToCompletion(build(fake, "2026-05-01T01:00:00Z"), cursor);
    expect(second.docs).toHaveLength(0);
  });

  it("a new commit arrives incrementally without refetching known ones", async () => {
    const fake = new FakeGithub();
    seed(fake);
    const { cursor } = await runToCompletion(build(fake), null);
    fake.repo(REPO).commits.push({
      sha: "e".repeat(40),
      message: "docs: update readme",
      authorLogin: "maya-reeves",
      authorEmail: "maya@example.org",
      date: "2026-05-01T02:00:00Z",
    });
    fake.requests = [];
    const second = await runToCompletion(build(fake, "2026-05-01T03:00:00Z"), cursor);
    expect(second.docs.map((d) => d.externalId)).toEqual([`acme/widgets/commit/${"e".repeat(40)}`]);
    const detailFetches = fake.requests.filter((r) => /\/commits\/[0-9a-f]+$/.test(r));
    expect(detailFetches).toHaveLength(1);
  });

  it("the snapshot notices a force-pushed commit with an old date and sweeps gone ones", async () => {
    const fake = new FakeGithub();
    seed(fake);
    const { cursor } = await runToCompletion(build(fake), null);

    // A rebase re-parented history: SHA_B disappears, an old-dated commit appears.
    fake.repo(REPO).commits = fake.repo(REPO).commits.filter((c) => c.sha !== SHA_B);
    fake.repo(REPO).commits.push({
      sha: SHA_OLD,
      message: "fix(sync): persist before commit (rebased)",
      authorLogin: "jlopez-dev",
      authorEmail: "jamie@example.org",
      date: "2026-03-30T10:00:00Z", // predates the watermark
    });

    const afterADay = new Date(
      new Date("2026-05-01T00:00:00Z").getTime() + SNAPSHOT_INTERVAL_MS + 1000,
    ).toISOString();
    const second = await runToCompletion(build(fake, afterADay), cursor);
    expect(second.docs.map((d) => d.externalId)).toEqual([`acme/widgets/commit/${SHA_OLD}`]);
    expect(second.presentExternalIds?.sort()).toEqual([
      `acme/widgets/commit/${SHA_A}`,
      `acme/widgets/commit/${SHA_OLD}`,
    ]);
  });

  it("an empty repository answering 409 does not wedge sibling repos", async () => {
    const fake = new FakeGithub();
    seed(fake);
    fake.addRepo("acme/docs", { commitsEmpty409: true });
    const { docs, presentExternalIds } = await runToCompletion(build(fake), null);
    expect(docs.map((d) => d.externalId).sort()).toEqual([
      `acme/widgets/commit/${SHA_A}`,
      `acme/widgets/commit/${SHA_B}`,
    ]);
    // 409 is an empty listing, not an enumeration failure — the snapshot
    // reconcile still runs over the sibling's commits.
    expect(presentExternalIds).toHaveLength(2);
  });

  it("reconciles to zero when a repository's commits are genuinely all gone", async () => {
    const fake = new FakeGithub();
    seed(fake);
    const { presentExternalIds, cursor } = await runToCompletion(build(fake), null);
    expect(presentExternalIds).toHaveLength(2);

    // History rewritten away entirely. A magnitude test would refuse this
    // snapshot forever, and refusing is not a delay: the gateway is told
    // nothing, so it marks nothing and no deadline runs. The walk covered every
    // repository, so it publishes what it found.
    fake.repo(REPO).commits = [];
    const afterADay = new Date(
      new Date("2026-05-01T00:00:00Z").getTime() + SNAPSHOT_INTERVAL_MS + 1000,
    ).toISOString();
    const second = await runToCompletion(build(fake, afterADay), cursor);
    expect(second.presentExternalIds).toEqual([]);
  });

  it("a repository that could not be listed withholds the account snapshot, not its sibling's claim", async () => {
    const fake = new FakeGithub();
    seed(fake);
    fake.addRepo("acme/docs", {
      commits: [
        {
          sha: "c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00",
          message: "docs: initial import",
          authorName: "Maya Reeves",
          authorEmail: "maya@example.org",
          date: "2026-04-03T10:00:00Z",
        },
      ],
    });
    const { docs, presentExternalIds, cursor } = await runToCompletion(build(fake), null);
    expect(presentExternalIds).toHaveLength(3);

    // The second repository's grant is revoked mid-cycle. This walk did not
    // look everywhere, and it knows it — the other half of the contract, and
    // the half that stays.
    fake.repo("acme/docs").gone404 = true;
    const afterADay = new Date(
      new Date("2026-05-01T00:00:00Z").getTime() + SNAPSHOT_INTERVAL_MS + 1000,
    ).toISOString();
    const second = await runToCompletion(build(fake, afterADay), cursor);
    expect(second.presentExternalIds).toBeUndefined();
    // The repository that WAS read is still vouched for by name. Without this
    // the revoked grant would suspend deletion detection for every other
    // repository too, for as long as the grant stays revoked.
    expect(second.presentClaims?.map((c) => c.partition)).toEqual([REPO]);
    expect(second.presentClaims?.[0]?.ids.slice().sort()).toEqual(
      [`${REPO}/commit/${SHA_A}`, `${REPO}/commit/${SHA_B}`].sort(),
    );
    // And every document says which repository it is in, or the claim above
    // would name a partition holding nothing.
    expect(new Set(docs.map((d) => d.partitionKey))).toEqual(new Set([REPO, "acme/docs"]));
  });

  it("a repository missing from the listing is not swept on its first absence, and is on its second", async () => {
    // At the listing level a revoked grant looks exactly like a deleted
    // repository, so the first absence withholds the account-wide form — the
    // repository is missing from the list that says what "everything" is, and
    // no per-repository record can carry that. The sibling that was read is
    // still claimed.
    const fake = new FakeGithub();
    seed(fake);
    fake.addRepo("acme/docs", {
      commits: [
        {
          sha: "c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00",
          message: "docs: initial import",
          authorName: "Jamie Lopez",
          authorEmail: "jamie@example.org",
          date: "2026-04-03T10:00:00Z",
        },
      ],
    });
    const first = await runToCompletion(build(fake), null);
    expect(first.presentExternalIds).toHaveLength(3);

    // Gone from `/user/repos` entirely — the account listing no longer names
    // it, which is where a revoked grant and a deletion look the same.
    fake.repos.delete("acme/docs");
    const day = (n: number) =>
      new Date(
        new Date("2026-05-01T00:00:00Z").getTime() + n * (SNAPSHOT_INTERVAL_MS + 1000),
      ).toISOString();

    const second = await runToCompletion(build(fake, day(1)), first.cursor);
    expect(second.presentExternalIds, "a first absence may not order a deletion").toBeUndefined();
    expect(second.presentClaims?.map((c) => c.partition)).toEqual([REPO]);

    // Still absent. The two-strike rule has decided it is gone, and says so in
    // the form the cycle is using: an empty claim for a repository that now
    // holds nothing. A cycle that only omitted it from a whole-account snapshot
    // would sweep nothing here, because there is no whole-account snapshot.
    const third = await runToCompletion(build(fake, day(2)), second.cursor);
    expect(third.presentExternalIds).toHaveLength(2);
    expect(third.presentExternalIds).not.toContain(
      "acme/docs/commit/c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00",
    );
  });

  it("a failed listing is recorded as that repository's gap, with the reason", async () => {
    // Leaving the repository merely uncovered would withhold the same way — an
    // unaccounted partition is a gap. What the explicit record adds is why,
    // which is the difference between an operator reading "acme/docs was not
    // read this cycle" and reading the 404 that stopped it. Asserted on the
    // cursor mid-cycle, because the ledger is cleared when the cycle closes.
    const fake = new FakeGithub();
    seed(fake);
    fake.addRepo("acme/docs", { gone404: true });

    const source = build(fake);
    let cursor: GithubCommitsCursor | null = null;
    let gaps: Record<string, string> | undefined;
    for (let i = 0; i < 300; i++) {
      const result = await source.sync(cursor);
      cursor = result.cursor;
      if (cursor.snapshot?.gaps) gaps = cursor.snapshot.gaps;
      if (!result.hasMore) break;
    }

    expect(Object.keys(gaps ?? {})).toEqual(["acme/docs"]);
    expect(gaps?.["acme/docs"]).toContain("acme/docs");
  });

  it("dataCutoff bounds the bootstrap listing and suppresses older commits", async () => {
    const fake = new FakeGithub();
    fake.addRepo(REPO, {
      commits: [
        {
          sha: SHA_OLD,
          message: "chore: ancient history",
          authorLogin: "maya-reeves",
          authorEmail: "maya@example.org",
          date: "2026-01-15T10:00:00Z",
        },
        {
          sha: SHA_A,
          message: "feat(sync): add watermark",
          authorLogin: "maya-reeves",
          authorEmail: "maya@example.org",
          date: "2026-04-01T10:00:00Z",
        },
      ],
    });
    const cutoff = "2026-03-01T00:00:00Z";
    const { docs } = await runToCompletion(
      build(fake, "2026-05-01T00:00:00Z", { dataCutoff: cutoff }),
      null,
    );
    expect(docs.map((d) => d.externalId)).toEqual([`acme/widgets/commit/${SHA_A}`]);
    // The bootstrap (snapshot) listing lane passes since=dataCutoff.
    const listings = fake.requests.filter((r) => r.startsWith("GET /repos/acme/widgets/commits?"));
    expect(listings.length).toBeGreaterThan(0);
    for (const r of listings) expect(decodeURIComponent(r)).toContain(`since=${cutoff}`);
  });
});
