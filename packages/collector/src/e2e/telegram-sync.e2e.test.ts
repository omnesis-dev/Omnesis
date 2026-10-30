// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Gateway-level E2E driving the REAL Telegram provider through the full
 * collector → gateway → indexer → search pipeline.
 *
 * The `telegram-sync` universe ships a `fake-corpus.json`, so the synth
 * Telegram twin runs the real provider, archive, history walk and normalizer
 * over the in-memory `SimulatedTelegram` (the production `AdapterFactory`
 * seam); only mtcute and the QR sign-in are replaced. Asserts, through a
 * spawned gateway:
 *   - the bootstrap walk lands one document per chat per UTC day, archived
 *     chats and Saved Messages included, the opt-in channel left out, and the
 *     day documents are searchable; it reads history through a data export
 *     (takeout) session, which it finishes once the walk is done;
 *   - a forum day renders each message with its topic and names the topics;
 *   - a live edit and a live deletion through the simulated server are
 *     reflected in the stored day document;
 *   - a voice note is transcribed into its day (the gateway runs the replay
 *     transcriber, which reads the audio bytes back as text: no model), and a
 *     text document becomes a searchable attachment of its day;
 *   - deleting the message that carried an attachment removes the attachment
 *     and keeps the day;
 *   - a day whose every message is deleted disappears from the gateway;
 *   - the account's own messages resolve to the cast's self person through
 *     the descriptor's `selfIdentity` alias.
 *
 * Switching channels on and off is a config change, which rebuilds the
 * source; the harness has no source manager to do that, so the toggle (with
 * a channel attachment) is covered over the same real source in
 * `packages/providers/telegram/src/messages.test.ts`.
 *
 * The controller is reached through a dynamic import: a static one would load
 * the synth package, and cache the active universe, before the harness sets
 * `OMNESIS_SYNTH_UNIVERSE`.
 */

import "./synth-env.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import Database from "better-sqlite3";
import { SyntheticE2EHarness } from "./synth-harness.js";
import type { TelegramWrapsRealController } from "@omnesis/provider-telegram-synth";

const SELF_ID = 5550100201;
const MAYA_ID = 5550100202;
const SOURCE_ID = `telegram-messages:${SELF_ID}`;
const MAYA_DAY_1 = `${MAYA_ID}:2026-03-10`;
const MAYA_DAY_2 = `${MAYA_ID}:2026-03-11`;
const CLUB_DAY = "-1001500000001:2026-03-10";
const CREW_DAY = "-4001500001:2026-03-12";
const SAVED_DAY = `${SELF_ID}:2026-03-12`;
const CHANNEL_DAY = "-1001500000002:2026-03-12";
const FORUM_DAY = "-1001500000003:2026-03-13";

interface DocRow {
  id: string;
  external_id: string;
  content: string;
  metadata: string;
}

async function controller(): Promise<TelegramWrapsRealController> {
  const mod = await import("@omnesis/provider-telegram-synth");
  const ctrl = mod.getTelegramWrapsRealController(SOURCE_ID);
  if (!ctrl) throw new Error(`no wraps-real controller registered for ${SOURCE_ID}`);
  return ctrl;
}

async function waitFor<T>(
  probe: () => T | undefined | Promise<T | undefined>,
  what: string,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

describe("Telegram wraps-real: day documents, live edits and deletions, self identity", () => {
  // Day documents write clock times in the collector host's zone; pin it so the
  // asserted times do not depend on where the suite runs.
  const priorTz = process.env.TZ;
  process.env.TZ = "UTC";
  afterAll(() => {
    if (priorTz === undefined) delete process.env.TZ;
    else process.env.TZ = priorTz;
  });

  let harness: SyntheticE2EHarness;
  let db: InstanceType<typeof Database>;

  const doc = (externalId: string): DocRow | undefined =>
    db
      .prepare(
        "SELECT id, external_id, content, metadata FROM documents WHERE source_id = ? AND external_id = ?",
      )
      .get(SOURCE_ID, externalId) as DocRow | undefined;

  const attachmentOf = (dayId: string): DocRow | undefined =>
    db
      .prepare(
        "SELECT id, external_id, content, metadata FROM documents WHERE source_id = ? AND external_id LIKE ?",
      )
      .get(SOURCE_ID, `${dayId}/att/%`) as DocRow | undefined;

  const selfAliasOwner = (): { is_self: number; name: string } | undefined =>
    db
      .prepare(
        `SELECT p.is_self AS is_self, p.canonical_name AS name FROM person_aliases a
         JOIN people p ON p.id = a.person_id
         WHERE a.alias_type = 'lid' AND a.alias = ? AND p.merged_into IS NULL`,
      )
      .get(`telegram-user:${SELF_ID}`) as { is_self: number; name: string } | undefined;

  beforeAll(async () => {
    harness = new SyntheticE2EHarness({
      gatewayMode: "synthetic",
      universe: "telegram-sync",
      transcriberBackend: "replay",
      sourceMediaProcessing: true,
      extraGatewayConfig: {
        // The install-level operator: the self person the alias attaches to.
        // A self is only created with an identifier, not from a name alone.
        self: { name: "Sarah Mendez", emails: ["sarah.mendez@example.com"] },
      },
    });
    await harness.start();
    db = new Database(harness.getDbPath(), { readonly: true });
    // The self person is bootstrapped from the config after boot, and the
    // collector's self-identity push pairs the account's alias onto it; both
    // must have happened before the first sync, as on a real install.
    await waitFor(
      () => (selfAliasOwner()?.is_self === 1 ? true : undefined),
      "the Telegram self alias on the self person",
      120_000,
    );
    await harness.triggerSyncAndWait(SOURCE_ID, 60_000);
  }, 240_000);

  afterAll(async () => {
    db?.close();
    await harness?.destroy();
  }, 30_000);

  test("the bootstrap lands one document per chat and day, without the opt-in channel", () => {
    const ids = (
      db.prepare("SELECT external_id FROM documents WHERE source_id = ?").all(SOURCE_ID) as Array<{
        external_id: string;
      }>
    )
      .map((r) => r.external_id)
      .filter((id) => !id.includes("/att/"))
      .sort();
    expect(ids).toEqual([CLUB_DAY, CREW_DAY, FORUM_DAY, MAYA_DAY_1, MAYA_DAY_2, SAVED_DAY].sort());
    expect(doc(CHANNEL_DAY)).toBeUndefined();

    const maya = doc(MAYA_DAY_1)!;
    expect(maya.content).toContain("**09:00** Maya Reeves: The pelican migration figures");
    expect(maya.content).toContain("**09:05** You: I will rerun the heron counts");
    expect(maya.content).toContain("[Document: entry-form.pdf]");
    const club = doc(CLUB_DAY)!;
    expect(club.content).toContain("> _Jamie Lopez: Long run on Saturday");
    expect(JSON.parse(doc(CREW_DAY)!.metadata)).toMatchObject({
      extra: { chatKind: "group", isArchived: true, isGroup: true },
    });
  });

  test("the bootstrap walk read history through a data export it then finished", async () => {
    const ctrl = await controller();
    expect(ctrl.server.takeoutScopes).toEqual([
      { messageUsers: true, messageChats: true, messageMegagroups: true, messageChannels: false },
    ]);
    const methods = ctrl.server.calls.map((c) => c.method);
    expect(methods).toContain("takeoutGetHistory");
    expect(methods.filter((m) => m === "finishTakeout")).toHaveLength(1);
    expect(ctrl.provider.getArchive().takeoutState().state).toBe("done");
  });

  test("a forum day renders each message with its topic", () => {
    const forum = doc(FORUM_DAY)!;
    expect(forum.content).toContain(
      "**07:00** [#Equipment] Jamie Lopez: The spare paddles are in the blue locker.",
    );
    expect(forum.content).toContain("**07:30** [#Trips] David Lin: Estuary trip is planned");
    expect(JSON.parse(forum.metadata)).toMatchObject({
      extra: { chatKind: "forum", isGroup: true, topics: ["Equipment", "Trips"] },
    });
  });

  test("day documents are searchable", async () => {
    await harness.refreshSearchSnapshot();
    const res = (await harness.gatewayJson(
      `/documents/search?q=${encodeURIComponent("pelican migration")}&limit=50`,
    )) as { results?: Array<{ source_id: string }> };
    expect((res.results ?? []).some((r) => r.source_id === SOURCE_ID)).toBe(true);
  });

  test("a voice note is transcribed inline and a document becomes an attachment", async () => {
    // Media is downloaded a budgeted few per page; later syncs work through it.
    const attachment = await waitFor(async () => {
      const att = attachmentOf(MAYA_DAY_1);
      if (doc(MAYA_DAY_2)?.content.includes("Remember the spotting scope") && att) return att;
      await harness.triggerSyncAndWait(SOURCE_ID, 60_000);
      return undefined;
    }, "the transcribed voice note and the extracted attachment");
    expect(doc(MAYA_DAY_2)!.content).toContain(
      "Maya Reeves: [Voice note, 0:09]: Remember the spotting scope for the Saturday survey.",
    );
    expect(attachment.content).toContain("Heron tally for the north marsh");
    expect(JSON.parse(attachment.metadata)).toMatchObject({
      documentType: "attachment",
      extra: { parentExternalId: MAYA_DAY_1, originalFilename: "heron-tally.txt" },
    });
    await harness.refreshSearchSnapshot();
    const res = (await harness.gatewayJson(
      `/documents/search?q=${encodeURIComponent("Heron tally for the north marsh")}&limit=50`,
    )) as { results?: Array<{ external_id?: string; source_id: string }> };
    expect((res.results ?? []).some((r) => r.source_id === SOURCE_ID)).toBe(true);
  });

  test("deleting the message that carried an attachment removes only the attachment", async () => {
    const ctrl = await controller();
    const attachmentId = attachmentOf(MAYA_DAY_1)!.external_id;
    ctrl.server.pushDelete(MAYA_ID, [106]);
    await harness.triggerSyncAndWait(SOURCE_ID, 60_000);
    await waitFor(
      () => (doc(attachmentId) ? undefined : true),
      "the deleted message's attachment to be removed",
    );
    expect(doc(MAYA_DAY_1)!.content).not.toContain("The tally sheet");
  });

  test("a live edit and a live deletion are reflected in the day document", async () => {
    const ctrl = await controller();
    ctrl.server.pushEdit(
      MAYA_ID,
      101,
      "The pelican migration figures are fine after all.",
      Date.parse("2026-03-10T10:00:00Z") / 1000,
    );
    ctrl.server.pushDelete(MAYA_ID, [103]);
    await harness.triggerSyncAndWait(SOURCE_ID, 60_000);
    const maya = await waitFor(() => {
      const row = doc(MAYA_DAY_1);
      return row?.content.includes("fine after all") ? row : undefined;
    }, "the edited Maya day");
    expect(maya.content).toContain("are fine after all. (edited)");
    expect(maya.content).not.toContain("entry-form.pdf");
  });

  test("a day whose messages are all deleted disappears", async () => {
    const ctrl = await controller();
    ctrl.server.pushDelete(MAYA_ID, [107, 108]);
    await harness.triggerSyncAndWait(SOURCE_ID, 60_000);
    await waitFor(() => (doc(MAYA_DAY_2) ? undefined : true), "the emptied day to be removed");
    expect(doc(MAYA_DAY_1)).toBeDefined();
  });

  test("the account's own messages resolve to the self person, not a new one", () => {
    expect(selfAliasOwner()).toEqual({ is_self: 1, name: "Sarah Mendez" });
    const you = db
      .prepare("SELECT COUNT(*) AS c FROM people WHERE canonical_name = 'You'")
      .get() as {
      c: number;
    };
    expect(you.c).toBe(0);
  });
});
