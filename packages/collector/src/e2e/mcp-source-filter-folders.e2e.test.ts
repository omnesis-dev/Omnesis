// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";
import { renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { portalJson } from "./mcp-oauth-helper.js";
import { SyntheticE2EHarness } from "./synth-harness.js";
import { startScopeScriptedAgent, type ScopeScriptedAgent } from "./scope-scripted-agent.js";
import {
  closeFilterContext,
  expectFilterBoundary,
  openFilterContext,
  type FilterAccount,
  type FilterContext,
  type FilterCorpus,
} from "./source-filter-corpus.js";
import type { ScopeRef, SourceScopeOptions } from "@omnesis/types";

/**
 * The folder filters of the sources that read directories, from the files a
 * collector reads to what an external agent is given. Nothing is pushed: the
 * `folder-filters` universe is read by the real coding-agent session sources
 * and the real local-files source, which file every document and publish
 * every folder themselves; the test picks folders the way the editor's tree
 * offers them.
 */

const CAPABILITIES = ["direct", "answer"] as const;
const SESSION_TYPES = ["claude-code", "codex", "pi"] as const;
const PATH_TYPES = [...SESSION_TYPES, "local-files"] as const;
type PathSourceType = (typeof PATH_TYPES)[number];
const folder = (id: string): ScopeRef => ({ kind: "folder", id });

/** What each source holds, by the marker its fixtures carry. */
const IN_WORK = ["atlas", "guide", "billing"];
const HELD: Record<PathSourceType, { work: string[]; other: string[]; unknown: string[] }> = {
  // "retries" started in work/billing and stepped into a subdirectory;
  // "roaming" went from a work project to a personal one.
  "claude-code": {
    work: [...IN_WORK, "retries"],
    other: ["garden", "bench"],
    unknown: ["roaming"],
  },
  codex: { work: [...IN_WORK, "retries"], other: ["garden", "bench"], unknown: ["roaming"] },
  pi: { work: IN_WORK, other: ["garden", "bench"], unknown: [] },
  "local-files": { work: IN_WORK, other: ["garden", "bench", "inbox"], unknown: [] },
};

interface PathSource {
  account: FilterAccount<PathSourceType>;
  corpus: FilterCorpus;
}

describe("folder filters over MCP, from directories on disk to what an agent is given", () => {
  let harness: SyntheticE2EHarness;
  let model: ScopeScriptedAgent;
  let context: FilterContext;
  const sources = new Map<PathSourceType, PathSource>();

  /** Every document of a source, keyed by the marker in its text. */
  function readCorpus(type: PathSourceType): PathSource {
    const sourceId = harness.getSourceIds().find((id) => id.startsWith(`${type}:`));
    if (!sourceId) throw new Error(`Missing synthetic source ${type}`);
    const reader = new Database(harness.getDbPath(), { readonly: true });
    try {
      const rows = reader
        .prepare<
          [string],
          {
            id: string;
            external_id: string;
            provider_id: string;
            content: string;
          }
        >(
          "SELECT id,external_id,provider_id,content FROM documents WHERE source_id=? ORDER BY external_id",
        )
        .all(sourceId);
      const corpus: FilterCorpus = new Map();
      for (const row of rows) {
        const marker = /(?:PROMPT|BODY)_([A-Z_]+)/.exec(row.content)?.[1];
        if (!marker) throw new Error(`A ${type} document carries no marker`);
        const key = marker.toLowerCase().replaceAll("_", "-");
        if (corpus.has(key)) throw new Error(`Two ${type} documents carry the marker ${marker}`);
        corpus.set(key, {
          key,
          id: row.id,
          externalId: row.external_id,
          // Session titles name the project, which sessions share; the answer's marker is the
          // second text only this document holds.
          title: type === "local-files" ? `TITLE_${marker}` : `ANSWER_${marker}`,
          body: type === "local-files" ? `BODY_${marker}` : `PROMPT_${marker}`,
        });
      }
      return { account: { type, sourceId, providerId: rows[0]!.provider_id }, corpus };
    } finally {
      reader.close();
    }
  }

  /** The editor's folder list for a source: its top folders, a folder's children, or a search. */
  async function folders(
    type: PathSourceType,
    query: { parentId?: string; q?: string } = {},
  ): Promise<SourceScopeOptions> {
    const { account } = sources.get(type)!;
    const params = new URLSearchParams({ kind: "folder", ...query });
    return portalJson<SourceScopeOptions>(
      harness.gatewayUrl,
      context.answer.portal,
      `/admin/access/source-filters/${encodeURIComponent(account.sourceId)}/options?${params}`,
    );
  }
  /** Walk the tree from its top folder down the given names, as a person clicking through it would. */
  async function pick(type: PathSourceType, ...names: string[]): Promise<ScopeRef> {
    const top = (await folders(type)).items;
    expect(top, `${type} top folders`).toHaveLength(1);
    let current = top[0]!;
    for (const name of names) {
      expect(current.hasChildren, `${current.label} has folders`).toBe(true);
      const children = (await folders(type, { parentId: (current.ref as { id: string }).id }))
        .items;
      const next = children.find((item) => item.label === `${current.label}/${name}`);
      if (!next)
        throw new Error(
          `${current.label} holds no ${name}: ${children.map((item) => item.label).join(", ")}`,
        );
      current = next;
    }
    return current.ref;
  }

  /** Let the gateway's background pass file stored documents under their folders, then index. */
  async function settleFolders(): Promise<void> {
    const settled = (): boolean => {
      const reader = new Database(harness.getDbPath(), { readonly: true });
      try {
        return (
          !reader.prepare("SELECT 1 FROM scope_hierarchy_dirty LIMIT 1").get() &&
          PATH_TYPES.every((type) => {
            const sourceId = harness.getSourceIds().find((id) => id.startsWith(`${type}:`))!;
            return (
              !!reader
                .prepare("SELECT 1 FROM scope_fact_backfill WHERE source_id=? AND ready=1")
                .get(sourceId) &&
              !!reader
                .prepare(
                  "SELECT 1 FROM source_scope_kind_readiness WHERE source_id=? AND kind='folder' AND ready=1",
                )
                .get(sourceId)
            );
          })
        );
      } finally {
        reader.close();
      }
    };
    for (let tick = 0; tick < 120 && !settled(); tick++)
      await harness.gatewayJson("/admin/background/run/backfill.scopeFacts", { method: "POST" });
    expect(settled(), "folder facts settled").toBe(true);
    await harness.reindexMissing();
    await harness.refreshSearchSnapshot();
  }

  beforeAll(async () => {
    model = await startScopeScriptedAgent();
    harness = new SyntheticE2EHarness({
      gatewayMode: "synthetic-experimental",
      universe: "folder-filters",
      extraInference: {
        backends: { filterFolders: { type: "http", url: model.url } },
        assignments: {
          agent: `filterFolders/${model.modelId}`,
          "privacy-reviewer": `filterFolders/${model.modelId}`,
        },
      },
    });
    await harness.start();
    for (const sourceId of harness.getSourceIds()) await harness.triggerSyncAndWait(sourceId);

    await settleFolders();

    for (const type of PATH_TYPES) sources.set(type, readCorpus(type));
    context = await openFilterContext(harness, model);
  }, 300_000);

  afterAll(async () => {
    await closeFilterContext(context);
    await harness?.destroy();
    await model?.close();
  }, 30_000);

  test("every source filed what it read: one document per session or file", () => {
    for (const [type, held] of Object.entries(HELD) as Array<
      [PathSourceType, (typeof HELD)[PathSourceType]]
    >)
      expect([...sources.get(type)!.corpus.keys()].sort(), `${type} documents`).toEqual(
        [...held.work, ...held.other, ...held.unknown].sort(),
      );
  });

  test("the editor's tree is the folders the sources read: a top folder, then each level beneath it", async () => {
    for (const type of SESSION_TYPES) {
      const top = (await folders(type)).items;
      expect(top.map((item) => item.label)).toEqual(["/srv"]);
      const srv = (await folders(type, { parentId: (top[0]!.ref as { id: string }).id })).items;
      expect(srv.map((item) => item.label)).toEqual([
        "/srv/personal",
        "/srv/work",
        "/srv/workshop",
      ]);
      const held = HELD[type];
      // A folder counts what a filter on it governs: everything beneath it.
      expect(srv.find((item) => item.label === "/srv/work")!.count).toBe(held.work.length);
      expect(srv.find((item) => item.label === "/srv/workshop")!.count).toBe(1);
      expect(top[0]!.count).toBe(held.work.length + held.other.length);
    }
    // A session that started in work/billing and stepped into billing/api is
    // filed under billing alone: no folder exists for the subdirectory, so no
    // filter can name it, and hiding billing is what hides the session.
    for (const type of ["claude-code", "codex"] as const) {
      const billing = await pick(type, "work", "billing");
      const beneath = await folders(type, { parentId: (billing as { id: string }).id });
      expect(beneath.items, `${type} folders beneath billing`).toEqual([]);
    }
    // local-files starts at the configured folder, never above it.
    const top = (await folders("local-files")).items;
    expect(top).toHaveLength(1);
    expect(top[0]!.label.endsWith("/synthetic-local-files")).toBe(true);
    expect(top[0]!.count).toBe(6);
    const children = (
      await folders("local-files", { parentId: (top[0]!.ref as { id: string }).id })
    ).items;
    expect(children.map((item) => item.label.slice(top[0]!.label.length))).toEqual([
      "/personal",
      "/work",
      "/workshop",
    ]);
    // Typing part of a path finds a folder at any depth.
    const found = (await folders("codex", { q: "atlas-api/d" })).items;
    expect(found.map((item) => item.label)).toEqual(["/srv/work/atlas-api/docs"]);
  }, 120_000);

  describe.each(CAPABILITIES)("%s", (capability) => {
    const run = (
      type: PathSourceType,
      action: "share" | "hide",
      match: ScopeRef[],
      markers: readonly string[],
    ) => {
      const source = sources.get(type)!;
      return expectFilterBoundary(
        context,
        source.account,
        source.corpus,
        capability,
        action,
        match,
        [...source.corpus.keys()].filter((key) => markers.includes(key)),
      );
    };

    test.each(SESSION_TYPES)(
      "%s, share only the work folder: sessions run in it at any depth, not the workshop beside it, not one that also left it",
      async (type) => {
        await run(type, "share", [await pick(type, "work")], HELD[type].work);
      },
      420_000,
    );

    test.each(SESSION_TYPES)(
      "%s, hide the personal folder: everything else stays, and a session with no single folder stays withheld",
      async (type) => {
        const held = HELD[type];
        await run(type, "hide", [await pick(type, "personal")], [...held.work, "bench"]);
      },
      420_000,
    );

    test("local-files, share only the work folder: files beneath it at any depth", async () => {
      await run("local-files", "share", [await pick("local-files", "work")], IN_WORK);
    }, 420_000);

    test("local-files, hide the personal folder: the rest stays, including a file at the top of the configured folder", async () => {
      await run(
        "local-files",
        "hide",
        [await pick("local-files", "personal")],
        [...IN_WORK, "bench", "inbox"],
      );
    }, 420_000);

    test("a nested folder shares only itself and what is beneath it; the configured folder shares everything", async () => {
      await run("codex", "share", [await pick("codex", "work", "atlas-api")], ["atlas", "guide"]);
      await run(
        "local-files",
        "share",
        [await pick("local-files", "work", "atlas-api", "docs")],
        ["guide"],
      );
      await run(
        "local-files",
        "share",
        [await pick("local-files")],
        [...IN_WORK, "garden", "bench", "inbox"],
      );
    }, 420_000);

    test("a session that stepped into a subdirectory goes with the folder it started in", async () => {
      const held = HELD.codex;
      const billing = [await pick("codex", "work", "billing")];
      await run("codex", "share", billing, ["billing", "retries"]);
      await run(
        "codex",
        "hide",
        billing,
        [...held.work, ...held.other].filter((key) => key !== "billing" && key !== "retries"),
      );
    }, 420_000);

    test("two folders together share their union and hide their union", async () => {
      const match = [await pick("pi", "work", "billing"), await pick("pi", "workshop")];
      await run("pi", "share", match, ["billing", "bench"]);
      await run("pi", "hide", match, ["atlas", "guide", "garden"]);
    }, 420_000);

    test("a folder that does not exist shares nothing and hides nothing that has a folder", async () => {
      const held = HELD["claude-code"];
      await run("claude-code", "share", [folder("dir:never")], []);
      await run("claude-code", "hide", [folder("dir:never")], [...held.work, ...held.other]);
    }, 420_000);
  });

  test("a file moved to another folder follows it at the next sync, with the identity it had", async () => {
    const { account, corpus } = sources.get("local-files")!;
    // The top folder's label is the configured folder's path, home-relative when it is inside home.
    const label = (await folders("local-files")).items[0]!.label;
    const root = label.startsWith("~") ? join(homedir(), label.slice(1)) : label;
    const work = await pick("local-files", "work");
    const personal = await pick("local-files", "personal");
    renameSync(
      join(root, "work/billing/zqfilter-billing.md"),
      join(root, "personal/zqfilter-billing.md"),
    );
    await harness.triggerSyncAndWait(account.sourceId);
    await settleFolders();
    expect(readCorpus("local-files").corpus.get("billing")!.id).toBe(corpus.get("billing")!.id);
    const keys = (markers: string[]) => [...corpus.keys()].filter((key) => markers.includes(key));
    await expectFilterBoundary(
      context,
      account,
      corpus,
      "direct",
      "share",
      [work],
      keys(["atlas", "guide"]),
    );
    await expectFilterBoundary(
      context,
      account,
      corpus,
      "direct",
      "hide",
      [personal],
      keys(["atlas", "guide", "bench", "inbox"]),
    );
    await expectFilterBoundary(
      context,
      account,
      corpus,
      "answer",
      "share",
      [personal],
      keys(["garden", "billing"]),
    );
  }, 420_000);
});
