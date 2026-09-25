// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { validateDocumentEventProfile } from "@omnesis/source-sdk";
import { ProviderId, SourceId, type DocumentInput } from "@omnesis/types";
import { githubCommitsDocumentProfile, githubThreadsDocumentProfile } from "./document-profiles.js";
import {
  collectIssueRefs,
  commitToDocument,
  discussionToDocument,
  extractMentions,
  isBot,
  parseNoreplyEmail,
  threadToDocument,
} from "./normalizer.js";
import type { DocumentEventProfile, DocumentMetadataFieldSpec } from "@omnesis/source-sdk";
import type { GqlDiscussion, GqlIssue, GqlPullRequest, RestCommitDetail } from "./types.js";

const providerId = ProviderId("github:tester");
const sourceId = SourceId("github:tester");
const commitsSourceId = SourceId("github-commits:tester");
const REPO = "acme/widgets";

function issue(overrides: Partial<GqlIssue> = {}): GqlIssue {
  return {
    __typename: "Issue",
    number: 12,
    title: "Sync cursor drops watermark on retry",
    body: "After a 502 mid-page the next run restarts. cc @jlopez-dev",
    state: "OPEN",
    createdAt: "2026-03-12T18:40:00Z",
    updatedAt: "2026-03-13T08:15:00Z",
    url: `https://github.com/${REPO}/issues/12`,
    author: { login: "maya-reeves", __typename: "User", name: "Maya Reeves" },
    labels: { nodes: [{ name: "bug" }, { name: "sync" }] },
    assignees: { nodes: [{ login: "jlopez-dev", name: "Jamie Lopez" }] },
    comments: {
      totalCount: 2,
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          author: { login: "jlopez-dev", __typename: "User", name: "Jamie Lopez" },
          body: "Repro'd. The cursor write races the page commit.",
          createdAt: "2026-03-13T08:15:00Z",
        },
        {
          author: { login: "deploy-bot[bot]", __typename: "Bot" },
          body: "Deployed to staging.",
          createdAt: "2026-03-13T08:20:00Z",
        },
      ],
    },
    ...overrides,
  };
}

function pull(overrides: Partial<GqlPullRequest> = {}): GqlPullRequest {
  return {
    __typename: "PullRequest",
    number: 34,
    title: "Fix watermark persistence",
    body: "Closes #12",
    state: "MERGED",
    createdAt: "2026-03-14T09:00:00Z",
    updatedAt: "2026-03-14T12:00:00Z",
    url: `https://github.com/${REPO}/pull/34`,
    author: { login: "maya-reeves", __typename: "User", name: "Maya Reeves" },
    merged: true,
    mergedAt: "2026-03-14T12:00:00Z",
    mergedBy: { login: "dlin-eng", __typename: "User", name: "David Lin" },
    baseRefName: "main",
    headRefName: "fix-watermark",
    additions: 42,
    deletions: 7,
    changedFiles: 2,
    files: {
      nodes: [
        { path: "src/sync.ts", additions: 40, deletions: 5 },
        { path: "src/sync.test.ts", additions: 2, deletions: 2 },
      ],
    },
    reviews: {
      nodes: [
        {
          author: { login: "dlin-eng", __typename: "User", name: "David Lin" },
          state: "CHANGES_REQUESTED",
          body: "The retry needs to re-read the stored watermark.",
          submittedAt: "2026-03-14T10:00:00Z",
          comments: {
            nodes: [
              {
                author: { login: "dlin-eng", __typename: "User" },
                body: "This races the abort signal.",
                path: "src/sync.ts",
                createdAt: "2026-03-14T10:01:00Z",
              },
            ],
          },
        },
      ],
    },
    closingIssuesReferences: { nodes: [{ number: 12, repository: { nameWithOwner: REPO } }] },
    mergeCommit: { oid: "a".repeat(40) },
    ...overrides,
  };
}

function detail(overrides: Partial<RestCommitDetail> = {}): RestCommitDetail {
  return {
    sha: "b".repeat(40),
    html_url: `https://github.com/${REPO}/commit/${"b".repeat(40)}`,
    commit: {
      message: "fix(sync): persist watermark before commit\n\nRe-reads the stored value.",
      author: { name: "Maya Reeves", email: "maya@example.org", date: "2026-03-14T11:59:00Z" },
      committer: { name: "Maya Reeves", email: "maya@example.org", date: "2026-03-14T11:59:00Z" },
    },
    author: { login: "maya-reeves", type: "User" },
    committer: { login: "maya-reeves", type: "User" },
    stats: { additions: 40, deletions: 5 },
    files: [{ filename: "src/sync.ts", additions: 40, deletions: 5 }],
    parents: [{ sha: "0".repeat(40) }],
    ...overrides,
  };
}

describe("threadToDocument", () => {
  it("renders an issue thread as one conversation document", () => {
    const { doc } = threadToDocument(issue(), REPO, providerId, sourceId);
    expect(doc.externalId).toBe("acme/widgets/issues/12");
    expect(doc.metadata.sourceUrl).toBe("https://github.com/acme/widgets/issues/12");
    expect(doc.metadata.documentType).toBe("conversation");
    expect(doc.metadata.status).toBe("open");
    expect(doc.metadata.rollingAggregate).toBe(true);
    expect(doc.metadata.tags).toEqual(["bug", "sync"]);
    expect(doc.title).toBe("Sync cursor drops watermark on retry · acme/widgets#12");
    expect(doc.content).toContain("**@maya-reeves** (2026-03-12 18:40)");
    expect(doc.content).toContain("**@jlopez-dev** (2026-03-13 08:15)");
    expect(doc.sourceCreatedAt).toBe("2026-03-12T18:40:00Z");
    expect(doc.sourceUpdatedAt).toBe("2026-03-13T08:15:00Z");
  });

  it("excludes bot comments from the body and bots from people", () => {
    const { doc } = threadToDocument(issue(), REPO, providerId, sourceId);
    expect(doc.content).not.toContain("Deployed to staging");
    expect(doc.content).not.toContain("deploy-bot");
    const lids = doc.metadata.people?.flatMap((p) => p.lids ?? []);
    expect(lids).not.toContain("github:deploy-bot[bot]");
  });

  it("extracts author, participants, and mentions with roles", () => {
    const { doc } = threadToDocument(issue(), REPO, providerId, sourceId);
    const people = doc.metadata.people ?? [];
    const author = people.find((p) => p.role === "author");
    expect(author?.lids).toEqual(["github:maya-reeves"]);
    expect(author?.name).toBe("Maya Reeves");
    // jlopez-dev is assignee + commenter + @mentioned — one participant entry.
    const jamie = people.filter((p) => p.lids?.includes("github:jlopez-dev"));
    expect(jamie).toHaveLength(1);
    expect(jamie[0].role).toBe("participant");
  });

  it("renders a PR with reviews, files, and edges but no diff hunks", () => {
    const { doc, mergeCommitSha } = threadToDocument(pull(), REPO, providerId, sourceId);
    expect(doc.externalId).toBe("acme/widgets/pull/34");
    expect(doc.metadata.status).toBe("merged");
    expect(doc.content).toContain("Branch: fix-watermark → main");
    expect(doc.content).toContain("+42 −7 in 2 files");
    expect(doc.content).toContain("Files: src/sync.ts, src/sync.test.ts");
    expect(doc.content).toContain("**Review · @dlin-eng · CHANGES_REQUESTED**");
    expect(doc.content).toContain("review comment on src/sync.ts");
    expect(doc.content).toContain("Closes: #12");
    expect(doc.metadata.extra?.links).toEqual(["acme/widgets/issues/12"]);
    expect(mergeCommitSha).toBe("a".repeat(40));
  });

  it("is deterministic — identical input produces an identical hash", () => {
    const a = threadToDocument(issue(), REPO, providerId, sourceId);
    const b = threadToDocument(issue(), REPO, providerId, sourceId);
    expect(a.doc.contentHash).toBe(b.doc.contentHash);
  });

  it("renders a verdict review with an empty body — the verdict is the content", () => {
    const { doc } = threadToDocument(
      pull({
        reviews: {
          nodes: [
            {
              author: { login: "dlin-eng", __typename: "User", name: "David Lin" },
              state: "APPROVED",
              body: "",
              submittedAt: "2026-03-14T10:00:00Z",
              comments: {
                nodes: [
                  {
                    author: { login: "dlin-eng", __typename: "User" },
                    body: "Nit: rename this.",
                    path: "src/sync.ts",
                    createdAt: "2026-03-14T10:01:00Z",
                  },
                ],
              },
            },
          ],
        },
      }),
      REPO,
      providerId,
      sourceId,
    );
    expect(doc.content).toContain("**Review · @dlin-eng · APPROVED**");
    expect(doc.content).toContain("review comment on src/sync.ts");
    expect(doc.content).toContain("Nit: rename this.");
  });

  it("suppresses a body-less COMMENTED review shell but keeps its inline comments", () => {
    const { doc } = threadToDocument(
      pull({
        reviews: {
          nodes: [
            {
              author: { login: "dlin-eng", __typename: "User" },
              state: "COMMENTED",
              body: "",
              submittedAt: "2026-03-14T10:00:00Z",
              comments: {
                nodes: [
                  {
                    author: { login: "dlin-eng", __typename: "User" },
                    body: "This races the abort signal.",
                    path: "src/sync.ts",
                    createdAt: "2026-03-14T10:01:00Z",
                  },
                ],
              },
            },
          ],
        },
      }),
      REPO,
      providerId,
      sourceId,
    );
    expect(doc.content).not.toContain("**Review · @dlin-eng · COMMENTED**");
    expect(doc.content).toContain("This races the abort signal.");
  });

  it("skips unsubmitted PENDING draft reviews entirely", () => {
    const { doc } = threadToDocument(
      pull({
        reviews: {
          nodes: [
            {
              author: { login: "dlin-eng", __typename: "User" },
              state: "PENDING",
              body: "Half-written thoughts.",
              submittedAt: null,
              comments: {
                nodes: [
                  {
                    author: { login: "dlin-eng", __typename: "User" },
                    body: "Draft inline note.",
                    path: "src/sync.ts",
                    createdAt: "2026-03-14T10:01:00Z",
                  },
                ],
              },
            },
          ],
        },
      }),
      REPO,
      providerId,
      sourceId,
    );
    expect(doc.content).not.toContain("PENDING");
    expect(doc.content).not.toContain("Half-written thoughts.");
    expect(doc.content).not.toContain("Draft inline note.");
  });

  it("marks a draft PR", () => {
    const { doc } = threadToDocument(
      pull({ merged: false, mergedAt: null, mergedBy: null, state: "OPEN", isDraft: true }),
      REPO,
      providerId,
      sourceId,
    );
    expect(doc.metadata.status).toBe("draft");
  });
});

describe("discussionToDocument", () => {
  const discussion: GqlDiscussion = {
    number: 7,
    title: "Should sync be pull or push?",
    body: "Thinking out loud about the tradeoffs.",
    createdAt: "2026-04-01T10:00:00Z",
    updatedAt: "2026-04-02T11:00:00Z",
    url: `https://github.com/${REPO}/discussions/7`,
    author: { login: "maya-reeves", __typename: "User", name: "Maya Reeves" },
    category: { name: "Ideas" },
    answer: { id: "x" },
    comments: {
      totalCount: 1,
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          author: { login: "dlin-eng", __typename: "User" },
          body: "Pull, with a push nudge.",
          createdAt: "2026-04-02T11:00:00Z",
          isAnswer: true,
          replies: {
            nodes: [
              {
                author: { login: "jlopez-dev", __typename: "User" },
                body: "Agreed.",
                createdAt: "2026-04-02T11:30:00Z",
              },
            ],
          },
        },
      ],
    },
  };

  it("renders threaded comments, replies, and the answered state", () => {
    const doc = discussionToDocument(discussion, REPO, providerId, sourceId);
    expect(doc.externalId).toBe("acme/widgets/discussions/7");
    expect(doc.metadata.status).toBe("answered");
    expect(doc.content).toContain("Category: Ideas");
    expect(doc.content).toContain("**@dlin-eng · accepted answer**");
    expect(doc.content).toContain("**@jlopez-dev · reply**");
    expect(doc.sourceUpdatedAt).toBe("2026-04-02T11:30:00Z");
  });
});

describe("commitToDocument", () => {
  it("bridges the GitHub login and the git email in one author mention", () => {
    const doc = commitToDocument(detail(), REPO, providerId, commitsSourceId);
    expect(doc.externalId).toBe(`acme/widgets/commit/${"b".repeat(40)}`);
    const author = doc.metadata.people?.find((p) => p.role === "author");
    expect(author?.lids).toEqual(["github:maya-reeves"]);
    expect(author?.emails).toEqual(["maya@example.org"]);
    expect(doc.content).toContain("Files:");
    expect(doc.content).toContain("- src/sync.ts (+40 −5)");
    expect(doc.content).not.toContain("diff");
  });

  it("never mints a person from the web-flow committer of a squash merge", () => {
    const doc = commitToDocument(
      detail({
        committer: { login: "web-flow", type: "User" },
        commit: {
          message: "fix(sync): persist watermark before commit (#34)",
          author: { name: "Maya Reeves", email: "maya@example.org", date: "2026-03-14T11:59:00Z" },
          committer: { name: "GitHub", email: "noreply@github.com", date: "2026-03-14T12:00:00Z" },
        },
      }),
      REPO,
      providerId,
      commitsSourceId,
    );
    const people = doc.metadata.people ?? [];
    expect(people).toHaveLength(1);
    expect(people[0].role).toBe("author");
    expect(people[0].lids).toEqual(["github:maya-reeves"]);
    expect(people.some((p) => p.name === "GitHub")).toBe(false);
    expect(people.some((p) => p.lids?.includes("github:web-flow"))).toBe(false);
  });

  it("maps a noreply address to the login lid, never an email alias", () => {
    const doc = commitToDocument(
      detail({
        author: null,
        committer: null,
        commit: {
          message: "chore: bump",
          author: {
            name: "Maya Reeves",
            email: "123+maya-reeves@users.noreply.github.com",
            date: "2026-03-14T11:59:00Z",
          },
          committer: {
            name: "Maya Reeves",
            email: "123+maya-reeves@users.noreply.github.com",
            date: "2026-03-14T11:59:00Z",
          },
        },
      }),
      REPO,
      providerId,
      commitsSourceId,
    );
    const author = doc.metadata.people?.find((p) => p.role === "author");
    expect(author?.lids).toEqual(["github:maya-reeves"]);
    expect(author?.emails).toBeUndefined();
  });
});

describe("helpers", () => {
  it("parseNoreplyEmail handles both noreply shapes", () => {
    expect(parseNoreplyEmail("123+maya@users.noreply.github.com")).toBe("maya");
    expect(parseNoreplyEmail("maya@users.noreply.github.com")).toBe("maya");
    expect(parseNoreplyEmail("maya@example.org")).toBeUndefined();
  });

  it("extractMentions skips code spans and fences", () => {
    const text =
      "Ping @maya-reeves about `@decorator` usage.\n```\n@not-a-mention\n```\nAlso @jlopez-dev.";
    expect(extractMentions(text).sort()).toEqual(["jlopez-dev", "maya-reeves"]);
  });

  it("extractMentions never truncates an over-long token into a phantom login", () => {
    const token = `@${"a".repeat(45)}`; // 45 > the 39-char login maximum
    expect(extractMentions(`ref ${token} here`)).toEqual([]);
    // A maximum-length login (39 chars) still matches.
    expect(extractMentions(`ping @${"b".repeat(39)}`)).toEqual(["b".repeat(39)]);
  });

  it("isBot flags [bot] logins, Bot typenames, and ghosts", () => {
    expect(isBot({ login: "dependabot[bot]" })).toBe(true);
    expect(isBot({ login: "x", __typename: "Bot" })).toBe(true);
    expect(isBot(null)).toBe(true);
    expect(isBot({ login: "maya-reeves", __typename: "User" })).toBe(false);
  });
});

describe("collectIssueRefs", () => {
  it("collects same-repo #N and owner/repo#N shorthand, skipping code spans", () => {
    const refs = collectIssueRefs(
      [
        "Supersedes #12 and relates to acme/widgets#34.",
        "Ignore `#99` and:\n```\n#100\n```\nBut other/repo#56 is foreign.",
      ],
      "acme/widgets",
    );
    expect(refs).toEqual([12, 34]);
  });

  it("rejects trailing word characters and collects parenthesised refs", () => {
    expect(collectIssueRefs(["fix (#207) but not #123abc"], "acme/widgets")).toEqual([207]);
  });
});

describe("shorthand refs in documents", () => {
  it("resolved ref kinds become extra.links, excluding self and unresolved numbers", () => {
    const kinds = new Map<number, "issues" | "pull" | "discussions">([
      [2, "pull"],
      [3, "discussions"],
      [12, "issues"],
    ]);
    const { doc } = threadToDocument(
      issue({ body: "See #2, #3, #999 and #12 (self)." }),
      REPO,
      providerId,
      sourceId,
      kinds,
    );
    expect(doc.metadata.extra?.links).toEqual([
      "acme/widgets/pull/2",
      "acme/widgets/discussions/3",
    ]);
  });
});

describe("document-event profiles", () => {
  function discussion(answered: boolean): GqlDiscussion {
    return {
      number: 7,
      title: "Should sync be pull or push?",
      body: "Thinking out loud about the tradeoffs.",
      createdAt: "2026-04-01T10:00:00Z",
      updatedAt: "2026-04-02T11:00:00Z",
      url: `https://github.com/${REPO}/discussions/7`,
      author: { login: "maya-reeves", __typename: "User", name: "Maya Reeves" },
      category: { name: "Ideas" },
      answer: answered ? { id: "x" } : null,
      comments: {
        totalCount: 1,
        pageInfo: { hasNextPage: false },
        nodes: [
          {
            author: { login: "dlin-eng", __typename: "User" },
            body: "Pull, with a push nudge. cc @jlopez-dev",
            createdAt: "2026-04-02T11:00:00Z",
            isAnswer: answered,
            replies: { nodes: [] },
          },
        ],
      },
    };
  }

  const thread = (t: GqlIssue | GqlPullRequest) =>
    threadToDocument(t, REPO, providerId, sourceId).doc;
  const openIssue = thread(issue());
  const unlabelledIssue = thread(issue({ labels: { nodes: [] } }));
  const answeredDiscussion = discussionToDocument(discussion(true), REPO, providerId, sourceId);
  // One document per state a thread can be in, so every declared status value
  // is proven reachable and no reachable value goes undeclared.
  const threadDocs: DocumentInput[] = [
    openIssue,
    thread(issue({ state: "CLOSED" })),
    thread(pull()),
    thread(pull({ merged: false, mergedAt: null, mergedBy: null, state: "OPEN", isDraft: true })),
    thread(pull({ merged: false, mergedAt: null, mergedBy: null, state: "CLOSED" })),
    answeredDiscussion,
    discussionToDocument(discussion(false), REPO, providerId, sourceId),
  ];

  const plainCommit = commitToDocument(detail(), REPO, providerId, commitsSourceId);
  // A merge commit whose committer differs from its author and whose message
  // mentions a third login: the one shape that reaches every declared role
  // and the merge-commit flag at once.
  const mergeCommit = commitToDocument(
    detail({
      commit: {
        message: "Merge branch 'fix-watermark'\n\nReviewed by @jlopez-dev.",
        author: { name: "Maya Reeves", email: "maya@example.org", date: "2026-03-14T11:59:00Z" },
        committer: { name: "David Lin", email: "dlin@example.org", date: "2026-03-14T12:00:00Z" },
      },
      committer: { login: "dlin-eng", type: "User" },
      parents: [{ sha: "0".repeat(40) }, { sha: "1".repeat(40) }],
    }),
    REPO,
    providerId,
    commitsSourceId,
  );
  const commitDocs: DocumentInput[] = [plainCommit, mergeCommit];

  function typesOf(docs: DocumentInput[]): Set<string | undefined> {
    return new Set(docs.map((d) => d.metadata.documentType));
  }
  function rolesOf(docs: DocumentInput[]): Set<string> {
    return new Set(docs.flatMap((d) => (d.metadata.people ?? []).map((p) => p.role)));
  }
  function metadataAt(doc: DocumentInput, path: string): unknown {
    return path
      .split(".")
      .reduce<unknown>(
        (value, key) =>
          value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined,
        doc.metadata as unknown,
      );
  }
  function valuesAt(docs: DocumentInput[], path: string): Set<unknown> {
    return new Set(docs.map((d) => metadataAt(d, path)));
  }
  function field(profile: DocumentEventProfile, path: string): DocumentMetadataFieldSpec {
    const found = profile.metadataFields?.find((f) => f.path === path);
    if (!found) throw new Error(`no field ${path}`);
    return found;
  }
  /** The declared field type a runtime value would satisfy. */
  function typeOf(value: unknown): string {
    if (Array.isArray(value)) {
      return value.every((v) => typeof v === "string") ? "string-array" : "mixed-array";
    }
    return typeof value;
  }

  it("both declarations satisfy the source-boundary contract", () => {
    expect(() =>
      validateDocumentEventProfile(githubThreadsDocumentProfile, "github"),
    ).not.toThrow();
    expect(() =>
      validateDocumentEventProfile(githubCommitsDocumentProfile, "github-commits"),
    ).not.toThrow();
  });

  it("declared document types are exactly the ones the normalizer stamps", () => {
    expect(new Set(githubThreadsDocumentProfile.documentTypes)).toEqual(typesOf(threadDocs));
    expect(new Set(githubCommitsDocumentProfile.documentTypes)).toEqual(typesOf(commitDocs));
  });

  it("declared person roles are exactly the ones the normalizer populates", () => {
    expect(new Set(githubThreadsDocumentProfile.personRoles)).toEqual(rolesOf(threadDocs));
    expect(new Set(githubCommitsDocumentProfile.personRoles)).toEqual(rolesOf(commitDocs));
  });

  it("the closed vocabularies are exactly the values thread documents carry", () => {
    const kind = field(githubThreadsDocumentProfile, "extra.kind");
    expect(new Set(kind.allowedValues)).toEqual(valuesAt(threadDocs, kind.path));
    const status = field(githubThreadsDocumentProfile, "status");
    expect(new Set(status.allowedValues)).toEqual(valuesAt(threadDocs, status.path));
  });

  it("every declared field is present on some document with the declared type", () => {
    for (const [profile, docs] of [
      [githubThreadsDocumentProfile, threadDocs],
      [githubCommitsDocumentProfile, commitDocs],
    ] as const) {
      for (const f of profile.metadataFields ?? []) {
        const carried = docs.map((d) => metadataAt(d, f.path)).filter((v) => v !== undefined);
        expect(carried.length, f.path).toBeGreaterThan(0);
        for (const value of carried) expect(typeOf(value), f.path).toBe(f.type);
      }
    }
  });

  it("labels are absent exactly when a thread has none, and a discussion never has any", () => {
    expect(metadataAt(openIssue, "tags")).toEqual(["bug", "sync"]);
    expect(metadataAt(unlabelledIssue, "tags")).toBeUndefined();
    expect(metadataAt(answeredDiscussion, "tags")).toBeUndefined();
    // Every other declared field still reaches a discussion.
    for (const f of githubThreadsDocumentProfile.metadataFields ?? []) {
      if (f.path === "tags") continue;
      expect(metadataAt(answeredDiscussion, f.path), f.path).toBeDefined();
    }
  });

  it("the merge-commit flag is absent, never false, on a single-parent commit", () => {
    expect(metadataAt(mergeCommit, "extra.mergeCommit")).toBe(true);
    expect(metadataAt(plainCommit, "extra.mergeCommit")).toBeUndefined();
  });
});
