// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Chat and person filters on WhatsApp and iMessage, through real MCP Direct
 * and Answer connections and a spawned gateway.
 *
 * The `chat-filters` universe gives both sources the same three chats: a
 * one-to-one chat with Maya, a group in which Jamie is a member who never
 * writes, and a group with a member the source cannot identify (a WhatsApp
 * member known only by a LID; an iMessage sender with no number or
 * address). WhatsApp runs the real provider over a fake server; iMessage is
 * the fixture twin. Each source writes the chat's id on every day of a
 * conversation and publishes the list of its chats with their members; its
 * person filter counts a chat's listed members as involved in every day of
 * it. Nothing is pushed or written by hand.
 *
 * Asserted for both sources, through Direct (search, fetch by id) and Answer:
 *   - a chat filter shares or hides exactly the days of that chat;
 *   - a person filter catches a chat through its member list: the silent
 *     member's group is hidden by "hide Jamie" and shared by "share Jamie"
 *     (on iMessage no day of it names Jamie; WhatsApp names every member of
 *     a group on each of its days), and a member who joins later is caught
 *     on days stored before they joined;
 *   - a chat whose members are not all known, with no match, is hidden under
 *     a person filter, whichever its action, while a member it does list
 *     still matches it; a day that itself names someone the source cannot
 *     identify is unknown whatever the match; the editor counts those days
 *     as ones it cannot match;
 *   - a person typed with spaces and brackets matches the number the source
 *     stored, and a person picked from the editor's list matches what the
 *     source declared;
 *   - a member who joins or leaves a group changes what a saved person filter
 *     reads at the next sync, with no conversation sent again; a day that
 *     named the member who left keeps naming them.
 *
 * The live WhatsApp controller and the iMessage roster are reached through
 * dynamic imports: a static one would load the synth packages, and cache the
 * active universe, before the harness sets `OMNESIS_SYNTH_UNIVERSE`.
 */

import "./synth-env.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { startScopeScriptedAgent, type ScopeScriptedAgent } from "./scope-scripted-agent.js";
import {
  closeFilterContext,
  expectFilterBoundary,
  filterEditor,
  filterOptions,
  openFilterContext,
  pickPerson,
  readFilterCorpus,
  startFilterHarness,
  typedIdentifier,
  typedPerson,
  type FilterAccess,
  type FilterContext,
  type FilterCorpus,
} from "./source-filter-corpus.js";
import type { SyntheticE2EHarness } from "./synth-harness.js";
import type { FilterRef } from "@omnesis/types";

const WHATSAPP = "whatsapp-messages:+12025550101";
const IMESSAGE = "apple-imessage:sam.rivera@icloud.example";
const ACCESSES: FilterAccess[] = ["direct", "answer"];

/** A WhatsApp address: a person's by their number, a group's by its id. */
const personJid = (phone: string) => `${phone.slice(1)}@s.whatsapp.net`;
const groupJid = (id: string) => `${id}@g.us`;
const WA_DIRECT = personJid("+12025550123");
const WA_CREW = groupJid("120000000000000001");
const WA_PARTIAL = groupJid("120000000000000002");

interface ChatSource {
  sourceId: string;
  field: string;
  chats: { direct: string; crew: string; partial: string };
  /** Each day of a conversation, by external id: its key and a sentence only it holds. */
  days: Record<string, [string, string]>;
  /**
   * Whether a group's day names every member of the group as it stood that
   * day, or only the people who wrote in it.
   */
  daysNameRoster: boolean;
}

const SOURCES: Record<"whatsapp" | "imessage", ChatSource> = {
  whatsapp: {
    sourceId: WHATSAPP,
    field: "extra.chatJid",
    chats: {
      direct: WA_DIRECT,
      crew: WA_CREW,
      partial: WA_PARTIAL,
    },
    days: {
      [`${WA_DIRECT}:2026-03-08`]: ["direct", "Are you still free for the trail run on Saturday?"],
      [`${WA_CREW}:2026-03-08`]: ["crew-1", "The rehearsal room is booked for Thursday evening."],
      [`${WA_CREW}:2026-03-09`]: ["crew-2", "Doors open at six, bring the cables."],
      [`${WA_PARTIAL}:2026-03-08`]: ["partial", "The street cleaning moved to Monday morning."],
    },
    daysNameRoster: true,
  },
  imessage: {
    sourceId: IMESSAGE,
    field: "extra.chatIdentifier",
    chats: {
      direct: "+12025550123",
      crew: "chat100000000000000001",
      partial: "chat100000000000000002",
    },
    days: {
      "+12025550123:2026-03-08": [
        "direct",
        "Could you send the marathon entry form when you have a minute?",
      ],
      "chat100000000000000001:2026-03-08": [
        "crew-1",
        "Saturday start is at the north car park, seven sharp.",
      ],
      "chat100000000000000001:2026-03-09": ["crew-2", "I can drive two people."],
      "chat100000000000000002:2026-03-08": ["partial", "The bin collection day changes next week."],
    },
    daysNameRoster: false,
  },
};

const MAYA = "+12025550123";
const JAMIE = "+12025550142";
const DAVID = "+12025550177";
const CREW = ["crew-1", "crew-2"];

describe("chat and person filters over MCP, from chat lists to what an agent reads", () => {
  let harness: SyntheticE2EHarness;
  let model: ScopeScriptedAgent;
  let context: FilterContext;
  const corpora = new Map<string, FilterCorpus>();
  /** The document count each completed sync reported, per source, in order. */
  const synced: Record<string, number[]> = { [WHATSAPP]: [], [IMESSAGE]: [] };
  const failures: string[] = [];
  let jamie: FilterRef;
  let david: FilterRef;

  const chat = (source: ChatSource, id: string): FilterRef => ({
    capability: "membership",
    field: source.field,
    id,
  });
  const sync = (sourceId: string) => harness.triggerSyncAndWait(sourceId, 60_000);

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
    model = await startScopeScriptedAgent();
    harness = startFilterHarness("chat-filters", model);
    await harness.start();
    harness.onStatusChange((change) => {
      const sourceId = String(change.sourceId);
      if (!(sourceId in synced)) return;
      if (change.event === "sync.completed")
        synced[sourceId]!.push(change.status.lastSyncStats?.documents ?? -1);
      if (change.event === "sync.error")
        failures.push(`${sourceId}: ${change.status.lastError ?? "unknown error"}`);
    });
    // The real provider fetches every group's whole roster once its history
    // is sealed; the list is published once it has.
    const store = (await whatsapp()).provider.getStore();
    const deadline = Date.now() + 30_000;
    while (!(
      store.getChat(SOURCES.whatsapp.chats.crew)?.rosterComplete &&
      store.getChat(SOURCES.whatsapp.chats.partial)?.rosterComplete
    )) {
      if (Date.now() > deadline) throw new Error("WhatsApp group rosters never arrived");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await sync(WHATSAPP);
    await sync(IMESSAGE);
    // A second cycle, so a list first published before the rosters arrived
    // has been replaced by the settled one.
    await sync(WHATSAPP);
    for (const source of Object.values(SOURCES))
      corpora.set(
        source.sourceId,
        readFilterCorpus(harness, source.sourceId, {
          describe: (row) => {
            const day = source.days[row.external_id];
            return day ? { key: day[0], body: day[1] } : null;
          },
        }),
      );
    context = await openFilterContext(harness, model);
    jamie = await typedPerson(harness, context.portal, "Jamie Lopez", [
      ["phone", "+1 (202) 555-0142"],
    ]);
    david = await typedPerson(harness, context.portal, "David", [["phone", "001 202 555 0177"]]);
  }, 300_000);

  afterAll(async () => {
    await closeFilterContext(context);
    await harness?.destroy();
    await model?.close();
  }, 30_000);

  test("both sources hold the four days of the three chats", () => {
    expect(failures).toEqual([]);
    for (const source of Object.values(SOURCES))
      expect([...corpora.get(source.sourceId)!.records.keys()].sort()).toEqual(
        ["crew-1", "crew-2", "direct", "partial"].sort(),
      );
  });

  test("a typed number is read into the spelling the sources store, and a number without a country code is refused", async () => {
    expect(jamie).toEqual({
      capability: "person",
      label: "Jamie Lopez",
      identifiers: [{ type: "phone", value: JAMIE }],
    });
    expect(david).toMatchObject({ identifiers: [{ type: "phone", value: DAVID }] });
    expect(await typedIdentifier(harness, context.portal, "phone", "202 555 0142")).toEqual({
      error: expect.stringMatching(/country code/),
    });
  });

  for (const [name, source] of Object.entries(SOURCES)) {
    test(`${name}: the editor offers chats and people, and counts the days a person filter cannot match`, async () => {
      const editor = await filterEditor(harness, context.portal, source.sourceId);
      expect(editor).toMatchObject({ profile: "declared", showDeviceLevel: false });
      const people = editor.fields.find((field) => field.field === "$people");
      expect(people).toMatchObject({
        capability: "person",
        picker: "search",
        state: { status: "ready" },
        // The group with a member the source cannot name.
        counts: {
          status: "ready",
          tooOld: 0,
          unmatched: 1,
          unmatchedText: "1 record can’t be matched to a person and stays hidden.",
        },
      });
      const chats = editor.fields.find((field) => field.field === source.field);
      expect(chats).toMatchObject({
        capability: "membership",
        state: { status: "ready" },
        counts: { status: "ready", tooOld: 0, unmatched: 0 },
      });
      const options = await filterOptions(harness, context.portal, source.sourceId, {
        field: source.field,
      });
      expect(
        Object.fromEntries(
          options.items.map((item) => [(item.ref as { id: string }).id, item.count]),
        ),
      ).toEqual({ [source.chats.direct]: 1, [source.chats.crew]: 2, [source.chats.partial]: 1 });
    });

    for (const access of ACCESSES) {
      const corpus = () => corpora.get(source.sourceId)!;

      test(`${name} ${access}: share only one group — its days, nothing else`, async () => {
        await expectFilterBoundary(
          context,
          corpus(),
          access,
          "share",
          [chat(source, source.chats.crew)],
          CREW,
        );
      });

      test(`${name} ${access}: hide one group — every other chat stays`, async () => {
        await expectFilterBoundary(
          context,
          corpus(),
          access,
          "hide",
          [chat(source, source.chats.crew)],
          ["direct", "partial"],
        );
      });

      test(`${name} ${access}: hide a member who never writes — their group goes through its member list, the chat with an unknown member goes too`, async () => {
        await expectFilterBoundary(context, corpus(), access, "hide", [jamie], ["direct"]);
      });

      test(`${name} ${access}: share only a member who never writes — their group, and not the chat whose members are not all known`, async () => {
        await expectFilterBoundary(context, corpus(), access, "share", [jamie], CREW);
      });

      test(`${name} ${access}: share a person picked from the editor — every chat she is in, unless the day itself names someone the source cannot identify`, async () => {
        const maya = await pickPerson(harness, context.portal, source.sourceId, "Maya", MAYA);
        // A member only the list cannot name leaves her match standing; a
        // person named on the day itself whom the source cannot identify
        // makes the day unknown, whatever else it names.
        await expectFilterBoundary(
          context,
          corpus(),
          access,
          "share",
          [maya.ref],
          source.daysNameRoster ? ["direct", ...CREW] : ["direct", ...CREW, "partial"],
        );
      });

      test(`${name} ${access}: a chat and a person together share their union`, async () => {
        await expectFilterBoundary(
          context,
          corpus(),
          access,
          "share",
          [chat(source, source.chats.direct), jamie],
          ["direct", ...CREW],
        );
      });
    }
  }

  test("a member who leaves and one who joins change a saved person filter at the next sync, and no conversation is sent again", async () => {
    const live = await whatsapp();
    live.fake.emitter.emit("group-participants.update", {
      id: SOURCES.whatsapp.chats.crew,
      participants: [personJid(JAMIE)],
      action: "remove",
    });
    live.fake.emitter.emit("group-participants.update", {
      id: SOURCES.whatsapp.chats.crew,
      participants: [personJid(DAVID)],
      action: "add",
    });
    const roster = await imessageRoster();
    roster.removeMember(SOURCES.imessage.chats.crew, "p_jamie");
    roster.addMember(SOURCES.imessage.chats.crew, "p_david");
    await sync(WHATSAPP);
    await sync(IMESSAGE);
    expect(failures).toEqual([]);
    expect(synced[WHATSAPP]!.at(-1)).toBe(0);
    expect(synced[IMESSAGE]!.at(-1)).toBe(0);

    for (const source of Object.values(SOURCES))
      for (const access of ACCESSES) {
        const corpus = corpora.get(source.sourceId)!;
        // A day that names the group as it stood still names Jamie; a day
        // that names its writers only no longer reaches Jamie through the list.
        await expectFilterBoundary(
          context,
          corpus,
          access,
          "hide",
          [jamie],
          source.daysNameRoster ? ["direct"] : ["direct", ...CREW],
        );
        // No stored day names David; the list does.
        await expectFilterBoundary(context, corpus, access, "share", [david], CREW);
      }
  });
});
