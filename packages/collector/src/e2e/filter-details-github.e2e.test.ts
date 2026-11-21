// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The repository on every GitHub record, and the list of owners and
 * repositories, from the sources to the gateway's stores, through the real
 * collector sync loop and a spawned gateway.
 *
 * The `repository-filters` universe seeds one account whose listing holds two
 * repositories of one organization, one of another organization, two personal
 * repositories of which one is a fork of a work repository, and one GitHub
 * gives no id for. Both GitHub sources read it: issues, pull requests and
 * discussions on one, commits on the other.
 *
 * The account is first read the way a build that predates the detail read
 * it: its pages carry version 1 and what it stored holds no repository id.
 * The test then asserts that:
 *   - an ordinary sync leaves those records as they are;
 *   - a sync from an empty cursor, on the current build, gives every record
 *     its repository's id and version 2 while keeping the record itself;
 *   - a record carries the id of its repository only, never a name or an
 *     owner, and a record whose repository has no id carries nothing;
 *   - the stored list has the owners as roots and each repository under the
 *     owner that holds it, a fork under whoever holds the fork, shared by
 *     every device;
 *   - the gateway reads the declared field as one it can filter on;
 *   - a rename and a transfer arrive through an ordinary sync that sends no
 *     record, and the records of the transferred repository now sit under its
 *     new owner through the list alone;
 *   - a repository that leaves the listing leaves the list on the next sync,
 *     and its records stay stored, naming a repository no longer listed.
 *
 * The account is reached through a dynamic import: a static one would load
 * the synth package, and cache the active universe, before the harness sets
 * `OMNESIS_SYNTH_UNIVERSE`.
 */

import "./synth-env.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import Database from "better-sqlite3";
import { filterFieldsFor } from "@omnesis/gateway/src/access/filter-fields.js";
import { SyntheticE2EHarness } from "./synth-harness.js";
import type { GithubAccount } from "@omnesis/provider-github-synth";

type Db = Parameters<typeof filterFieldsFor>[0];

const THREADS = "github:maya-reeves";
const COMMITS = "github-commits:maya-reeves";
const SOURCES = [THREADS, COMMITS] as const;
const FIELD = "extra.repositoryIds";

/** GitHub's id of each repository of the universe, by name; `null` where it gives none. */
const REPOSITORY_IDS: Record<string, string | null> = {
  "northstar-labs/atlas-api": "4101",
  "northstar-labs/atlas-api-docs": "4102",
  "northstar-labs-archive/atlas-api": "4201",
  "maya-reeves/garden-notes": "5201",
  "maya-reeves/atlas-api": "5202",
  "maya-reeves/sketches": null,
};

/** The list as the universe starts: `id → [label, parent]`. */
const INITIAL_LIST: Record<string, [string, string | null]> = {
  "owner:9001": ["northstar-labs", null],
  "owner:9002": ["northstar-labs-archive", null],
  "owner:7001": ["maya-reeves", null],
  "4101": ["northstar-labs/atlas-api", "owner:9001"],
  "4102": ["northstar-labs/atlas-api-docs", "owner:9001"],
  "4201": ["northstar-labs-archive/atlas-api", "owner:9002"],
  "5201": ["maya-reeves/garden-notes", "owner:7001"],
  // The fork of a work repository sits under the person who holds the fork.
  "5202": ["maya-reeves/atlas-api", "owner:7001"],
};

interface StoredRecord {
  id: string;
  external_id: string;
  updated_at: string;
  source_version: number;
  repo: string;
  /** JSON type of the detail: `array` when written, `null` when absent. */
  detail_type: string | null;
  detail: string | null;
  metadata: string;
}

async function account(sourceId: string): Promise<GithubAccount> {
  const mod = await import("@omnesis/provider-github-synth");
  const live = mod.getGithubAccount(sourceId);
  if (!live) throw new Error(`no GitHub account registered for ${sourceId}`);
  return live;
}

describe("filter details: GitHub records carry their repository, and the list says who holds it", () => {
  let harness: SyntheticE2EHarness;
  let db: InstanceType<typeof Database>;
  /** The document count each completed sync reported, per source, in order. */
  const synced: Record<string, number[]> = { [THREADS]: [], [COMMITS]: [] };
  const failures: string[] = [];

  const records = (sourceId: string): StoredRecord[] =>
    db
      .prepare(
        `SELECT id, external_id, updated_at, source_version, metadata,
                json_extract(metadata, '$.extra.repo') AS repo,
                json_type(metadata, '$.extra.repositoryIds') AS detail_type,
                json_extract(metadata, '$.extra.repositoryIds') AS detail
           FROM documents WHERE source_id = ? ORDER BY external_id`,
      )
      .all(sourceId) as StoredRecord[];

  /** What a sync that sends no record must leave exactly as it was. */
  const untouched = (sourceId: string) =>
    records(sourceId).map(({ id, external_id, updated_at, source_version, metadata }) => ({
      id,
      external_id,
      updated_at,
      source_version,
      metadata,
    }));

  const list = (sourceId: string) =>
    db
      .prepare(
        `SELECT device_id, generation, item_count FROM source_filter_lists
          WHERE source_id = ? AND field = ?`,
      )
      .get(sourceId, FIELD) as
      { device_id: string; generation: number; item_count: number } | undefined;

  const items = (sourceId: string): Record<string, [string, string | null]> =>
    Object.fromEntries(
      (
        db
          .prepare(
            `SELECT i.item_id, i.label, i.parent_id
               FROM source_filter_lists l
               JOIN source_filter_items i
                 ON i.source_id = l.source_id AND i.field = l.field
                AND i.device_id = l.device_id AND i.generation = l.generation
              WHERE l.source_id = ? AND l.field = ?`,
          )
          .all(sourceId, FIELD) as Array<{
          item_id: string;
          label: string;
          parent_id: string | null;
        }>
      ).map((row) => [row.item_id, [row.label, row.parent_id]]),
    );

  const sync = (sourceId: string) => harness.triggerSyncAndWait(sourceId, 60_000);
  const syncBoth = async () => {
    for (const sourceId of SOURCES) await sync(sourceId);
  };

  /** Send the source's host back to an empty cursor, keeping every stored record. */
  async function resetCursor(sourceId: string): Promise<void> {
    const headers = {
      Authorization: `Bearer ${harness.deviceForSource(sourceId).token}`,
      "Content-Type": "application/json",
    };
    const path = `${harness.gatewayUrl}/sync-state/${encodeURIComponent(sourceId)}`;
    const state = (await (await fetch(path, { headers })).json()) as { wipeEpoch?: number };
    const response = await fetch(path, {
      method: "POST",
      headers,
      body: JSON.stringify({ cursor: {}, writeEpoch: state.wipeEpoch }),
    });
    expect(await response.json()).toEqual({ ok: true });
  }

  beforeAll(async () => {
    harness = new SyntheticE2EHarness({ gatewayMode: "stable", universe: "repository-filters" });
    await harness.start();
    harness.onStatusChange((change) => {
      const sourceId = String(change.sourceId);
      if (!(sourceId in synced)) return;
      if (change.event === "sync.completed") {
        synced[sourceId]!.push(change.status.lastSyncStats?.documents ?? -1);
      }
      if (change.event === "sync.error") failures.push(change.status.lastError ?? "unknown error");
    });
    db = new Database(harness.getDbPath(), { readonly: true });

    // The account as a build that predates the detail read it: pages at
    // version 1, and no repository id in what was stored.
    for (const sourceId of SOURCES) harness.setSourceVersion(sourceId, 1);
    await syncBoth();
    const writable = new Database(harness.getDbPath());
    try {
      writable.pragma("busy_timeout = 10000");
      writable
        .prepare(
          `UPDATE documents SET metadata = json_remove(metadata, '$.extra.repositoryIds')
            WHERE source_id IN (?, ?)`,
        )
        .run(THREADS, COMMITS);
    } finally {
      writable.close();
    }
  }, 240_000);

  afterAll(async () => {
    db?.close();
    await harness?.destroy();
  }, 15_000);

  test("records an older build wrote hold version 1 and no repository", () => {
    expect(failures).toEqual([]);
    expect(synced).toEqual({ [THREADS]: [8], [COMMITS]: [6] });
    for (const sourceId of SOURCES) {
      const stored = records(sourceId);
      expect(stored).toHaveLength(sourceId === THREADS ? 8 : 6);
      for (const record of stored) {
        expect(record.source_version, record.external_id).toBe(1);
        expect(record.detail_type, record.external_id).toBeNull();
      }
    }
  });

  test("an ordinary sync leaves them as they are", async () => {
    const before = Object.fromEntries(SOURCES.map((id) => [id, untouched(id)]));
    await syncBoth();
    expect(failures).toEqual([]);
    for (const sourceId of SOURCES) {
      expect(synced[sourceId]!.at(-1)).toBe(0);
      expect(untouched(sourceId)).toEqual(before[sourceId]);
    }
  });

  test("a sync from an empty cursor gives every record its repository and version 2", async () => {
    const before = Object.fromEntries(SOURCES.map((id) => [id, records(id)]));

    for (const sourceId of SOURCES) {
      harness.setSourceVersion(sourceId, 2);
      await resetCursor(sourceId);
    }
    await syncBoth();

    expect(failures).toEqual([]);
    for (const sourceId of SOURCES) {
      const stored = records(sourceId);
      // Every record was sent again, and each landed on the record it already was.
      expect(synced[sourceId]!.at(-1)).toBe(stored.length);
      expect(stored.map((r) => [r.id, r.external_id])).toEqual(
        before[sourceId]!.map((r) => [r.id, r.external_id]),
      );
      const kinds = new Set<string>();
      for (const record of stored) {
        expect(record.source_version, record.external_id).toBe(2);
        const repositoryId = REPOSITORY_IDS[record.repo];
        expect(repositoryId, record.repo).not.toBeUndefined();
        if (repositoryId === null) {
          // GitHub gave no id: nothing is written, which is not an empty list.
          expect(record.detail_type, record.external_id).toBeNull();
        } else {
          expect(record.detail_type, record.external_id).toBe("array");
          expect(JSON.parse(record.detail!), record.external_id).toEqual([repositoryId]);
        }
        const extra = (JSON.parse(record.metadata) as { extra: Record<string, unknown> }).extra;
        // The repository only; the owner above it is the list's to say.
        expect(Object.keys(extra).filter((key) => /owner/i.test(key))).toEqual([]);
        kinds.add(String(extra.kind));
      }
      // Every kind of record the two sources write was covered.
      expect([...kinds].sort()).toEqual(
        sourceId === THREADS ? ["discussion", "issue", "pull-request"] : ["commit"],
      );
    }
    // The fork is filed under its own id, not under the repository it was forked from.
    const fork = records(THREADS).find((r) => r.repo === "maya-reeves/atlas-api")!;
    expect(JSON.parse(fork.detail!)).toEqual(["5202"]);
  });

  test("the stored list has owners as roots and each repository under its holder", () => {
    for (const sourceId of SOURCES) {
      // One list for every device of the source: the ids mean the same everywhere.
      expect(list(sourceId)).toMatchObject({ device_id: "", item_count: 8 });
      // The repository with no id is not in it.
      expect(items(sourceId)).toEqual(INITIAL_LIST);
    }
  });

  test("the gateway reads the repository field as one it can filter on, and the resync cost", () => {
    for (const sourceType of ["github", "github-commits"]) {
      const declared = filterFieldsFor(db as unknown as Db, sourceType);
      expect(declared).toMatchObject({ state: "declared", outputRevision: 2, person: null });
      if (declared.state !== "declared") throw new Error("unreachable");
      expect(declared.fields).toEqual([
        {
          path: FIELD,
          state: "ready",
          type: "string-array",
          filter: {
            capability: "tree",
            minVersion: 2,
            scope: "global",
            noun: { one: "repository", many: "repositories" },
            levels: [
              { one: "owner", many: "owners" },
              { one: "repository", many: "repositories" },
            ],
            picker: "tree",
            inside: { one: "repository", many: "repositories" },
          },
        },
      ]);
      const meta = db
        .prepare("SELECT resync_cost FROM source_family_meta WHERE source_type = ?")
        .get(sourceType) as { resync_cost: string | null } | undefined;
      expect(meta?.resync_cost, sourceType).toMatch(/GitHub/);
    }
  });

  test("a rename and a transfer arrive through an ordinary sync that sends no record", async () => {
    const before = Object.fromEntries(SOURCES.map((id) => [id, untouched(id)]));
    const generations = Object.fromEntries(SOURCES.map((id) => [id, list(id)!.generation]));

    for (const sourceId of SOURCES) {
      const live = await account(sourceId);
      live.rename(4102, "atlas-handbook");
      // The personal fork is handed to the organization: same id, new owner.
      live.transfer(5202, { id: 9001, login: "northstar-labs" });
    }
    await syncBoth();

    expect(failures).toEqual([]);
    for (const sourceId of SOURCES) {
      expect(items(sourceId)).toEqual({
        ...INITIAL_LIST,
        "4102": ["northstar-labs/atlas-handbook", "owner:9001"],
        "5202": ["northstar-labs/atlas-api", "owner:9001"],
      });
      expect(list(sourceId)!.generation).toBe(generations[sourceId]! + 1);
      expect(synced[sourceId]!.at(-1)).toBe(0);
      expect(untouched(sourceId)).toEqual(before[sourceId]);
    }
    // The records of the transferred repository still say "5202", and the
    // list alone now places them under the organization.
    const moved = records(THREADS).filter((r) => r.detail === '["5202"]');
    expect(moved.map((r) => r.repo)).toEqual(["maya-reeves/atlas-api"]);
    expect(items(THREADS)["5202"]![1]).toBe("owner:9001");
  });

  test("a repository that leaves the listing leaves the list, and its records stay", async () => {
    const before = Object.fromEntries(SOURCES.map((id) => [id, untouched(id)]));

    for (const sourceId of SOURCES) (await account(sourceId)).remove(4201);
    await syncBoth();

    expect(failures).toEqual([]);
    for (const sourceId of SOURCES) {
      const listed = items(sourceId);
      expect(Object.keys(listed)).not.toContain("4201");
      // It was the only repository of its owner, so the owner goes with it.
      expect(Object.keys(listed)).not.toContain("owner:9002");
      expect(list(sourceId)).toMatchObject({ item_count: 6 });
      expect(synced[sourceId]!.at(-1)).toBe(0);
      expect(untouched(sourceId)).toEqual(before[sourceId]);
      // The leftover records name a repository the list no longer holds.
      const leftover = records(sourceId).filter((r) => r.detail === '["4201"]');
      expect(leftover.length).toBeGreaterThan(0);
    }
  });

  test("a listing that fails keeps the stored list, and the sync completes", async () => {
    const stored = items(THREADS);
    const completed = synced[THREADS]!.length;
    const live = await account(THREADS);

    live.rename(4101, "atlas-core");
    live.failListings(true);
    await sync(THREADS);
    expect(failures).toEqual([]);
    expect(synced[THREADS]).toHaveLength(completed + 1);
    expect(items(THREADS)).toEqual(stored);

    live.failListings(false);
    await sync(THREADS);
    expect(items(THREADS)["4101"]).toEqual(["northstar-labs/atlas-core", "owner:9001"]);
  });
});
