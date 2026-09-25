// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * In-memory GitHub API double for tests: serves the REST lanes and the
 * GraphQL batch + overflow-page queries the sources use, from a mutable repo
 * model, through a `fetch`-compatible function. Test-only — not exported
 * from the package.
 *
 * Fidelity notes:
 * - `/issues` validates the query params the sources' correctness depends on
 *   (`state=all`, `direction=asc`, `per_page=100`, a known `sort`) and throws
 *   a plain Error on a violation so a source regression fails loudly.
 * - GraphQL connections honor the query's `first:` argument (parsed from the
 *   query text) and page out via stringified-offset `endCursor`s, so the
 *   sources' overflow pagination runs for real.
 */

import type { GqlActor } from "./types.js";

export interface FakeComment {
  author: FakeUser | null;
  body: string;
  createdAt: string;
  updatedAt?: string;
  isAnswer?: boolean;
  replies?: FakeComment[];
}

export interface FakeUser {
  login: string;
  name?: string;
  bot?: boolean;
}

export interface FakeReview {
  author: FakeUser | null;
  state: string;
  body?: string;
  submittedAt?: string;
  comments?: Array<{
    author: FakeUser | null;
    body: string;
    path?: string;
    createdAt: string;
    updatedAt?: string;
  }>;
}

export interface FakeThread {
  number: number;
  kind: "issue" | "pull";
  title: string;
  body?: string;
  state?: string;
  createdAt: string;
  updatedAt: string;
  author: FakeUser | null;
  labels?: string[];
  assignees?: FakeUser[];
  comments?: FakeComment[];
  // PR-only
  merged?: boolean;
  mergedAt?: string;
  mergedBy?: FakeUser;
  isDraft?: boolean;
  baseRefName?: string;
  headRefName?: string;
  additions?: number;
  deletions?: number;
  files?: Array<{ path: string; additions?: number; deletions?: number }>;
  reviews?: FakeReview[];
  closingIssues?: number[];
  mergeCommitSha?: string;
}

export interface FakeDiscussion {
  number: number;
  title: string;
  body?: string;
  createdAt: string;
  updatedAt: string;
  author: FakeUser | null;
  category?: string;
  answered?: boolean;
  comments?: FakeComment[];
}

export interface FakeCommit {
  sha: string;
  message: string;
  authorName?: string;
  authorEmail?: string;
  authorLogin?: string;
  date: string;
  files?: Array<{ filename: string; additions?: number; deletions?: number }>;
  additions?: number;
  deletions?: number;
}

export interface FakeRepo {
  threads: FakeThread[];
  discussions: FakeDiscussion[];
  commits: FakeCommit[];

  /**
   * Invoked after each discovery page is served, with the number of pages
   * served so far — lets a test mutate the repo mid-walk the way a concurrent
   * upstream edit would.
   */
  onDiscoveryPage?: (pagesServed: number) => void;
  /** DiscussionsDiscovery answers a GraphQL FORBIDDEN errors envelope. */
  discussionsDisabled?: boolean;
  /** `/commits` answers HTTP 409 "Git Repository is empty". */
  commitsEmpty409?: boolean;
  /**
   * The repo still appears in `/user/repos` but every per-repo endpoint
   * answers 404 (GraphQL: `repository: null`) — simulates a deletion or a
   * grant revocation racing the cycle's repo listing.
   */
  gone404?: boolean;
}

const PAGE_SIZE = 100;

function actor(u: FakeUser | null | undefined): GqlActor | null {
  if (!u) return null;
  return { login: u.login, __typename: u.bot ? "Bot" : "User", name: u.name ?? null };
}

/** Parse the `first:` argument of the named connection out of a query string. */
function connFirst(query: string, conn: string, fallback: number): number {
  const m = new RegExp(`${conn}\\(first:\\s*(\\d+)`).exec(query);
  return m ? Number(m[1]) : fallback;
}

/**
 * A connection page over `rows`, sliced `[offset, offset + first)`, with a
 * stringified-offset `endCursor`.
 */
function connectionPage<T, N>(rows: T[], offset: number, first: number, toNode: (row: T) => N) {
  const slice = rows.slice(offset, offset + first);
  return {
    pageInfo: {
      hasNextPage: rows.length > offset + slice.length,
      endCursor: slice.length > 0 ? String(offset + slice.length) : null,
    },
    nodes: slice.map(toNode),
  };
}

function commentNode(c: FakeComment, repliesFirst?: number): Record<string, unknown> {
  return {
    author: actor(c.author),
    body: c.body,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt ?? c.createdAt,
    ...(c.isAnswer !== undefined ? { isAnswer: c.isAnswer } : {}),
    ...(repliesFirst !== undefined
      ? { replies: { nodes: (c.replies ?? []).slice(0, repliesFirst).map((r) => commentNode(r)) } }
      : {}),
  };
}

function reviewNode(r: FakeReview, fallbackSubmittedAt: string, commentsFirst: number) {
  const all = r.comments ?? [];
  return {
    author: actor(r.author),
    state: r.state,
    body: r.body ?? "",
    submittedAt: r.submittedAt ?? fallbackSubmittedAt,
    comments: {
      pageInfo: { hasNextPage: all.length > commentsFirst },
      nodes: all.slice(0, commentsFirst).map((c) => ({
        author: actor(c.author),
        body: c.body,
        path: c.path ?? null,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt ?? c.createdAt,
      })),
    },
  };
}

interface ThreadNodeLimits {
  comments: number;
  reviews: number;
  reviewComments: number;
}

function threadNode(t: FakeThread, repo: string, limits: ThreadNodeLimits) {
  const comments = t.comments ?? [];
  const base = {
    __typename: t.kind === "pull" ? "PullRequest" : "Issue",
    number: t.number,
    title: t.title,
    body: t.body ?? "",
    state: t.state ?? (t.merged ? "MERGED" : "OPEN"),
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    closedAt: null,
    url: `https://github.com/${repo}/${t.kind === "pull" ? "pull" : "issues"}/${t.number}`,
    author: actor(t.author),
    labels: { nodes: (t.labels ?? []).map((name) => ({ name })) },
    assignees: {
      nodes: (t.assignees ?? []).map((a) => ({ login: a.login, name: a.name ?? null })),
    },
    milestone: null,
    comments: {
      totalCount: comments.length,
      ...connectionPage(comments, 0, limits.comments, (c) => commentNode(c)),
    },
  };
  if (t.kind !== "pull") return { ...base, stateReason: null };
  const reviews = t.reviews ?? [];
  return {
    ...base,
    isDraft: t.isDraft ?? false,
    merged: t.merged ?? false,
    mergedAt: t.mergedAt ?? null,
    mergedBy: actor(t.mergedBy ?? null),
    baseRefName: t.baseRefName ?? "main",
    headRefName: t.headRefName ?? "feature",
    additions: t.additions ?? 0,
    deletions: t.deletions ?? 0,
    changedFiles: (t.files ?? []).length,
    files: { pageInfo: { hasNextPage: false }, nodes: t.files ?? [] },
    reviews: connectionPage(reviews, 0, limits.reviews, (r) =>
      reviewNode(r, t.updatedAt, limits.reviewComments),
    ),
    closingIssuesReferences: {
      nodes: (t.closingIssues ?? []).map((number) => ({
        number,
        repository: { nameWithOwner: repo },
      })),
    },
    mergeCommit: t.mergeCommitSha ? { oid: t.mergeCommitSha } : null,
  };
}

function discussionNode(
  d: FakeDiscussion,
  repo: string,
  limits: { comments: number; replies: number },
) {
  const comments = d.comments ?? [];
  return {
    number: d.number,
    title: d.title,
    body: d.body ?? "",
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    url: `https://github.com/${repo}/discussions/${d.number}`,
    author: actor(d.author),
    category: d.category ? { name: d.category } : null,
    answer: d.answered ? { id: "ans" } : null,
    comments: {
      totalCount: comments.length,
      ...connectionPage(comments, 0, limits.comments, (c) => commentNode(c, limits.replies)),
    },
  };
}

export class FakeGithub {
  repos = new Map<string, FakeRepo>();
  /** Every request as `METHOD pathname?search`, in arrival order. */
  requests: string[] = [];
  private discoveryPagesServed = 0;

  addRepo(name: string, repo: Partial<FakeRepo> = {}) {
    this.repos.set(name, { threads: [], discussions: [], commits: [], ...repo });
  }

  repo(name: string): FakeRepo {
    const r = this.repos.get(name);
    if (!r) throw new Error(`no fake repo ${name}`);
    return r;
  }

  readonly fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    this.requests.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
    if (url.pathname === "/graphql") {
      return this.handleGraphql(JSON.parse(String(init?.body ?? "{}")));
    }
    return this.handleRest(url);
  };

  private json(body: unknown, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json", ...headers },
    });
  }

  private page<T>(rows: T[], pageNum: number, base: string): Response {
    const start = (pageNum - 1) * PAGE_SIZE;
    const slice = rows.slice(start, start + PAGE_SIZE);
    const hasNext = rows.length > start + PAGE_SIZE;
    return this.json(slice, hasNext ? { link: `<${base}&page=${pageNum + 1}>; rel="next"` } : {});
  }

  private handleRest(url: URL): Response {
    const path = url.pathname;
    const page = Number(url.searchParams.get("page") ?? "1");
    const since = url.searchParams.get("since") ?? undefined;

    if (path === "/user") return this.json({ login: "tester", name: "Test Er" });
    if (path === "/user/repos") {
      return this.page(
        [...this.repos.keys()].map((full_name) => ({ full_name })),
        page,
        url.toString(),
      );
    }

    const m = /^\/repos\/([^/]+\/[^/]+)(\/.*)?$/.exec(path);
    if (!m) return new Response("not found", { status: 404 });
    const repoName = m[1];
    const rest = m[2] ?? "";
    const repo = this.repos.get(repoName);
    if (!repo || repo.gone404) return new Response("{}", { status: 404 });

    if (rest === "/issues") {
      // Thread enumeration moved to the GraphQL connections: this listing is
      // served from an index that can persistently omit issues which exist.
      // A source that calls it again fails loudly here rather than silently
      // under-enumerating.
      throw new Error("the source must not enumerate issues over the REST listing");
    }

    if (rest === "/issues/comments" || rest === "/pulls/comments") {
      const wantReview = rest === "/pulls/comments";
      const rows: Array<{
        id: number;
        issue_url?: string;
        pull_request_url?: string;
        updated_at: string;
      }> = [];
      // Fake comment ids are position-derived (thread number × offset +
      // index) — NOT stable across comment deletions, unlike real GitHub ids.
      for (const t of repo.threads) {
        if (wantReview) {
          if (t.kind !== "pull") continue;
          (t.reviews ?? []).forEach((r, ri) => {
            (r.comments ?? []).forEach((c, ci) => {
              const updated = c.updatedAt ?? c.createdAt;
              if (!since || updated >= since) {
                rows.push({
                  id: t.number * 100_000 + ri * 1_000 + ci,
                  pull_request_url: `https://api.github.com/repos/${repoName}/pulls/${t.number}`,
                  updated_at: updated,
                });
              }
            });
          });
        } else {
          (t.comments ?? []).forEach((c, ci) => {
            const updated = c.updatedAt ?? c.createdAt;
            if (!since || updated >= since) {
              rows.push({
                id: t.number * 100_000 + ci,
                issue_url: `https://api.github.com/repos/${repoName}/issues/${t.number}`,
                updated_at: updated,
              });
            }
          });
        }
      }
      rows.sort((a, b) => a.updated_at.localeCompare(b.updated_at));
      return this.page(rows, page, url.toString());
    }
    if (rest === "/commits") {
      if (repo.commitsEmpty409) {
        return new Response(JSON.stringify({ message: "Git Repository is empty." }), {
          status: 409,
          headers: { "content-type": "application/json" },
        });
      }
      const rows = repo.commits
        .filter((c) => !since || c.date >= since)
        .sort((a, b) => b.date.localeCompare(a.date))
        .map((c) => ({
          sha: c.sha,
          commit: { committer: { date: c.date }, author: { date: c.date } },
        }));
      return this.page(rows, page, url.toString());
    }
    const cm = /^\/commits\/([0-9a-f]+)$/.exec(rest);
    if (cm) {
      const c = repo.commits.find((x) => x.sha === cm[1]);
      if (!c) return new Response("{}", { status: 404 });
      return this.json({
        sha: c.sha,
        html_url: `https://github.com/${repoName}/commit/${c.sha}`,
        commit: {
          message: c.message,
          author: { name: c.authorName, email: c.authorEmail, date: c.date },
          committer: { name: c.authorName, email: c.authorEmail, date: c.date },
        },
        author: c.authorLogin ? { login: c.authorLogin, type: "User" } : null,
        committer: c.authorLogin ? { login: c.authorLogin, type: "User" } : null,
        stats: { additions: c.additions ?? 0, deletions: c.deletions ?? 0 },
        files: c.files ?? [],
        parents: [{ sha: "0".repeat(40) }],
      });
    }
    return new Response("{}", { status: 404 });
  }

  private handleGraphql(payload: {
    query?: string;
    variables?: Record<string, unknown>;
  }): Response {
    const query = payload.query ?? "";
    const vars = payload.variables ?? {};
    const repoName = `${String(vars.owner)}/${String(vars.name)}`;
    const repo = this.repos.get(repoName);
    if (!repo || repo.gone404) {
      // GitHub pairs a null repository with a NOT_FOUND error; answering a
      // bare null would let a source treat a vanished repo as an empty one.
      return this.json({
        data: { repository: null },
        errors: [{ type: "NOT_FOUND", message: `Could not resolve to a Repository ${repoName}.` }],
      });
    }

    if (query.includes("query Discovery")) {
      // Which connection, and in which order — the source asks for
      // CREATED_AT ASC on snapshot walks (immutable key) and UPDATED_AT DESC
      // on incremental ones, and the fake honors both so a source that picks
      // the wrong order enumerates in the wrong order here too.
      const conn: "issues" | "pullRequests" | "discussions" = query.includes("pullRequests(first:")
        ? "pullRequests"
        : query.includes("discussions(first:")
          ? "discussions"
          : "issues";
      if (conn === "discussions" && repo.discussionsDisabled) {
        return this.json({
          data: { repository: null },
          errors: [{ type: "FORBIDDEN", message: "Discussions are disabled for this repository." }],
        });
      }
      const byCreated = query.includes("field: CREATED_AT");
      const rows: Array<{ number: number; createdAt: string; updatedAt: string }> =
        conn === "discussions"
          ? repo.discussions.map((d) => ({
              number: d.number,
              createdAt: d.createdAt,
              updatedAt: d.updatedAt,
            }))
          : repo.threads
              .filter((t) => (conn === "pullRequests" ? t.kind === "pull" : t.kind === "issue"))
              .map((t) => ({ number: t.number, createdAt: t.createdAt, updatedAt: t.updatedAt }));
      rows.sort((a, b) =>
        byCreated
          ? a.createdAt.localeCompare(b.createdAt) || a.number - b.number
          : b.updatedAt.localeCompare(a.updatedAt) || b.number - a.number,
      );
      const offset = Number(vars.after ?? 0);
      const page = connectionPage(rows, offset, connFirst(query, conn, 100), (r) => ({
        number: r.number,
        updatedAt: r.updatedAt,
      }));
      const response = this.json({ data: { repository: { [conn]: page } } });
      repo.onDiscoveryPage?.(++this.discoveryPagesServed);
      return response;
    }

    if (query.includes("RefKinds")) {
      const repository: Record<string, unknown> = {};
      for (let i = 0; `n${i}` in vars; i++) {
        const n = vars[`n${i}`] as number;
        const t = repo.threads.find((x) => x.number === n);
        const d = repo.discussions.find((x) => x.number === n);
        repository[`t${i}`] = t
          ? { __typename: t.kind === "pull" ? "PullRequest" : "Issue" }
          : null;
        repository[`d${i}`] = d ? { number: d.number } : null;
      }
      return this.json({ data: { repository } });
    }

    if (query.includes("DiscussionsDiscovery")) {
      if (repo.discussionsDisabled) {
        return this.json({
          data: { repository: null },
          errors: [{ type: "FORBIDDEN", message: "Discussions are disabled for this repository." }],
        });
      }
      const nodes = [...repo.discussions]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map((d) => ({ number: d.number, updatedAt: d.updatedAt }));
      return this.json({
        data: {
          repository: {
            discussions: { pageInfo: { hasNextPage: false, endCursor: null }, nodes },
          },
        },
      });
    }

    // Overflow page queries — `after` is a stringified offset from a
    // previous connectionPage.
    if (query.includes("ThreadComments")) {
      const t = repo.threads.find((x) => x.number === Number(vars.number));
      if (!t) return this.json({ data: { repository: { issueOrPullRequest: null } } });
      const comments = connectionPage(
        t.comments ?? [],
        Number(vars.after ?? 0),
        connFirst(query, "comments", 100),
        (c) => commentNode(c),
      );
      return this.json({ data: { repository: { issueOrPullRequest: { comments } } } });
    }
    if (query.includes("PrReviews")) {
      const t = repo.threads.find((x) => x.number === Number(vars.number));
      if (!t) return this.json({ data: { repository: { pullRequest: null } } });
      const reviewCommentsFirst = connFirst(query, "comments", 15);
      const reviews = connectionPage(
        t.reviews ?? [],
        Number(vars.after ?? 0),
        connFirst(query, "reviews", 50),
        (r) => reviewNode(r, t.updatedAt, reviewCommentsFirst),
      );
      return this.json({ data: { repository: { pullRequest: { reviews } } } });
    }
    if (query.includes("DiscussionComments")) {
      const d = repo.discussions.find((x) => x.number === Number(vars.number));
      if (!d) return this.json({ data: { repository: { discussion: null } } });
      const repliesFirst = connFirst(query, "replies", 10);
      const comments = connectionPage(
        d.comments ?? [],
        Number(vars.after ?? 0),
        connFirst(query, "comments", 50),
        (c) => commentNode(c, repliesFirst),
      );
      return this.json({ data: { repository: { discussion: { comments } } } });
    }

    if (query.includes("DiscussionBatch")) {
      const limits = {
        comments: connFirst(query, "comments", 30),
        replies: connFirst(query, "replies", 10),
      };
      const repository: Record<string, unknown> = {};
      for (let i = 0; `n${i}` in vars; i++) {
        const d = repo.discussions.find((x) => x.number === vars[`n${i}`]);
        repository[`d${i}`] = d ? discussionNode(d, repoName, limits) : null;
      }
      return this.json({ data: { repository } });
    }
    if (query.includes("ThreadBatch")) {
      const limits: ThreadNodeLimits = {
        comments: connFirst(query, "comments", 40),
        reviews: connFirst(query, "reviews", 25),
        // The inline review-comment first sits inside the reviews selection.
        reviewComments: connFirst(
          query.slice(Math.max(0, query.indexOf("reviews("))),
          "comments",
          15,
        ),
      };
      const repository: Record<string, unknown> = {};
      for (let i = 0; `n${i}` in vars; i++) {
        const t = repo.threads.find((x) => x.number === vars[`n${i}`]);
        repository[`t${i}`] = t ? threadNode(t, repoName, limits) : null;
      }
      return this.json({ data: { repository } });
    }
    return this.json({ data: { repository: null } });
  }
}
