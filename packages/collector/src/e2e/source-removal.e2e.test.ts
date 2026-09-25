// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  MultiCollectorHarness,
  waitForCondition,
  type PairedCollector,
} from "./multi-collector-harness.js";

describe("whole-source removal across members", () => {
  let harness: MultiCollectorHarness;
  let members: PairedCollector[];

  beforeAll(async () => {
    harness = new MultiCollectorHarness();
    await harness.start();
    members = [];
    for (const name of ["owner", "sibling", "unresponsive", "offline"]) {
      members.push(
        await harness.addCollector({
          name,
          hostableSourceTypes: ["notes-synth", "visits-synth"],
          multiDeviceModes: { "notes-synth": "replicated", "visits-synth": "partitioned" },
          syncLease: true,
        }),
      );
    }
  }, 60_000);

  afterAll(async () => {
    await harness.destroy();
  }, 15_000);

  const path = (id: string) => `/admin/sources/${encodeURIComponent(id)}`;
  const removedIds = async () =>
    (await harness.json<{ removedSourceIds: string[] }>("/admin/sources")).removedSourceIds;
  function durable(id: string) {
    const db = new Database(harness.getDbPath(), { readonly: true });
    try {
      return {
        source: db.prepare("SELECT id, device_id, enabled FROM sources WHERE id = ?").get(id),
        tombstone: db
          .prepare<
            [string],
            { cleanup_done_at: number | null }
          >("SELECT cleanup_done_at FROM removed_sources WHERE id = ?")
          .get(id),
        documents: db
          .prepare<
            [string],
            { n: number }
          >("SELECT COUNT(*) AS n FROM documents WHERE source_id = ?")
          .get(id)!.n,
      };
    } finally {
      db.close();
    }
  }

  async function register(accountId: string, collectors = members, type = "notes-synth") {
    for (const c of collectors) {
      const res = await fetch(`${c.gatewayBase}/devices/sources/bulk-upsert`, {
        method: "POST",
        headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ sources: [{ type, accountId, enabled: true }] }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ errors: [] });
    }
    return `${type}:${accountId}`;
  }

  function holdRemoval(c: PairedCollector) {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    c.ws.onCommand(async (command) => {
      c.receivedCommands.push({ type: command.type, payload: command.payload });
      if (command.type === "source.removed") await held;
      return { ok: true, applied: true };
    });
    return release;
  }

  async function expectSnapshotExcludes(c: PairedCollector, id: string) {
    await waitForCondition(
      () =>
        c.receivedCommands.some(
          (cmd) =>
            cmd.type === "sources.snapshot" &&
            !(cmd.payload as { sources: Array<{ id: string }> }).sources.some((s) => s.id === id),
        ),
      5_000,
      `${c.name} reconciles the removed source on reconnect`,
    );
  }

  test("notifies owner and every connected sibling once, bounds unresponsive delivery, and reconciles the offline member", async () => {
    const id = await register("removal@example.com");
    const [owner, sibling, unresponsive, offline] = members as [
      PairedCollector,
      PairedCollector,
      PairedCollector,
      PairedCollector,
    ];
    await harness.pushDocuments(owner, [{ sourceId: id, externalId: "retired-note" }]);
    expect(durable(id).documents).toBe(1);
    await harness.disconnectCollector(offline);
    for (const c of members) c.receivedCommands.length = 0;
    const release = holdRemoval(unresponsive);
    try {
      await expect(harness.json(path(id), { method: "DELETE" })).resolves.toEqual({
        ok: true,
        state: "removing",
      });
      for (const c of [owner, sibling, unresponsive]) {
        expect(
          c.receivedCommands.filter(
            (cmd) =>
              cmd.type === "source.removed" &&
              (cmd.payload as { sourceId: string }).sourceId === id,
          ),
        ).toHaveLength(1);
      }
      expect(offline.receivedCommands).toEqual([]);
      await waitForCondition(
        () => durable(id).tombstone?.cleanup_done_at != null,
        15_000,
        "cleanup completes despite missed acknowledgements",
      );
      expect(durable(id)).toMatchObject({ source: undefined, documents: 0 });
      expect(await removedIds()).toContain(id);
      await expect(
        harness.pushDocuments(offline, [{ sourceId: id, externalId: "late-note" }]),
      ).resolves.toMatchObject({ ingested: 0, rejected: [{ sourceId: id, reason: "removed" }] });
      expect(durable(id).documents).toBe(0);
      await harness.reconnectCollector(offline);
      await expectSnapshotExcludes(offline, id);
      await register("removal@example.com", [owner]);
      expect(durable(id).tombstone).toBeUndefined();
      expect(await removedIds()).not.toContain(id);
      await expect(
        harness.pushDocuments(owner, [{ sourceId: id, externalId: "new-note" }]),
      ).resolves.toMatchObject({ ingested: 1 });
    } finally {
      release();
      await harness.disconnectCollector(unresponsive);
      await harness.reconnectCollector(unresponsive);
    }
  }, 30_000);

  test("a restart during pending removal resumes cleanup and retains the tombstone until explicit re-add", async () => {
    const id = await register("restart@example.com");
    const owner = members[0]!;
    const blocked = members[2]!;
    await harness.pushDocuments(owner, [{ sourceId: id, externalId: "interrupted-note" }]);
    for (const c of members) c.receivedCommands.length = 0;
    const release = holdRemoval(blocked);
    // Observe the durable phase while the command acknowledgement is held;
    // killing the gateway here interrupts removal before it starts its sweep.
    const request = harness.json(path(id), { method: "DELETE" }).catch(() => undefined);
    try {
      await waitForCondition(
        () => durable(id).tombstone?.cleanup_done_at === null,
        5_000,
        "pending removal committed",
      );
      expect(durable(id).documents).toBe(1);
      expect(await removedIds()).toContain(id);
      await expect(
        harness.json("/admin/sources", {
          method: "POST",
          body: JSON.stringify({
            type: "notes-synth",
            accountId: "restart@example.com",
            deviceId: owner.deviceId,
          }),
        }),
      ).rejects.toMatchObject({ status: 409, body: { code: "SOURCE_REMOVAL_IN_PROGRESS" } });
      await harness.restartGateway({ signal: "SIGKILL" });
      await request;
      await waitForCondition(
        () => durable(id).tombstone?.cleanup_done_at != null,
        15_000,
        "restart completes the interrupted purge",
      );
      expect(durable(id)).toMatchObject({ source: undefined, documents: 0 });
      expect(await removedIds()).toContain(id);
      for (const c of members) await expectSnapshotExcludes(c, id);
      await expect(
        harness.pushDocuments(owner, [{ sourceId: id, externalId: "late-after-restart" }]),
      ).resolves.toMatchObject({ ingested: 0, rejected: [{ sourceId: id, reason: "removed" }] });
      await register("restart@example.com", [owner]);
      expect(durable(id).tombstone).toBeUndefined();
      expect(await removedIds()).not.toContain(id);
    } finally {
      release();
    }
  }, 60_000);

  test.each([
    { type: "notes-synth", remainingDocuments: 2 },
    { type: "visits-synth", remainingDocuments: 1 },
  ])(
    "$type detach preserves siblings and last-member pause retains data",
    async ({ type, remainingDocuments }) => {
      const [owner, sibling] = members as [PairedCollector, PairedCollector, ...PairedCollector[]];
      const id = await register("detach@example.com", [owner, sibling], type);
      await harness.pushDocuments(owner, [{ sourceId: id, externalId: "owner-contribution" }]);
      await harness.pushDocuments(sibling, [{ sourceId: id, externalId: "sibling-contribution" }]);
      expect(durable(id).documents).toBe(2);

      await harness.json(`${path(id)}/members/${owner.deviceId}`, { method: "DELETE" });
      expect(durable(id)).toMatchObject({
        source: { device_id: sibling.deviceId, enabled: 1 },
        documents: remainingDocuments,
        tombstone: undefined,
      });
      const db = new Database(harness.getDbPath(), { readonly: true });
      try {
        expect(
          db
            .prepare("SELECT external_id FROM documents WHERE source_id = ? AND external_id = ?")
            .get(id, "sibling-contribution"),
        ).toBeDefined();
      } finally {
        db.close();
      }

      await expect(
        harness.json(`${path(id)}/members/${sibling.deviceId}`, { method: "DELETE" }),
      ).rejects.toMatchObject({ status: 409, body: { code: "LAST_MEMBER" } });
      // The mobile fallback is a source pause, never a whole-source removal.
      await harness.json(path(id), { method: "PATCH", body: JSON.stringify({ enabled: false }) });
      expect(durable(id)).toMatchObject({
        source: { device_id: sibling.deviceId, enabled: 0 },
        documents: remainingDocuments,
        tombstone: undefined,
      });
    },
    30_000,
  );
});
