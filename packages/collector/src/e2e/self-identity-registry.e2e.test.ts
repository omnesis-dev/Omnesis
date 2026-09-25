// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The self-identity registry across a real thread boundary and across
 * several collectors.
 *
 * A source that represents the user declares, on its descriptor, how its
 * account id becomes the LID alias its normalizer stamps on the user's own
 * documents. The collector pushes those hooks to the gateway, and the
 * gateway's self-detection pass writes the resulting alias onto the self
 * person so the source's self-authored documents resolve to self instead of
 * minting a duplicate.
 *
 * Both halves live on different threads: the push lands on the HTTP thread,
 * the pass runs on the writer worker. A unit test that sets the registry and
 * runs the pass in one process cannot see a registry the worker never
 * received, so this suite boots a real gateway and drives the push the way a
 * collector does, then reads the alias table the way the engine does.
 *
 * Two collectors, because a real install has several and they do not all
 * run the same code: the registry has to survive a sibling that declares
 * fewer hooks than its peer.
 */

import SqliteDatabase from "better-sqlite3";
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { MultiCollectorHarness, type PairedCollector } from "./multi-collector-harness.js";

const GITHUB_HOOK = { sourceType: "github", aliasPrefix: "github", accountPattern: "^([^@]+)" };
const STRAVA_HOOK = {
  sourceType: "strava-activities",
  aliasPrefix: "strava-athlete",
  accountPattern: "^\\d+$",
};

describe("self-identity registry (real gateway, two collectors)", () => {
  let harness: MultiCollectorHarness;
  let current: PairedCollector;
  let older: PairedCollector;

  beforeAll(async () => {
    harness = new MultiCollectorHarness({
      // `config.self` bootstraps the canonical self person at boot; without
      // one there is nothing for the pass to attach an alias to.
      gatewayConfig: { self: { name: "Maya Reeves", emails: ["maya@example.com"] } },
    });
    await harness.start();
    // Two hosts of the same source types. `current` runs code whose
    // descriptors declare self-identity hooks; `older` models a collector on
    // a pin that predates them and so declares none.
    current = await harness.addCollector({
      name: "current",
      hostableSourceTypes: ["github", "strava-activities"],
    });
    older = await harness.addCollector({
      name: "older",
      hostableSourceTypes: ["github", "strava-activities"],
    });
  }, 60_000);

  afterAll(async () => {
    await harness.destroy();
  }, 15_000);

  /** The hooks a collector declares, pushed the way the real collector does. */
  async function pushHooks(
    collector: PairedCollector,
    entries: Array<{ sourceType: string; aliasPrefix: string; accountPattern?: string }>,
  ): Promise<void> {
    const res = await fetch(`${collector.gatewayBase}/admin/self-identity-sources`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${collector.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ entries }),
    });
    expect(res.status).toBe(200);
  }

  async function addSource(
    collector: PairedCollector,
    descriptorId: string,
    accountId: string,
  ): Promise<void> {
    await harness.json("/admin/sources/add", {
      method: "POST",
      body: JSON.stringify({ deviceId: collector.deviceId, descriptorId, accountIds: [accountId] }),
    });
  }

  /** The lid aliases on the self person, read the way the engine reads people. */
  function selfLids(): string[] {
    const db = new SqliteDatabase(harness.getDbPath(), { readonly: true });
    try {
      return db
        .prepare<[], { alias: string }>(
          `SELECT pa.alias FROM person_aliases pa
             JOIN people p ON p.id = pa.person_id
            WHERE p.is_self = 1 AND pa.alias_type = 'lid'
            ORDER BY pa.alias`,
        )
        .all()
        .map((r) => r.alias);
    } finally {
      db.close();
    }
  }

  test("a hook pushed by a collector puts the source's alias on self", async () => {
    await addSource(current, "github", "maya-reeves");
    expect(selfLids()).toEqual([]);

    await pushHooks(current, [GITHUB_HOOK]);

    // The push is the trigger: the pass runs on the writer thread with the
    // hooks the HTTP thread just received, and the alias is on self before
    // the source's first page of documents can arrive.
    expect(selfLids()).toEqual(["github:maya-reeves"]);
  });

  test("a source added on a sibling that declares no hooks still pairs through its peer's", async () => {
    // `older` hosts the same types but its code declares no hooks. Its push
    // is truthful about itself and must not be read as the whole truth.
    await pushHooks(older, []);

    // A source added on the older host still pairs through the hook its peer
    // declared: the pass after this push sees the merged registry.
    await addSource(older, "github", "jamie-lopez");
    await pushHooks(older, []);

    expect(selfLids()).toEqual(["github:jamie-lopez", "github:maya-reeves"]);
  });

  test("a later declaration for one type replaces that type and leaves the others in place", async () => {
    await addSource(current, "strava-activities", "43560449");
    // A declaration whose pattern rejects the account pairs nothing.
    await pushHooks(current, [{ ...STRAVA_HOOK, accountPattern: "^\\d{1,3}$" }]);
    expect(selfLids()).toEqual(["github:jamie-lopez", "github:maya-reeves"]);

    // Re-declaring Strava replaces only Strava: the alias now pairs, and the
    // GitHub hook a sibling relies on is still there for its next source.
    await pushHooks(current, [STRAVA_HOOK]);
    await addSource(older, "github", "david-lin");
    await pushHooks(older, []);

    expect(selfLids()).toEqual([
      "github:david-lin",
      "github:jamie-lopez",
      "github:maya-reeves",
      "strava-athlete:43560449",
    ]);
  });
});
