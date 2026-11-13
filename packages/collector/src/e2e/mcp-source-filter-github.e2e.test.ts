// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Repository and owner filters on the two GitHub sources, through real MCP
 * Direct and Answer connections and a spawned gateway.
 *
 * The `repository-filters` universe is one account whose listing holds two
 * repositories of the organization northstar-labs (one whose name extends
 * the other's), one of an organization whose name extends northstar-labs, a
 * personal repository, a personal fork of a work repository, and one
 * repository GitHub gives no id for. Both sources run the real provider's
 * code over the fixtures: every record carries its repository's id, and the
 * list of owners and repositories is published at the end of each sync.
 * Nothing is pushed or written by hand.
 *
 * Every case saves a filter on a live connection's level, the way the portal
 * does, and checks the exact set an agent reads: Direct search, fetch by id
 * and URL lookup, and Answer's own tools and released answer. Asserted:
 *   - the editor's tree has the owners as roots and their repositories under
 *     them, with the source's word for each level and a count per entry;
 *   - an owner covers its repositories; a name that only extends another one
 *     is a different owner or repository;
 *   - a fork held by another owner is not covered by the owner of the
 *     repository it was forked from;
 *   - a record whose repository has no id is hidden under every filter on the
 *     field, and readable under "All content";
 *   - a repository transferred to another owner moves under that owner for a
 *     saved filter with no record sent again, and a renamed one keeps its
 *     entry;
 *   - the records of a repository that left the listing are hidden under
 *     every filter, including a hide filter naming another repository, and
 *     readable under "All content".
 *
 * The live accounts are reached through a dynamic import: a static one would
 * load the synth package, and cache the active universe, before the harness
 * sets `OMNESIS_SYNTH_UNIVERSE`.
 */

import "./synth-env.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { startScopeScriptedAgent, type ScopeScriptedAgent } from "./scope-scripted-agent.js";
import {
  closeFilterContext,
  expectDirectBoundary,
  expectFilterBoundary,
  filterEditor,
  filterOptions,
  filterPolicy,
  filterPreview,
  nextDirect,
  openFilterContext,
  pickTreePath,
  readFilterCorpus,
  saveFilters,
  startFilterHarness,
  type FilterAccess,
  type FilterContext,
  type FilterCorpus,
} from "./source-filter-corpus.js";
import type { SyntheticE2EHarness } from "./synth-harness.js";
import type { FilterRef } from "@omnesis/types";

const THREADS = "github:maya-reeves";
const COMMITS = "github-commits:maya-reeves";
const FIELD = "extra.repositoryIds";
const ACCESSES: FilterAccess[] = ["direct", "answer"];

const ref = (id: string): FilterRef => ({ capability: "tree", field: FIELD, id });
const NORTHSTAR = ref("owner:9001");
const MAYA = ref("owner:7001");
const ATLAS = ref("4101");

/** The records of each source, by the repository they belong to. */
const HELD = {
  [THREADS]: {
    atlas: ["atlas-issue", "atlas-pull", "atlas-discussion"],
    docs: ["docs-issue"],
    archive: ["archive-issue"],
    garden: ["garden-issue"],
    fork: ["fork-pull"],
    sketches: ["sketches-issue"],
  },
  [COMMITS]: {
    atlas: ["atlas-commit"],
    docs: ["docs-commit"],
    archive: ["archive-commit"],
    garden: ["garden-commit"],
    fork: ["fork-commit"],
    sketches: ["sketches-commit"],
  },
} as const;
type Repository = keyof (typeof HELD)[typeof THREADS];
const of = (sourceId: keyof typeof HELD, ...repositories: Repository[]): string[] =>
  repositories.flatMap((repository) => [...HELD[sourceId][repository]]);

describe("GitHub repository and owner filters over MCP", () => {
  let harness: SyntheticE2EHarness;
  let model: ScopeScriptedAgent;
  let context: FilterContext;
  const corpora = new Map<string, FilterCorpus>();
  /** The document count each completed sync reported, per source, in order. */
  const synced: Record<string, number[]> = { [THREADS]: [], [COMMITS]: [] };
  const failures: string[] = [];

  const corpus = (sourceId: string) => corpora.get(sourceId)!;
  const syncBoth = async () => {
    for (const sourceId of [THREADS, COMMITS]) await harness.triggerSyncAndWait(sourceId, 60_000);
  };
  async function account(sourceId: string) {
    const mod = await import("@omnesis/provider-github-synth");
    const live = mod.getGithubAccount(sourceId);
    if (!live) throw new Error(`no GitHub account registered for ${sourceId}`);
    return live;
  }

  beforeAll(async () => {
    model = await startScopeScriptedAgent();
    harness = startFilterHarness("repository-filters", model);
    await harness.start();
    harness.onStatusChange((change) => {
      const sourceId = String(change.sourceId);
      if (!(sourceId in synced)) return;
      if (change.event === "sync.completed")
        synced[sourceId]!.push(change.status.lastSyncStats?.documents ?? -1);
      if (change.event === "sync.error") failures.push(change.status.lastError ?? "unknown error");
    });
    await syncBoth();
    for (const sourceId of [THREADS, COMMITS])
      corpora.set(sourceId, readFilterCorpus(harness, sourceId));
    context = await openFilterContext(harness, model);
  }, 300_000);

  afterAll(async () => {
    await closeFilterContext(context);
    await harness?.destroy();
    await model?.close();
  }, 30_000);

  test("both sources read every record of every repository", () => {
    expect(failures).toEqual([]);
    for (const sourceId of [THREADS, COMMITS] as const)
      expect([...corpus(sourceId).records.keys()].sort()).toEqual(
        Object.values(HELD[sourceId]).flat().sort(),
      );
  });

  test("the editor offers owners, then their repositories, with a count for each", async () => {
    const editor = await filterEditor(harness, context.portal, THREADS);
    expect(editor).toMatchObject({ profile: "declared", showDeviceLevel: false });
    expect(editor.fields).toEqual([
      expect.objectContaining({
        field: FIELD,
        capability: "tree",
        picker: "tree",
        scope: "global",
        noun: { one: "repository", many: "repositories" },
        levels: [
          { one: "owner", many: "owners" },
          { one: "repository", many: "repositories" },
        ],
        state: { status: "ready" },
      }),
    ]);

    const owners = await filterOptions(harness, context.portal, THREADS, { field: FIELD });
    expect(
      owners.items.map((item) => [item.ref, item.label, item.count, item.hasChildren]),
    ).toEqual([
      [MAYA, "maya-reeves", 2, true],
      [NORTHSTAR, "northstar-labs", 4, true],
      [ref("owner:9002"), "northstar-labs-archive", 1, true],
    ]);
    const work = await filterOptions(harness, context.portal, THREADS, {
      field: FIELD,
      parentId: "owner:9001",
    });
    expect(work.items.map((item) => [item.ref, item.label, item.shortLabel, item.count])).toEqual([
      [ATLAS, "northstar-labs/atlas-api", "atlas-api", 3],
      [ref("4102"), "northstar-labs/atlas-api-docs", "atlas-api-docs", 1],
    ]);
    // The fork is listed under the person who holds it.
    const fork = await pickTreePath(harness, context.portal, THREADS, FIELD, [
      "maya-reeves",
      "atlas-api",
    ]);
    expect(fork).toMatchObject({ ref: ref("5202"), label: "maya-reeves/atlas-api", count: 1 });
  });

  for (const sourceId of [THREADS, COMMITS] as const)
    for (const access of ACCESSES) {
      test(`${sourceId} ${access}: share only an owner — its repositories, not a lookalike owner, not a fork held elsewhere`, async () => {
        await expectFilterBoundary(
          context,
          corpus(sourceId),
          access,
          "share",
          [NORTHSTAR],
          [...of(sourceId, "atlas", "docs")],
        );
      });

      test(`${sourceId} ${access}: hide one repository — the rest stays, except what has no repository`, async () => {
        await expectFilterBoundary(
          context,
          corpus(sourceId),
          access,
          "hide",
          [ATLAS],
          [...of(sourceId, "docs", "archive", "garden", "fork")],
        );
      });
    }

  for (const access of ACCESSES) {
    test(`${access}: share only one repository — not one whose name extends it, not its fork`, async () => {
      await expectFilterBoundary(
        context,
        corpus(THREADS),
        access,
        "share",
        [ATLAS],
        [...of(THREADS, "atlas")],
      );
    });

    test(`${access}: hide an owner — every repository it holds goes, the fork it does not hold stays`, async () => {
      await expectFilterBoundary(
        context,
        corpus(THREADS),
        access,
        "hide",
        [NORTHSTAR],
        [...of(THREADS, "archive", "garden", "fork")],
      );
    });

    test(`${access}: share an owner and a repository of another — their union`, async () => {
      await expectFilterBoundary(
        context,
        corpus(THREADS),
        access,
        "share",
        [MAYA, ref("4102")],
        [...of(THREADS, "garden", "fork", "docs")],
      );
    });

    test(`${access}: "All content" reads every record, the one with no repository included`, async () => {
      await expectFilterBoundary(
        context,
        corpus(THREADS),
        access,
        "all",
        [],
        [...corpora.get(THREADS)!.records.keys()],
      );
    });
  }

  test("a transfer moves a repository under its new owner for a saved filter, and a rename keeps its entry, with no record sent again", async () => {
    const direct = nextDirect(context);
    const shareWork = filterPolicy(THREADS, "direct", "share", [NORTHSTAR, ref("4102")]);
    await saveFilters(harness, direct, [{ access: "direct", policies: [shareWork] }]);
    await expectDirectBoundary(harness, direct, corpus(THREADS), of(THREADS, "atlas", "docs"));

    for (const sourceId of [THREADS, COMMITS]) {
      const live = await account(sourceId);
      // The personal fork is handed to the organization: same id, new owner.
      live.transfer(5202, { id: 9001, login: "northstar-labs" });
      live.rename(4102, "atlas-handbook");
    }
    await syncBoth();
    expect(failures).toEqual([]);
    expect(synced[THREADS]!.at(-1)).toBe(0);
    expect(synced[COMMITS]!.at(-1)).toBe(0);

    await expectDirectBoundary(
      harness,
      direct,
      corpus(THREADS),
      of(THREADS, "atlas", "docs", "fork"),
    );
    const preview = await filterPreview(harness, context.portal, shareWork);
    expect(preview.items.map((item) => [item.ref, item.label, item.count])).toEqual([
      [NORTHSTAR, "northstar-labs", 5],
      [ref("4102"), "northstar-labs/atlas-handbook", 1],
    ]);
    // The upstream owner's former repository is no longer the person's.
    await expectFilterBoundary(
      context,
      corpus(COMMITS),
      "answer",
      "share",
      [MAYA],
      [...of(COMMITS, "garden")],
    );
  });

  test("records of a repository that left the listing are hidden under every filter and readable under All content", async () => {
    for (const sourceId of [THREADS, COMMITS]) (await account(sourceId)).remove(4201);
    await syncBoth();
    expect(failures).toEqual([]);
    expect(synced[THREADS]!.at(-1)).toBe(0);
    const owners = await filterOptions(harness, context.portal, THREADS, { field: FIELD });
    expect(owners.items.map((item) => item.label)).toEqual(["maya-reeves", "northstar-labs"]);

    for (const sourceId of [THREADS, COMMITS] as const)
      for (const access of ACCESSES) {
        // A hide filter naming another repository would leave it, were it listed.
        await expectFilterBoundary(
          context,
          corpus(sourceId),
          access,
          "hide",
          [ATLAS],
          [...of(sourceId, "docs", "garden", "fork")],
        );
        await expectFilterBoundary(
          context,
          corpus(sourceId),
          access,
          "hide",
          [MAYA],
          [...of(sourceId, "atlas", "docs", "fork")],
        );
        await expectFilterBoundary(
          context,
          corpus(sourceId),
          access,
          "all",
          [],
          [...corpus(sourceId).records.keys()],
        );
      }
  });
});
