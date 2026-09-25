// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Universe fixtures for the synthetic GitHub twin.
 *
 * The fixture files hold GitHub's own payload shapes — GraphQL issue /
 * pull-request / discussion nodes in `github/threads.json`, REST commit
 * details in `github-commits/commits.json` — so the twin can hand them
 * straight to the REAL provider's normalizer. Every rendered body, external
 * id, people mention and `metadata.extra.links` entry therefore comes out of
 * the same code the live source runs; the twin only reads fixtures and pages
 * them.
 *
 * Identities are the universe cast's: each actor's `login` is that person's
 * `extra.githubLogin`, and commit git identities carry their cast email, so
 * the login↔email bridge that merges a GitHub identity with the same person's
 * mail identity is exercised end to end.
 */

import { commitToDocument, discussionToDocument, threadToDocument } from "@omnesis/provider-github";
import { loadActiveUniverse, loadSourceFixtureJson } from "@omnesis/providers-synth-common";
import type { EdgeDeclaration } from "@omnesis/core";
import type { DocumentInput, ProviderId, SourceId } from "@omnesis/types";

// The provider package exports its normalizer but not the GraphQL/REST
// payload interfaces those functions consume. Reading the shapes back off the
// real signatures keeps the fixtures typed against the live contract — a
// field the provider adds or renames reddens this package's build.
type ThreadNode = Parameters<typeof threadToDocument>[0];
type DiscussionNode = Parameters<typeof discussionToDocument>[0];
type CommitDetail = Parameters<typeof commitToDocument>[0];
type RefKinds = NonNullable<Parameters<typeof threadToDocument>[4]>;
type ThreadKind = RefKinds extends ReadonlyMap<number, infer K> ? K : never;

interface ThreadsFixture {
  /** `owner/repo` every thread in the file belongs to. */
  repo: string;
  threads: ThreadNode[];
  discussions: DiscussionNode[];
}

interface CommitsFixture {
  repo: string;
  commits: CommitDetail[];
}

/** One materializable unit of the threads source. */
export type ThreadEntry =
  | { kind: "thread"; repo: string; node: ThreadNode; refKinds?: RefKinds }
  | { kind: "discussion"; repo: string; node: DiscussionNode; refKinds?: RefKinds };

/** One materializable unit of the commits source. */
export interface CommitEntry {
  repo: string;
  detail: CommitDetail;
}

export interface DocContext {
  sourceId: SourceId;
  providerId: ProviderId;
}

// ---------------------------------------------------------------------------
// Shorthand-reference resolution
// ---------------------------------------------------------------------------

/**
 * `#N` autolinks, as the numbers they name. Issues, PRs and discussions share
 * one number sequence, so the number alone does not say which kind it is —
 * `kindIndex` below supplies that, standing in for the live source's
 * existence-checking GraphQL lookup. Code fences and inline code are stripped
 * first: `#fff` in a CSS snippet is a colour, not a reference.
 */
function collectRefs(texts: readonly string[]): number[] {
  const found = new Set<number>();
  for (const text of texts) {
    const stripped = text.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");
    for (const m of stripped.matchAll(/(?:^|[\s([{])#(\d{1,7})(?![\d\w])/g)) {
      found.add(Number(m[1]));
    }
  }
  return [...found].sort((a, b) => a - b);
}

function threadRefTexts(node: ThreadNode): string[] {
  const texts: string[] = [];
  if (node.body) texts.push(node.body);
  for (const c of node.comments?.nodes ?? []) if (c?.body) texts.push(c.body);
  if (node.__typename === "PullRequest") {
    for (const r of node.reviews?.nodes ?? []) {
      if (!r) continue;
      if (r.body) texts.push(r.body);
      for (const c of r.comments?.nodes ?? []) if (c?.body) texts.push(c.body);
    }
  }
  return texts;
}

function discussionRefTexts(node: DiscussionNode): string[] {
  const texts: string[] = [];
  if (node.body) texts.push(node.body);
  for (const c of node.comments?.nodes ?? []) {
    if (!c) continue;
    if (c.body) texts.push(c.body);
    for (const r of c.replies?.nodes ?? []) if (r?.body) texts.push(r.body);
  }
  return texts;
}

/** Every thread number in the fixture, with the kind its document is filed as. */
function buildKindIndex(fixture: ThreadsFixture): Map<number, ThreadKind> {
  const index = new Map<number, ThreadKind>();
  for (const t of fixture.threads) {
    index.set(t.number, (t.__typename === "PullRequest" ? "pull" : "issues") as ThreadKind);
  }
  for (const d of fixture.discussions) index.set(d.number, "discussions" as ThreadKind);
  return index;
}

/**
 * The subset of `kindIndex` this entry actually references. Passing the whole
 * index would link every thread to every other one — `shorthandLinks` emits
 * every entry of the map it is handed.
 */
function refKindsFor(
  texts: readonly string[],
  ownNumber: number,
  kindIndex: ReadonlyMap<number, ThreadKind>,
): RefKinds | undefined {
  const kinds = new Map<number, ThreadKind>();
  for (const n of collectRefs(texts)) {
    if (n === ownNumber) continue;
    const kind = kindIndex.get(n);
    if (kind) kinds.set(n, kind);
  }
  return kinds.size > 0 ? kinds : undefined;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

let threadCache: ThreadEntry[] | null = null;
let commitCache: CommitEntry[] | null = null;

/** Threads then discussions, in fixture order — a stable, deterministic page sequence. */
export function loadThreadEntries(): ThreadEntry[] {
  if (threadCache) return threadCache;
  const fixture = loadSourceFixtureJson<ThreadsFixture>(
    loadActiveUniverse(),
    "github",
    "threads.json",
  );
  const kindIndex = buildKindIndex(fixture);
  const repo = fixture.repo;
  threadCache = [
    ...fixture.threads.map(
      (node): ThreadEntry => ({
        kind: "thread",
        repo,
        node,
        refKinds: refKindsFor(threadRefTexts(node), node.number, kindIndex),
      }),
    ),
    ...fixture.discussions.map(
      (node): ThreadEntry => ({
        kind: "discussion",
        repo,
        node,
        refKinds: refKindsFor(discussionRefTexts(node), node.number, kindIndex),
      }),
    ),
  ];
  return threadCache;
}

export function loadCommitEntries(): CommitEntry[] {
  if (commitCache) return commitCache;
  const fixture = loadSourceFixtureJson<CommitsFixture>(
    loadActiveUniverse(),
    "github-commits",
    "commits.json",
  );
  commitCache = fixture.commits.map((detail) => ({ repo: fixture.repo, detail }));
  return commitCache;
}

/** Drop the parsed fixtures — testing aid for a universe switch. */
export function resetFixtureCache(): void {
  threadCache = null;
  commitCache = null;
}

// ---------------------------------------------------------------------------
// Document + edge mapping
// ---------------------------------------------------------------------------

export function mapThread(entry: ThreadEntry, ctx: DocContext): DocumentInput {
  return entry.kind === "thread"
    ? threadToDocument(entry.node, entry.repo, ctx.providerId, ctx.sourceId, entry.refKinds).doc
    : discussionToDocument(entry.node, entry.repo, ctx.providerId, ctx.sourceId, entry.refKinds);
}

export function mapCommit(entry: CommitEntry, ctx: DocContext): DocumentInput {
  return commitToDocument(entry.detail, entry.repo, ctx.providerId, ctx.sourceId);
}

/**
 * A merged PR and the commit it landed as, declared the way the real threads
 * source declares it: an `accompanies` edge into the sibling commits source,
 * which survives link re-extraction (a `references` edge would be wiped by
 * it, so the "Closes #N" refs ride `metadata.extra.links` instead).
 */
export function mapThreadEdges(
  entry: ThreadEntry,
  ctx: DocContext & { commitsSourceId: string },
): EdgeDeclaration[] {
  if (entry.kind !== "thread") return [];
  const normalized = threadToDocument(
    entry.node,
    entry.repo,
    ctx.providerId,
    ctx.sourceId,
    entry.refKinds,
  );
  if (!normalized.mergeCommitSha) return [];
  return [
    {
      from: { kind: "internal", sourceDocumentId: normalized.doc.externalId },
      to: {
        kind: "external",
        sourceId: ctx.commitsSourceId,
        sourceDocumentId: `${entry.repo}/commit/${normalized.mergeCommitSha}`,
      },
      type: "accompanies",
      metadata: { relation: "merge-commit" },
    },
  ];
}
