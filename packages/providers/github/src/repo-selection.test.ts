// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { GithubClient } from "./client.js";
import { FakeGithub } from "./fake-github.js";
import { parseRepoFilter, reconcileMissingRepos, resolveRepoList } from "./repo-selection.js";

function clientFor(fake: FakeGithub) {
  return new GithubClient("github_pat_test", { fetchImpl: fake.fetchImpl, sleep: async () => {} });
}

describe("parseRepoFilter", () => {
  it("accepts comma strings and arrays", () => {
    expect(parseRepoFilter("acme/widgets, Acme/Docs")).toEqual(["acme/widgets", "acme/docs"]);
    expect(parseRepoFilter(["acme/widgets"])).toEqual(["acme/widgets"]);
    expect(parseRepoFilter("")).toBeUndefined();
    expect(parseRepoFilter(undefined)).toBeUndefined();
  });

  it("refuses a filter that parses to nothing instead of widening to sync-all", () => {
    expect(() => parseRepoFilter("not-a-repo")).toThrow(/no valid owner\/repo entries/);
    // A partially valid filter keeps the valid entries.
    expect(parseRepoFilter("junk, acme/widgets")).toEqual(["acme/widgets"]);
  });
});

describe("resolveRepoList", () => {
  it("defaults to every accessible repo", async () => {
    const fake = new FakeGithub();
    fake.addRepo("acme/widgets");
    fake.addRepo("acme/docs");
    expect(await resolveRepoList(clientFor(fake), undefined)).toEqual([
      "acme/docs",
      "acme/widgets",
    ]);
  });

  it("honours the include filter case-insensitively and skips inaccessible entries", async () => {
    const fake = new FakeGithub();
    fake.addRepo("acme/widgets");
    fake.addRepo("acme/docs");
    const repos = await resolveRepoList(clientFor(fake), {
      repos: "Acme/Widgets, other/gone",
    });
    expect(repos).toEqual(["acme/widgets"]);
  });

  it("reads add-time params nested under `params` — the shape addSources stores", async () => {
    const fake = new FakeGithub();
    fake.addRepo("acme/widgets");
    fake.addRepo("acme/docs");
    const repos = await resolveRepoList(clientFor(fake), {
      syncInterval: "15m",
      params: { repos: "acme/widgets" },
    });
    expect(repos).toEqual(["acme/widgets"]);
  });

  it("honours the exclude filter", async () => {
    const fake = new FakeGithub();
    fake.addRepo("acme/widgets");
    fake.addRepo("acme/scratch");
    const repos = await resolveRepoList(clientFor(fake), { excludeRepos: "acme/scratch" });
    expect(repos).toEqual(["acme/widgets"]);
  });
});

describe("reconcileMissingRepos", () => {
  const base = { repoList: ["acme/widgets"], knownRepos: ["acme/widgets", "acme/gone"] };

  it("first missing snapshot poisons the reconcile and keeps state", () => {
    const dropped: string[] = [];
    const r = reconcileMissingRepos({
      ...base,
      missing: undefined,
      snapshot: true,
      dropRepoState: (repo) => dropped.push(repo),
    });
    expect(r.poison).toBe(true);
    expect(r.missing).toEqual({ "acme/gone": 1 });
    expect(dropped).toEqual([]);
  });

  it("second consecutive missing snapshot allows the sweep and drops state", () => {
    const dropped: string[] = [];
    const r = reconcileMissingRepos({
      ...base,
      missing: { "acme/gone": 1 },
      snapshot: true,
      dropRepoState: (repo) => dropped.push(repo),
    });
    expect(r.poison).toBe(false);
    expect(r.missing).toBeUndefined();
    expect(dropped).toEqual(["acme/gone"]);
  });

  it("a repo that reappears clears its missing count", () => {
    const r = reconcileMissingRepos({
      repoList: ["acme/widgets", "acme/gone"],
      knownRepos: ["acme/widgets", "acme/gone"],
      missing: { "acme/gone": 1 },
      snapshot: true,
      dropRepoState: () => {},
    });
    expect(r.poison).toBe(false);
    expect(r.missing).toBeUndefined();
  });

  it("non-snapshot cycles never advance the count", () => {
    const r = reconcileMissingRepos({
      ...base,
      missing: { "acme/gone": 1 },
      snapshot: false,
      dropRepoState: () => {},
    });
    expect(r.poison).toBe(false);
    expect(r.missing).toEqual({ "acme/gone": 1 });
  });
});
