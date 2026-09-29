// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The real Maildir source end to end: a real gateway, a real collector
 * (source manager, sync engine and command channel), and a Maildir tree on
 * disk that the test changes the way a mail tool mirroring a Gmail account
 * would — new deliveries, labels added and removed, a star, archiving,
 * deletion, an unreadable folder, a collector restart and a resync.
 *
 * The source is added the way the portal adds it: the gateway asks the
 * collector to name the account for a folder, then to add it.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  setThunderbirdStatus,
  storeThunderbirdMessage,
} from "@omnesis/provider-maildir/testing";
import { SourceType } from "@omnesis/types";
import { extractDescriptors } from "../source-descriptors.js";
import { SourceManager } from "../source-manager.js";
import { createSourceWsHandlers } from "../source-ws-handlers.js";
import { SyncEngine } from "../sync-engine.js";
import { createCommandDispatch } from "../ws-command-dispatch.js";
import { MultiCollectorHarness, waitForCondition } from "./multi-collector-harness.js";
import type { CollectorInternalConfig } from "../internal-config.js";
import type { FixtureMessage } from "@omnesis/provider-maildir/testing";

const SOURCE_TYPE = "maildir";

/**
 * What this collector advertises, derived from the descriptor the way the
 * real collector derives it — including which settings are member-local.
 */
const CAPABILITIES = {
  hostname: "mail-host.example.com",
  platform: "linux",
  hostableSourceTypes: [SourceType(SOURCE_TYPE)],
  memberScopedParams: Object.fromEntries(
    extractDescriptors(maildirDefinition).map((d) => [d.id, d.memberScopedParamNames ?? []]),
  ),
};
const isRoot = process.getuid?.() === 0;

const SELF = { name: "Maya Reeves", address: "maya.reeves@example.com" };
const JAMIE = { name: "Jamie Lopez", address: "jamie.lopez@example.org" };
const DAVID = { name: "David Lin", address: "david.lin@example.io" };
const SARAH = { name: "Sarah Mendez", address: "sarah.mendez@example.net" };

function mail(
  id: string,
  subject: string,
  overrides: Partial<FixtureMessage> = {},
): FixtureMessage {
  return {
    messageId: `${id}@example.org`,
    from: JAMIE,
    to: [SELF],
    subject,
    date: "2026-03-02T09:30:00Z",
    text: `${subject}. Fictional test content for the Maildir lifecycle suite.`,
    ...overrides,
  };
}

interface Collector {
  deviceId: string;
  gateway: HttpGatewayClient;
  engine: SyncEngine;
  manager: SourceManager;
  ws: GatewayWsClient;
}

interface DocumentRow {
  external_id: string;
  title: string;
  metadata: string;
}

describe("real Maildir source through a real collector", () => {
  let harness: MultiCollectorHarness;
  let scratch: string;
  let root: string;
  let collectorConfigDir: string;
  let collector: Collector;
  let deviceToken: string;
  let deviceId: string;
  let sourceId: string;

  const inbox = () => join(root, "INBOX");
  const allMail = () => join(root, "[Gmail]", "All Mail");
  const sentMail = () => join(root, "[Gmail]", "Sent Mail");
  const work = () => join(root, "Work");
  const trash = () => join(root, "[Gmail]", "Trash");

  /** An admin request whose failure carries the gateway's own explanation. */
  const admin = async <T>(path: string, init?: RequestInit): Promise<T> => {
    try {
      return await harness.json<T>(path, init);
    } catch (err) {
      const body = (err as { body?: unknown }).body;
      throw Object.assign(new Error(`${(err as Error).message}: ${JSON.stringify(body)}`), {
        status: (err as { status?: number }).status,
      });
    }
  };

  const rows = (id = sourceId): DocumentRow[] => {
    const db = new Database(harness.getDbPath(), { readonly: true });
    try {
      return db
        .prepare<
          [string],
          DocumentRow
        >("SELECT external_id, title, metadata FROM documents WHERE source_id = ? ORDER BY title")
        .all(id);
    } finally {
      db.close();
    }
  };
  const titles = (id = sourceId) => rows(id).map((row) => row.title);
  const metadataOf = (
    title: string,
    id = sourceId,
  ): { tags?: string[]; extra?: Record<string, unknown>; documentType?: string } => {
    const row = rows(id).find((r) => r.title === title);
    if (!row) throw new Error(`no document titled ${title}`);
    return JSON.parse(row.metadata) as { tags?: string[]; extra?: Record<string, unknown> };
  };
  const indexPath = () =>
    join(
      collectorConfigDir,
      SOURCE_TYPE,
      sourceId.slice(SOURCE_TYPE.length + 1),
      "maildir-index.sqlite",
    );
  /** The source's local index, read beside the running collector. */
  const indexState = () => {
    const db = new Database(indexPath(), { readonly: true });
    try {
      return {
        generation: (
          db.prepare("SELECT v FROM meta WHERE k = 'generation'").get() as { v: string } | undefined
        )?.v,
        emitted: db.prepare("SELECT key, seq FROM emitted ORDER BY key").all() as Array<{
          key: string;
          seq: number;
        }>,
        unnamedFiles: (
          db.prepare("SELECT COUNT(*) AS n FROM files WHERE key IS NULL").get() as { n: number }
        ).n,
      };
    } finally {
      db.close();
    }
  };
  const lastSynced = (id = sourceId): string | null => {
    const db = new Database(harness.getDbPath(), { readonly: true });
    try {
      return (
        db
          .prepare<
            [string],
            { last_synced_at: string | null }
          >("SELECT last_synced_at FROM sync_state WHERE source_id = ?")
          .get(id)?.last_synced_at ?? null
      );
    } finally {
      db.close();
    }
  };
  /** Trigger one sync and wait until its final page has committed. */
  const syncAndWait = async (restart = false, id = sourceId): Promise<void> => {
    const before = lastSynced(id);
    const triggered = collector.engine.triggerSync(id, { restart });
    expect(triggered.error).toBeUndefined();
    await waitForCondition(
      () =>
        Promise.resolve(
          lastSynced(id) !== before &&
            collector.engine.getStatuses().find((s) => s.sourceId === id)?.state === "idle",
        ),
      30_000,
      "a Maildir sync committed",
    );
    expect(
      collector.engine.getStatuses().find((s) => s.sourceId === id)?.lastError,
    ).toBeUndefined();
  };
  /** Add a Maildir source over `path` the way the portal does, and return its id once registered. */
  const addSource = async (path: string): Promise<string> => {
    const resolved = await admin<{ accountId: string }>("/admin/sources/resolve-account", {
      method: "POST",
      body: JSON.stringify({ deviceId, descriptorId: SOURCE_TYPE, params: { path } }),
    });
    await admin("/admin/sources/add", {
      method: "POST",
      body: JSON.stringify({
        deviceId,
        descriptorId: SOURCE_TYPE,
        accountIds: [resolved.accountId],
        params: { path },
      }),
    });
    const id = `${SOURCE_TYPE}:${resolved.accountId}`;
    await waitForCondition(
      () => Promise.resolve(collector.engine.getSourcesById(id).length === 1),
      15_000,
      "the collector registered the Maildir source",
    );
    collector.engine.stopSyncLoop();
    return id;
  };
  const runAbsenceSweep = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    for (let phase = 0; phase < 2; phase++) {
      await admin("/admin/background/run/absence.sweep", { method: "POST" });
    }
  };

  const startCollector = async (): Promise<Collector> => {
    const gateway = new HttpGatewayClient(harness.gatewayUrl, deviceToken);
    const engine = new SyncEngine(gateway);
    const manager = new SourceManager(
      engine,
      gateway,
      { sources: {}, defaultSyncInterval: "999999s" } satisfies CollectorInternalConfig,
      {
        definitions: [maildirDefinition],
        descriptors: extractDescriptors(maildirDefinition),
        configDir: collectorConfigDir,
      },
    );
    const ws = new GatewayWsClient(harness.gatewayUrl, deviceToken, { capabilities: CAPABILITIES });
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
    commands.register("source.removed", async ({ sourceId: removed }) => {
      await manager.removeSources([removed]);
      return { ok: true, applied: true };
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
    ws.onCommand(async (command) => {
      const handled = sourceHandlers.handle(command);
      if (handled !== undefined) return handled;
      const byEngine = commands.handle(command);
      if (byEngine !== undefined) return byEngine;
      throw new Error(`Unhandled collector command ${command.type}`);
    });
    ws.connect();
    await waitForCondition(
      () => Promise.resolve(ws.isAuthenticated()),
      10_000,
      "collector connected",
    );
    return { deviceId, gateway, engine, manager, ws };
  };
  const stopCollector = async (c: Collector) => {
    c.ws.disconnect();
    await c.engine.stopSyncLoopAndDrain();
    for (const registered of c.engine.getSourcesById(sourceId))
      await registered.instance.dispose?.();
  };

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), "omnesis-maildir-e2e-"));
    root = join(scratch, "Mail", "example");
    collectorConfigDir = join(scratch, "collector-config");
    harness = new MultiCollectorHarness({
      // Synthetic mode is what exposes the route that runs the absence sweep
      // on demand; the source itself is the real one.
      extraGatewayEnv: { OMNESIS_SYNTHETIC: "1" },
      gatewayConfig: {
        gateway: { snapshotAbsence: { minObservations: 1, minAge: "1ms", deletionGrace: "1ms" } },
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

    // An account mirrored the way mbsync mirrors Gmail: every message in All
    // Mail, plus a copy per label.
    for (const dir of [inbox(), allMail(), sentMail(), work(), trash()]) createMailbox(dir);
    const welcome = mail("welcome", "Welcome to the team");
    deliverMessage(inbox(), "1772443800.1.host", welcome, { flags: "S" });
    deliverMessage(allMail(), "1772443800.2.host", welcome, { flags: "S" });
    const reply = mail("reply", "Re: Welcome to the team", {
      from: SELF,
      to: [JAMIE],
      cc: [DAVID],
      date: "2026-03-02T10:00:00Z",
      inReplyTo: "welcome@example.org",
      references: ["welcome@example.org"],
    });
    deliverMessage(sentMail(), "1772445600.3.host", reply, { flags: "S" });
    deliverMessage(allMail(), "1772445600.4.host", reply, { flags: "S" });
    const plan = mail("plan", "Quarterly planning notes", {
      from: DAVID,
      date: "2026-03-03T08:00:00Z",
    });
    deliverMessage(work(), "1772524800.5.host", plan, { flags: "S" });
    deliverMessage(allMail(), "1772524800.6.host", plan, { flags: "S" });
    deliverMessage(trash(), "1772524900.7.host", mail("junk", "Discarded draft idea"), {
      flags: "S",
    });

    collector = await startCollector();
  }, 120_000);

  afterAll(async () => {
    if (collector) await stopCollector(collector);
    await harness?.destroy();
    if (scratch) {
      try {
        chmodSync(work(), 0o755);
      } catch {
        // Already restored.
      }
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 30_000);

  test("a folder that is not a Maildir is refused when the source is added", async () => {
    await expect(
      admin("/admin/sources/resolve-account", {
        method: "POST",
        body: JSON.stringify({
          deviceId,
          descriptorId: SOURCE_TYPE,
          params: { path: join(scratch, "missing") },
        }),
      }),
    ).rejects.toThrow(/does not exist|not there|must exist|no such/i);
  });

  test("added through the portal's path, it indexes one document per message", async () => {
    const resolved = await admin<{ accountId: string }>("/admin/sources/resolve-account", {
      method: "POST",
      body: JSON.stringify({ deviceId, descriptorId: SOURCE_TYPE, params: { path: root } }),
    });
    expect(resolved.accountId).toMatch(/^example-[0-9a-f]{16}$/);
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
      () => Promise.resolve(collector.engine.getSourcesById(sourceId).length === 1),
      15_000,
      "the collector registered the Maildir source",
    );
    // Filesystem watchers are real, but this sequence drives each sync itself
    // so a change and its sync are one step.
    collector.engine.stopSyncLoop();
    expect(collector.engine.getSourcesById(sourceId)[0]?.instance.watchPaths).toEqual([root]);

    await syncAndWait();
    expect(titles()).toEqual([
      "Quarterly planning notes",
      "Re: Welcome to the team",
      "Welcome to the team",
    ]);
    expect(metadataOf("Welcome to the team").tags).toEqual(["INBOX"]);
    expect(metadataOf("Re: Welcome to the team").tags).toEqual(["SENT"]);
    expect(metadataOf("Re: Welcome to the team").extra?.threadId).toBe(
      metadataOf("Welcome to the team").extra?.threadId,
    );

    const search = await admin<{ results?: Array<{ title: string }> }>(
      `/documents/search?q=${encodeURIComponent("Quarterly planning")}&sources=${encodeURIComponent(sourceId)}&limit=10`,
    );
    expect((search.results ?? []).map((r) => r.title)).toContain("Quarterly planning notes");
  }, 60_000);

  test("a delivery, a star and a new label each re-emit only their message", async () => {
    expect(sourceId, "the source was added by an earlier step").toBeTruthy();
    deliverMessage(
      inbox(),
      "1772611200.8.host",
      mail("lunch", "Lunch on Friday", { from: SARAH, date: "2026-03-04T08:00:00Z" }),
      {
        subdir: "new",
      },
    );
    deliverMessage(
      allMail(),
      "1772611200.9.host",
      mail("lunch", "Lunch on Friday", { from: SARAH, date: "2026-03-04T08:00:00Z" }),
      {
        subdir: "new",
      },
    );
    await syncAndWait();
    expect(titles()).toContain("Lunch on Friday");
    expect(metadataOf("Lunch on Friday").tags).toEqual(["INBOX"]);

    // Starred in Gmail: mbsync renames every copy with the F flag.
    renameSync(
      join(allMail(), "cur", maildirFileName("1772443800.2.host", "cur", "S")),
      join(allMail(), "cur", maildirFileName("1772443800.2.host", "cur", "FS")),
    );
    // A label added in Gmail: a new copy appears in the folder named for it.
    deliverMessage(work(), "1772443800.10.host", mail("welcome", "Welcome to the team"), {
      flags: "S",
    });
    await syncAndWait();
    expect(metadataOf("Welcome to the team").extra?.flagged).toBe(true);
    expect(metadataOf("Welcome to the team").tags).toEqual(["INBOX", "STARRED", "Work"]);
    expect(titles()).toHaveLength(4);
  }, 60_000);

  test("archiving keeps a message; deleting its last copy removes it", async () => {
    expect(sourceId, "the source was added by an earlier step").toBeTruthy();
    rmSync(join(inbox(), "cur", maildirFileName("1772443800.1.host", "cur", "S")));
    rmSync(join(work(), "cur", maildirFileName("1772443800.10.host", "cur", "S")));
    await syncAndWait();
    await runAbsenceSweep();
    // All Mail alone holds it now, and that folder tags nothing; the star stays.
    expect(metadataOf("Welcome to the team").tags).toEqual(["STARRED"]);

    // Deleted in Gmail: it moves to Trash, which is never indexed.
    renameSync(
      join(inbox(), "new", "1772611200.8.host"),
      join(trash(), "cur", maildirFileName("1772611200.8.host", "cur", "S")),
    );
    rmSync(join(allMail(), "new", "1772611200.9.host"));
    await syncAndWait();
    await runAbsenceSweep();
    await waitForCondition(
      () => Promise.resolve(!titles().includes("Lunch on Friday")),
      15_000,
      "the deleted message was swept",
    );
    expect(titles()).toEqual([
      "Quarterly planning notes",
      "Re: Welcome to the team",
      "Welcome to the team",
    ]);
  }, 60_000);

  test.skipIf(isRoot)(
    "an unreadable folder withholds deletions until it reads again",
    async () => {
      expect(sourceId, "the source was added by an earlier step").toBeTruthy();
      chmodSync(work(), 0o000);
      try {
        // The only other copy goes: without the Work folder the source cannot
        // tell whether the message is still there, so it must not be deleted.
        rmSync(join(allMail(), "cur", maildirFileName("1772524800.6.host", "cur", "S")));
        await syncAndWait();
        await runAbsenceSweep();
        expect(titles()).toContain("Quarterly planning notes");
      } finally {
        chmodSync(work(), 0o755);
      }
      await syncAndWait();
      await runAbsenceSweep();
      expect(titles()).toContain("Quarterly planning notes");
      expect(metadataOf("Quarterly planning notes").tags).toEqual(["Work"]);
    },
    60_000,
  );

  test("a restarted collector resumes from its index without re-emitting", async () => {
    expect(sourceId, "the source was added by an earlier step").toBeTruthy();
    expect(existsSync(indexPath())).toBe(true);
    const before = rows();
    const emittedBefore = indexState().emitted;
    await stopCollector(collector);
    collector = await startCollector();
    await waitForCondition(
      () => Promise.resolve(collector.engine.getSourcesById(sourceId).length === 1),
      15_000,
      "the restarted collector registered the source again",
    );
    collector.engine.stopSyncLoop();
    await syncAndWait();
    expect(rows()).toEqual(before);
    // Nothing was read or emitted again: every message keeps the page that
    // emitted it, and every file its name.
    const after = indexState();
    expect(after.emitted).toEqual(emittedBefore);
    expect(after.unnamedFiles).toBe(0);
  }, 60_000);

  test("a resync rebuilds the corpus from the tree", async () => {
    expect(sourceId, "the source was added by an earlier step").toBeTruthy();
    const generation = indexState().generation;
    const before = rows().map((row) => [row.external_id, row.title]);
    const stamp = lastSynced();
    await admin(`/admin/sources/${encodeURIComponent(sourceId)}/resync`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    await waitForCondition(
      () =>
        Promise.resolve(
          lastSynced() !== null && lastSynced() !== stamp && rows().length === before.length,
        ),
      30_000,
      "the resync rebuilt every document",
    );
    expect(rows().map((row) => [row.external_id, row.title])).toEqual(before);
    // A new generation, re-emitted from its first page.
    const rebuilt = indexState();
    expect(rebuilt.generation).not.toBe(generation);
    expect(rebuilt.emitted.length).toBe(before.length);
  }, 60_000);

  test("a Thunderbird account kept file per message is indexed and follows stars and deletions", async () => {
    const account = join(scratch, "thunderbird", "Mail", "pop.example.com");
    const READ = 0x0001;
    const STARRED = 0x0004;
    const EXPUNGED = 0x0008;
    const inboxCopy = storeThunderbirdMessage(
      join(account, "INBOX"),
      "1772443800.M1P1Q1.mail-host.example.com",
      mail("tb-welcome", "Board meeting agenda"),
      { status: READ },
    );
    storeThunderbirdMessage(
      join(account, "[Gmail].sbd", "All Mail"),
      "1772443800.M1P1Q2.mail-host.example.com",
      mail("tb-welcome", "Board meeting agenda"),
      { status: READ },
    );
    const receipt = storeThunderbirdMessage(
      join(account, "Archives.sbd", "2026"),
      "1772524800.M1P1Q3.mail-host.example.com",
      mail("tb-receipt", "Your order has shipped", { from: DAVID }),
      { status: READ },
    );
    for (const summary of ["INBOX.msf", "Archives.msf", "[Gmail].msf"]) {
      writeFileSync(join(account, summary), "");
    }

    const tbSource = await addSource(account);
    await syncAndWait(false, tbSource);
    expect(titles(tbSource)).toEqual(["Board meeting agenda", "Your order has shipped"]);
    expect(metadataOf("Board meeting agenda", tbSource).tags).toEqual(["INBOX"]);
    expect(metadataOf("Your order has shipped", tbSource).tags).toEqual(["Archives/2026"]);

    // Starred in Thunderbird: the status header is rewritten in place.
    setThunderbirdStatus(inboxCopy, { status: READ | STARRED }, new Date(Date.now() + 2_000));
    await syncAndWait(false, tbSource);
    expect(metadataOf("Board meeting agenda", tbSource).extra?.flagged).toBe(true);
    expect(metadataOf("Board meeting agenda", tbSource).tags).toEqual(["INBOX", "STARRED"]);

    // Deleted and waiting for the folder to be compacted: Thunderbird marks it
    // expunged in its status header.
    setThunderbirdStatus(receipt, { status: READ | EXPUNGED }, new Date(Date.now() + 4_000));
    await syncAndWait(false, tbSource);
    await runAbsenceSweep();
    await waitForCondition(
      () => Promise.resolve(!titles(tbSource).includes("Your order has shipped")),
      15_000,
      "the message marked deleted was swept",
    );
    expect(titles(tbSource)).toEqual(["Board meeting agenda"]);
  }, 60_000);

  test("a Thunderbird account still stored as mbox says how to convert it", async () => {
    const account = join(scratch, "thunderbird", "Mail", "local-folders");
    mkdirSync(account, { recursive: true });
    writeFileSync(join(account, "Inbox"), "From - 2026-03-02 09:30:00\r\nSubject: x\r\n\r\nx\r\n");
    writeFileSync(join(account, "Inbox.msf"), "");
    const mboxSource = await addSource(account);
    expect(collector.engine.triggerSync(mboxSource).error).toBeUndefined();
    await waitForCondition(
      () =>
        Promise.resolve(
          /Thunderbird mbox files/.test(
            collector.engine.getStatuses().find((s) => s.sourceId === mboxSource)?.lastError ?? "",
          ),
        ),
      30_000,
      "the sync failed with the mbox explanation",
    );
    const status = collector.engine.getStatuses().find((s) => s.sourceId === mboxSource);
    expect(status?.remediation?.summary).toBe("Thunderbird stores this account as mbox");
    expect(status?.remediation?.steps.join(" ")).toMatch(/File per message \(maildir\)/);
    expect(titles(mboxSource)).toEqual([]);
  }, 60_000);
});
