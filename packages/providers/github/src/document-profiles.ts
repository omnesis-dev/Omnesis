// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { DocumentEventProfile, DocumentMetadataFieldSpec } from "@omnesis/source-sdk";

/**
 * Which repository a document belongs to. Shared by both sources.
 *
 * A personal repository is spelled `<login>/<name>`, so a filter on this
 * field can single out a person as surely as an author filter does.
 */
const repoField = {
  path: "extra.repo",
  type: "string",
  description:
    "Repository the document belongs to, spelled owner/name exactly as it appears in the GitHub URL (for example acme/widgets).",
  identifiesPeople: true,
} satisfies DocumentMetadataFieldSpec;

/**
 * GitHub threads: one conversation document per issue, pull request, or
 * discussion, carrying its comments and reviews.
 *
 * Deliberately undeclared: `extra.links` (same-source external ids, an
 * internal linking convention), `extra.commentCount` (a count the predicate
 * grammar can only test for equality, never as a threshold), `sourceUrl` and
 * `rollingAggregate` (every document carries them).
 */
export const githubThreadsDocumentProfile: DocumentEventProfile = {
  documentTypes: ["conversation"],
  personRoles: ["author", "participant", "mentioned"],
  metadataFields: [
    {
      path: "extra.kind",
      type: "string",
      description:
        "Which kind of thread the document is. A thread's kind never changes, so a new issue or a new pull request is a created event whose kind matches.",
      allowedValues: ["issue", "pull-request", "discussion"],
      valueAliases: {
        issue: ["issues", "bug report", "ticket", "feature request"],
        "pull-request": ["pull requests", "PR", "PRs", "merge request", "patch"],
        discussion: ["discussions", "forum thread", "Q&A"],
      },
    },
    {
      path: "status",
      type: "string",
      description:
        "Lifecycle state of the thread. An issue is open or closed. A pull request is open, draft, merged, or closed without being merged. A discussion is answered or unanswered.",
      allowedValues: ["open", "closed", "merged", "draft", "answered", "unanswered"],
      valueAliases: {
        open: ["still open", "not yet closed"],
        closed: ["closed out", "closed without merging"],
        merged: ["landed", "merged in", "shipped"],
        draft: ["draft PR", "work in progress", "WIP"],
        answered: ["has an accepted answer", "solved"],
        unanswered: ["no accepted answer", "awaiting an answer"],
      },
    },
    repoField,
    {
      path: "extra.number",
      type: "number",
      description: "The thread's number within its repository, as shown at the end of its URL.",
    },
    {
      path: "tags",
      type: "string-array",
      description:
        "Labels applied to an issue or pull request, using the repository's own label names. Absent when the thread has no labels; discussions never carry any.",
    },
  ],
};

/**
 * GitHub commits: one document per commit on a repository's default branch,
 * carrying the message, the author, the change stats and the touched paths.
 *
 * Deliberately undeclared: `extra.sha` (an opaque hash that nobody spells in
 * full, and the predicate grammar has no prefix match), `extra.filesChanged`
 * (a count, testable only for equality) and `extra.kind` (always `commit`).
 */
export const githubCommitsDocumentProfile: DocumentEventProfile = {
  documentTypes: ["document"],
  personRoles: ["author", "participant", "mentioned"],
  metadataFields: [
    repoField,
    {
      path: "extra.mergeCommit",
      type: "boolean",
      description:
        "Present and true only on a merge commit, one with more than one parent. Absent on every other commit, so 'exists' is the test for it.",
    },
  ],
};
