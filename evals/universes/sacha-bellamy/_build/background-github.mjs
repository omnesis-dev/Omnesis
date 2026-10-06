// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { at, hash, SELF, OWNER_EMAIL } from "./shared.mjs";
import { topics, dayAt } from "./background-content.mjs";

export function addGithub(state) {
  const { ctx, last, put } = state;
  const repo = "fictional-sacha/hobby-catalogue";
  const threads = Array.from({ length: 100 }, (_, i) => {
    const day = dayAt(i, 100, "2021-01-01", last);
    const topic = topics[i % topics.length];
    const actor = ctx.person(i % 2 ? SELF : "p_ada");
    return {
      __typename: "Issue",
      number: i + 1,
      title: `Catalogue ${topic[0]} materials`,
      body: `Add a simple record for ${topic[0]}. Required fields: storage box, quantity, condition and a short handling note. The first sketch omitted the condition field.`,
      state: i % 8 === 0 ? "OPEN" : "CLOSED",
      createdAt: at(day),
      updatedAt: at(day),
      closedAt: i % 8 === 0 ? null : at(day, "16:00"),
      url: `https://github.com/${repo}/issues/${i + 1}`,
      author: { login: actor.extra.githubLogin, name: actor.name },
      labels: { nodes: [{ name: "household-tool" }] },
      assignees: { nodes: [] },
      comments: {
        nodes: [
          {
            author: { login: ctx.person(SELF).extra.githubLogin },
            body: `I added the condition field. For ${topic[0]}, the useful note is: ${topic[4]}.`,
            createdAt: at(day, "14:00"),
            url: `https://github.com/${repo}/issues/${i + 1}#issuecomment-${5000 + i}`,
          },
        ],
        totalCount: 1,
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    };
  });
  put("github", "threads.json", { repo, threads, discussions: [] });
  put("github-commits", "commits.json", {
    repo,
    commits: Array.from({ length: 140 }, (_, i) => {
      const day = dayAt(i, 140, "2021-01-01", last);
      const sha = hash(`sacha-hobby-commit-${i}`).slice(0, 40);
      return {
        sha,
        html_url: `https://github.com/${repo}/commit/${sha}`,
        commit: {
          message: `Add storage category for ${topics[i % topics.length][0]}\n\nKeep handling notes separate from quantity.`,
          author: { name: ctx.person(SELF).name, email: OWNER_EMAIL, date: at(day) },
          committer: { name: ctx.person(SELF).name, email: OWNER_EMAIL, date: at(day) },
        },
        author: { login: ctx.person(SELF).extra.githubLogin },
        committer: { login: ctx.person(SELF).extra.githubLogin },
        stats: { additions: 5 + (i % 21), deletions: i % 5, total: 5 + (i % 21) + (i % 5) },
        files: [
          {
            filename: `catalogue/category-${i % 40}.json`,
            status: "modified",
            additions: 5 + (i % 21),
            deletions: i % 5,
          },
        ],
        parents: [],
      };
    }),
  });
}
