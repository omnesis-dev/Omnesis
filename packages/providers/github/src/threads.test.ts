// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { ProviderId, SourceId, SyncError } from "@omnesis/types";
import { GithubClient } from "./client.js";
import { FakeGithub } from "./fake-github.js";
import { GithubThreadsSource, SNAPSHOT_INTERVAL_MS } from "./threads.js";
import type { DocumentInput } from "@omnesis/types";
import type { EdgeDeclaration } from "@omnesis/core";
import type { FakeThread } from "./fake-github.js";
import type { SnapshotClaim } from "@omnesis/source-sdk";
import type { GithubThreadsCursor } from "./types.js";

const REPO = "acme/widgets";
const maya = { login: "maya-reeves", name: "Maya Reeves" };
const jamie = { login: "jlopez-dev", name: "Jamie Lopez" };

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
  return new GithubThreadsSource({
    client,
    providerId: ProviderId("github:tester"),
    sourceId: SourceId("github:tester"),
    commitsSourceId: SourceId("github-commits:tester"),
    accountId: "tester",
    now: () => new Date(nowIso).getTime(),
    ...extra,
  });
}

/** `base` + `offsetSec` seconds, in the second-granular format fixtures use. */
function tick(base: string, offsetSec: number): string {
  return new Date(new Date(base).getTime() + offsetSec * 1000).toISOString().replace(".000Z", "Z");
}

function issueAt(number: number, createdAt: string, updatedAt = createdAt): FakeThread {
  return {
    number,
    kind: "issue",
    title: `Issue ${number}`,
    body: `Body of issue ${number}.`,
    createdAt,
    updatedAt,
    author: maya,
  };
}

async function runToCompletion(source: GithubThreadsSource, cursor: GithubThreadsCursor | null) {
  const docs: DocumentInput[] = [];
  const edges: EdgeDeclaration[] = [];
  let presentExternalIds: string[] | undefined;
  let presentClaims: SnapshotClaim[] | undefined;
  let current = cursor;
  for (let i = 0; i < 300; i++) {
    const result = await source.sync(current);
    docs.push(...result.documents);
    edges.push(...(result.edges ?? []));
    if (result.presentExternalIds) presentExternalIds = result.presentExternalIds;
    if (result.presentClaims) presentClaims = result.presentClaims;
    current = result.cursor;
    if (!result.hasMore) return { docs, edges, presentExternalIds, presentClaims, cursor: current };
  }
  throw new Error("sync did not converge in 300 iterations");
}

function seed(fake: FakeGithub) {
  fake.addRepo(REPO, {
    threads: [
      {
        number: 1,
        kind: "issue",
        title: "Watermark bug",
        body: "It drops.",
        createdAt: "2026-04-01T10:00:00Z",
        updatedAt: "2026-04-02T10:00:00Z",
        author: maya,
        comments: [{ author: jamie, body: "Repro'd.", createdAt: "2026-04-02T10:00:00Z" }],
      },
      {
        number: 2,
        kind: "pull",
        title: "Fix watermark",
        body: "Closes #1",
        createdAt: "2026-04-03T10:00:00Z",
        updatedAt: "2026-04-03T12:00:00Z",
        author: maya,
        merged: true,
        closingIssues: [1],
        mergeCommitSha: "c".repeat(40),
      },
    ],
    discussions: [
      {
        number: 3,
        title: "Roadmap",
        body: "Where next?",
        createdAt: "2026-04-04T10:00:00Z",
        updatedAt: "2026-04-04T10:00:00Z",
        author: jamie,
      },
    ],
  });
}

function seedSix(fake: FakeGithub) {
  fake.addRepo(REPO, {
    threads: [1, 2, 3, 4, 5, 6].map((n) => issueAt(n, tick("2026-04-01T10:00:00Z", n * 3600))),
  });
}

describe("GithubThreadsSource bootstrap", () => {
  it("materializes every thread and emits a snapshot", async () => {
    const fake = new FakeGithub();
    seed(fake);
    const source = build(fake);
    const { docs, edges, presentExternalIds, cursor } = await runToCompletion(source, null);

    expect(docs.map((d) => d.externalId).sort()).toEqual([
      "acme/widgets/discussions/3",
      "acme/widgets/issues/1",
      "acme/widgets/pull/2",
    ]);
    expect(presentExternalIds?.sort()).toEqual([
      "acme/widgets/discussions/3",
      "acme/widgets/issues/1",
      "acme/widgets/pull/2",
    ]);
    // The PR carries its closes-reference in metadata (extractLinks
    // convention) and one declared accompanies edge to its merge commit.
    const prDoc = docs.find((d) => d.externalId === "acme/widgets/pull/2");
    expect(prDoc?.metadata.extra?.links).toEqual(["acme/widgets/issues/1"]);
    expect(edges).toHaveLength(1);
    expect(edges[0].type).toBe("accompanies");
    expect(edges[0].to).toEqual({
      kind: "external",
      sourceId: "github-commits:tester",
      sourceDocumentId: `acme/widgets/commit/${"c".repeat(40)}`,
    });
    expect(cursor?.lastSnapshotAt).toBeDefined();
    expect(cursor?.pending).toBeUndefined();
  });
});

describe("GithubThreadsSource incremental", () => {
  async function bootstrap() {
    const fake = new FakeGithub();
    seed(fake);
    const source = build(fake);
    const { cursor } = await runToCompletion(source, null);
    return { fake, cursor };
  }

  it("a second cycle with nothing changed emits nothing", async () => {
    const { fake, cursor } = await bootstrap();
    const later = build(fake, "2026-05-01T01:00:00Z"); // < 24h: incremental
    const second = await runToCompletion(later, cursor);
    expect(second.docs).toHaveLength(0);
    expect(second.presentExternalIds).toBeUndefined();
  });

  it("a new comment re-materializes only its thread", async () => {
    const { fake, cursor } = await bootstrap();
    const thread = fake.repo(REPO).threads.find((t) => t.number === 1)!;
    thread.comments!.push({
      author: maya,
      body: "Fixed by #2.",
      createdAt: "2026-05-01T02:00:00Z",
    });
    thread.updatedAt = "2026-05-01T02:00:00Z";

    const later = build(fake, "2026-05-01T03:00:00Z");
    const second = await runToCompletion(later, cursor);
    expect(second.docs.map((d) => d.externalId)).toEqual(["acme/widgets/issues/1"]);
    expect(second.docs[0].content).toContain("Fixed by #2.");
  });

  it("a comment edit that does not bump the parent still re-materializes it", async () => {
    const { fake, cursor } = await bootstrap();
    const thread = fake.repo(REPO).threads.find((t) => t.number === 1)!;
    // Edit the comment body + its own updated_at; parent updatedAt unchanged.
    thread.comments![0].body = "Repro'd — and the cause is the abort signal.";
    thread.comments![0].updatedAt = "2026-05-01T02:00:00Z";

    const later = build(fake, "2026-05-01T03:00:00Z");
    const second = await runToCompletion(later, cursor);
    expect(second.docs.map((d) => d.externalId)).toEqual(["acme/widgets/issues/1"]);
    expect(second.docs[0].content).toContain("the cause is the abort signal");
  });

  it("a discussion update is discovered via the GraphQL lane", async () => {
    const { fake, cursor } = await bootstrap();
    const discussion = fake.repo(REPO).discussions[0];
    discussion.comments = [
      { author: maya, body: "Ship the GitHub source.", createdAt: "2026-05-01T02:00:00Z" },
    ];
    discussion.updatedAt = "2026-05-01T02:00:00Z";

    const later = build(fake, "2026-05-01T03:00:00Z");
    const second = await runToCompletion(later, cursor);
    expect(second.docs.map((d) => d.externalId)).toEqual(["acme/widgets/discussions/3"]);
  });
});

describe("GithubThreadsSource snapshot", () => {
  it("a deleted thread disappears from presentExternalIds on the next snapshot", async () => {
    const fake = new FakeGithub();
    seed(fake);
    const { cursor } = await runToCompletion(build(fake), null);

    fake.repo(REPO).threads = fake.repo(REPO).threads.filter((t) => t.number !== 1);
    const afterADay = new Date(
      new Date("2026-05-01T00:00:00Z").getTime() + SNAPSHOT_INTERVAL_MS + 1000,
    ).toISOString();
    const later = build(fake, afterADay);
    const second = await runToCompletion(later, cursor);
    expect(second.presentExternalIds?.sort()).toEqual([
      "acme/widgets/discussions/3",
      "acme/widgets/pull/2",
    ]);
    // A snapshot enumerates for presence — it must not re-emit unchanged threads.
    expect(second.docs).toHaveLength(0);
  });

  it("a repo answering 404 is skipped: siblings still sync and are still claimed", async () => {
    const fake = new FakeGithub();
    seed(fake);
    fake.addRepo("acme/docs", { threads: [issueAt(9, "2026-04-05T10:00:00Z")] });
    const first = await runToCompletion(build(fake), null);
    expect(first.docs.map((d) => d.externalId)).toContain("acme/docs/issues/9");

    // The repo vanishes (deletion or grant revocation racing the cycle's
    // repo listing): still listed, every per-repo endpoint 404s.
    fake.repo("acme/docs").gone404 = true;
    const thread = fake.repo(REPO).threads.find((t) => t.number === 1)!;
    thread.updatedAt = "2026-05-02T01:00:00Z";
    const afterADay = new Date(
      new Date("2026-05-01T00:00:00Z").getTime() + SNAPSHOT_INTERVAL_MS + 1000,
    ).toISOString();
    const second = await runToCompletion(build(fake, afterADay), first.cursor);
    // The sibling repo's update still materializes …
    expect(second.docs.map((d) => d.externalId)).toEqual(["acme/widgets/issues/1"]);
    // … the gone repo's documents are not swept on an ambiguous error …
    expect(second.presentExternalIds).toBeUndefined();
    // … and the sibling is still vouched for by name, so a deletion inside it
    // is found this cycle instead of waiting on a repair that may never come.
    expect(second.presentClaims?.map((c) => c.partition)).toEqual([REPO]);
    expect(second.presentClaims?.[0]?.ids).toContain("acme/widgets/issues/1");
    // Every document says which repository it is in, or the claim above would
    // name a partition holding nothing.
    expect(new Set(first.docs.map((d) => d.partitionKey))).toEqual(new Set([REPO, "acme/docs"]));
  });

  it("a failed lane is recorded as that repository's gap, with the lane that failed", async () => {
    // An uncovered repository withholds the same way, so forgetting to record
    // the failure changes no outcome — only what an operator can find out
    // about it. The lane name is the part no other record carries. Read off the
    // cursor mid-cycle, because the ledger is cleared when the cycle closes.
    const fake = new FakeGithub();
    seed(fake);
    fake.addRepo("acme/docs", { threads: [issueAt(9, "2026-04-05T10:00:00Z")], gone404: true });

    const source = build(fake);
    let cursor: GithubThreadsCursor | null = null;
    let gaps: Record<string, string> | undefined;
    for (let i = 0; i < 300; i++) {
      const result = await source.sync(cursor);
      cursor = result.cursor;
      if (cursor.snapshot?.gaps) gaps = cursor.snapshot.gaps;
      if (!result.hasMore) break;
    }

    expect(Object.keys(gaps ?? {})).toEqual(["acme/docs"]);
    expect(gaps?.["acme/docs"]).toContain("issues lane failed");
  });

  it("reconciles to zero when a repository is genuinely emptied", async () => {
    const fake = new FakeGithub();
    seed(fake);
    const { cursor } = await runToCompletion(build(fake), null);

    // Every thread and discussion is gone. A magnitude test here would refuse
    // the snapshot forever — and refusing is not a delay, it is an absent
    // signal: the gateway would mark nothing, no deadline would run, and the
    // documents would stay indexed with no way back. Magnitude is the
    // gateway's judgement; this walk's job is to report that it read every
    // repository, which it did.
    fake.repo(REPO).threads = [];
    fake.repo(REPO).discussions = [];
    const afterADay = new Date(
      new Date("2026-05-01T00:00:00Z").getTime() + SNAPSHOT_INTERVAL_MS + 1000,
    ).toISOString();
    const second = await runToCompletion(build(fake, afterADay), cursor);
    expect(second.presentExternalIds).toEqual([]);
  });
});

describe("GithubThreadsSource GraphQL thread discovery", () => {
  it("re-materializes every updated thread from the cursor-paginated walk", async () => {
    const fake = new FakeGithub();
    seedSix(fake);
    const { cursor } = await runToCompletion(build(fake), null);

    const updates: Array<[number, string]> = [
      [2, "2026-05-01T02:00:00Z"],
      [4, "2026-05-01T03:00:00Z"],
      [6, "2026-05-01T04:00:00Z"],
    ];
    for (const [n, ts] of updates) {
      const t = fake.repo(REPO).threads.find((x) => x.number === n)!;
      t.updatedAt = ts;
      t.body = `Body of issue ${n}, revised.`;
    }

    const second = await runToCompletion(build(fake, "2026-05-01T05:00:00Z"), cursor);
    expect(second.docs.map((d) => d.externalId).sort()).toEqual([
      "acme/widgets/issues/2",
      "acme/widgets/issues/4",
      "acme/widgets/issues/6",
    ]);
    for (const doc of second.docs) expect(doc.content).toContain("revised");
  });

  it("discovers every thread without touching the REST issues listing", async () => {
    // The fake throws if the REST issues listing is touched — the guarantee
    // under test is that discovery reads the GraphQL connection, which sees
    // issues that listing persistently omits.
    const fake = new FakeGithub();
    seedSix(fake);
    const { docs, presentExternalIds } = await runToCompletion(build(fake), null);
    expect(docs.filter((d) => d.externalId.includes("/issues/"))).toHaveLength(6);
    expect(presentExternalIds).toHaveLength(6);
  });
});

describe("GithubThreadsSource multi-page incremental", () => {
  it("a 150-thread update wave (two listing pages) fully re-materializes", async () => {
    const fake = new FakeGithub();
    fake.addRepo(REPO, {
      threads: Array.from({ length: 150 }, (_, i) =>
        issueAt(i + 1, tick("2026-03-01T00:00:00Z", i)),
      ),
    });
    const first = await runToCompletion(build(fake), null);
    expect(first.docs).toHaveLength(150);

    for (const t of fake.repo(REPO).threads) {
      t.updatedAt = tick("2026-05-01T02:00:00Z", t.number);
      t.body = `Body of issue ${t.number}, revised.`;
    }
    const second = await runToCompletion(build(fake, "2026-05-01T05:00:00Z"), first.cursor);
    expect(new Set(second.docs.map((d) => d.externalId)).size).toBe(150);
  });
});

describe("GithubThreadsSource overflow pagination", () => {
  it("a 45-comment issue and a 35-comment discussion land every comment", async () => {
    const fake = new FakeGithub();
    fake.addRepo(REPO, {
      threads: [
        {
          number: 1,
          kind: "issue",
          title: "Long thread",
          body: "Start.",
          createdAt: "2026-04-01T10:00:00Z",
          updatedAt: "2026-04-02T10:00:00Z",
          author: maya,
          comments: Array.from({ length: 45 }, (_, i) => ({
            author: jamie,
            body: `Follow-up number ${i + 1}.`,
            createdAt: tick("2026-04-01T11:00:00Z", i * 60),
          })),
        },
      ],
      discussions: [
        {
          number: 2,
          title: "Long discussion",
          body: "Kickoff.",
          createdAt: "2026-04-01T10:00:00Z",
          updatedAt: "2026-04-02T10:00:00Z",
          author: jamie,
          comments: Array.from({ length: 35 }, (_, i) => ({
            author: maya,
            body: `Reply number ${i + 1}.`,
            createdAt: tick("2026-04-01T12:00:00Z", i * 60),
          })),
        },
      ],
    });
    const { docs } = await runToCompletion(build(fake), null);

    const issue = docs.find((d) => d.externalId === "acme/widgets/issues/1")!;
    // The batch query carries the first 40 — 41+ arrive via the overflow page.
    expect(issue.content).toContain("Follow-up number 41.");
    expect(issue.content).toContain("Follow-up number 45.");
    const discussion = docs.find((d) => d.externalId === "acme/widgets/discussions/2")!;
    expect(discussion.content).toContain("Reply number 31.");
    expect(discussion.content).toContain("Reply number 35.");
  });
});

describe("GithubThreadsSource with Discussions disabled", () => {
  it("repeated unknown discussion failures never corroborate absence", async () => {
    const fake = new FakeGithub();
    seed(fake);
    const fetchImpl: typeof fetch = async (input, init) => {
      const body = String(init?.body ?? "");
      if (body.includes("discussions(")) {
        return new Response(
          JSON.stringify({ errors: [{ type: "INTERNAL", message: "Temporary upstream failure" }] }),
          { status: 200 },
        );
      }
      return fake.fetchImpl(input, init);
    };
    const client = new GithubClient("github_pat_test", { fetchImpl, sleep: async () => {} });
    const source = new GithubThreadsSource({
      client,
      providerId: ProviderId("github:tester"),
      sourceId: SourceId("github:tester"),
      commitsSourceId: SourceId("github-commits:tester"),
      accountId: "tester",
      now: () => new Date("2026-05-01T00:00:00Z").getTime(),
    });
    let cursor: GithubThreadsCursor | null = null;
    for (let cycle = 0; cycle < 3; cycle++) {
      const result = await runToCompletion(source, cursor);
      expect(result.presentExternalIds).toBeUndefined();
      expect(result.presentClaims).toBeUndefined();
      cursor = { ...result.cursor, lastSnapshotAt: undefined, snapshotMode: undefined };
    }
  });
  it("threads still materialize, and the repository they are in is not claimed", async () => {
    const fake = new FakeGithub();
    seed(fake);
    fake.repo(REPO).discussions = [];
    fake.repo(REPO).discussionsDisabled = true;
    const { docs, presentExternalIds, presentClaims } = await runToCompletion(build(fake), null);
    expect(docs.map((d) => d.externalId).sort()).toEqual([
      "acme/widgets/issues/1",
      "acme/widgets/pull/2",
    ]);
    // The FORBIDDEN discussions lane leaves this repository unenumerated, so
    // it is not claimed and the account-wide form is withheld. With one
    // repository in the account there is nothing left to claim, and the cycle
    // asserts nothing at all rather than claiming an empty set.
    expect(presentExternalIds).toBeUndefined();
    expect(presentClaims).toBeUndefined();
  });

  it("a repository whose discussions come back is not swept for having failed before", async () => {
    // The flag exists to say "this is the steady state, stop withholding".
    // Left uncleared, a failure last winter and another this summer read as
    // that steady state, and the second one lets the sweep take discussions
    // that are still there. A repeat failure has to mean two in a row.
    const fake = new FakeGithub();
    seed(fake);

    // Each cycle must be a snapshot cycle, or the flag is never consulted and
    // this test passes for a reason that has nothing to do with it.
    const asSnapshotCycle = (c: GithubThreadsCursor | null) =>
      c ? ({ ...c, lastSnapshotAt: undefined, snapshotMode: undefined } as GithubThreadsCursor) : c;

    // Cycle one: discussions unavailable. A first failure withholds.
    fake.repo(REPO).discussions = [];
    fake.repo(REPO).discussionsDisabled = true;
    const first = await runToCompletion(build(fake), null);
    expect(first.presentExternalIds).toBeUndefined();

    // Cycle two: the feature is back. Discovery succeeds, the flag clears, and
    // the snapshot is emitted — which is what proves this was a snapshot cycle.
    fake.repo(REPO).discussionsDisabled = false;
    const second = await runToCompletion(build(fake), asSnapshotCycle(first.cursor));
    expect(second.presentExternalIds).toBeDefined();

    // Cycle three: it fails again, months later. Because cycle two cleared the
    // flag this is a first failure once more, so the snapshot is withheld
    // rather than sweeping discussions that are still there.
    fake.repo(REPO).discussionsDisabled = true;
    const third = await runToCompletion(build(fake), asSnapshotCycle(second.cursor));
    expect(third.presentExternalIds).toBeUndefined();
  });
});

describe("GithubThreadsSource dataCutoff", () => {
  it("suppresses threads created before the cutoff", async () => {
    const fake = new FakeGithub();
    fake.addRepo(REPO, {
      threads: [
        issueAt(1, "2026-01-05T10:00:00Z", "2026-01-06T10:00:00Z"),
        issueAt(2, "2026-04-05T10:00:00Z"),
      ],
    });
    const { docs } = await runToCompletion(
      build(fake, "2026-05-01T00:00:00Z", { dataCutoff: "2026-03-01T00:00:00Z" }),
      null,
    );
    expect(docs.map((d) => d.externalId)).toEqual(["acme/widgets/issues/2"]);
  });
});

describe("GithubThreadsSource discussion boundary", () => {
  it("a fresh discussion sharing the watermark second is not lost to an early stop", async () => {
    const fake = new FakeGithub();
    seed(fake);
    const source = build(fake);
    const { cursor } = await runToCompletion(source, null);

    // A new discussion lands at EXACTLY the stored discussions watermark
    // second (2026-04-04T10:00:00Z). The DESC walk returns ties in arbitrary
    // order; the already-seen #3 must not stop the walk before the fresh #9.
    fake.repo(REPO).discussions.push({
      number: 9,
      title: "Same-second sibling",
      body: "Landed in the watermark second.",
      createdAt: "2026-04-04T10:00:00Z",
      updatedAt: "2026-04-04T10:00:00Z",
      author: maya,
    });

    const later = build(fake, "2026-05-01T01:00:00Z");
    const second = await runToCompletion(later, cursor);
    expect(second.docs.map((d) => d.externalId)).toEqual(["acme/widgets/discussions/9"]);
  });
});

describe("GithubThreadsSource shorthand refs", () => {
  it("resolves #N mentions to kind-correct links via the batch RefKinds query", async () => {
    const fake = new FakeGithub();
    seed(fake);
    const thread = fake.repo(REPO).threads.find((t) => t.number === 1)!;
    thread.body = "It drops. Fix incoming in #2; context in #3. Not a ref: #77.";
    const { docs } = await runToCompletion(build(fake), null);
    const issueDoc = docs.find((d) => d.externalId === "acme/widgets/issues/1")!;
    expect(issueDoc.metadata.extra?.links).toEqual([
      "acme/widgets/pull/2",
      "acme/widgets/discussions/3",
    ]);
  });

  it("resolves every ref of a batch that needs more than one RefKinds query", async () => {
    // A tracking issue listing 129 siblings exceeds what one aliased query
    // carries. The refs past the first query's worth must be looked up in a
    // further query, not dropped — a dropped ref is a link the document never
    // grows back, since re-materializing it hits the same boundary.
    const fake = new FakeGithub();
    fake.addRepo(REPO, {
      threads: Array.from({ length: 130 }, (_, i) =>
        issueAt(i + 1, tick("2026-04-01T10:00:00Z", (i + 1) * 60)),
      ),
    });
    const tracking = fake.repo(REPO).threads.find((t) => t.number === 1)!;
    tracking.body = `Tracking: ${Array.from({ length: 129 }, (_, i) => `#${i + 2}`).join(", ")}`;

    const { docs } = await runToCompletion(build(fake, "2026-06-01T00:00:00Z"), null);
    const links = docs.find((d) => d.externalId === "acme/widgets/issues/1")!.metadata.extra
      ?.links as string[];
    expect(links).toHaveLength(129);
    expect(links).toContain("acme/widgets/issues/130");
  });
});

describe("GithubThreadsSource discovery boundaries", () => {
  it("a fresh issue sharing the watermark second is not lost to an early stop", async () => {
    const fake = new FakeGithub();
    seed(fake);
    const { cursor } = await runToCompletion(build(fake), null);
    // Lands at exactly the stored issues watermark second; the DESC walk sees
    // the already-processed sibling first and must not stop on it.
    fake.repo(REPO).threads.push(issueAt(9, "2026-04-02T10:00:00Z"));

    const second = await runToCompletion(build(fake, "2026-05-01T01:00:00Z"), cursor);
    expect(second.docs.map((d) => d.externalId)).toEqual(["acme/widgets/issues/9"]);
  });

  it("the pull-request lane stops at its own watermark", async () => {
    const fake = new FakeGithub();
    seed(fake);
    const { cursor } = await runToCompletion(build(fake), null);
    const pr = fake.repo(REPO).threads.find((t) => t.number === 2)!;
    pr.updatedAt = "2026-05-01T02:00:00Z";
    pr.body = "Closes #1 — revised.";

    const second = await runToCompletion(build(fake, "2026-05-01T03:00:00Z"), cursor);
    expect(second.docs.map((d) => d.externalId)).toEqual(["acme/widgets/pull/2"]);
    expect(second.docs[0].content).toContain("revised");
  });

  it("a snapshot walk pages on creation order, so a concurrent edit cannot drop a thread", async () => {
    // 150 issues → two discovery pages. Between them, a thread from the
    // second page is bumped to the newest update time. Under an
    // update-ordered walk that moves it into the already-served region and it
    // vanishes from the presence set — which the reconcile reads as deleted.
    // Creation order is immutable, so its page position cannot move.
    const fake = new FakeGithub();
    fake.addRepo(REPO, {
      threads: Array.from({ length: 150 }, (_, i) =>
        issueAt(i + 1, tick("2026-04-01T10:00:00Z", (i + 1) * 60)),
      ),
    });
    fake.repo(REPO).onDiscoveryPage = (pages) => {
      if (pages === 1) {
        // #10 sits in the second update-ordered page (it is among the oldest
        // updates). Bumping it to the newest time moves it to the FRONT of an
        // update-ordered walk — into the region page one already served.
        fake.repo(REPO).threads.find((t) => t.number === 10)!.updatedAt = "2026-06-01T00:00:00Z";
      }
    };

    const { presentExternalIds } = await runToCompletion(build(fake), null);
    expect(presentExternalIds).toHaveLength(150);
    expect(presentExternalIds).toContain("acme/widgets/issues/10");
  });
});

describe("GithubThreadsSource discovery scope", () => {
  it("a lane page that reports more with no cursor gaps its repository", async () => {
    // The walk can neither continue nor say it finished. The lane advances so
    // the source does not re-read page one forever, and advancing off the last
    // lane covers the repository — so without the gap, "I am stuck here"
    // becomes "I read everything", and a claim built on that deletes whatever
    // the walk never reached.
    const client = {
      graphql: async () => ({
        repository: { issues: { pageInfo: { hasNextPage: true, endCursor: null }, nodes: [] } },
      }),
    } as unknown as GithubClient;
    const source = new GithubThreadsSource({
      client,
      providerId: ProviderId("github:tester"),
      sourceId: SourceId("github:tester"),
      commitsSourceId: SourceId("github-commits:tester"),
      accountId: "tester",
      now: () => new Date("2026-05-01T00:00:00Z").getTime(),
    }) as unknown as {
      connectionLaneStep: (
        cur: GithubThreadsCursor,
        lane: { repo: string; kind: "issues" },
        pending: unknown[],
        pendingSet: Set<unknown>,
        opts: { connection: "issues"; kind: "issues"; discussion: boolean },
      ) => Promise<void>;
    };

    const cur = {
      snapshotMode: true,
      snapshotRepos: ["acme/widgets"],
      snapshot: {},
      repos: {},
    } as unknown as GithubThreadsCursor;
    await source.connectionLaneStep(cur, { repo: "acme/widgets", kind: "issues" }, [], new Set(), {
      connection: "issues",
      kind: "issues",
      discussion: false,
    });

    expect(cur.snapshot?.gaps?.["acme/widgets"]).toContain("no cursor to continue");
  });

  it("scopes a bare-null repository response as a partition failure, not the whole source", async () => {
    // GitHub can resolve a nullable `repository` field to null with no
    // top-level `errors` entry (distinct from the paired null+NOT_FOUND shape
    // FakeGithub's `gone404` simulates) — the defensive check this exercises.
    const client = { graphql: async () => ({ repository: null }) } as unknown as GithubClient;
    const source = new GithubThreadsSource({
      client,
      providerId: ProviderId("github:tester"),
      sourceId: SourceId("github:tester"),
      commitsSourceId: SourceId("github-commits:tester"),
      accountId: "tester",
      now: () => new Date("2026-05-01T00:00:00Z").getTime(),
    }) as unknown as {
      connectionLaneStep: (
        cur: GithubThreadsCursor,
        lane: { repo: string; kind: "issues" },
        pending: unknown[],
        pendingSet: Set<unknown>,
        opts: { connection: "issues"; kind: "issues"; discussion: boolean },
      ) => Promise<void>;
    };
    try {
      await source.connectionLaneStep(
        {} as GithubThreadsCursor,
        { repo: "ghost/repo", kind: "issues" },
        [],
        new Set(),
        { connection: "issues", kind: "issues", discussion: false },
      );
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(SyncError);
      expect((err as SyncError).kind).toBe("permission");
      expect((err as SyncError).scope).toBe("partition");
    }
  });
});
