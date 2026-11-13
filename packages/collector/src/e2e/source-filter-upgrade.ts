// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Source filters switched on over an install that already holds records.
 *
 * A universe is synced by its collector against a gateway where source filters
 * are not in use, so the gateway keeps no filter state and the collector sends
 * none. The collector then goes offline, the gateway is restarted with filters
 * in use — the way an owner switches them on — and the collector comes back.
 * Nothing in the suite triggers a sync after that: the collector notices on
 * reconnecting that the gateway now takes filter facts and reports its stored
 * records' labels, folders and repositories by itself, without sending a
 * record again.
 *
 * What is pinned, for Direct and for Answer:
 *  - while the collector has not reported, no filter that needs its facts can
 *    be saved, an unfiltered connection reads everything as before, and a
 *    filter the gateway can settle from what it stores works already;
 *  - from the first moment a filter is accepted, at whatever point of the
 *    collector's report, nothing the settled filter withholds ever shows;
 *  - once the source is ready each filter leaves exactly its records, and the
 *    editor lists what can be picked with the records each choice governs.
 */

import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { portalJson } from "./mcp-oauth-helper.js";
import { startScopeScriptedAgent, type ScopeScriptedAgent } from "./scope-scripted-agent.js";
import {
  closeFilterContext,
  expectAnswerBoundary,
  expectDirectBoundary,
  expectNoDirectLeak,
  filterPolicy,
  openFilterContext,
  saveFilters,
  type FilterAccount,
  type FilterAction,
  type FilterCapability,
  type FilterContext,
  type FilterCorpus,
} from "./source-filter-corpus.js";
import { SyntheticE2EHarness } from "./synth-harness.js";
import type { AuthorizedMcpClient } from "./mcp-oauth-helper.js";
import type { ScopeRef, SourceScopeOptions } from "@omnesis/types";

/** A choice named outright, or the editor's entry whose label ends with a path. */
type Choice = ScopeRef | { labelEndsWith: string };

export interface UpgradeSource {
  sourceId: string;
  /** The kind of choice the collector reports for this source. */
  kind: "folder" | "label";
  /** The prefixes of the two texts only one record holds: its title and its body. */
  markers: { title: string; body: string };
  /** Every record the collector indexed, by marker. */
  records: string[];
  /** A share-only filter and the records it leaves. */
  share: { choice: Choice; leaves: string[] };
  /** A hide filter and the records it leaves. */
  hide: { choice: Choice; leaves: string[] };
  /**
   * A share-only filter the gateway settles from the records it stores, with
   * no report from a collector.
   */
  storedFacts?: { choice: ScopeRef; leaves: string[] };
}
export interface FilterUpgrade {
  universe: string;
  sources: UpgradeSource[];
}

/** Tables that hold what filters derive from documents and from what collectors report. */
const FACT_TABLES = [
  "document_scope_facts",
  "document_scope_completeness",
  "scope_document_hierarchy",
  "scope_hierarchy_nodes",
  "scope_entities",
  "scope_fact_backfill",
  "source_scope_kind_readiness",
  "source_scope_refresh_requirements",
];

const isRef = (choice: Choice): choice is ScopeRef => "kind" in choice;
const refused = (error: unknown): boolean =>
  error instanceof Error && error.message.includes("HTTP 409");

export function describeFilterUpgrade({ universe, sources }: FilterUpgrade): void {
  describe(`source filters switched on over records already indexed: ${universe}`, () => {
    let harness: SyntheticE2EHarness;
    let model: ScopeScriptedAgent;
    let context: FilterContext;
    const held = new Map<string, { account: FilterAccount; corpus: FilterCorpus }>();
    const before = { advertised: true, factRows: -1, cursors: "", stored: "" };
    const after = { advertised: false };

    const of = (source: UpgradeSource) => held.get(source.sourceId)!;
    const keys = (source: UpgradeSource, markers: readonly string[]) =>
      [...of(source).corpus.keys()].filter((key) => markers.includes(key));

    function read<T>(query: (reader: Database.Database) => T): T {
      const reader = new Database(harness.getDbPath(), { readonly: true });
      try {
        return query(reader);
      } finally {
        reader.close();
      }
    }

    /** Every record of a source as the collector indexed it, keyed by the marker in its text. */
    function readCorpus(source: UpgradeSource): { account: FilterAccount; corpus: FilterCorpus } {
      const rows = read((reader) =>
        reader
          .prepare<
            [string],
            {
              id: string;
              external_id: string;
              provider_id: string;
              content: string;
              url: string | null;
            }
          >(
            `SELECT id, external_id, provider_id, content,
                    json_extract(metadata, '$.sourceUrl') AS url
             FROM documents WHERE source_id=? ORDER BY external_id`,
          )
          .all(source.sourceId),
      );
      const corpus: FilterCorpus = new Map();
      for (const row of rows) {
        const marker = new RegExp(`${source.markers.body}_([A-Z_]+)`).exec(row.content)?.[1];
        if (!marker) throw new Error(`A ${source.sourceId} record carries no marker`);
        const key = marker.toLowerCase().replaceAll("_", "-");
        if (corpus.has(key)) throw new Error(`Two ${source.sourceId} records carry ${marker}`);
        corpus.set(key, {
          key,
          id: row.id,
          externalId: row.external_id,
          title: `${source.markers.title}_${marker}`,
          body: `${source.markers.body}_${marker}`,
          ...(row.url ? { url: row.url } : {}),
        });
      }
      if (rows.length === 0) throw new Error(`${source.sourceId} indexed nothing`);
      return {
        account: {
          type: source.sourceId.slice(0, source.sourceId.indexOf(":")),
          sourceId: source.sourceId,
          providerId: rows[0]!.provider_id,
        },
        corpus,
      };
    }

    /** Each stored record's identity, content and the moment it was last written. */
    const storedRecords = (): string =>
      read((reader) =>
        JSON.stringify(
          reader
            .prepare(
              `SELECT id, source_id, external_id, content_hash, ingested_at FROM documents
               WHERE source_id IN (${sources.map(() => "?").join(",")}) ORDER BY id`,
            )
            .all(...sources.map((source) => source.sourceId)),
        ),
      );

    async function advertisesFilters(): Promise<boolean> {
      const health = await harness.gatewayJson<{ compat?: { sourceScopes?: unknown } }>("/health");
      return health.compat?.sourceScopes !== undefined;
    }

    const factRows = (): number =>
      read((reader) => {
        let rows = 0;
        for (const table of FACT_TABLES) {
          if (!reader.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(table)) continue;
          rows += reader.prepare<[], { n: number }>(`SELECT count(*) AS n FROM ${table}`).get()!.n;
        }
        return rows;
      });

    /** The editor's list for a source: what it offers, and whether the kind can be picked from. */
    const options = (source: UpgradeSource, query = "") =>
      portalJson<SourceScopeOptions>(
        harness.gatewayUrl,
        context.answer.portal,
        `/admin/access/source-filters/${encodeURIComponent(source.sourceId)}/options?kind=${source.kind}${query}`,
      );
    const ready = async (source: UpgradeSource): Promise<boolean> =>
      (await options(source)).readiness.find((item) => item.kind === source.kind)?.ready === true;

    /** The gateway's own pass over the records it stores has reached the end of every source. */
    const storedPassDone = (): boolean =>
      read(
        (reader) =>
          !reader.prepare("SELECT 1 FROM scope_hierarchy_dirty LIMIT 1").get() &&
          sources.every(
            (source) =>
              !!reader
                .prepare("SELECT 1 FROM scope_fact_backfill WHERE source_id=? AND ready=1")
                .get(source.sourceId),
          ),
      );

    /**
     * Run the gateway's filter upkeep, which it otherwise runs on its own
     * schedule, until `done`. Never syncs a source.
     */
    async function upkeepUntil(done: () => boolean | Promise<boolean>): Promise<boolean> {
      for (let tick = 0; tick < 240; tick++) {
        if (await done()) return true;
        await harness.gatewayJson("/admin/background/run/backfill.scopeFacts", { method: "POST" });
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return done();
    }

    async function refOf(source: UpgradeSource, choice: Choice): Promise<ScopeRef> {
      if (isRef(choice)) return choice;
      const wanted = choice.labelEndsWith;
      const found = (await options(source, `&q=${encodeURIComponent(wanted.slice(1))}`)).items;
      const item = found.find((candidate) => candidate.label.endsWith(wanted));
      if (!item) throw new Error(`${source.sourceId} offers no ${wanted}`);
      return item.ref;
    }

    const save = (
      client: AuthorizedMcpClient,
      capability: FilterCapability,
      source: UpgradeSource,
      action: FilterAction,
      ref: ScopeRef,
    ) =>
      saveFilters(harness, client, [
        { capability, policies: [filterPolicy(of(source).account, capability, action, [ref])] },
      ]);

    beforeAll(async () => {
      model = await startScopeScriptedAgent();
      harness = new SyntheticE2EHarness({
        gatewayMode: "synthetic",
        universe,
        extraInference: {
          backends: { filterUpgrade: { type: "http", url: model.url } },
          assignments: {
            agent: `filterUpgrade/${model.modelId}`,
            "privacy-reviewer": `filterUpgrade/${model.modelId}`,
          },
        },
      });
      await harness.start();
      // Twice, as a collector that has been running for a while: the second
      // sync finds nothing new and leaves each source's cursor at rest.
      for (let pass = 0; pass < 2; pass++)
        for (const source of sources) await harness.triggerSyncAndWait(source.sourceId, 120_000);
      for (const source of sources) held.set(source.sourceId, readCorpus(source));
      before.advertised = await advertisesFilters();
      before.factRows = factRows();
      before.stored = storedRecords();
      before.cursors = JSON.stringify(
        await Promise.all(sources.map((source) => harness.getSyncState(source.sourceId))),
      );

      await harness.disconnectCollectors();
      await harness.restartGateway({ gatewayMode: "synthetic-experimental" });
      after.advertised = await advertisesFilters();
      await harness.reindexMissing();
      await harness.refreshSearchSnapshot();
      context = await openFilterContext(harness, model);
    }, 300_000);

    afterAll(async () => {
      await closeFilterContext(context);
      await harness?.destroy();
      await model?.close();
    }, 30_000);

    test("the collector indexed every record while the gateway took no filter facts and kept no filter state", () => {
      for (const source of sources)
        expect([...of(source).corpus.keys()].sort(), source.sourceId).toEqual(
          [...source.records].sort(),
        );
      expect(before.advertised).toBe(false);
      expect(before.factRows).toBe(0);
      expect(after.advertised).toBe(true);
    });

    test("until the collector reports, no filter on what it reports can be saved, an unfiltered connection reads everything, and what the gateway stores already filters", async () => {
      const [filtered, unfiltered] = context.direct;
      // The gateway's own pass over stored records ends without any collector.
      expect(await upkeepUntil(storedPassDone), "the gateway's pass over stored records").toBe(
        true,
      );
      await harness.reindexMissing();
      await harness.refreshSearchSnapshot();
      for (const source of sources) {
        const { account, corpus } = of(source);
        expect(await ready(source), `${source.sourceId} ready`).toBe(false);
        expect((await options(source)).items).toEqual([]);
        const named = isRef(source.share.choice)
          ? source.share.choice
          : ({ kind: source.kind, id: "never" } as ScopeRef);
        for (const action of ["share", "hide"] as const) {
          await expect(save(filtered!, "direct", source, action, named)).rejects.toSatisfy(refused);
          await expect(save(context.answer, "answer", source, action, named)).rejects.toSatisfy(
            refused,
          );
        }
        await saveFilters(harness, unfiltered!, []);
        await expectDirectBoundary(harness, unfiltered!, account, corpus, [...corpus.keys()]);
        if (!source.storedFacts) continue;
        const { choice, leaves } = source.storedFacts;
        await save(filtered!, "direct", source, "share", choice);
        await expectDirectBoundary(harness, filtered!, account, corpus, keys(source, leaves));
        await save(context.answer, "answer", source, "share", choice);
        await expectAnswerBoundary(model, context.answer, account, corpus, keys(source, leaves));
        await saveFilters(harness, filtered!, []);
        await saveFilters(harness, context.answer, []);
      }
    }, 420_000);

    test("the returning collector reports by itself; from the first filter the gateway accepts nothing withheld shows, and each filter then leaves exactly its records", async () => {
      // One connection keeps asking for a share-only filter on every source
      // whose choice can be named before the source has reported, the way an
      // owner would save one at the earliest moment the editor allows.
      const watcher = context.direct[2]!;
      const watched = sources.filter((source) => isRef(source.share.choice));
      const policies = watched.map((source) =>
        filterPolicy(of(source).account, "direct", "share", [source.share.choice as ScopeRef]),
      );
      const seen = { refusals: 0, accepted: false, looks: 0 };
      let reporting = true;
      const look = async (): Promise<void> => {
        if (!seen.accepted) {
          try {
            await saveFilters(harness, watcher, [{ capability: "direct", policies }]);
            seen.accepted = true;
          } catch (error) {
            if (!refused(error)) throw error;
            seen.refusals++;
            return;
          }
        }
        for (const source of watched) {
          const { account, corpus } = of(source);
          await expectNoDirectLeak(watcher, account, corpus, keys(source, source.share.leaves));
        }
        seen.looks++;
      };
      await look();
      expect(seen, "a filter saved before the collector is back").toMatchObject({
        accepted: false,
        refusals: 1,
      });
      const watch = (async () => {
        while (reporting) {
          await look();
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      })();
      let settled: boolean;
      try {
        await harness.reconnectCollectors();
        settled = await upkeepUntil(async () => {
          if (!storedPassDone()) return false;
          for (const source of sources) if (!(await ready(source))) return false;
          return true;
        });
      } finally {
        reporting = false;
        await watch;
      }
      // No sync was asked for: the collector's own report on reconnecting is
      // the whole upgrade.
      expect(settled, "every source ready without a sync being triggered").toBe(true);
      await look();
      expect(seen.accepted, "the filter is accepted once the source is ready").toBe(true);
      await harness.reindexMissing();
      await harness.refreshSearchSnapshot();

      const [direct] = context.direct;
      for (const source of sources) {
        const { account, corpus } = of(source);
        const boundaries: Array<[FilterAction, ScopeRef, string[]]> = [
          ["share", await refOf(source, source.share.choice), source.share.leaves],
          ["hide", await refOf(source, source.hide.choice), source.hide.leaves],
        ];
        for (const [action, ref, leaves] of boundaries) {
          await save(direct!, "direct", source, action, ref);
          await expectDirectBoundary(harness, direct!, account, corpus, keys(source, leaves));
          await save(context.answer, "answer", source, action, ref);
          await expectAnswerBoundary(model, context.answer, account, corpus, keys(source, leaves));
        }
      }
      // The watcher's filter, accepted while the report was arriving, governs like any other.
      for (const source of watched) {
        const { account, corpus } = of(source);
        await expectDirectBoundary(
          harness,
          watcher,
          account,
          corpus,
          keys(source, source.share.leaves),
        );
      }
    }, 900_000);

    test("the editor lists what the collector reported, each choice with the records it governs, and no record was sent again", async () => {
      for (const source of sources) {
        expect(await ready(source), `${source.sourceId} ready`).toBe(true);
        const ref = await refOf(source, source.share.choice);
        const id = (ref as { id: string }).id;
        // The top of the list, then every entry at any depth.
        const listed = [
          ...(await options(source)).items,
          ...(await options(source, "&q=a")).items,
          ...(await options(source, "&q=o")).items,
        ];
        const item = listed.find((candidate) => (candidate.ref as { id?: string }).id === id);
        expect(item, `${source.sourceId} offers its shared choice`).toBeDefined();
        expect(item!.count, `${source.sourceId} records under its shared choice`).toBe(
          source.share.leaves.length,
        );
      }
      // The same rows, with the content and the ingestion time they had: the
      // facts were attached to the stored records.
      expect(storedRecords()).toBe(before.stored);
    }, 120_000);
  });
}
