// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Filters on an account whose records were written before its source wrote
 * what the filter matches on, through a real collector, a spawned gateway
 * and agents connected over MCP.
 *
 * The universe's accounts are first read by hosts that send no source
 * version, so every record is stored at version 0, below the field's
 * minimum. The suite then asserts, per account:
 *
 *  - the editor says the host must be updated; once it is, and an ordinary
 *    sync has run, the field reads `needs-resync` with the source's own
 *    resync cost, every record is counted too old, no filter on the field
 *    can be saved for Direct or Answer, and the review of a draft filter
 *    says it would leave nothing;
 *  - where the source can be made to miss records (`unreadable`), a resync
 *    in place that cannot reach them makes the field `ready`; a saved filter
 *    then hides exactly the records still too old, the editor counts them,
 *    the review agrees with what Direct and Answer read, and the rest are
 *    filtered as they should be;
 *  - a resync in place that reads everything makes the field `ready` (the
 *    editor may show `resyncing` while it runs), every record carries the
 *    new version, each filter leaves exactly its records for Direct and
 *    Answer, and no record changed id at any point.
 *
 * Every read is started by the suite: the harness's collectors sync only
 * when asked, so a resync's own command to the collector is stood in for by
 * the sync the suite then starts, from the cursor the resync emptied.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  answerReadable,
  closeAgents,
  connectAgent,
  declaredVersion,
  editorField,
  expectDirectReads,
  fieldCounts,
  grantRule,
  identities,
  ownerPortal,
  pickEntry,
  previewFilter,
  readRecords,
  refusedSave,
  resyncAndWatch,
  resyncCost,
  saveFilters,
  sourceFilter,
  versionsOf,
  type ObservedState,
  type RecordSet,
} from "./filter-e2e-reads.js";
import { startScopeScriptedAgent, type ScopeScriptedAgent } from "./scope-scripted-agent.js";
import { SyntheticE2EHarness, type HarnessDevice } from "./synth-harness.js";
import type { AuthorizedMcpClient, PortalSession } from "./mcp-oauth-helper.js";
import type { FilterRef } from "@omnesis/types";

/** The word every record of the filter universes carries. */
const QUERY = "zqfilter";

/** An entry named outright, or the picker's entry whose label ends with a path (on a device). */
export type UpgradeChoice =
  | { id: string }
  | { labelEndsWith: string; device?: (harness: SyntheticE2EHarness) => HarnessDevice };

export interface UpgradeSource {
  sourceId: string;
  /** The filterable field the filters use. */
  field: string;
  /** Names each stored record of the account; see `readRecords`. */
  key: Parameters<typeof readRecords>[2];
  /** Every record the account holds, by key. */
  records: string[];
  /** A share-only filter and the records it leaves once every record is new enough. */
  share: { choice: UpgradeChoice; leaves: string[] };
  /** A hide filter and the records it leaves once every record is new enough. */
  hide: { choice: UpgradeChoice; leaves: string[] };
  /** Makes the account's host write records as the build before the field did, or not. */
  oldBuild?: (harness: SyntheticE2EHarness, old: boolean) => Promise<void>;
  /**
   * Makes the next reads of the account miss some of its records, as items
   * the source can no longer supply would be, or stops doing so. Neither
   * starts a sync.
   */
  unreadable?: (missing: boolean) => void;
  /** Whether Answer is checked too; off for an account with several streams. */
  answer: boolean;
}

export interface FilterUpgrade {
  universe: string;
  sources: UpgradeSource[];
}

const without = (keys: readonly string[], gone: ReadonlySet<string>) =>
  keys.filter((key) => !gone.has(key));

/** The editor's states seen during a resync: from `needs-resync` or `ready`, ending `ready`. */
function expectResyncedToReady(states: ObservedState[], from: "needs-resync" | "ready"): void {
  expect(states[0]?.status, JSON.stringify(states)).toBe(from);
  expect(states.at(-1)?.status, JSON.stringify(states)).toBe("ready");
  for (const state of states)
    expect(["needs-resync", "resyncing", "ready"], JSON.stringify(states)).toContain(state.status);
}

export function describeFilterUpgrade({ universe, sources }: FilterUpgrade): void {
  describe(`filters over records written before their field: ${universe}`, () => {
    let harness: SyntheticE2EHarness;
    let model: ScopeScriptedAgent;
    let direct: AuthorizedMcpClient;
    let answer: AuthorizedMcpClient;
    let portal: PortalSession;
    const records = new Map<string, RecordSet>();
    const original = new Map<string, Record<string, string>>();
    const versions = new Map<string, number>();
    /** Records each account's first resync could not reach. */
    const missed = new Map<string, Set<string>>();

    const of = (source: UpgradeSource) => records.get(source.sourceId)!;
    const sourceType = (source: UpgradeSource) =>
      source.sourceId.slice(0, source.sourceId.indexOf(":"));

    async function refOf(source: UpgradeSource, choice: UpgradeChoice): Promise<FilterRef> {
      if ("id" in choice) return { capability: "tree", field: source.field, id: choice.id };
      return (
        await pickEntry(
          harness,
          source.sourceId,
          source.field,
          choice.labelEndsWith,
          choice.device?.(harness),
        )
      ).ref;
    }

    /**
     * An entry on the field as the owner would draft one while the picker
     * cannot be used yet: the entry named outright, or for a per-device
     * field the whole device that hosts the account.
     */
    function draftRef(source: UpgradeSource): FilterRef {
      const choice = source.share.choice;
      if ("id" in choice) return { capability: "tree", field: source.field, id: choice.id };
      const device = choice.device?.(harness) ?? harness.deviceForSource(source.sourceId);
      return { capability: "tree", field: source.field, id: "", device: device.deviceId };
    }

    async function filtersOf(source: UpgradeSource) {
      return {
        share: sourceFilter(source.sourceId, "share", [await refOf(source, source.share.choice)]),
        hide: sourceFilter(source.sourceId, "hide", [await refOf(source, source.hide.choice)]),
      };
    }

    /**
     * Save each filter for Direct and Answer and compare what the agents read
     * with what the editor's review of the filter says.
     */
    async function expectFiltered(source: UpgradeSource, gone: ReadonlySet<string>) {
      const filters = await filtersOf(source);
      for (const action of ["share", "hide"] as const) {
        const leaves = without(source[action].leaves, gone);
        await saveFilters(harness, direct, { direct: [filters[action]] });
        await expectDirectReads(harness, direct, of(source), leaves, QUERY);
        const review = await previewFilter(harness, portal, filters[action]);
        expect(review, `${source.sourceId} ${action} review`).toMatchObject({
          total: source.records.length,
          visible: leaves.length,
          hidden: source.records.length - leaves.length,
          tooOld: gone.size,
        });
        if (!source.answer) continue;
        await saveFilters(harness, answer, { answer: [filters[action]] });
        expect(await answerReadable(model, answer, of(source), QUERY), `Answer ${action}`).toEqual(
          [...leaves].sort(),
        );
      }
    }

    beforeAll(async () => {
      model = await startScopeScriptedAgent();
      harness = new SyntheticE2EHarness({
        gatewayMode: "synthetic-experimental",
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
      for (const source of sources) {
        versions.set(source.sourceId, declaredVersion(harness, source.sourceId));
        // A build that predates versions sends none: its records are stored at 0.
        harness.setSourceVersion(source.sourceId, undefined);
        await source.oldBuild?.(harness, true);
      }
      // Twice, as a collector that has been running for a while: the second
      // sync finds nothing new and leaves each cursor at rest.
      for (let pass = 0; pass < 2; pass++)
        for (const source of sources) await harness.triggerSyncAndWait(source.sourceId, 120_000);
      for (const source of sources) {
        const read = readRecords(harness, [source.sourceId], source.key);
        records.set(source.sourceId, read);
        original.set(source.sourceId, identities(read));
      }
      await harness.reindexMissing();
      await harness.refreshSearchSnapshot();
      direct = await connectAgent(harness, "Invented filtered reader", [grantRule("direct")]);
      answer = await connectAgent(harness, "Invented filtered asker", [grantRule("answer")]);
      portal = await ownerPortal(harness);
    }, 300_000);

    afterAll(async () => {
      await closeAgents([direct, answer]);
      await harness?.destroy();
      await model?.close();
    }, 30_000);

    test("every record was written at version 0, below the field's minimum", () => {
      for (const source of sources) {
        expect([...of(source).keys()].sort(), source.sourceId).toEqual([...source.records].sort());
        expect(new Set(versionsOf(harness, of(source)).values()), source.sourceId).toEqual(
          new Set([0]),
        );
        expect(versions.get(source.sourceId), source.sourceId).toBeGreaterThan(0);
      }
    });

    test("once the host is updated the field needs a resync: nothing can be saved, and every record is counted too old", async () => {
      for (const source of sources) {
        const behind = await editorField(harness, source.sourceId, source.field);
        expect(behind.state.status, source.sourceId).toBe("collector-behind");
        expect("text" in behind.state && behind.state.text).toMatch(/^Update Omnesis on /);

        // The host is updated; an ordinary sync finds nothing changed.
        harness.setSourceVersion(source.sourceId, versions.get(source.sourceId));
        await source.oldBuild?.(harness, false);
        await harness.triggerSyncAndWait(source.sourceId, 120_000);
        expect(new Set(versionsOf(harness, of(source)).values()), source.sourceId).toEqual(
          new Set([0]),
        );

        const { state } = await editorField(harness, source.sourceId, source.field);
        const cost = resyncCost(harness, sourceType(source));
        expect(cost, `${source.sourceId} declares what a resync costs`).toBeTruthy();
        expect(state, source.sourceId).toMatchObject({ status: "needs-resync", cost });
        const text = (state as { text: string }).text;
        expect(text).toMatch(/^[A-Z][a-z ]+ filters need .+ to be resynced\. /);
        expect(text.endsWith(cost!)).toBe(true);
        expect(await fieldCounts(harness, source.sourceId, source.field)).toMatchObject({
          tooOld: source.records.length,
          tooOldText: `${source.records.length} older items could not be resynced and stay hidden from agents using this filter.`,
        });

        const draft = draftRef(source);
        const filters = {
          share: sourceFilter(source.sourceId, "share", [draft]),
          hide: sourceFilter(source.sourceId, "hide", [draft]),
        };
        for (const filter of [filters.share, filters.hide]) {
          for (const [agent, capability] of [
            [direct, "direct"],
            [answer, "answer"],
          ] as const) {
            expect(
              await refusedSave(harness, agent, { [capability]: [filter] }),
              `${source.sourceId} ${capability}`,
            ).toEqual({ status: 409, error: "invalid-selection", message: text });
          }
          // What such a filter would leave: nothing, every record being too old.
          expect(await previewFilter(harness, portal, filter)).toMatchObject({
            total: source.records.length,
            visible: 0,
            tooOld: source.records.length,
          });
        }
        // An agent with no filter reads the account as before.
        await saveFilters(harness, direct, {});
        await expectDirectReads(harness, direct, of(source), source.records, QUERY);
      }
    }, 600_000);

    test("a resync in place that cannot reach every record makes the field ready; the records it missed stay hidden and are counted", async ({
      annotate,
    }) => {
      for (const source of sources) {
        if (!source.unreadable) continue;
        source.unreadable(true);
        let states: ObservedState[];
        try {
          states = await resyncAndWatch(harness, source.sourceId, source.field, { pageSize: 2 });
        } finally {
          source.unreadable(false);
        }
        await annotate(`${source.sourceId}: ${JSON.stringify(states)}`, "editor states");
        expectResyncedToReady(states, "needs-resync");
        expect(states.map((state) => state.status)).toContain("resyncing");

        const stamped = versionsOf(harness, of(source));
        const gone = new Set([...stamped].filter(([, v]) => v === 0).map(([key]) => key));
        expect(gone.size, `${source.sourceId}: some records out of reach`).toBeGreaterThan(0);
        expect(gone.size).toBeLessThan(source.records.length);
        for (const [key, version] of stamped)
          if (!gone.has(key)) expect(version, key).toBe(versions.get(source.sourceId));
        expect(identities(of(source))).toEqual(original.get(source.sourceId));
        expect(identities(readRecords(harness, [source.sourceId], source.key))).toEqual(
          original.get(source.sourceId),
        );
        missed.set(source.sourceId, gone);

        expect(await fieldCounts(harness, source.sourceId, source.field)).toMatchObject({
          tooOld: gone.size,
          tooOldText: `${gone.size} older ${gone.size === 1 ? "item" : "items"} could not be resynced and ${gone.size === 1 ? "stays" : "stay"} hidden from agents using this filter.`,
        });
        await expectFiltered(source, gone);
      }
    }, 900_000);

    test("a resync in place that reads everything leaves every record at the new version, each filter leaving exactly its records, with no record changing id", async ({
      annotate,
    }) => {
      for (const source of sources) {
        const states = await resyncAndWatch(harness, source.sourceId, source.field, {
          pageSize: 2,
        });
        await annotate(`${source.sourceId}: ${JSON.stringify(states)}`, "editor states");
        expectResyncedToReady(states, missed.has(source.sourceId) ? "ready" : "needs-resync");

        expect(new Set(versionsOf(harness, of(source)).values()), source.sourceId).toEqual(
          new Set([versions.get(source.sourceId)]),
        );
        expect(identities(readRecords(harness, [source.sourceId], source.key))).toEqual(
          original.get(source.sourceId),
        );
        expect(await fieldCounts(harness, source.sourceId, source.field)).toMatchObject({
          tooOld: 0,
          tooOldText: null,
        });
        await expectFiltered(source, new Set());
        // The picker counts what its entry would share.
        if (!("id" in source.share.choice)) {
          const entry = await pickEntry(
            harness,
            source.sourceId,
            source.field,
            source.share.choice.labelEndsWith,
            source.share.choice.device?.(harness),
          );
          expect(entry.count, `${source.sourceId} picker count`).toBe(source.share.leaves.length);
        }
      }
    }, 900_000);
  });
}
