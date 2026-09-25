// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * GraphQL query builders. Nested `first:` arguments are deliberately small —
 * GitHub prices a GraphQL call by the *maximum* nodes it could return
 * (nested firsts multiply), so requesting 100 review comments per review "to
 * be safe" costs the budget whether or not the data exists. The batch query
 * fetches typical threads whole; any connection that overflows is paged out
 * separately with the `*_PAGE_QUERY` constants below.
 */

const ACTOR_FRAGMENT = `fragment A on Actor { login __typename ... on User { name } }`;

const COMMENTS_SELECTION = (first: number) =>
  `comments(first: ${first}) {
    totalCount
    pageInfo { hasNextPage endCursor }
    nodes { author { ...A } body createdAt updatedAt }
  }`;

const ISSUE_FIELDS = `
  __typename number title body state stateReason createdAt updatedAt closedAt url
  author { ...A }
  labels(first: 15) { nodes { name } }
  assignees(first: 10) { nodes { login name } }
  milestone { title }
  ${COMMENTS_SELECTION(40)}
`;

const PR_FIELDS = `
  __typename number title body state createdAt updatedAt closedAt url
  author { ...A }
  labels(first: 15) { nodes { name } }
  assignees(first: 10) { nodes { login name } }
  milestone { title }
  isDraft merged mergedAt mergedBy { ...A }
  baseRefName headRefName additions deletions changedFiles
  ${COMMENTS_SELECTION(40)}
  files(first: 40) { pageInfo { hasNextPage } nodes { path additions deletions } }
  reviews(first: 25) {
    pageInfo { hasNextPage endCursor }
    nodes {
      author { ...A } state body submittedAt
      comments(first: 15) { pageInfo { hasNextPage } nodes { author { ...A } body path createdAt updatedAt } }
    }
  }
  closingIssuesReferences(first: 10) { nodes { number repository { nameWithOwner } } }
  mergeCommit { oid }
`;

/** Batch-materialize up to `count` issues/PRs of one repository by number. */
export function buildThreadBatchQuery(count: number): string {
  const vars = Array.from({ length: count }, (_, i) => `$n${i}: Int!`).join(", ");
  const aliases = Array.from(
    { length: count },
    (_, i) => `t${i}: issueOrPullRequest(number: $n${i}) { ...IssueF ...PrF }`,
  ).join("\n    ");
  return `query ThreadBatch($owner: String!, $name: String!, ${vars}) {
  repository(owner: $owner, name: $name) {
    ${aliases}
  }
}
${ACTOR_FRAGMENT}
fragment IssueF on Issue { ${ISSUE_FIELDS} }
fragment PrF on PullRequest { ${PR_FIELDS} }`;
}

/** Batch-materialize up to `count` discussions of one repository by number. */
export function buildDiscussionBatchQuery(count: number): string {
  const vars = Array.from({ length: count }, (_, i) => `$n${i}: Int!`).join(", ");
  const aliases = Array.from(
    { length: count },
    (_, i) => `d${i}: discussion(number: $n${i}) { ...DiscussionF }`,
  ).join("\n    ");
  return `query DiscussionBatch($owner: String!, $name: String!, ${vars}) {
  repository(owner: $owner, name: $name) {
    ${aliases}
  }
}
${ACTOR_FRAGMENT}
fragment DiscussionF on Discussion {
  number title body createdAt updatedAt url
  author { ...A }
  category { name }
  answer { id }
  comments(first: 30) {
    totalCount
    pageInfo { hasNextPage endCursor }
    nodes {
      author { ...A } body createdAt updatedAt isAnswer
      replies(first: 10) { nodes { author { ...A } body createdAt updatedAt } }
    }
  }
}`;
}

/** One page of extra top-level comments for an overflowing issue/PR. */
export const THREAD_COMMENTS_PAGE_QUERY = `query ThreadComments($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    issueOrPullRequest(number: $number) {
      ... on Issue { comments(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { author { ...A } body createdAt updatedAt } } }
      ... on PullRequest { comments(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { author { ...A } body createdAt updatedAt } } }
    }
  }
}
${ACTOR_FRAGMENT}`;

/** One page of extra reviews for an overflowing PR. */
export const PR_REVIEWS_PAGE_QUERY = `query PrReviews($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviews(first: 50, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          author { ...A } state body submittedAt
          comments(first: 15) { pageInfo { hasNextPage } nodes { author { ...A } body path createdAt updatedAt } }
        }
      }
    }
  }
}
${ACTOR_FRAGMENT}`;

/** One page of extra comments for an overflowing discussion. */
export const DISCUSSION_COMMENTS_PAGE_QUERY = `query DiscussionComments($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    discussion(number: $number) {
      comments(first: 50, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          author { ...A } body createdAt updatedAt isAnswer
          replies(first: 10) { nodes { author { ...A } body createdAt updatedAt } }
        }
      }
    }
  }
}
${ACTOR_FRAGMENT}`;

/**
 * Issue / PR / discussion discovery over cursor-paginated connections.
 *
 * Deliberately not the REST `/issues` listing: that listing is served from an
 * index that can persistently omit issues which exist and are individually
 * fetchable — observed against a real repository where REST returned 80 of 82
 * issues under every variant of sort, direction, state, and `since`, while
 * this connection, the repository's own `open_issues_count`, and a direct
 * fetch all agreed on 82.
 *
 * The ordering differs by mode, and the difference is load-bearing.
 * Incremental walks order on `UPDATED_AT DESC` so the walk can stop at the
 * freshness cutoff. Snapshot walks build `presentExternalIds`, where a missed
 * row is a deleted document, and a keyset cursor over a *mutable* sort key
 * still skips a row that a concurrent edit moves above the walk position — so
 * they order on `CREATED_AT`, which never changes.
 */
export type DiscoveryConnection = "issues" | "pullRequests" | "discussions";

export function buildDiscoveryQuery(conn: DiscoveryConnection, snapshot: boolean): string {
  const orderBy = snapshot
    ? "{ field: CREATED_AT, direction: ASC }"
    : "{ field: UPDATED_AT, direction: DESC }";
  return `query Discovery($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    ${conn}(first: 100, after: $after, orderBy: ${orderBy}) {
      pageInfo { hasNextPage endCursor }
      nodes { number updatedAt }
    }
  }
}`;
}

/**
 * Resolve what kind of thread each `#N` shorthand names. Issues, PRs, and
 * discussions share one number sequence, so both lookups run per number;
 * a number that is neither (NOT_FOUND, tolerated) is not a reference at all
 * — which also filters prose false-positives like CSS colors.
 */
export function buildRefKindsQuery(count: number): string {
  const vars = Array.from({ length: count }, (_, i) => `$n${i}: Int!`).join(", ");
  const aliases = Array.from(
    { length: count },
    (_, i) =>
      `t${i}: issueOrPullRequest(number: $n${i}) { __typename }\n    d${i}: discussion(number: $n${i}) { number }`,
  ).join("\n    ");
  return `query RefKinds($owner: String!, $name: String!, ${vars}) {
  repository(owner: $owner, name: $name) {
    ${aliases}
  }
}`;
}

/**
 * Issue / PR discovery, newest-updated first with cursor pagination.
 *
 * Deliberately not the REST `/issues` listing: that listing is served from an
 * index that can persistently omit issues which exist and are individually
 * fetchable — observed against a real repository where REST returned 80 of 82
 * issues under every variant of sort, direction, state, and `since`, while
 * this connection, the repository's own `open_issues_count`, and a direct
 * fetch all agreed on 82. Enumerating here also gives stable cursor
 * pagination, where REST's offset pages shift under concurrent edits.
 */
export const ISSUES_DISCOVERY_QUERY = `query IssuesDiscovery($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    issues(first: 100, after: $after, orderBy: { field: UPDATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes { number updatedAt }
    }
  }
}`;

export const PULLS_DISCOVERY_QUERY = `query PullsDiscovery($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: 100, after: $after, orderBy: { field: UPDATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes { number updatedAt }
    }
  }
}`;
