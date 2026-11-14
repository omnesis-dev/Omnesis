// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The two resync modes on a source one device hosts, end to end: a real
 * gateway, a real collector (source manager, sync engine and command
 * channel) and the real Maildir source over a mail folder the test changes
 * between reads.
 *
 * In place deletes nothing: the collector reads the folder again from the
 * start and every message lands on the record it already has. The suite
 * holds the collector offline between the reset and the read, so what the
 * gateway serves while a resync is pending is asserted before anything is
 * read again. From scratch — what a caller that names no mode gets — wipes
 * first, so every record is new and a message the owner deleted comes back.
 */

import { mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { GatewayWsClient, HttpGatewayClient } from "@omnesis/gateway-client";
import maildirDefinition from "@omnesis/provider-maildir";
import {
  createMailbox,
  deliverMessage,
  maildirFileName,
  type FixtureMessage,
} from "@omnesis/provider-maildir/testing";
import { SourceType } from "@omnesis/types";
import { extractDescriptors } from "../source-descriptors.js";
import { SourceManager } from "../source-manager.js";
import { createSourceWsHandlers } from "../source-ws-handlers.js";
import { SyncEngine } from "../sync-engine.js";
import { createCommandDispatch } from "../ws-command-dispatch.js";
import { MultiCollectorHarness, waitForCondition } from "./multi-collector-harness.js";
import type { CollectorInternalConfig } from "../internal-config.js";

const SOURCE_TYPE = "maildir";
const CAPABILITIES = {
  hostname: "mail-host.example.com",
  platform: "linux",
  hostableSourceTypes: [SourceType(SOURCE_TYPE)],
  memberScopedParams: Object.fromEntries(
    extractDescriptors(maildirDefinition).map((d) => [d.id, d.memberScopedParamNames ?? []]),
  ),
};

const SELF = { name: "Maya Reeves", address: "maya.reeves@example.com" };
const JAMIE = { name: "Jamie Lopez", address: "jamie.lopez@example.org" };

function mail(id: string, subject: string): FixtureMessage {
  return {
    messageId: `${id}@example.org`,
    from: JAMIE,
    to: [SELF],
    subject,
    date: "2026-03-02T09:30:00Z",
    text: `${subject}. Fictional test content for the resync suite.`,
  };
}

interface ResyncAnswer {
  ok: boolean;
  mode: string;
  scope: string;
  deviceIds: string[];
  restarting: string[];
  skipped: string[];
  disabled: string[];
}

describe("resync in place and from scratch on a single-device source", () => {
  let harness: MultiCollectorHarness;
  let scratch: string;
  let root: string;
  let deviceToken: string;
  let deviceId: string;
  let sourceId: string;
  let engine: SyncEngine;
  let ws: GatewayWsClient;

  const inbox = () => join(root, "INBOX");
  const file = (uniq: string, flags = "S") =>
    join(inbox(), "cur", maildirFileName(uniq, "cur", flags));

  const admin = async <T>(path: string, init?: RequestInit): Promise<T> => {
    try {
      return await harness.json<T>(path, init);
    } catch (err) {
      const body = (err as { body?: unknown }).body;
      throw new Error(`${(err as Error).message}: ${JSON.stringify(body)}`, { cause: err });
    }
  };
  const readDb = <T>(read: (db: Database.Database) => T): T => {
    const db = new Database(harness.getDbPath(), { readonly: true });
    try {
      return read(db);
    } finally {
      db.close();
    }
  };
  /** Every record of the source as `title → record id`. */
  const records = (): Record<string, string> =>
    readDb((db) =>
      Object.fromEntries(
        db
          .prepare<[string], { id: string; title: string }>(
            "SELECT id, title FROM documents WHERE source_id = ? ORDER BY title",
          )
          .all(sourceId)
          .map((row) => [row.title, row.id]),
      ),
    );
  const flagged = (title: string): boolean =>
    readDb((db) => {
      const row = db
        .prepare<[string, string], { metadata: string }>(
          "SELECT metadata FROM documents WHERE source_id = ? AND title = ?",
        )
        .get(sourceId, title);
      if (!row) throw new Error(`no document titled ${title}`);
      return (
        (JSON.parse(row.metadata) as { extra?: { flagged?: boolean } }).extra?.flagged === true
      );
    });
  const cursorRow = () =>
    readDb((db) =>
      db
        .prepare<[string], { cursor: string; last_synced_at: string | null }>(
          "SELECT cursor, last_synced_at FROM sync_state WHERE source_id = ? AND device_id = ''",
        )
        .get(sourceId),
    );
  const lastSynced = () => cursorRow()?.last_synced_at ?? null;
  const idle = () => engine.getStatuses().find((s) => s.sourceId === sourceId)?.state === "idle";
  /** Wait until a sync that started after `before` has committed its last page. */
  const waitForSync = async (before: string | null): Promise<void> => {
    await waitForCondition(
      () => Promise.resolve(lastSynced() !== null && lastSynced() !== before && idle()),
      30_000,
      "a sync committed",
    );
    expect(engine.getStatuses().find((s) => s.sourceId === sourceId)?.lastError).toBeUndefined();
  };
  /** Run one sync on the collector, the way the gateway's command does, and wait for it. */
  const sync = async (restart = false): Promise<void> => {
    await waitForCondition(() => Promise.resolve(idle()), 30_000, "the source is idle");
    const before = lastSynced();
    const triggered = engine.triggerSync(sourceId, { restart });
    expect(triggered.error).toBeUndefined();
    await waitForSync(before);
  };
  const resync = (body: Record<string, unknown>) =>
    admin<ResyncAnswer>(`/admin/sources/${encodeURIComponent(sourceId)}/resync`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  const search = async (query: string): Promise<string[]> =>
    (
      (
        await admin<{ results?: Array<{ title: string }> }>(
          `/documents/search?q=${encodeURIComponent(query)}&sources=${encodeURIComponent(sourceId)}&limit=10`,
        )
      ).results ?? []
    ).map((r) => r.title);
  const runAbsenceSweep = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    for (let phase = 0; phase < 2; phase++) {
      await admin("/admin/background/run/absence.sweep", { method: "POST" });
    }
  };
  /** Open the collector's command channel; a closed one is replaced, as a restart would. */
  let connect: () => Promise<void>;

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), "omnesis-resync-e2e-"));
    root = join(scratch, "Mail", "example");
    harness = new MultiCollectorHarness({
      // Synthetic mode exposes the route that runs the absence sweep on
      // demand; the source itself is the real one. A message has to be missing
      // from two completed reads before the sweep may delete it.
      extraGatewayEnv: { OMNESIS_SYNTHETIC: "1" },
      gatewayConfig: {
        gateway: { snapshotAbsence: { minObservations: 2, minAge: "1ms", deletionGrace: "1ms" } },
      },
    });
    await harness.start();
    const paired = await admin<{ device: { id: string }; token: string }>("/admin/devices", {
      method: "POST",
      body: JSON.stringify({
        name: "mail-host",
        kind: "collector",
        scopes: ["read", "write:*", "admin"],
        capabilities: CAPABILITIES,
      }),
    });
    deviceToken = paired.token;
    deviceId = paired.device.id;

    createMailbox(inbox());
    deliverMessage(inbox(), "1772443800.1.host", mail("agenda", "Board meeting agenda"), {
      flags: "S",
    });
    deliverMessage(inbox(), "1772443800.2.host", mail("budget", "Quarterly budget review"), {
      flags: "S",
    });
    deliverMessage(inbox(), "1772443800.3.host", mail("offsite", "Offsite travel plans"), {
      flags: "S",
    });
    deliverMessage(inbox(), "1772443800.4.host", mail("draft", "Discarded draft idea"), {
      flags: "S",
    });

    const gateway = new HttpGatewayClient(harness.gatewayUrl, deviceToken);
    engine = new SyncEngine(gateway);
    const manager = new SourceManager(
      engine,
      gateway,
      { sources: {}, defaultSyncInterval: "999999s" } satisfies CollectorInternalConfig,
      {
        definitions: [maildirDefinition],
        descriptors: extractDescriptors(maildirDefinition),
        configDir: join(scratch, "collector-config"),
      },
    );
    const sourceHandlers = createSourceWsHandlers({
      sourceManager: manager,
      gateway,
      emitEvent: (type, payload) => ws.emitEvent(type, payload),
    });
    const commands = createCommandDispatch();
    commands.register("sources.snapshot", async ({ sources }) => {
      await manager.applySourcesSnapshot(sources);
      return { ok: true, applied: sources.length };
    });
    commands.register("source.added", async ({ source }) => {
      if (source) await manager.applySourcesSnapshot([source], { merge: true });
      return { ok: true, applied: Boolean(source) };
    });
    commands.register("source.updated", async ({ source }) => {
      if (source) await manager.applySourcesSnapshot([source], { merge: true });
      return { ok: true, applied: Boolean(source) };
    });
    commands.register("source.sync", ({ sourceId: target, restart }) => {
      const result = engine.triggerSync(target, { restart: restart === true });
      return {
        ok: !result.error,
        triggered: result.triggered.length,
        skipped: result.skipped.length,
        disabled: result.disabled.length,
        restarting: result.restarting.length,
      };
    });
    connect = async () => {
      ws = new GatewayWsClient(harness.gatewayUrl, deviceToken, { capabilities: CAPABILITIES });
      ws.onCommand(async (command) => {
        const handled = sourceHandlers.handle(command);
        if (handled !== undefined) return handled;
        const byEngine = commands.handle(command);
        if (byEngine !== undefined) return byEngine;
        throw new Error(`Unhandled collector command ${command.type}`);
      });
      ws.connect();
      await waitForCondition(() => Promise.resolve(ws.isAuthenticated()), 10_000, "connected");
    };
    await connect();

    const resolved = await admin<{ accountId: string }>("/admin/sources/resolve-account", {
      method: "POST",
      body: JSON.stringify({ deviceId, descriptorId: SOURCE_TYPE, params: { path: root } }),
    });
    sourceId = `${SOURCE_TYPE}:${resolved.accountId}`;
    await admin("/admin/sources/add", {
      method: "POST",
      body: JSON.stringify({
        deviceId,
        descriptorId: SOURCE_TYPE,
        accountIds: [resolved.accountId],
        params: { path: root },
      }),
    });
    await waitForCondition(
      () => Promise.resolve(engine.getSourcesById(sourceId).length === 1),
      15_000,
      "the collector registered the Maildir source",
    );
    // Every sync in this suite is one the suite asks for.
    engine.stopSyncLoop();
    await sync();
  }, 120_000);

  afterAll(async () => {
    ws?.disconnect();
    await engine?.stopSyncLoopAndDrain();
    for (const registered of engine?.getSourcesById(sourceId) ?? [])
      await registered.instance.dispose?.();
    await harness?.destroy();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }, 30_000);

  test("the source offers both modes, and the owner deletes one message for good", async () => {
    const listing = await admin<{ items: Array<{ id: string; resyncModes: string[] }> }>(
      "/admin/sources",
    );
    expect(listing.items.find((s) => s.id === sourceId)?.resyncModes).toEqual([
      "in-place",
      "from-scratch",
    ]);
    expect(Object.keys(records())).toEqual([
      "Board meeting agenda",
      "Discarded draft idea",
      "Offsite travel plans",
      "Quarterly budget review",
    ]);
    await admin(`/documents/${records()["Discarded draft idea"]}`, { method: "DELETE" });
    expect(Object.keys(records())).not.toContain("Discarded draft idea");
  }, 60_000);

  test("in place, sent to the online host: every record keeps its id and the deleted message stays deleted", async () => {
    const before = records();
    const stamp = lastSynced();

    const answer = await resync({ mode: "in-place" });

    expect(answer).toMatchObject({ ok: true, mode: "in-place", scope: "source" });
    expect([...answer.deviceIds, ...answer.restarting]).toEqual([deviceId]);
    await waitForSync(stamp);
    expect(records()).toEqual(before);
  }, 60_000);

  test("in place, pending: nothing is deleted, the source stays searchable, and the read updates records where they are", async () => {
    const before = records();
    // The host is offline, so the reset happens and the read does not start.
    ws.disconnect();
    await waitForCondition(
      async () =>
        (
          await admin<{ items: Array<{ id: string; online: boolean }> }>("/admin/devices")
        ).items.find((d) => d.id === deviceId)?.online === false,
      10_000,
      "the gateway saw the collector leave",
    );

    const answer = await resync({ mode: "in-place" });

    expect(answer).toEqual({
      ok: true,
      mode: "in-place",
      scope: "source",
      deviceIds: [],
      restarting: [],
      skipped: [],
      disabled: [],
    });
    // The cursor is back at the start and nothing else moved.
    expect(cursorRow()).toEqual({ cursor: "{}", last_synced_at: null });
    expect(records()).toEqual(before);
    expect(await search("Quarterly budget")).toEqual(["Quarterly budget review"]);
    const read = await admin<{ id: string; title: string }>(
      `/documents/${before["Offsite travel plans"]}`,
    );
    expect(read.title).toBe("Offsite travel plans");

    // Meanwhile the mailbox changes: one message is starred, one is gone,
    // one is new, and the message the owner deleted is still in the folder.
    renameSync(file("1772443800.2.host"), file("1772443800.2.host", "FS"));
    rmSync(file("1772443800.3.host"));
    deliverMessage(inbox(), "1772443800.5.host", mail("lunch", "Lunch on Friday"), { flags: "S" });

    await sync(true);

    const after = records();
    // Changed content landed on the record it already had.
    expect(after["Quarterly budget review"]).toBe(before["Quarterly budget review"]);
    expect(flagged("Quarterly budget review")).toBe(true);
    expect(after["Board meeting agenda"]).toBe(before["Board meeting agenda"]);
    // A new message is a new record; the deleted one was read again and refused.
    expect(after["Lunch on Friday"]).toBeTruthy();
    expect(Object.keys(after)).not.toContain("Discarded draft idea");
    // The message the folder no longer holds was not deleted by the resync:
    // one completed read omitting it is one observation, as after any sync.
    await runAbsenceSweep();
    expect(records()["Offsite travel plans"]).toBe(before["Offsite travel plans"]);
    expect(await search("Offsite travel")).toEqual(["Offsite travel plans"]);

    // An ordinary sync that omits it again is what lets the sweep delete it.
    await sync();
    await runAbsenceSweep();
    await waitForCondition(
      () => Promise.resolve(!("Offsite travel plans" in records())),
      15_000,
      "the message missing from two reads was swept",
    );
    expect(Object.keys(records())).toEqual([
      "Board meeting agenda",
      "Lunch on Friday",
      "Quarterly budget review",
    ]);
  }, 90_000);

  test("a caller that names no mode gets from scratch: new records, and the deleted message comes back", async () => {
    await connect();
    const before = records();
    const stamp = lastSynced();

    const answer = await resync({});

    expect(answer).toMatchObject({ ok: true, mode: "from-scratch", scope: "source" });
    await waitForSync(stamp);
    await waitForCondition(
      () => Promise.resolve(Object.keys(records()).length === 4),
      30_000,
      "the wiped source was imported again",
    );
    const after = records();
    expect(Object.keys(after)).toEqual([
      "Board meeting agenda",
      "Discarded draft idea",
      "Lunch on Friday",
      "Quarterly budget review",
    ]);
    for (const title of Object.keys(before)) expect(after[title]).not.toBe(before[title]);
  }, 60_000);
});
