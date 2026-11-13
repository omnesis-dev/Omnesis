// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Repository and owner filters on the two GitHub sources, over MCP.
 *
 * The `repository-filters` universe is one account that sees a work
 * organization and personal repositories. Its synthetic twin pages the
 * fixtures and runs the real provider's filter protocol: the refresh the
 * gateway opens, the tree of owners and repositories, the repository on every
 * document. Nothing here installs a fact by hand for that account — each
 * boundary is what the gateway derived from what the source sent.
 *
 * A second account, pushed through the same provider functions, stands in for
 * what a fixture cannot do: a repository seen from two accounts, and one that
 * is renamed, transferred and withdrawn while filters name it.
 */

import "./synth-env.js";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  repoDocumentScope,
  repoScopeCatalogue,
} from "../../../providers/github/src/repo-scopes.js";
import { portalJson } from "./mcp-oauth-helper.js";
import { startScopeScriptedAgent, type ScopeScriptedAgent } from "./scope-scripted-agent.js";
import { pushScopeUpdates } from "./source-scope-fixtures.js";
import {
  closeFilterContext,
  createFilterAccount,
  expectDirectBoundary,
  expectFilterBoundary,
  filterPolicy,
  nextDirect,
  openFilterContext,
  pushFilterRecords,
  readyFilterAccounts,
  saveFilters,
  type FilterAccount,
  type FilterContext,
  type FilterCorpus,
} from "./source-filter-corpus.js";
import { SyntheticE2EHarness } from "./synth-harness.js";
import type {
  ScopeRef,
  SourceScopeOptions,
  SourceScopePreview,
  SourceScopes,
} from "@omnesis/types";

const CAPABILITIES = ["direct", "answer"] as const;
const ACCOUNT = "maya-reeves";

// GitHub's ids, as the universe's fixtures give them.
const NORTHSTAR = "owner:9001";
const NORTHSTAR_ARCHIVE = "owner:9002";
const MAYA = "owner:7001";
const ATLAS = "repo:4101";
const GARDEN = "repo:5201";
const FORK = "repo:5202";
const folder = (id: string): ScopeRef => ({ kind: "folder", id });

// Thread records by key; the commits source holds one `<repository>-commit` each.
const ATLAS_THREADS = ["atlas-issue", "atlas-pull", "atlas-discussion"];
const WORK_THREADS = [...ATLAS_THREADS, "docs-issue"];
const PERSONAL_THREADS = ["garden-issue", "fork-pull"];
/** Every thread a filter can reach; `sketches-issue` sits in a repository GitHub gave no id for. */
const ATTRIBUTED_THREADS = [...WORK_THREADS, "archive-issue", ...PERSONAL_THREADS];

/** The universe's records of one source, keyed by the marker each title carries. */
function readCorpus(
  harness: SyntheticE2EHarness,
  sourceId: string,
): {
  account: FilterAccount;
  corpus: FilterCorpus;
} {
  const reader = new Database(harness.getDbPath(), { readonly: true });
  try {
    const rows = reader
      .prepare<
        [string],
        { id: string; external_id: string; title: string; provider_id: string; url: string | null }
      >(
        `SELECT id, external_id, title, provider_id, json_extract(metadata, '$.sourceUrl') AS url
         FROM documents WHERE source_id=? ORDER BY external_id`,
      )
      .all(sourceId);
    const corpus: FilterCorpus = new Map();
    for (const row of rows) {
      const marker = /TITLE_([A-Z_]+)/.exec(row.title)?.[1];
      if (!marker) throw new Error(`Record without a marker: ${row.external_id}`);
      const key = marker.toLowerCase().replaceAll("_", "-");
      corpus.set(key, {
        key,
        id: row.id,
        externalId: row.external_id,
        title: `TITLE_${marker}`,
        body: `BODY_${marker}`,
        ...(row.url ? { url: row.url } : {}),
      });
    }
    return {
      account: {
        type: sourceId.slice(0, sourceId.indexOf(":")),
        sourceId,
        providerId: rows[0]!.provider_id,
      },
      corpus,
    };
  } finally {
    reader.close();
  }
}

describe("GitHub repository and owner filters over MCP", () => {
  let harness: SyntheticE2EHarness;
  let model: ScopeScriptedAgent;
  let context: FilterContext;
  let threads: FilterAccount;
  let threadRecords: FilterCorpus;
  let commits: FilterAccount;
  let commitRecords: FilterCorpus;
  let other: FilterAccount;
  let otherRecords: FilterCorpus;

  const options = (account: FilterAccount, query = "") =>
    portalJson<SourceScopeOptions>(
      harness.gatewayUrl,
      context.direct[0]!.portal,
      `/admin/access/source-filters/${encodeURIComponent(account.sourceId)}/options?kind=folder${query}`,
    );
  /** Run the gateway's filter upkeep until the source's tree is open to the editor. */
  async function treeReady(account: FilterAccount): Promise<void> {
    for (let tick = 0; tick < 120; tick++) {
      await harness.gatewayJson("/admin/background/run/backfill.scopeFacts", { method: "POST" });
      const state = await harness.gatewayJson<{
        readiness?: Array<{ kind: string; ready: boolean }>;
      }>(
        `/admin/access/source-filters/${encodeURIComponent(account.sourceId)}/options?kind=folder`,
      );
      if (state.readiness?.find((item) => item.kind === "folder")?.ready) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`The repository tree of ${account.sourceId} never became ready`);
  }

  beforeAll(async () => {
    model = await startScopeScriptedAgent();
    harness = new SyntheticE2EHarness({
      gatewayMode: "synthetic-experimental",
      universe: "repository-filters",
      extraInference: {
        backends: { filterRepos: { type: "http", url: model.url } },
        assignments: {
          agent: `filterRepos/${model.modelId}`,
          "privacy-reviewer": `filterRepos/${model.modelId}`,
        },
      },
    });
    await harness.start();
    for (const type of ["github", "github-commits"]) {
      await harness.triggerSyncAndWait(`${type}:${ACCOUNT}`);
      await harness.triggerSyncAndWait(`${type}:${ACCOUNT}`);
    }
    ({ account: threads, corpus: threadRecords } = readCorpus(harness, `github:${ACCOUNT}`));
    ({ account: commits, corpus: commitRecords } = readCorpus(
      harness,
      `github-commits:${ACCOUNT}`,
    ));

    // A colleague's account: the same work repository, by the same GitHub id,
    // and a repository of their own.
    other = await createFilterAccount(harness, "github", "jamie-lopez");
    const listing = [
      {
        full_name: "northstar-labs/atlas-api",
        id: 4101,
        owner: { id: 9001, login: "northstar-labs" },
      },
      { full_name: "jamie-lopez/dotfiles", id: 6101, owner: { id: 7002, login: "jamie-lopez" } },
      { full_name: "jamie-lopez/Field-Notes", id: 6102, owner: { id: 7002, login: "jamie-lopez" } },
    ];
    const { nodes, ids } = repoScopeCatalogue(listing);
    await pushScopeUpdates(harness, other, { hierarchy: { kind: "folder", nodes } });
    const record = (key: string, repo: string) => ({
      key,
      documentType: "conversation",
      metadata: { scopeHierarchy: [repoDocumentScope(ids, repo)] },
    });
    otherRecords = await pushFilterRecords(harness, other, [
      record("shared-atlas", "northstar-labs/atlas-api"),
      record("dotfiles", "jamie-lopez/dotfiles"),
      // GitHub names are case-insensitive; a document may spell one differently from the listing.
      record("field-notes", "JAMIE-LOPEZ/field-notes"),
      record("elsewhere", "jamie-lopez/never-listed"),
    ]);
    await pushScopeUpdates(harness, other, { readiness: [{ kind: "folder", complete: true }] });

    await readyFilterAccounts(harness, [threads, commits, other]);
    context = await openFilterContext(harness, model);
    for (const account of [threads, commits, other]) await treeReady(account);
    await harness.reindexMissing();
    await harness.refreshSearchSnapshot();
  }, 300_000);

  afterAll(async () => {
    await closeFilterContext(context);
    await harness?.destroy();
    await model?.close();
  }, 30_000);

  test("the twin indexed every kind of record of every repository", () => {
    expect([...threadRecords.keys()].sort()).toEqual(
      [...ATTRIBUTED_THREADS, "sketches-issue"].sort(),
    );
    expect([...commitRecords.keys()].sort()).toEqual([
      "archive-commit",
      "atlas-commit",
      "docs-commit",
      "fork-commit",
      "garden-commit",
      "sketches-commit",
    ]);
  });

  test("the editor browses owners, then their repositories, with the source's word for each level and the records each governs", async () => {
    const roots = await options(threads);
    const item = roots.scopes.items.find((candidate) => candidate.kind === "folder") as Extract<
      SourceScopes["items"][number],
      { kind: "folder" }
    >;
    expect(item).toMatchObject({
      picker: "tree",
      link: "hierarchy",
      levels: [
        { one: "owner", many: "owners" },
        { one: "repository", many: "repositories" },
      ],
    });
    expect(roots.items).toEqual([
      { ref: folder(MAYA), label: "maya-reeves", count: 2, hasChildren: true, depth: 0 },
      { ref: folder(NORTHSTAR), label: "northstar-labs", count: 4, hasChildren: true, depth: 0 },
      {
        ref: folder(NORTHSTAR_ARCHIVE),
        label: "northstar-labs-archive",
        count: 1,
        hasChildren: true,
        depth: 0,
      },
    ]);
    const work = await options(threads, `&parentId=${encodeURIComponent(NORTHSTAR)}`);
    expect(work.items).toEqual([
      {
        ref: folder(ATLAS),
        label: "northstar-labs/atlas-api",
        count: 3,
        parentId: NORTHSTAR,
        hasChildren: false,
        depth: 1,
      },
      {
        ref: folder("repo:4102"),
        label: "northstar-labs/atlas-api-docs",
        count: 1,
        parentId: NORTHSTAR,
        hasChildren: false,
        depth: 1,
      },
    ]);
    // A search reaches both levels, whatever the case typed; the repository without an id is not offered.
    const found = await options(threads, "&q=ATLAS-API");
    expect(found.items.map((entry) => [entry.label, entry.depth])).toEqual([
      ["maya-reeves/atlas-api", 1],
      ["northstar-labs-archive/atlas-api", 1],
      ["northstar-labs/atlas-api", 1],
      ["northstar-labs/atlas-api-docs", 1],
    ]);
    expect((await options(threads, "&q=sketches")).items).toEqual([]);
    // The commits source declares the same tree and counts its own records.
    expect((await options(commits)).items.map((entry) => [entry.label, entry.count])).toEqual([
      ["maya-reeves", 2],
      ["northstar-labs", 2],
      ["northstar-labs-archive", 1],
    ]);

    const preview = await portalJson<SourceScopePreview>(
      harness.gatewayUrl,
      context.direct[0]!.portal,
      `/admin/access/source-filters/${encodeURIComponent(threads.sourceId)}/preview`,
      {
        policy: filterPolicy(threads, "direct", "share", [
          folder(NORTHSTAR),
          folder(GARDEN),
          folder("repo:999"),
        ]),
      },
    );
    expect(preview).toMatchObject({
      total: 8,
      visible: 5,
      hidden: 3,
      unknown: 1,
      items: [
        { ref: folder(NORTHSTAR), label: "northstar-labs", count: 4, depth: 0 },
        {
          ref: folder(GARDEN),
          label: "maya-reeves/garden-notes",
          count: 1,
          depth: 1,
          parentId: MAYA,
        },
        { ref: folder("repo:999"), count: 0, missing: true },
      ],
    });
  }, 120_000);

  describe.each(CAPABILITIES)("issues, pull requests and discussions, %s", (capability) => {
    const run = (action: "share" | "hide", match: ScopeRef[], shared: string[]) =>
      expectFilterBoundary(context, threads, threadRecords, capability, action, match, shared);

    test("share only an organization: every repository it holds, and none of an organization or a fork that merely shares its name", async () => {
      await run("share", [folder(NORTHSTAR)], WORK_THREADS);
    }, 420_000);

    test("hide an organization: everything else stays, except the repository GitHub gave no id for", async () => {
      await run("hide", [folder(NORTHSTAR)], ["archive-issue", ...PERSONAL_THREADS]);
    }, 420_000);

    test("share only a repository: not the one whose name extends it, nor its namesake under another owner", async () => {
      await run("share", [folder(ATLAS)], ATLAS_THREADS);
    }, 420_000);

    test("hide a repository: its owner's other repositories stay", async () => {
      await run(
        "hide",
        [folder(GARDEN)],
        ATTRIBUTED_THREADS.filter((key) => key !== "garden-issue"),
      );
    }, 420_000);

    test("work but not personal: sharing the work organizations and hiding the personal account leave the same records", async () => {
      const work = [...WORK_THREADS, "archive-issue"];
      await run("share", [folder(NORTHSTAR), folder(NORTHSTAR_ARCHIVE)], work);
      await run("hide", [folder(MAYA)], work);
    }, 420_000);

    test("an organization and a single repository together share their union and hide their union", async () => {
      await run("share", [folder(NORTHSTAR), folder(FORK)], [...WORK_THREADS, "fork-pull"]);
      await run("hide", [folder(NORTHSTAR), folder(FORK)], ["archive-issue", "garden-issue"]);
    }, 420_000);

    test("a repository that does not exist shares nothing and hides nothing", async () => {
      await run("share", [folder("repo:999")], []);
      await run("hide", [folder("repo:999")], ATTRIBUTED_THREADS);
    }, 420_000);
  });

  describe.each(CAPABILITIES)("commits, %s", (capability) => {
    const run = (action: "share" | "hide", match: ScopeRef[], shared: string[]) =>
      expectFilterBoundary(context, commits, commitRecords, capability, action, match, shared);

    test("share only an organization, or hide the personal account", async () => {
      await run("share", [folder(NORTHSTAR)], ["atlas-commit", "docs-commit"]);
      await run("hide", [folder(MAYA)], ["atlas-commit", "docs-commit", "archive-commit"]);
    }, 420_000);

    test("share only one repository", async () => {
      await run("share", [folder(FORK)], ["fork-commit"]);
    }, 420_000);
  });

  test("a filter governs the account it was saved on: the same repository seen from another account is that account's to filter", async () => {
    const client = nextDirect(context);
    await saveFilters(harness, client, [
      {
        capability: "direct",
        policies: [filterPolicy(threads, "direct", "hide", [folder(ATLAS)])],
      },
    ]);
    await expectDirectBoundary(
      harness,
      client,
      threads,
      threadRecords,
      ATTRIBUTED_THREADS.filter((key) => !ATLAS_THREADS.includes(key)),
    );
    // The colleague's copy of the repository is untouched, and so is a record no repository claims:
    // no filter is saved on that account.
    await expectDirectBoundary(harness, client, other, otherRecords, [
      "shared-atlas",
      "dotfiles",
      "field-notes",
      "elsewhere",
    ]);
    await saveFilters(harness, client, [
      {
        capability: "direct",
        policies: [
          filterPolicy(threads, "direct", "hide", [folder(ATLAS)]),
          filterPolicy(other, "direct", "hide", [folder(ATLAS)]),
        ],
      },
    ]);
    await expectDirectBoundary(harness, client, other, otherRecords, ["dotfiles", "field-notes"]);
  }, 420_000);

  test("a repository renamed, transferred and then withdrawn after the filter was saved: the filter follows its id", async () => {
    const shareWork = nextDirect(context);
    const hidePersonal = nextDirect(context);
    const DOTFILES = "repo:6101";
    await saveFilters(harness, shareWork, [
      {
        capability: "direct",
        policies: [
          filterPolicy(other, "direct", "share", [folder(NORTHSTAR), folder("repo:6102")]),
        ],
      },
    ]);
    await saveFilters(harness, hidePersonal, [
      {
        capability: "direct",
        policies: [filterPolicy(other, "direct", "hide", [folder("owner:7002")])],
      },
    ]);
    await expectDirectBoundary(harness, shareWork, other, otherRecords, [
      "shared-atlas",
      "field-notes",
    ]);
    await expectDirectBoundary(harness, hidePersonal, other, otherRecords, ["shared-atlas"]);

    // Renamed: same id, new label. Nothing a filter decides changes.
    const renamed = repoScopeCatalogue([
      {
        full_name: "jamie-lopez/workstation-setup",
        id: 6101,
        owner: { id: 7002, login: "jamie-lopez" },
      },
    ]).nodes.filter((node) => node.id === DOTFILES);
    await pushScopeUpdates(harness, other, { hierarchy: { kind: "folder", nodes: renamed } });
    await treeReady(other);
    expect(
      (await options(other, "&q=workstation")).items.map((entry) => [entry.ref, entry.label]),
    ).toEqual([[folder(DOTFILES), "jamie-lopez/workstation-setup"]]);
    await expectDirectBoundary(harness, hidePersonal, other, otherRecords, ["shared-atlas"]);

    // Transferred to the organization: its stored record follows at once, with no document re-sent.
    const transferred = repoScopeCatalogue([
      {
        full_name: "northstar-labs/workstation-setup",
        id: 6101,
        owner: { id: 9001, login: "northstar-labs" },
      },
    ]).nodes.filter((node) => node.id === DOTFILES);
    await pushScopeUpdates(harness, other, { hierarchy: { kind: "folder", nodes: transferred } });
    await treeReady(other);
    await readyFilterAccounts(harness, [other]);
    await expectDirectBoundary(harness, shareWork, other, otherRecords, [
      "shared-atlas",
      "dotfiles",
      "field-notes",
    ]);
    await expectDirectBoundary(harness, hidePersonal, other, otherRecords, [
      "shared-atlas",
      "dotfiles",
    ]);

    // Withdrawn from the source: its record can no longer be placed, so both filters withhold it.
    await pushScopeUpdates(harness, other, {
      hierarchy: {
        kind: "folder",
        nodes: [{ id: DOTFILES, label: DOTFILES, parentIds: [], complete: false, deleted: true }],
      },
    });
    await treeReady(other);
    await readyFilterAccounts(harness, [other]);
    await expectDirectBoundary(harness, shareWork, other, otherRecords, [
      "shared-atlas",
      "field-notes",
    ]);
    await expectDirectBoundary(harness, hidePersonal, other, otherRecords, ["shared-atlas"]);
    expect((await options(other, "&q=workstation")).items).toEqual([]);
  }, 600_000);
});
