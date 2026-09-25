// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { computeContentHash, formatLid } from "@omnesis/core";
import { commitExternalId, threadExternalId } from "./types.js";
import type { DocumentInput, PersonMention, ProviderId, SourceId } from "@omnesis/types";
import type {
  GqlActor,
  GqlComment,
  GqlDiscussion,
  GqlPullRequest,
  GqlThread,
  RestCommitDetail,
  ThreadKind,
} from "./types.js";

/**
 * Version of the rendered thread-document format. Folded into the cursor: a
 * bump forces a full re-walk so every document re-renders (and unchanged
 * output still upserts as a no-op). Bump whenever the markdown layout,
 * external-id scheme, or people extraction changes shape — and also when a
 * discovery change means the source can now see threads it could not before,
 * since only a full re-walk re-materializes what an existing cursor already
 * considers older than its watermark.
 */
export const THREADS_RENDER_VERSION = 4;

/**
 * Commit documents version independently — a thread-render change must not
 * reset the commits cursor (whose re-walk re-fetches one detail per commit).
 */
export const COMMITS_RENDER_VERSION = 1;

/** Files listed in a commit/PR body before eliding. */
const MAX_FILES_LISTED = 50;

// ---------------------------------------------------------------------------
// Actors
// ---------------------------------------------------------------------------

/**
 * Bot detection. Bot comments are excluded from thread bodies (they dominate
 * churn — a deploy bot commenting on every PR would re-embed the whole
 * thread each time) and bots never become people.
 */
export function isBot(actor: GqlActor | { login?: string; type?: string } | null | undefined) {
  if (!actor?.login) return true; // deleted/ghost accounts render as nobody
  if (actor.login.endsWith("[bot]")) return true;
  const typename = (actor as GqlActor).__typename ?? (actor as { type?: string }).type;
  return typename === "Bot";
}

/** Canonical person alias for a GitHub login. Logins are case-insensitive. */
function githubLid(login: string): string {
  return formatLid("github", login.toLowerCase());
}

/**
 * GitHub's commit noreply addresses encode the login (`123+login@users.
 * noreply.github.com` or `login@users.noreply.github.com`). They are unique
 * per user but are not a real mailbox — surface them as the login's lid,
 * never as an email alias.
 */
export function parseNoreplyEmail(email: string): string | undefined {
  const m = /^(?:\d+\+)?([A-Za-z0-9-]+)@users\.noreply\.github\.com$/i.exec(email.trim());
  return m ? m[1] : undefined;
}

/** UTC `YYYY-MM-DD HH:MM` from an ISO timestamp — deterministic, locale-free. */
function ts(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

// ---------------------------------------------------------------------------
// @mention extraction
// ---------------------------------------------------------------------------

/**
 * Extract `@login` mentions from markdown, ignoring code fences and inline
 * code spans (where `@` almost always means a decorator or scope). Mentions
 * are linking evidence only — they carry `allowPersonCreation: false`
 * downstream, so a false positive can never mint a person.
 */
/** Remove fenced blocks and inline code — `#123` or `@user` inside code is not a reference. */
function stripCodeSpans(markdown: string): string {
  return markdown.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");
}

export function extractMentions(markdown: string): string[] {
  const stripped = stripCodeSpans(markdown);
  const found = new Set<string>();
  for (const m of stripped.matchAll(
    /(?:^|[\s([{])@([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))(?![A-Za-z0-9-])/g,
  )) {
    const login = m[1].toLowerCase();
    if (!login.endsWith("-") && !login.includes("--")) found.add(login);
  }
  return [...found];
}

/**
 * GitHub's shorthand autolinks: `#123` (same repo) and `owner/repo#123`.
 * Issues, PRs, and discussions share one number sequence, so the number alone
 * does not name the kind — callers resolve the kinds (and existence) upstream
 * before the numbers become links. Only same-repo references are collected:
 * `references` links resolve within one source, and a foreign `owner/repo#N`
 * that is not synced could never resolve.
 */
export function collectIssueRefs(texts: readonly string[], repo: string): number[] {
  const found = new Set<number>();
  const repoLower = repo.toLowerCase();
  for (const text of texts) {
    const stripped = stripCodeSpans(text);
    for (const m of stripped.matchAll(
      /(?:^|[\s([{])(?:([A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+))?#(\d{1,7})(?![\d\w])/g,
    )) {
      if (m[1] && m[1].toLowerCase() !== repoLower) continue;
      found.add(Number(m[2]));
    }
  }
  return [...found].sort((a, b) => a - b);
}

/** Every ref-bearing text of a thread: body, comments, reviews, inline review comments. */
export function collectThreadRefTexts(thread: GqlThread): string[] {
  const texts: string[] = [];
  if (thread.body) texts.push(thread.body);
  for (const c of thread.comments?.nodes ?? []) if (c?.body) texts.push(c.body);
  if (thread.__typename === "PullRequest") {
    for (const r of (thread as GqlPullRequest).reviews?.nodes ?? []) {
      if (!r) continue;
      if (r.body) texts.push(r.body);
      for (const c of r.comments?.nodes ?? []) if (c?.body) texts.push(c.body);
    }
  }
  return texts;
}

/** Every ref-bearing text of a discussion: body, comments, replies. */
export function collectDiscussionRefTexts(discussion: GqlDiscussion): string[] {
  const texts: string[] = [];
  if (discussion.body) texts.push(discussion.body);
  for (const c of discussion.comments?.nodes ?? []) {
    if (!c) continue;
    if (c.body) texts.push(c.body);
    for (const r of c.replies?.nodes ?? []) if (r?.body) texts.push(r.body);
  }
  return texts;
}

// ---------------------------------------------------------------------------
// People assembly
// ---------------------------------------------------------------------------

class PeopleCollector {
  private byLogin = new Map<string, { role: PersonMention["role"]; name?: string }>();
  private mentioned = new Set<string>();

  private static RANK: Record<string, number> = { author: 2, participant: 1 };

  add(actor: GqlActor | null | undefined, role: "author" | "participant") {
    if (!actor?.login || isBot(actor)) return;
    const login = actor.login.toLowerCase();
    const existing = this.byLogin.get(login);
    if (!existing || PeopleCollector.RANK[role] > PeopleCollector.RANK[existing.role as string]) {
      this.byLogin.set(login, { role, name: actor.name ?? existing?.name ?? undefined });
    } else if (existing && !existing.name && actor.name) {
      existing.name = actor.name;
    }
  }

  mention(login: string) {
    this.mentioned.add(login.toLowerCase());
  }

  /**
   * A thread's people carry a login and a display name only — GitHub exposes
   * no email for the author of an issue, pull request or discussion — so the
   * git email a commit carries is the sole bridge to the rest of the graph.
   * See #73: a login first seen here becomes a person of its own.
   */
  build(): PersonMention[] {
    const mentions: PersonMention[] = [];
    const byLoginKey = (a: [string, unknown], b: [string, unknown]) =>
      a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
    for (const [login, { role, name }] of [...this.byLogin.entries()].sort(byLoginKey)) {
      mentions.push({ role, ...(name ? { name } : {}), lids: [githubLid(login)] });
    }
    for (const login of [...this.mentioned].sort()) {
      if (this.byLogin.has(login)) continue;
      mentions.push({ role: "mentioned", lids: [githubLid(login)], allowPersonCreation: false });
    }
    return mentions;
  }
}

// ---------------------------------------------------------------------------
// Thread rendering
// ---------------------------------------------------------------------------

function actorHandle(actor: GqlActor | null | undefined): string {
  return actor?.login ? `@${actor.login}` : "@ghost";
}

function commentNodes(page: GqlComment["replies"] | GqlThread["comments"]): GqlComment[] {
  return (page?.nodes ?? []).filter((n): n is GqlComment => n !== null && n !== undefined);
}

interface RenderedBlock {
  at: string;
  text: string;
}

function block(header: string, at: string, body: string | null | undefined): RenderedBlock {
  const text = `**${header}** (${ts(at)})\n${(body ?? "").trim() || "_(no text)_"}`;
  return { at, text };
}

function threadStatus(t: GqlThread): string {
  if (t.__typename === "PullRequest") {
    if (t.merged) return "merged";
    if (t.isDraft && t.state === "OPEN") return "draft";
    return t.state.toLowerCase();
  }
  return t.state.toLowerCase();
}

/** Newest of the thread's own and every comment/review timestamp. */
function latestActivity(base: string, blocks: Array<{ at?: string }>): string {
  let latest = base;
  for (const b of blocks) if (b.at && b.at > latest) latest = b.at;
  return latest;
}

/** External ids for resolved `#N` shorthand refs, the doc's own number excluded. */
function shorthandLinks(
  repo: string,
  ownNumber: number,
  refKinds: ReadonlyMap<number, ThreadKind> | undefined,
): string[] {
  if (!refKinds) return [];
  return [...refKinds.entries()]
    .filter(([n]) => n !== ownNumber)
    .sort(([a], [b]) => a - b)
    .map(([n, kind]) => threadExternalId(repo, kind, n));
}

/** Deduped `links` metadata entry, omitted when empty. */
function refLinks(ownExternalId: string, links: string[]): { links?: string[] } {
  const unique = [...new Set(links)].filter((l) => l !== ownExternalId);
  return unique.length > 0 ? { links: unique } : {};
}

export interface NormalizedThread {
  doc: DocumentInput;
  /** The sha this PR landed on the base branch as, when merged. */
  mergeCommitSha?: string;
}

export function threadToDocument(
  thread: GqlThread,
  repo: string,
  providerId: ProviderId,
  sourceId: SourceId,
  /** Kinds of same-repo `#N` shorthand refs, resolved (and existence-checked) upstream. */
  refKinds?: ReadonlyMap<number, ThreadKind>,
): NormalizedThread {
  const isPr = thread.__typename === "PullRequest";
  const kind: ThreadKind = isPr ? "pull" : "issues";
  const externalId = threadExternalId(repo, kind, thread.number);
  const people = new PeopleCollector();
  const blocks: RenderedBlock[] = [];
  const mentionSources: string[] = [];

  people.add(thread.author, "author");
  for (const a of thread.assignees?.nodes ?? []) people.add(a, "participant");

  // Header facts.
  const labels = (thread.labels?.nodes ?? []).flatMap((l) => (l ? [l.name] : []));
  const headerParts = [`State: ${threadStatus(thread)}`];
  if (labels.length > 0) headerParts.push(`Labels: ${labels.join(", ")}`);
  const assignees = (thread.assignees?.nodes ?? []).flatMap((a) =>
    a?.login ? [`@${a.login}`] : [],
  );
  if (assignees.length > 0) headerParts.push(`Assignees: ${assignees.join(", ")}`);
  if (thread.milestone?.title) headerParts.push(`Milestone: ${thread.milestone.title}`);

  const pr = isPr ? (thread as GqlPullRequest) : undefined;
  const closesIssues: Array<{ repo: string; number: number }> = [];
  if (pr) {
    if (pr.baseRefName && pr.headRefName) {
      headerParts.push(`Branch: ${pr.headRefName} → ${pr.baseRefName}`);
    }
    if (pr.additions !== undefined && pr.deletions !== undefined) {
      headerParts.push(`+${pr.additions} −${pr.deletions} in ${pr.changedFiles ?? "?"} files`);
    }
    if (pr.merged && pr.mergedBy?.login) {
      headerParts.push(
        `Merged by @${pr.mergedBy.login}${pr.mergedAt ? ` on ${ts(pr.mergedAt)}` : ""}`,
      );
      people.add(pr.mergedBy, "participant");
    }
    for (const ref of pr.closingIssuesReferences?.nodes ?? []) {
      if (!ref) continue;
      closesIssues.push({ repo: ref.repository?.nameWithOwner ?? repo, number: ref.number });
    }
    if (closesIssues.length > 0) {
      headerParts.push(
        `Closes: ${closesIssues.map((c) => (c.repo === repo ? `#${c.number}` : `${c.repo}#${c.number}`)).join(", ")}`,
      );
    }
  }

  // Opening post.
  if (thread.body?.trim() || !isBot(thread.author)) {
    blocks.push(block(actorHandle(thread.author), thread.createdAt, thread.body));
  }
  if (thread.body) mentionSources.push(thread.body);

  // Conversation comments (bot comments excluded — see isBot()).
  for (const c of commentNodes(thread.comments)) {
    if (isBot(c.author)) continue;
    people.add(c.author ?? null, "participant");
    blocks.push(block(actorHandle(c.author), c.createdAt, c.body));
    mentionSources.push(c.body);
  }

  // Reviews + inline review-comment text (file paths kept, hunks never fetched).
  if (pr) {
    for (const review of (pr.reviews?.nodes ?? []).filter((r) => r != null)) {
      // Unsubmitted draft reviews carry no verdict and no submittedAt — the
      // updatedAt fallback would churn the content hash every poll.
      if (review.state === "PENDING") continue;
      const reviewer = review.author ?? null;
      const inline = (review.comments?.nodes ?? []).filter((c) => c != null && !isBot(c.author));
      if (!isBot(reviewer)) {
        people.add(reviewer, "participant");
        // Verdict reviews (APPROVED, CHANGES_REQUESTED, DISMISSED) always
        // render — the verdict itself is the content, body or not. A
        // COMMENTED review is just a shell around its inline comments, so a
        // body-less one is suppressed.
        if (review.state !== "COMMENTED" || review.body?.trim()) {
          blocks.push(
            block(
              `Review · ${actorHandle(reviewer)} · ${review.state}`,
              review.submittedAt ?? thread.updatedAt,
              review.body,
            ),
          );
          if (review.body) mentionSources.push(review.body);
        }
      }
      for (const c of inline) {
        people.add(c!.author ?? null, "participant");
        blocks.push(
          block(
            `${actorHandle(c!.author)} · review comment${c!.path ? ` on ${c!.path}` : ""}`,
            c!.createdAt,
            c!.body,
          ),
        );
        mentionSources.push(c!.body);
      }
    }
  }

  blocks.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  const fileList =
    pr?.files?.nodes
      ?.filter((f) => f != null)
      .map((f) => f!.path)
      .slice(0, MAX_FILES_LISTED) ?? [];
  const filesLine =
    fileList.length > 0
      ? `Files: ${fileList.join(", ")}${(pr?.changedFiles ?? 0) > fileList.length ? `, … ${(pr?.changedFiles ?? 0) - fileList.length} more` : ""}\n\n`
      : "";

  const title = `${thread.title} · ${repo}#${thread.number}`;
  const content = `# ${title}\n\n${headerParts.join(" · ")}\n\n${filesLine}${blocks.map((b) => b.text).join("\n\n")}\n`;

  for (const source of mentionSources)
    for (const login of extractMentions(source)) people.mention(login);

  const sourceUpdatedAt = latestActivity(thread.updatedAt, blocks);
  const doc: DocumentInput = {
    providerId,
    sourceId,
    externalId,
    // The repository this document lives in. A snapshot that could not read
    // every repository claims the ones it did by name, and a claim only reaches
    // documents that say which repository they are in.
    partitionKey: repo,
    title,
    content,
    contentHash: computeContentHash(content),
    metadata: {
      documentType: "conversation",
      sourceUrl: thread.url,
      status: threadStatus(thread),
      rollingAggregate: true,
      ...(labels.length > 0 ? { tags: labels } : {}),
      people: people.build(),
      extra: {
        repo,
        number: thread.number,
        kind: isPr ? "pull-request" : "issue",
        commentCount: thread.comments?.totalCount ?? 0,
        // "Closes #N" references and `#N` shorthand mentions, as same-source
        // external ids. Resolved by the `references` link convention, which
        // regenerates from this metadata on every re-extraction (a declared
        // references-edge would be wiped by it).
        ...refLinks(externalId, [
          ...closesIssues.map((c) => threadExternalId(c.repo, "issues", c.number)),
          ...shorthandLinks(repo, thread.number, refKinds),
        ]),
      },
    },
    sourceCreatedAt: thread.createdAt,
    sourceUpdatedAt,
  };
  return { doc, mergeCommitSha: pr?.mergeCommit?.oid };
}

// ---------------------------------------------------------------------------
// Discussions
// ---------------------------------------------------------------------------

export function discussionToDocument(
  discussion: GqlDiscussion,
  repo: string,
  providerId: ProviderId,
  sourceId: SourceId,
  /** Kinds of same-repo `#N` shorthand refs, resolved (and existence-checked) upstream. */
  refKinds?: ReadonlyMap<number, ThreadKind>,
): DocumentInput {
  const externalId = threadExternalId(repo, "discussions", discussion.number);
  const people = new PeopleCollector();
  const blocks: RenderedBlock[] = [];
  const mentionSources: string[] = [];

  people.add(discussion.author, "author");
  const answered = discussion.answer != null;
  const headerParts = [
    ...(discussion.category?.name ? [`Category: ${discussion.category.name}`] : []),
    answered ? "Answered" : "Unanswered",
  ];

  // Opening post — a body-less bot opener renders nothing (same gate as
  // threadToDocument).
  if (discussion.body?.trim() || !isBot(discussion.author)) {
    blocks.push(block(actorHandle(discussion.author), discussion.createdAt, discussion.body));
  }
  if (discussion.body) mentionSources.push(discussion.body);

  for (const c of commentNodes(discussion.comments)) {
    if (!isBot(c.author)) {
      people.add(c.author ?? null, "participant");
      blocks.push(
        block(
          `${actorHandle(c.author)}${c.isAnswer ? " · accepted answer" : ""}`,
          c.createdAt,
          c.body,
        ),
      );
      mentionSources.push(c.body);
    }
    for (const reply of commentNodes(c.replies)) {
      if (isBot(reply.author)) continue;
      people.add(reply.author ?? null, "participant");
      blocks.push(block(`${actorHandle(reply.author)} · reply`, reply.createdAt, reply.body));
      mentionSources.push(reply.body);
    }
  }

  blocks.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  for (const source of mentionSources)
    for (const login of extractMentions(source)) people.mention(login);

  const title = `${discussion.title} · ${repo} discussion #${discussion.number}`;
  const content = `# ${title}\n\n${headerParts.join(" · ")}\n\n${blocks.map((b) => b.text).join("\n\n")}\n`;
  return {
    providerId,
    sourceId,
    externalId,
    // The repository this document lives in. A snapshot that could not read
    // every repository claims the ones it did by name, and a claim only reaches
    // documents that say which repository they are in.
    partitionKey: repo,
    title,
    content,
    contentHash: computeContentHash(content),
    metadata: {
      documentType: "conversation",
      sourceUrl: discussion.url,
      status: answered ? "answered" : "unanswered",
      rollingAggregate: true,
      people: people.build(),
      extra: {
        repo,
        number: discussion.number,
        kind: "discussion",
        commentCount: discussion.comments?.totalCount ?? 0,
        ...refLinks(externalId, shorthandLinks(repo, discussion.number, refKinds)),
      },
    },
    sourceCreatedAt: discussion.createdAt,
    sourceUpdatedAt: latestActivity(discussion.updatedAt, blocks),
  };
}

// ---------------------------------------------------------------------------
// Commits
// ---------------------------------------------------------------------------

/** Build the author/committer PersonMention for a commit identity. */
function commitPerson(
  role: "author" | "participant",
  gitIdentity: { name?: string; email?: string } | null | undefined,
  user: { login: string; type?: string } | null | undefined,
): PersonMention | undefined {
  const lids: string[] = [];
  const emails: string[] = [];
  if (user && !isBot(user)) lids.push(githubLid(user.login));
  if (gitIdentity?.email) {
    const noreplyLogin = parseNoreplyEmail(gitIdentity.email);
    if (noreplyLogin) {
      const lid = githubLid(noreplyLogin);
      if (!lids.includes(lid)) lids.push(lid);
    } else if (gitIdentity.email.toLowerCase() !== "noreply@github.com") {
      // The real git email — the bridge that merges this GitHub identity
      // with the same person's email-based identity elsewhere in the graph.
      // GitHub's own web-flow identity (`noreply@github.com`) is not a
      // person's mailbox and never becomes an alias.
      emails.push(gitIdentity.email.toLowerCase());
    }
  }
  if (lids.length === 0 && emails.length === 0) return undefined;
  return {
    role,
    ...(gitIdentity?.name ? { name: gitIdentity.name } : {}),
    ...(lids.length > 0 ? { lids } : {}),
    ...(emails.length > 0 ? { emails } : {}),
  };
}

export function commitToDocument(
  detail: RestCommitDetail,
  repo: string,
  providerId: ProviderId,
  sourceId: SourceId,
): DocumentInput {
  const sha = detail.sha;
  const message = detail.commit.message ?? "";
  const [firstLine, ...rest] = message.split("\n");
  const bodyRest = rest.join("\n").trim();
  const committedAt =
    detail.commit.committer?.date ?? detail.commit.author?.date ?? new Date(0).toISOString();

  const people: PersonMention[] = [];
  const author = commitPerson("author", detail.commit.author, detail.author);
  if (author) people.push(author);
  const sameIdentity =
    detail.commit.committer?.email === detail.commit.author?.email ||
    (detail.committer?.login != null && detail.committer.login === detail.author?.login);
  // Squash/web merges are committed by GitHub itself: the `web-flow` user
  // (a real User, not a Bot) with git identity `GitHub <noreply@github.com>`.
  // That is machinery, not a person — never a committer mention.
  const githubWebFlow =
    detail.committer?.login === "web-flow" ||
    detail.commit.committer?.email?.toLowerCase() === "noreply@github.com";
  if (!sameIdentity && !githubWebFlow) {
    const committer = commitPerson("participant", detail.commit.committer, detail.committer);
    if (committer) people.push(committer);
  }
  for (const login of extractMentions(message)) {
    if (!people.some((p) => p.lids?.includes(githubLid(login)))) {
      people.push({ role: "mentioned", lids: [githubLid(login)], allowPersonCreation: false });
    }
  }

  const files = detail.files ?? [];
  const fileLines = files
    .slice(0, MAX_FILES_LISTED)
    .map((f) => `- ${f.filename} (+${f.additions ?? 0} −${f.deletions ?? 0})`);
  if (files.length > MAX_FILES_LISTED) {
    fileLines.push(`- … ${files.length - MAX_FILES_LISTED} more files`);
  }

  const authorLine = [
    detail.commit.author?.name,
    detail.author?.login ? `@${detail.author.login}` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");

  const shortSha = sha.slice(0, 7);
  const title = `${firstLine.trim()} · ${repo}@${shortSha}`;
  const statsLine =
    detail.stats !== undefined
      ? `+${detail.stats.additions ?? 0} −${detail.stats.deletions ?? 0} in ${files.length} files`
      : "";
  const content = [
    `# ${title}`,
    "",
    [`Author: ${authorLine || "unknown"}`, `Committed: ${ts(committedAt)}`, statsLine]
      .filter(Boolean)
      .join(" · "),
    ...(bodyRest ? ["", bodyRest] : []),
    ...(fileLines.length > 0 ? ["", "Files:", ...fileLines] : []),
    "",
  ].join("\n");

  return {
    providerId,
    sourceId,
    externalId: commitExternalId(repo, sha),
    // The repository this document lives in. A snapshot that could not read
    // every repository claims the ones it did by name, and a claim only reaches
    // documents that say which repository they are in.
    partitionKey: repo,
    title,
    content,
    contentHash: computeContentHash(content),
    metadata: {
      documentType: "document",
      sourceUrl: detail.html_url,
      people,
      extra: {
        repo,
        sha,
        kind: "commit",
        filesChanged: files.length,
        ...(detail.parents && detail.parents.length > 1 ? { mergeCommit: true } : {}),
      },
    },
    sourceCreatedAt: committedAt,
    sourceUpdatedAt: committedAt,
  };
}
