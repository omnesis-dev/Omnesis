// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What a filter on a chat or on a person reads for the two chat sources, from
 * the source to the gateway's stores, through the real collector sync loop
 * and a spawned gateway.
 *
 * The `chat-filters` universe seeds both sources with the same three shapes:
 * a one-to-one chat, a group with a member who never speaks, and a group with
 * a member the source cannot identify.
 *
 * - WhatsApp runs the REAL provider (durable store, group rosters, the LID
 *   map, the normalizer and the list producer) over a `FakeWhatsAppServer`;
 *   the unidentifiable member is known only by a LID.
 * - iMessage is the fixture twin: its days name only the people who spoke,
 *   and `chats.json` states who is in each chat; the unidentifiable member is
 *   a sender with neither a phone number nor an address.
 *
 * Asserted through the gateway's database:
 *   - every conversation carries its chat's id at the path the source
 *     declares, and that id is the list's item id;
 *   - the list holds every chat with its name and members, the silent member
 *     included, and says which chats have a member it cannot name;
 *   - a member added to a group reaches the list on the next ordinary sync,
 *     while no conversation is sent again.
 *
 * Neither source starts writing anything new for filters, so neither raises
 * its version: the fields declare version 0 and the records here are stamped
 * with the version the sources already had.
 *
 * The live WhatsApp controller and the iMessage roster are reached through
 * dynamic imports: a static one would load the synth packages, and cache the
 * active universe, before the harness sets `OMNESIS_SYNTH_UNIVERSE`.
 */

import "./synth-env.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import Database from "better-sqlite3";
import { SyntheticE2EHarness } from "./synth-harness.js";

const WHATSAPP = "whatsapp-messages:+12025550101";
const IMESSAGE = "apple-imessage:sam.rivera@icloud.example";
const WHATSAPP_FIELD = "extra.chatJid";
const IMESSAGE_FIELD = "extra.chatIdentifier";

const SELF = "+12025550101";
const MAYA = "+12025550123";
const JAMIE = "+12025550142";
const DAVID = "+12025550177";

const WA_DIRECT = "12025550123@s.whatsapp.net";
const WA_CREW = "120000000000000001@g.us";
const WA_NEIGHBOURS = "120000000000000002@g.us";
const IM_DIRECT = "+12025550123";
const IM_CREW = "chat100000000000000001";
const IM_NOTICES = "chat100000000000000002";

interface ItemRow {
  item_id: string;
  label: string;
  parent_id: string | null;
  members_incomplete: number;
}

interface ConversationRow {
  external_id: string;
  chat: string | null;
  source_version: number;
  updated_at: number;
  people: string;
}

describe("chat filters: chats, their members and the chat of every conversation", () => {
  let harness: SyntheticE2EHarness;
  let db: InstanceType<typeof Database>;
  const syncedDocuments = new Map<string, number[]>();
  const failures: string[] = [];

  const listRow = (sourceId: string, field: string) =>
    db
      .prepare(
        `SELECT device_id, generation, digest, item_count FROM source_filter_lists
          WHERE source_id = ? AND field = ?`,
      )
      .get(sourceId, field) as
      { device_id: string; generation: number; digest: string; item_count: number } | undefined;

  const items = (sourceId: string, field: string): Map<string, ItemRow> =>
    new Map(
      (
        db
          .prepare(
            `SELECT i.item_id, i.label, i.parent_id, i.members_incomplete
               FROM source_filter_lists l
               JOIN source_filter_items i
                 ON i.source_id = l.source_id AND i.field = l.field
                AND i.device_id = l.device_id AND i.generation = l.generation
              WHERE l.source_id = ? AND l.field = ?`,
          )
          .all(sourceId, field) as ItemRow[]
      ).map((row) => [row.item_id, row]),
    );

  const members = (sourceId: string, field: string, itemId: string): string[] =>
    (
      db
        .prepare(
          `SELECT m.identifier_type || ':' || m.identifier_value AS member
             FROM source_filter_lists l
             JOIN source_filter_item_members m
               ON m.source_id = l.source_id AND m.field = l.field
              AND m.device_id = l.device_id AND m.generation = l.generation
            WHERE l.source_id = ? AND l.field = ? AND m.item_id = ?
            ORDER BY member`,
        )
        .all(sourceId, field, itemId) as Array<{ member: string }>
    ).map((row) => row.member);

  const conversations = (sourceId: string, field: string): ConversationRow[] =>
    db
      .prepare(
        `SELECT external_id,
                json_extract(metadata, '$.' || ?) AS chat,
                source_version, updated_at,
                json_extract(metadata, '$.people') AS people
           FROM documents
          WHERE source_id = ? AND json_extract(metadata, '$.documentType') = 'conversation'
          ORDER BY external_id`,
      )
      .all(field, sourceId) as ConversationRow[];

  /** The phones and addresses on a conversation's participants, as `kind:value`. */
  const participantIdentifiers = (row: ConversationRow): string[] =>
    (JSON.parse(row.people) as Array<{ role: string; phones?: string[]; emails?: string[] }>)
      .filter((person) => person.role === "participant")
      .flatMap((person) => [
        ...(person.phones ?? []).map((value) => `phone:${value}`),
        ...(person.emails ?? []).map((value) => `email:${value}`),
      ])
      .sort();

  const sync = (sourceId: string) => harness.triggerSyncAndWait(sourceId, 60_000);
  const lastSynced = (sourceId: string) => syncedDocuments.get(sourceId)?.at(-1);

  async function whatsapp() {
    const mod = await import("@omnesis/provider-whatsapp-synth");
    const controller = mod.getWhatsAppWrapsRealController(WHATSAPP);
    if (!controller) throw new Error(`no wraps-real controller registered for ${WHATSAPP}`);
    return controller;
  }

  async function imessageRoster() {
    const mod = await import("@omnesis/providers-synth-common");
    const roster = mod.getChatRoster(IMESSAGE);
    if (!roster) throw new Error(`no chat roster registered for ${IMESSAGE}`);
    return roster;
  }

  beforeAll(async () => {
    harness = new SyntheticE2EHarness({ gatewayMode: "stable", universe: "chat-filters" });
    await harness.start();
    harness.onStatusChange((change) => {
      if (change.event === "sync.completed") {
        const counts = syncedDocuments.get(change.sourceId) ?? [];
        counts.push(change.status.lastSyncStats?.documents ?? -1);
        syncedDocuments.set(change.sourceId, counts);
      }
      if (change.event === "sync.error") {
        failures.push(`${change.sourceId}: ${change.status.lastError ?? "unknown error"}`);
      }
    });
    db = new Database(harness.getDbPath(), { readonly: true });

    // The real provider fetches every group's whole roster once its history
    // is sealed, without waiting on it; the list is asserted once it has.
    const store = (await whatsapp()).provider.getStore();
    const deadline = Date.now() + 30_000;
    while (!(
      store.getChat(WA_CREW)?.rosterComplete && store.getChat(WA_NEIGHBOURS)?.rosterComplete
    )) {
      if (Date.now() > deadline) throw new Error("WhatsApp group rosters never arrived");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await sync(WHATSAPP);
    await sync(IMESSAGE);
    // A second cycle, so a list first published before the rosters arrived
    // has been replaced by the settled one.
    await sync(WHATSAPP);
  }, 240_000);

  afterAll(async () => {
    db?.close();
    await harness?.destroy();
  }, 15_000);

  test("every WhatsApp conversation carries its chat's JID, the id the list uses", () => {
    expect(failures).toEqual([]);
    const rows = conversations(WHATSAPP, WHATSAPP_FIELD);
    expect(rows.map((row) => [row.external_id, row.chat])).toEqual([
      [`${WA_CREW}:2026-03-08`, WA_CREW],
      [`${WA_CREW}:2026-03-09`, WA_CREW],
      [`${WA_NEIGHBOURS}:2026-03-08`, WA_NEIGHBOURS],
      [`${WA_DIRECT}:2026-03-08`, WA_DIRECT],
    ]);
    const listed = items(WHATSAPP, WHATSAPP_FIELD);
    for (const row of rows) expect(listed.has(String(row.chat))).toBe(true);
    // Nothing new is written for filters, so the source's version is unchanged.
    expect(new Set(rows.map((row) => row.source_version))).toEqual(new Set([1]));
    // Phones are stored in E.164, the form the list spells its members in.
    const direct = rows.find((row) => row.chat === WA_DIRECT)!;
    expect(participantIdentifiers(direct)).toEqual([`phone:${SELF}`, `phone:${MAYA}`]);
  });

  test("the WhatsApp list holds every chat with its name and members", () => {
    const list = listRow(WHATSAPP, WHATSAPP_FIELD);
    // Chat JIDs mean the same on every device, so the account has one list.
    expect(list).toMatchObject({ device_id: "", item_count: 3 });
    expect(list?.digest).toMatch(/^[0-9a-f]{64}$/);

    const listed = items(WHATSAPP, WHATSAPP_FIELD);
    expect(
      [...listed.values()]
        .map((row) => [row.item_id, row.label, row.parent_id, row.members_incomplete])
        .sort(),
    ).toEqual(
      [
        [WA_DIRECT, "Maya Reeves", null, 0],
        [WA_CREW, "Studio Northstar crew", null, 0],
        // One member is known only by a LID, so the chat's members are not all named.
        [WA_NEIGHBOURS, "Riverside neighbours", null, 1],
      ].sort(),
    );
    expect(members(WHATSAPP, WHATSAPP_FIELD, WA_DIRECT)).toEqual([
      `phone:${SELF}`,
      `phone:${MAYA}`,
    ]);
    // Jamie is in the group and has never written in it.
    expect(members(WHATSAPP, WHATSAPP_FIELD, WA_CREW)).toEqual([
      `phone:${SELF}`,
      `phone:${MAYA}`,
      `phone:${JAMIE}`,
    ]);
    expect(members(WHATSAPP, WHATSAPP_FIELD, WA_NEIGHBOURS)).toEqual([
      `phone:${SELF}`,
      `phone:${MAYA}`,
    ]);
  });

  test("every iMessage conversation carries its chat's identifier, the id the list uses", () => {
    const rows = conversations(IMESSAGE, IMESSAGE_FIELD);
    expect(rows.map((row) => [row.external_id, row.chat])).toEqual([
      [`${IM_DIRECT}:2026-03-08`, IM_DIRECT],
      [`${IM_CREW}:2026-03-08`, IM_CREW],
      [`${IM_CREW}:2026-03-09`, IM_CREW],
      [`${IM_NOTICES}:2026-03-08`, IM_NOTICES],
    ]);
    const listed = items(IMESSAGE, IMESSAGE_FIELD);
    for (const row of rows) expect(listed.has(String(row.chat))).toBe(true);
    expect(new Set(rows.map((row) => row.source_version))).toEqual(new Set([1]));
  });

  test("the iMessage list names a member no conversation of the chat names", () => {
    expect(listRow(IMESSAGE, IMESSAGE_FIELD)).toMatchObject({ device_id: "", item_count: 3 });
    const listed = items(IMESSAGE, IMESSAGE_FIELD);
    expect(
      [...listed.values()].map((row) => [row.item_id, row.label, row.members_incomplete]).sort(),
    ).toEqual(
      [
        [IM_DIRECT, "Maya Reeves", 0],
        [IM_CREW, "Trail crew", 0],
        // A sender with neither a phone number nor an address is in this chat.
        [IM_NOTICES, "Riverside Estate notices", 1],
      ].sort(),
    );

    const crewDays = conversations(IMESSAGE, IMESSAGE_FIELD).filter((row) => row.chat === IM_CREW);
    expect(crewDays).toHaveLength(2);
    for (const day of crewDays) {
      expect(participantIdentifiers(day)).not.toContain(`phone:${JAMIE}`);
    }
    expect(members(IMESSAGE, IMESSAGE_FIELD, IM_CREW)).toEqual([
      "email:maya.reeves@example.com",
      "email:sam.rivera@icloud.example",
      `phone:${SELF}`,
      `phone:${MAYA}`,
      `phone:${JAMIE}`,
    ]);
    expect(members(IMESSAGE, IMESSAGE_FIELD, IM_NOTICES)).toEqual([
      "email:maya.reeves@example.com",
      "email:sam.rivera@icloud.example",
      `phone:${SELF}`,
      `phone:${MAYA}`,
    ]);
  });

  test("the collector is told the digest of each chat list on its sync-state read", async () => {
    for (const [sourceId, field] of [
      [WHATSAPP, WHATSAPP_FIELD],
      [IMESSAGE, IMESSAGE_FIELD],
    ] as const) {
      const state = await harness.gatewayJson<{ filterListDigests?: Record<string, string> }>(
        `/sync-state/${encodeURIComponent(sourceId)}`,
      );
      expect(state.filterListDigests).toEqual({ [field]: listRow(sourceId, field)?.digest });
    }
  });

  test("a member added to a WhatsApp group reaches the list, and no conversation is sent again", async () => {
    const before = listRow(WHATSAPP, WHATSAPP_FIELD)!;
    const stamps = conversations(WHATSAPP, WHATSAPP_FIELD).map((row) => [
      row.external_id,
      row.updated_at,
      row.people,
    ]);

    (await whatsapp()).fake.emitter.emit("group-participants.update", {
      id: WA_CREW,
      participants: ["12025550177@s.whatsapp.net"],
      action: "add",
    });
    await sync(WHATSAPP);

    expect(failures).toEqual([]);
    expect(members(WHATSAPP, WHATSAPP_FIELD, WA_CREW)).toEqual([
      `phone:${SELF}`,
      `phone:${MAYA}`,
      `phone:${JAMIE}`,
      `phone:${DAVID}`,
    ]);
    expect(items(WHATSAPP, WHATSAPP_FIELD).get(WA_CREW)?.members_incomplete).toBe(0);
    const after = listRow(WHATSAPP, WHATSAPP_FIELD)!;
    expect(after.generation).toBe(before.generation + 1);
    expect(after.digest).not.toBe(before.digest);
    // The other chats are as they were.
    expect(members(WHATSAPP, WHATSAPP_FIELD, WA_NEIGHBOURS)).toEqual([
      `phone:${SELF}`,
      `phone:${MAYA}`,
    ]);

    expect(lastSynced(WHATSAPP)).toBe(0);
    expect(
      conversations(WHATSAPP, WHATSAPP_FIELD).map((row) => [
        row.external_id,
        row.updated_at,
        row.people,
      ]),
    ).toEqual(stamps);
  });

  test("a member added to an iMessage group reaches the list, and no conversation is sent again", async () => {
    const before = listRow(IMESSAGE, IMESSAGE_FIELD)!;
    const stamps = conversations(IMESSAGE, IMESSAGE_FIELD).map((row) => [
      row.external_id,
      row.updated_at,
      row.people,
    ]);

    (await imessageRoster()).addMember(IM_CREW, "p_david");
    await sync(IMESSAGE);

    expect(failures).toEqual([]);
    expect(members(IMESSAGE, IMESSAGE_FIELD, IM_CREW)).toEqual([
      "email:david.lin@example.org",
      "email:maya.reeves@example.com",
      "email:sam.rivera@icloud.example",
      `phone:${SELF}`,
      `phone:${MAYA}`,
      `phone:${JAMIE}`,
      `phone:${DAVID}`,
    ]);
    expect(listRow(IMESSAGE, IMESSAGE_FIELD)?.generation).toBe(before.generation + 1);

    expect(lastSynced(IMESSAGE)).toBe(0);
    expect(
      conversations(IMESSAGE, IMESSAGE_FIELD).map((row) => [
        row.external_id,
        row.updated_at,
        row.people,
      ]),
    ).toEqual(stamps);
  });

  test("a sync with nothing changed sends neither list again", async () => {
    const before = [listRow(WHATSAPP, WHATSAPP_FIELD), listRow(IMESSAGE, IMESSAGE_FIELD)];

    await sync(WHATSAPP);
    await sync(IMESSAGE);

    expect(failures).toEqual([]);
    expect([listRow(WHATSAPP, WHATSAPP_FIELD), listRow(IMESSAGE, IMESSAGE_FIELD)]).toEqual(before);
  });
});
