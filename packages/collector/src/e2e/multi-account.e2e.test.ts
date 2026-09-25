// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Multi-account (multi-instance) source E2E.
 *
 * Several accounts of one source type — two mailboxes, two workspaces, two
 * phone numbers — are the normal case, not an edge case. Everything downstream
 * keys off `<sourceType>:<accountId>`, so the invariant under test is that one
 * account's lifecycle never disturbs its siblings: adding a second account
 * doesn't disturb the first, and removing or pausing one leaves the other
 * registered, enabled and owned by the same collector.
 *
 * Runs against a real gateway subprocess with paired pseudo-collectors (see
 * `multi-collector-harness.ts`), so the assertions cover the real HTTP routes,
 * the real WS dispatch and the real `sources` rows.
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import {
  MultiCollectorHarness,
  waitForCondition,
  type PairedCollector,
} from "./multi-collector-harness.js";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

/** A multi-account mail-ish source and a single-instance local one. */
const MULTI_TYPE = "synth-mail";
const SINGLE_TYPE = "synth-local-notes";
const DISCOVERABLE_SINGLE_TYPE = "synth-host-account";

function descriptorsFor(types: string[]): Array<Record<string, unknown>> {
  return types.map((type) => ({
    id: type,
    name: type,
    description: `synthetic ${type}`,
    provider: { id: `${type}-provider`, name: `${type}-provider` },
    params: [],
    hasAuthFlow: type === MULTI_TYPE,
    hasDiscover: false,
    authType: type === MULTI_TYPE ? "oauth" : "local",
    pushBased: false,
    singleInstance: type === SINGLE_TYPE,
  }));
}

interface SourceRow {
  id: string;
  type: string;
  accountId: string;
  deviceId: string;
  enabled: boolean;
  members?: string[];
}

async function listSources(h: MultiCollectorHarness): Promise<SourceRow[]> {
  const res = await h.json<{ items: SourceRow[] }>("/admin/sources");
  return res.items ?? [];
}

async function addAccount(
  h: MultiCollectorHarness,
  deviceId: string,
  descriptorId: string,
  accountId: string,
): Promise<string[]> {
  const res = await h.json<{ sourceIds: string[] }>("/admin/sources/add", {
    method: "POST",
    body: JSON.stringify({ deviceId, descriptorId, accountIds: [accountId] }),
  });
  return res.sourceIds ?? [];
}

/** WS commands of a given type this collector has been sent. */
function commandsOfType(c: PairedCollector, type: string): Array<{ payload: unknown }> {
  return c.receivedCommands.filter((cmd) => cmd.type === type);
}

describe("multi-account sources — one collector, two accounts", () => {
  let harness: MultiCollectorHarness;
  let collector: PairedCollector;

  beforeAll(async () => {
    harness = new MultiCollectorHarness();
    await harness.start();
    collector = await harness.addCollector({
      name: "mac-one",
      hostableSourceTypes: [MULTI_TYPE, SINGLE_TYPE],
      descriptors: descriptorsFor([MULTI_TYPE, SINGLE_TYPE]),
    });
  }, 120_000);

  afterAll(async () => {
    await harness?.destroy();
  }, 15_000);

  // Each test owns its own pair of accounts. Sharing one pair made the suite a
  // chain — a `-t` filter, `.only`, shuffle or a bisect all broke it, and a
  // failure in the first test cascaded into misleading failures in the rest.
  let seq = 0;
  function accountPair(): [string, string] {
    seq += 1;
    return [`maya.reeves+${seq}@example.com`, `jamie.lopez+${seq}@example.org`];
  }

  async function addPair(): Promise<[string, string]> {
    const [a, b] = accountPair();
    await addAccount(harness, collector.deviceId, MULTI_TYPE, a);
    await addAccount(harness, collector.deviceId, MULTI_TYPE, b);
    return [a, b];
  }

  test("adding two accounts of one type creates two independent rows", async () => {
    const [a, b] = accountPair();
    expect(await addAccount(harness, collector.deviceId, MULTI_TYPE, a)).toEqual([
      `${MULTI_TYPE}:${a}`,
    ]);
    expect(await addAccount(harness, collector.deviceId, MULTI_TYPE, b)).toEqual([
      `${MULTI_TYPE}:${b}`,
    ]);

    const rows = await listSources(harness);
    for (const id of [`${MULTI_TYPE}:${a}`, `${MULTI_TYPE}:${b}`]) {
      const row = rows.find((r) => r.id === id);
      expect(row, id).toBeDefined();
      expect(row?.deviceId).toBe(collector.deviceId);
      expect(row?.enabled).toBe(true);
    }
  });

  test("pausing one account leaves the sibling enabled", async () => {
    const [a, b] = await addPair();
    collector.receivedCommands.length = 0;

    await harness.json(`/admin/sources/${encodeURIComponent(`${MULTI_TYPE}:${a}`)}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: false }),
    });

    const rows = await listSources(harness);
    expect(rows.find((r) => r.id === `${MULTI_TYPE}:${a}`)?.enabled).toBe(false);
    expect(rows.find((r) => r.id === `${MULTI_TYPE}:${b}`)?.enabled).toBe(true);

    // `source.updated` is dispatched fire-and-forget, so wait for the paused
    // account's command to land before asserting the sibling's is absent —
    // otherwise the negative passes simply by reading too early.
    const updates = () =>
      commandsOfType(collector, "source.updated").map(
        (c) => (c.payload as { source: { id: string; enabled: boolean } }).source,
      );
    await waitForCondition(
      () => updates().some((u) => u.id === `${MULTI_TYPE}:${a}` && !u.enabled),
      10_000,
      "source.updated for the paused account",
    );
    expect(updates().some((u) => u.id === `${MULTI_TYPE}:${b}`)).toBe(false);
  });

  test("removing one account leaves the sibling row untouched", async () => {
    const [a, b] = await addPair();
    collector.receivedCommands.length = 0;

    await harness.json(`/admin/sources/${encodeURIComponent(`${MULTI_TYPE}:${a}`)}`, {
      method: "DELETE",
    });

    const rows = await listSources(harness);
    expect(rows.find((r) => r.id === `${MULTI_TYPE}:${a}`)).toBeUndefined();
    const survivor = rows.find((r) => r.id === `${MULTI_TYPE}:${b}`);
    expect(survivor).toBeDefined();
    expect(survivor?.enabled).toBe(true);
    expect(survivor?.deviceId).toBe(collector.deviceId);

    // Exactly one teardown command, naming only the removed account — a
    // type-wide teardown is what takes a sibling down with it. `source.removed`
    // is awaited before the DELETE responds, so this needs no sync point.
    const removed = commandsOfType(collector, "source.removed").map(
      (c) => (c.payload as { sourceId: string }).sourceId,
    );
    expect(removed).toEqual([`${MULTI_TYPE}:${a}`]);
  });

  test("a removed account can be added back without disturbing the sibling", async () => {
    const [a, b] = await addPair();
    await harness.json(`/admin/sources/${encodeURIComponent(`${MULTI_TYPE}:${a}`)}`, {
      method: "DELETE",
    });

    // DELETE returns as soon as the tombstone is written; purging what the
    // source ingested continues behind it, and a re-add is refused with
    // SOURCE_REMOVAL_IN_PROGRESS until that sweep finishes. Honour the
    // contract the 409 states rather than racing it — how long the sweep
    // takes depends on how much there is to purge and on what else holds the
    // writer, so any fixed delay here would be a machine-speed assumption.
    let added: string[] = [];
    await waitForCondition(
      async () => {
        try {
          added = await addAccount(harness, collector.deviceId, MULTI_TYPE, a);
          return true;
        } catch (err) {
          const body = (err as { body?: { error?: string } }).body;
          if (body?.error?.includes("SOURCE_REMOVAL_IN_PROGRESS")) return false;
          throw err;
        }
      },
      30_000,
      "the removal sweep to finish so the account can be re-added",
    );
    expect(added).toEqual([`${MULTI_TYPE}:${a}`]);

    const rows = await listSources(harness);
    for (const id of [`${MULTI_TYPE}:${a}`, `${MULTI_TYPE}:${b}`]) {
      expect(rows.find((r) => r.id === id)?.enabled, id).toBe(true);
    }
  });

  test("the descriptor union reports single- vs multi-instance honestly", async () => {
    const res = await harness.json<{
      items: Array<{ id: string; singleInstance?: boolean }>;
    }>("/admin/source-descriptors");
    const multi = res.items.find((d) => d.id === MULTI_TYPE);
    const single = res.items.find((d) => d.id === SINGLE_TYPE);
    expect(multi?.singleInstance).toBe(false);
    expect(single?.singleInstance).toBe(true);
  });
});

describe("multi-account sources — collector connect", () => {
  let harness: MultiCollectorHarness;
  let macTwo: PairedCollector;

  beforeAll(async () => {
    harness = new MultiCollectorHarness();
    await harness.start();
    macTwo = await harness.addCollector({
      name: "mac-two",
      hostableSourceTypes: [MULTI_TYPE],
      descriptors: descriptorsFor([MULTI_TYPE]),
    });
  }, 120_000);

  afterAll(async () => {
    await harness?.destroy();
  }, 15_000);

  test("a collector with no sources still receives an (empty) snapshot on connect", async () => {
    // Nothing is registered yet, so both collectors are in the zero-source
    // state. The snapshot is how a collector learns it should be hosting
    // nothing — which is what makes it drop an instance whose source was
    // removed, or handed to another host, while it was offline.
    await waitForCondition(
      () => commandsOfType(macTwo, "sources.snapshot").length > 0,
      15_000,
      "empty sources.snapshot on connect",
    );
    const snapshot = commandsOfType(macTwo, "sources.snapshot")[0]!.payload as {
      sources: unknown[];
    };
    expect(snapshot.sources).toEqual([]);
  });
});

describe("single-instance sources — account identity is per host", () => {
  let harness: MultiCollectorHarness;
  let owner: PairedCollector;
  let freshHost: PairedCollector;
  let replicaHost: PairedCollector;

  const accountA = "maya.reeves@example.com";
  const accountB = "jamie.lopez@example.org";
  const descriptor = {
    id: DISCOVERABLE_SINGLE_TYPE,
    name: "Synthetic host account",
    description: "synthetic host-local account",
    provider: { id: "synth-host-provider", name: "Synthetic host provider" },
    params: [],
    hasAuthFlow: true,
    hasDiscover: true,
    authType: "oauth",
    pushBased: false,
    singleInstance: true,
    multiDeviceMode: "replicated",
  };

  beforeAll(async () => {
    harness = new MultiCollectorHarness();
    await harness.start();
    owner = await harness.addCollector({
      name: "account-owner",
      hostableSourceTypes: [DISCOVERABLE_SINGLE_TYPE],
      multiDeviceModes: { [DISCOVERABLE_SINGLE_TYPE]: "replicated" },
      syncLease: true,
      descriptors: [descriptor],
      discoveredAccountsByType: { [DISCOVERABLE_SINGLE_TYPE]: [accountA] },
    });
    freshHost = await harness.addCollector({
      name: "fresh-account-host",
      hostableSourceTypes: [DISCOVERABLE_SINGLE_TYPE],
      multiDeviceModes: { [DISCOVERABLE_SINGLE_TYPE]: "replicated" },
      syncLease: true,
      descriptors: [descriptor],
      discoveredAccountsByType: { [DISCOVERABLE_SINGLE_TYPE]: [accountB] },
    });
    replicaHost = await harness.addCollector({
      name: "same-account-host",
      hostableSourceTypes: [DISCOVERABLE_SINGLE_TYPE],
      multiDeviceModes: { [DISCOVERABLE_SINGLE_TYPE]: "replicated" },
      syncLease: true,
      descriptors: [descriptor],
      discoveredAccountsByType: { [DISCOVERABLE_SINGLE_TYPE]: [accountA] },
    });
    await addAccount(harness, owner.deviceId, DISCOVERABLE_SINGLE_TYPE, accountA);
  }, 120_000);

  afterAll(async () => {
    await harness?.destroy();
  }, 15_000);

  test("the CLI add flow creates a fresh host account and joins only an exact match", async () => {
    freshHost.receivedCommands.length = 0;
    const fresh = await harness.runCli(
      ["sources", "add", DISCOVERABLE_SINGLE_TYPE, "--device", freshHost.name, "--yes"],
      { timeoutMs: 30_000 },
    );
    expect(fresh.exitCode, fresh.stderr || fresh.stdout).toBe(0);
    expect(commandsOfType(freshHost, "source.discover").map((command) => command.payload)).toEqual([
      { descriptorId: DISCOVERABLE_SINGLE_TYPE },
    ]);
    expect(commandsOfType(freshHost, "source.add").map((command) => command.payload)).toEqual([
      {
        descriptorId: DISCOVERABLE_SINGLE_TYPE,
        accountIds: [accountB],
      },
    ]);

    let rows = await listSources(harness);
    const sourceA = rows.find((row) => row.id === `${DISCOVERABLE_SINGLE_TYPE}:${accountA}`);
    const sourceB = rows.find((row) => row.id === `${DISCOVERABLE_SINGLE_TYPE}:${accountB}`);
    expect(sourceA?.deviceId).toBe(owner.deviceId);
    expect(sourceA?.members).toEqual([owner.deviceId]);
    expect(sourceB?.deviceId).toBe(freshHost.deviceId);
    expect(sourceB?.members).toEqual([freshHost.deviceId]);

    replicaHost.receivedCommands.length = 0;
    const same = await harness.runCli(
      ["sources", "add", DISCOVERABLE_SINGLE_TYPE, "--device", replicaHost.name, "--yes"],
      { timeoutMs: 30_000 },
    );
    expect(same.exitCode, same.stderr || same.stdout).toBe(0);
    // The CLI discovers the account to choose add versus join; the gateway
    // independently repeats discovery as the authoritative join preflight.
    expect(
      commandsOfType(replicaHost, "source.discover").map((command) => command.payload),
    ).toEqual([
      { descriptorId: DISCOVERABLE_SINGLE_TYPE },
      { descriptorId: DISCOVERABLE_SINGLE_TYPE },
    ]);
    expect(commandsOfType(replicaHost, "source.add")).toEqual([]);

    rows = await listSources(harness);
    const joinedA = rows.find((row) => row.id === `${DISCOVERABLE_SINGLE_TYPE}:${accountA}`);
    const unchangedB = rows.find((row) => row.id === `${DISCOVERABLE_SINGLE_TYPE}:${accountB}`);
    expect(joinedA?.deviceId).toBe(owner.deviceId);
    expect(new Set(joinedA?.members)).toEqual(new Set([owner.deviceId, replicaHost.deviceId]));
    expect(unchangedB?.deviceId).toBe(freshHost.deviceId);
    expect(unchangedB?.members).toEqual([freshHost.deviceId]);
  });
});
