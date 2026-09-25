// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Membership under a non-exclusive mode, end to end over two real collector
 * connections. `notes-synth` is announced as `replicated` by both collectors;
 * `gmail-synth` carries no mode and stays exclusive, the contract
 * `source-ownership.e2e` pins.
 *
 * What a second collector's add means for a replicated source: it joins
 * (no 409), it receives the source in its member-scoped snapshot and every
 * `source.updated`, "Sync now" reaches every member, each member keeps its
 * own cursor row after adopting the shared one, and detaching leaves the
 * source — and the other member — intact.
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import {
  MultiCollectorHarness,
  waitForCondition,
  type PairedCollector,
} from "./multi-collector-harness.js";

const REPLICATED = "notes-synth:shared@example.com";
const EXCLUSIVE = "gmail-synth:shared@example.com";

interface SourceRow {
  id: string;
  deviceId: string;
  members: string[];
  multiDeviceMode: string;
}

async function bulkUpsert(
  c: PairedCollector,
  entries: Array<{ type: string; accountId: string }>,
): Promise<{ sources: Array<{ id: string; updated: boolean }>; errors: Array<{ error: string }> }> {
  const res = await fetch(`${c.gatewayBase}/devices/sources/bulk-upsert`, {
    method: "POST",
    headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ sources: entries.map((e) => ({ ...e, enabled: true })) }),
  });
  if (!res.ok) throw new Error(`bulk-upsert failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as {
    sources: Array<{ id: string; updated: boolean }>;
    errors: Array<{ error: string }>;
  };
}

async function asDevice<T>(c: PairedCollector, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${c.gatewayBase}${path}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      Authorization: `Bearer ${c.token}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) throw new Error(`${path} failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

describe("source membership across collectors", () => {
  let harness: MultiCollectorHarness;
  let macbook: PairedCollector;
  let linuxbox: PairedCollector;
  /** Hosts the same types but never joins anything. */
  let stranger: PairedCollector;

  const row = async (id: string): Promise<SourceRow | undefined> => {
    const { items } = await harness.json<{ items: SourceRow[] }>("/admin/sources");
    return items.find((s) => s.id === id);
  };

  beforeAll(async () => {
    harness = new MultiCollectorHarness();
    await harness.start();
    const modes = { "notes-synth": "replicated" as const };
    macbook = await harness.addCollector({
      name: "macbook",
      hostableSourceTypes: ["gmail-synth", "notes-synth"],
      multiDeviceModes: modes,
      syncLease: true,
    });
    linuxbox = await harness.addCollector({
      name: "linuxbox",
      hostableSourceTypes: ["gmail-synth", "notes-synth"],
      multiDeviceModes: modes,
      syncLease: true,
    });
    stranger = await harness.addCollector({
      name: "stranger",
      hostableSourceTypes: ["gmail-synth", "notes-synth"],
      multiDeviceModes: modes,
      syncLease: true,
    });
    const seeded = await bulkUpsert(macbook, [
      { type: "notes-synth", accountId: "shared@example.com" },
      { type: "gmail-synth", accountId: "shared@example.com" },
    ]);
    expect(seeded.errors).toEqual([]);
  }, 60_000);

  afterAll(async () => {
    await harness.destroy();
  }, 15_000);

  test("a second collector's add joins a replicated source and is refused for an exclusive one", async () => {
    const result = await bulkUpsert(linuxbox, [
      { type: "notes-synth", accountId: "shared@example.com" },
      { type: "gmail-synth", accountId: "shared@example.com" },
    ]);
    expect(result.sources).toEqual([{ id: REPLICATED, updated: false }]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.error).toContain("macbook");

    const replicated = await row(REPLICATED);
    expect(replicated?.deviceId).toBe(macbook.deviceId);
    expect(replicated?.members).toEqual([macbook.deviceId, linuxbox.deviceId]);
    expect(replicated?.multiDeviceMode).toBe("replicated");
    expect((await row(EXCLUSIVE))?.members).toEqual([macbook.deviceId]);
  });

  test("the members endpoint refuses an exclusive source and is idempotent for a replicated one", async () => {
    type GatewayFailure = { status?: number; body?: { code?: string; error?: string } };
    let failure: GatewayFailure | null = null;
    try {
      await harness.json(`/admin/sources/${encodeURIComponent(EXCLUSIVE)}/members`, {
        method: "POST",
        body: JSON.stringify({ deviceId: linuxbox.deviceId }),
      });
    } catch (err) {
      failure = err as GatewayFailure;
    }
    expect(failure?.status).toBe(409);
    expect(failure?.body?.code).toBe("SOURCE_ALREADY_HOSTED");

    const joined = await harness.json<{ members: string[] }>(
      `/admin/sources/${encodeURIComponent(REPLICATED)}/members`,
      { method: "POST", body: JSON.stringify({ deviceId: linuxbox.deviceId }) },
    );
    expect(joined.members).toEqual([macbook.deviceId, linuxbox.deviceId]);
  });

  test("an update reaches every member and Sync now triggers every member", async () => {
    macbook.receivedCommands.length = 0;
    linuxbox.receivedCommands.length = 0;
    await harness.json(`/admin/sources/${encodeURIComponent(REPLICATED)}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: true }),
    });
    for (const c of [macbook, linuxbox]) {
      await waitForCondition(
        () =>
          c.receivedCommands.some(
            (cmd) =>
              cmd.type === "source.updated" &&
              (cmd.payload as { source?: { id: string } }).source?.id === REPLICATED,
          ),
        5_000,
        `${c.name} received source.updated for the replicated source`,
      );
    }

    macbook.receivedCommands.length = 0;
    linuxbox.receivedCommands.length = 0;
    const sync = await harness.json<{
      ok: boolean;
      results: Array<{ deviceId: string; ok: boolean }>;
    }>(`/admin/sources/${encodeURIComponent(REPLICATED)}/sync`, { method: "POST" });
    expect(sync.ok).toBe(true);
    expect(sync.results.map((r) => r.deviceId).sort()).toEqual(
      [macbook.deviceId, linuxbox.deviceId].sort(),
    );
    for (const c of [macbook, linuxbox]) {
      expect(c.receivedCommands.some((cmd) => cmd.type === "source.sync")).toBe(true);
    }
    // The exclusive source is still triggered on its one host, and the
    // response names that host.
    const single = await harness.json<{ ok: boolean; result: { ok: boolean }; deviceId: string }>(
      `/admin/sources/${encodeURIComponent(EXCLUSIVE)}/sync`,
      { method: "POST" },
    );
    expect(single.ok).toBe(true);
    expect(single.deviceId).toBe(macbook.deviceId);
  });

  test("each member keeps its own cursor after adopting the shared one; non-members are refused", async () => {
    // The bookmark the source had before it was replicated lives on the
    // shared row — written here by the admin token, which has no device.
    await harness.json(`/sync-state/${encodeURIComponent(REPLICATED)}`, {
      method: "POST",
      body: JSON.stringify({ cursor: { page: 3 } }),
    });
    const adopted = await asDevice<{ cursor: { page: number } | null }>(
      linuxbox,
      `/sync-state/${encodeURIComponent(REPLICATED)}`,
    );
    expect(adopted.cursor).toEqual({ page: 3 });

    // linuxbox advances its own row; macbook still reads the shared bookmark.
    await asDevice(linuxbox, `/sync-state/${encodeURIComponent(REPLICATED)}`, {
      method: "POST",
      body: JSON.stringify({ cursor: { page: 7 } }),
    });
    expect(
      (
        await asDevice<{ cursor: { page: number } }>(
          linuxbox,
          `/sync-state/${encodeURIComponent(REPLICATED)}`,
        )
      ).cursor,
    ).toEqual({ page: 7 });
    expect(
      (
        await asDevice<{ cursor: { page: number } }>(
          macbook,
          `/sync-state/${encodeURIComponent(REPLICATED)}`,
        )
      ).cursor,
    ).toEqual({ page: 3 });
    expect(
      (
        await harness.json<{ cursor: { page: number } }>(
          `/sync-state/${encodeURIComponent(REPLICATED)}`,
        )
      ).cursor,
    ).toEqual({ page: 3 });

    // A collector that hosts the type but never joined the replicated source
    // is refused; the exclusive source keeps one ungated shared row, which
    // any collector holding the write scope reads.
    await expect(
      asDevice(stranger, `/sync-state/${encodeURIComponent(REPLICATED)}`),
    ).rejects.toThrow(/403/);
    await asDevice(macbook, `/sync-state/${encodeURIComponent(EXCLUSIVE)}`, {
      method: "POST",
      body: JSON.stringify({ cursor: { page: 1 } }),
    });
    expect(
      (
        await asDevice<{ cursor: { page: number } }>(
          stranger,
          `/sync-state/${encodeURIComponent(EXCLUSIVE)}`,
        )
      ).cursor,
    ).toEqual({ page: 1 });
  });

  test("a page commit as a member advances that member's row; an operator-kind device uses the shared row", async () => {
    const committed = await asDevice<{ ingested: number }>(linuxbox, "/documents/with-cursor", {
      method: "POST",
      body: JSON.stringify({
        providerId: REPLICATED,
        sourceId: REPLICATED,
        documents: [],
        hasMore: false,
        cursor: { page: 9 },
      }),
    });
    expect(committed.ingested).toBe(0);
    expect(
      (
        await asDevice<{ cursor: { page: number } }>(
          linuxbox,
          `/sync-state/${encodeURIComponent(REPLICATED)}`,
        )
      ).cursor,
    ).toEqual({ page: 9 });
    expect(
      (
        await asDevice<{ cursor: { page: number } }>(
          macbook,
          `/sync-state/${encodeURIComponent(REPLICATED)}`,
        )
      ).cursor,
    ).toEqual({ page: 3 });

    // A cli device (an operator, not a host) reads the shared row and is never gated.
    const cli = await harness.json<{ token: string }>("/admin/devices", {
      method: "POST",
      body: JSON.stringify({ name: "ops-shell", kind: "cli", scopes: ["admin", "read"] }),
    });
    const res = await fetch(`${harness.gatewayUrl}/sync-state/${encodeURIComponent(REPLICATED)}`, {
      headers: { Authorization: `Bearer ${cli.token}` },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { cursor: { page: number } }).cursor).toEqual({ page: 3 });
  });

  test("members claim write authority on their own rows; a wipe of the source revokes every claim", async () => {
    const begin = (c: PairedCollector) =>
      asDevice<{ wipeEpoch: number }>(c, `/sync-state/${encodeURIComponent(REPLICATED)}/begin`, {
        method: "POST",
        body: JSON.stringify({}),
      });
    const commit = (c: PairedCollector, wipeEpoch: number, page: number) =>
      asDevice<{ ingested: number; rejected?: boolean }>(c, "/documents/with-cursor", {
        method: "POST",
        body: JSON.stringify({
          providerId: REPLICATED,
          sourceId: REPLICATED,
          documents: [],
          hasMore: false,
          cursor: { page },
          wipeEpoch,
        }),
      });
    const cursorOf = async (c: PairedCollector) =>
      (
        await asDevice<{ cursor: { page: number } | null; wipeEpoch: number }>(
          c,
          `/sync-state/${encodeURIComponent(REPLICATED)}`,
        )
      ).cursor;

    // Each member's claim is on its own row: the second claim does not
    // supersede the first, and both pages commit.
    const macbookClaim = (await begin(macbook)).wipeEpoch;
    const linuxboxClaim = (await begin(linuxbox)).wipeEpoch;
    expect(await commit(macbook, macbookClaim, 11)).toMatchObject({ ingested: 0 });
    expect(await commit(linuxbox, linuxboxClaim, 12)).toMatchObject({ ingested: 0 });
    expect(await cursorOf(macbook)).toEqual({ page: 11 });
    expect(await cursorOf(linuxbox)).toEqual({ page: 12 });

    // A wipe advances every row: both in-flight attempts lose their authority.
    const staleMacbook = (await begin(macbook)).wipeEpoch;
    const staleLinuxbox = (await begin(linuxbox)).wipeEpoch;
    await harness.json(`/documents/delete-all/source/${encodeURIComponent(REPLICATED)}`, {
      method: "POST",
    });
    expect(await commit(macbook, staleMacbook, 13)).toMatchObject({ rejected: true });
    expect(await commit(linuxbox, staleLinuxbox, 14)).toMatchObject({ rejected: true });
    expect(await cursorOf(macbook)).not.toEqual({ page: 13 });
    expect(await cursorOf(linuxbox)).not.toEqual({ page: 14 });

    // Fresh claims after the wipe commit again, each on its own row.
    const freshMacbook = (await begin(macbook)).wipeEpoch;
    const freshLinuxbox = (await begin(linuxbox)).wipeEpoch;
    expect(await commit(macbook, freshMacbook, 15)).toMatchObject({ ingested: 0 });
    expect(await commit(linuxbox, freshLinuxbox, 16)).toMatchObject({ ingested: 0 });
    expect(await cursorOf(macbook)).toEqual({ page: 15 });
    expect(await cursorOf(linuxbox)).toEqual({ page: 16 });
  });

  test("each member's report shows up as its own entry; Sync now reports the offline member", async () => {
    macbook.ws.emitEvent("sync.status", {
      sourceId: REPLICATED,
      deviceId: macbook.deviceId,
      state: "completed",
      completedAt: Date.now(),
    });
    linuxbox.ws.emitEvent("sync.status", {
      sourceId: REPLICATED,
      deviceId: linuxbox.deviceId,
      state: "error",
      errorMessage: "replica offline",
    });
    await waitForCondition(
      async () => {
        const status = await harness.json<{ members?: Array<{ deviceId: string }> }>(
          `/admin/sync/status/${encodeURIComponent(REPLICATED)}`,
        );
        return (status.members?.length ?? 0) === 2;
      },
      5_000,
      "both members reported their status",
    );
    const status = await harness.json<{
      state: string;
      members: Array<{ deviceId: string; state: string }>;
    }>(`/admin/sync/status/${encodeURIComponent(REPLICATED)}`);
    const byDevice = new Map(status.members.map((m) => [m.deviceId, m.state]));
    expect(byDevice.get(macbook.deviceId)).toBe("synced");
    expect(byDevice.get(linuxbox.deviceId)).toBe("error");
    const listed = await harness.json<{ items: Array<{ sourceId: string; members?: unknown[] }> }>(
      "/admin/sync/status",
    );
    expect(listed.items.find((s) => s.sourceId === REPLICATED)?.members).toHaveLength(2);

    // A third member that goes offline is left out of Sync now's results; it
    // is detached afterwards, offline — the snapshot it would get is
    // best-effort — so the source is back to its two live members.
    await harness.json(`/admin/sources/${encodeURIComponent(REPLICATED)}/members`, {
      method: "POST",
      body: JSON.stringify({ deviceId: stranger.deviceId }),
    });
    stranger.ws.disconnect();
    await waitForCondition(
      async () => {
        const { items } = await harness.json<{ items: Array<{ id: string; online: boolean }> }>(
          "/admin/devices",
        );
        return items.find((d) => d.id === stranger.deviceId)?.online === false;
      },
      5_000,
      "the third member went offline",
    );
    const sync = await harness.json<{ results: Array<{ deviceId: string; ok: boolean }> }>(
      `/admin/sources/${encodeURIComponent(REPLICATED)}/sync`,
      { method: "POST" },
    );
    expect(sync.results.map((r) => r.deviceId).sort()).toEqual(
      [macbook.deviceId, linuxbox.deviceId].sort(),
    );
    const detached = await harness.json<{ members: string[] }>(
      `/admin/sources/${encodeURIComponent(REPLICATED)}/members/${stranger.deviceId}`,
      { method: "DELETE" },
    );
    expect(detached.members.sort()).toEqual([macbook.deviceId, linuxbox.deviceId].sort());
  });

  test("a per-device resync resets that member's cursor alone: its claim is revoked, the sibling's still commits", async () => {
    const begin = (c: PairedCollector) =>
      asDevice<{ wipeEpoch: number }>(c, `/sync-state/${encodeURIComponent(REPLICATED)}/begin`, {
        method: "POST",
        body: JSON.stringify({}),
      });
    const commit = (c: PairedCollector, wipeEpoch: number, page: number) =>
      asDevice<{ ingested: number; rejected?: boolean }>(c, "/documents/with-cursor", {
        method: "POST",
        body: JSON.stringify({
          providerId: REPLICATED,
          sourceId: REPLICATED,
          documents: [],
          hasMore: false,
          cursor: { page },
          wipeEpoch,
        }),
      });
    const stateOf = (c: PairedCollector) =>
      asDevice<{ cursor: { page: number } | null; wipeEpoch: number }>(
        c,
        `/sync-state/${encodeURIComponent(REPLICATED)}`,
      );
    const macbookClaim = (await begin(macbook)).wipeEpoch;
    const linuxboxClaim = (await begin(linuxbox)).wipeEpoch;
    expect(await commit(macbook, macbookClaim, 21)).toMatchObject({ ingested: 0 });
    expect(await commit(linuxbox, linuxboxClaim, 22)).toMatchObject({ ingested: 0 });
    macbook.receivedCommands.length = 0;
    linuxbox.receivedCommands.length = 0;

    const reset = await harness.json<{ ok: boolean; scope: string; deviceIds: string[] }>(
      `/admin/sources/${encodeURIComponent(REPLICATED)}/resync`,
      { method: "POST", body: JSON.stringify({ deviceId: linuxbox.deviceId }) },
    );
    expect(reset).toEqual({
      ok: true,
      scope: "cursor",
      deviceIds: [linuxbox.deviceId],
      restarting: [],
      disabled: [],
      skipped: [],
    });
    await waitForCondition(
      () => linuxbox.receivedCommands.some((cmd) => cmd.type === "source.sync"),
      5_000,
      "the reset member was told to sync",
    );
    expect(macbook.receivedCommands.some((cmd) => cmd.type === "source.sync")).toBe(false);

    // The reset member's row is kept with no cursor and a fresh epoch: its
    // in-flight claim is revoked, while the sibling's claim still commits.
    const linuxboxState = await stateOf(linuxbox);
    expect(linuxboxState.cursor).toBeNull();
    expect(linuxboxState.wipeEpoch).toBeGreaterThan(linuxboxClaim);
    expect(await commit(linuxbox, linuxboxClaim, 24)).toMatchObject({ rejected: true });
    expect(await commit(macbook, macbookClaim, 23)).toMatchObject({ ingested: 0 });
    expect((await stateOf(macbook)).cursor).toEqual({ page: 23 });
    // A fresh claim on the reset row commits again.
    const fresh = (await begin(linuxbox)).wipeEpoch;
    expect(await commit(linuxbox, fresh, 25)).toMatchObject({ ingested: 0 });
    expect((await stateOf(linuxbox)).cursor).toEqual({ page: 25 });
  });

  test("detaching a member leaves the source intact; detaching the owner passes ownership on", async () => {
    linuxbox.receivedCommands.length = 0;
    const detached = await harness.json<{ members: string[]; source: { deviceId: string } }>(
      `/admin/sources/${encodeURIComponent(REPLICATED)}/members/${linuxbox.deviceId}`,
      { method: "DELETE" },
    );
    expect(detached.members).toEqual([macbook.deviceId]);
    expect(detached.source.deviceId).toBe(macbook.deviceId);
    // The detached collector's fresh snapshot no longer lists the source.
    await waitForCondition(
      () => linuxbox.receivedCommands.some((cmd) => cmd.type === "sources.snapshot"),
      5_000,
      "detached collector received a fresh snapshot",
    );
    const snapshot = linuxbox.receivedCommands.find((cmd) => cmd.type === "sources.snapshot");
    expect(
      (snapshot?.payload as { sources: Array<{ id: string }> }).sources.map((s) => s.id),
    ).not.toContain(REPLICATED);
    expect((await row(REPLICATED))?.members).toEqual([macbook.deviceId]);

    // Re-join, then detach the owner: ownership passes to the remaining member.
    await harness.json(`/admin/sources/${encodeURIComponent(REPLICATED)}/members`, {
      method: "POST",
      body: JSON.stringify({ deviceId: linuxbox.deviceId }),
    });
    const ownerLeft = await harness.json<{ members: string[]; source: { deviceId: string } }>(
      `/admin/sources/${encodeURIComponent(REPLICATED)}/members/${macbook.deviceId}`,
      { method: "DELETE" },
    );
    expect(ownerLeft.source.deviceId).toBe(linuxbox.deviceId);
    expect(ownerLeft.members).toEqual([linuxbox.deviceId]);
    expect((await row(REPLICATED))?.deviceId).toBe(linuxbox.deviceId);
  });
});
