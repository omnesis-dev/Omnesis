// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Person and chat filters on records stored by the first builds of the chat
 * and mail sources, with no resync, through the real ingest path, the real
 * filter check and an agent reading over MCP.
 *
 * WhatsApp and iMessage filters declare version 0: they must catch every
 * conversation stored before versions existed. The records here are written
 * the ways those builds wrote them:
 *
 *  - WhatsApp: the real provider, over the `chat-filters` universe's fake
 *    server, synced by a host that sends no version; plus, pushed as stored
 *    data, the first build's group day stored before the group's roster was
 *    known (its silent member is not on it) and its attachment form;
 *  - iMessage: the fixture twin's days, synced at no version (they name only
 *    who spoke); a day written by the real normalizer with no roster; and the
 *    first build's group day, whose speaker is known by address alone.
 *
 * People are stored in the arrays those builds used (`phones`, `emails`,
 * `lids`). Every filter entry is typed the way an owner copies it from a
 * contact card and read by the editor's identifier route. Asserted, for each
 * filter, with Direct fetch and search: a hidden person hides every record
 * they are on, a group day missing them through the chat's member list, and
 * an attachment through the record it belongs to; a chat with a member known
 * only by a LID, or a sender with no number or address, is hidden under any
 * person filter and counted as one that can't be matched; a hidden chat
 * hides its days and their attachments.
 *
 * Gmail's people, which need version 2, are in `filter-people-mail-cap`.
 */

import "./synth-env.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { normalizeDayChat } from "@omnesis/provider-apple/src/imessage-normalizer.js";
import { ProviderId, SourceId, type DocumentInput, type FilterRef } from "@omnesis/types";
import {
  closeAgents,
  connectAgent,
  documentAudit,
  editorField,
  expectDirectReads,
  fieldCounts,
  grantRule,
  ownerPortal,
  previewFilter,
  providerIdOf,
  readRecords,
  saveFilters,
  sourceFilter,
  typedIdentifier,
  versionsOf,
  type RecordSet,
} from "./filter-e2e-reads.js";
import { SyntheticE2EHarness } from "./synth-harness.js";
import type { AuthorizedMcpClient, PortalSession } from "./mcp-oauth-helper.js";
import type { ParsedIMessage } from "@omnesis/provider-apple/src/imessage-types.js";

const QUERY = "zqfilter";
const PEOPLE = "$people";

const SELF_PHONE = "+12025550101";
const MAYA = "+12025550123";
const JAMIE = "+12025550142";

// ── WhatsApp ───────────────────────────────────────────────────────────────

const WHATSAPP = "whatsapp-messages:+12025550101";
const WA_CHAT = "extra.chatJid";
const WA_DIRECT = "12025550123@s.whatsapp.net";
const WA_CREW = "120000000000000001@g.us";
const WA_NEIGHBOURS = "120000000000000002@g.us";

/** The WhatsApp records by external id. */
const WA_KEYS: Record<string, string> = {
  [`${WA_DIRECT}:2026-03-08`]: "wa-direct",
  [`${WA_CREW}:2026-03-08`]: "wa-crew",
  [`${WA_CREW}:2026-03-09`]: "wa-crew-next",
  [`${WA_NEIGHBOURS}:2026-03-08`]: "wa-neighbours",
  [`${WA_CREW}:2026-03-01`]: "wa-crew-before-roster",
  [`${WA_CREW}:2026-03-08/att/booking.pdf-1024-0`]: "wa-crew-attachment",
};

/** As the first build stored them; the forms are pinned beside the provider's normalizer. */
const waFirstBuild = (providerId: string) => [
  {
    providerId,
    sourceId: WHATSAPP,
    externalId: `${WA_CREW}:2026-03-01`,
    title: "Studio Northstar crew — 2026-03-01",
    content: "zqfilter MARK_WA_BEFORE_ROSTER Maya: The rehearsal list is on the door.",
    metadata: {
      sourceUrl: `whatsapp://chat?jid=${WA_CREW}`,
      tags: [],
      documentType: "conversation",
      people: [
        { role: "participant", name: "You", phones: [SELF_PHONE] },
        { role: "participant", name: "Maya Reeves", phones: [MAYA] },
      ],
      extra: {
        chatJid: WA_CREW,
        chatName: WA_CREW,
        isGroup: false,
        messageCount: 1,
        mediaCount: 0,
        participants: ["Maya Reeves"],
        date: "2026-03-01",
      },
    },
  },
  {
    providerId,
    sourceId: WHATSAPP,
    externalId: `${WA_CREW}:2026-03-08/att/booking.pdf-1024-0`,
    title: "booking.pdf",
    content: "zqfilter MARK_WA_ATTACHMENT Booking confirmation for the rehearsal room.",
    metadata: {
      sourceUrl: `whatsapp://chat?jid=${WA_CREW}`,
      documentType: "attachment",
      people: [
        { role: "participant", name: "You", phones: [SELF_PHONE] },
        { role: "participant", name: "Maya Reeves", phones: [MAYA] },
        { role: "participant", name: "Jamie Lopez", phones: [JAMIE] },
        { role: "participant", name: "LID 20000000…", lids: ["200000000000077"] },
      ],
      extra: {
        parentExternalId: `${WA_CREW}:2026-03-08`,
        originalFilename: "booking.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1024,
        truncated: false,
      },
    },
  },
];

// ── iMessage ───────────────────────────────────────────────────────────────

const IMESSAGE = "apple-imessage:sam.rivera@icloud.example";
const IM_ACCOUNT = "sam.rivera@icloud.example";
const IM_CHAT = "extra.chatIdentifier";
const IM_DIRECT = MAYA;
const IM_CREW = "chat100000000000000001";
const IM_NOTICES = "chat100000000000000002";

const IM_KEYS: Record<string, string> = {
  [`${IM_DIRECT}:2026-03-08`]: "im-direct",
  [`${IM_CREW}:2026-03-08`]: "im-crew",
  [`${IM_CREW}:2026-03-09`]: "im-crew-next",
  [`${IM_NOTICES}:2026-03-08`]: "im-notices",
  [`${IM_CREW}:2026-03-02`]: "im-crew-first-build",
  [`${IM_CREW}:2026-03-10`]: "im-crew-today",
};

/** The first build's group day: the roster was not read, and its speaker is known by address. */
const imFirstBuild = (providerId: string) => ({
  providerId,
  sourceId: IMESSAGE,
  externalId: `${IM_CREW}:2026-03-02`,
  title: "Trail crew — 2026-03-02",
  content: "zqfilter MARK_IM_FIRST_BUILD David: call the venue on +12025550199",
  metadata: {
    documentType: "conversation",
    tags: ["iMessage"],
    people: [
      { role: "participant", name: "You", emails: [IM_ACCOUNT] },
      { role: "participant", emails: ["david.lin@example.org"] },
      { role: "mentioned", phones: ["+12025550199"] },
    ],
    extra: {
      chatIdentifier: IM_CREW,
      chatName: "Trail crew",
      isGroup: true,
      messageCount: 1,
      service: "iMessage",
      participants: ["David.Lin@Example.org"],
      date: "2026-03-02",
    },
  },
});

/** A group day as today's normalizer writes it when the chat's roster is not known. */
function imToday(providerId: string): DocumentInput {
  const message: ParsedIMessage = {
    rowId: 1,
    guid: "invented-guid-1",
    text: "zqfilter MARK_IM_TODAY The north car park again on Saturday.",
    date: new Date("2026-03-10T09:00:00Z"),
    isFromMe: false,
    isSystemMessage: false,
    sender: MAYA,
    service: "iMessage",
    attachments: [],
    contactId: MAYA,
  };
  return normalizeDayChat(
    "2026-03-10",
    [message],
    { chatIdentifier: IM_CREW, displayName: "Trail crew", isGroup: true, service: "iMessage" },
    ProviderId(providerId),
    SourceId(IMESSAGE),
  );
}

const byExternalId =
  (keys: Record<string, string>) =>
  ({ externalId, content }: { externalId: string; content: string }) => {
    const key = keys[externalId];
    return key ? { key, marker: /MARK_[A-Z_]+/.exec(content)?.[0] ?? "" } : null;
  };

const person = (label: string, identifier: { type: "phone" | "email" | "domain"; value: string }) =>
  ({ capability: "person", label, identifiers: [identifier] }) as FilterRef;
const chat = (field: string, id: string): FilterRef => ({ capability: "membership", field, id });

describe("person and chat filters on chat records stored by the first builds", () => {
  let harness: SyntheticE2EHarness;
  let portal: PortalSession;
  let agent: AuthorizedMcpClient;
  let whatsapp: RecordSet;
  let imessage: RecordSet;

  const keysOf = (records: RecordSet, hidden: readonly string[]) =>
    [...records.keys()].filter((key) => !hidden.includes(key));

  beforeAll(async () => {
    harness = new SyntheticE2EHarness({
      gatewayMode: "synthetic-experimental",
      universe: "chat-filters",
    });
    await harness.start();
    // Hosts that predate versions: every synced record is stored at 0.
    harness.setSourceVersion(WHATSAPP, undefined);
    harness.setSourceVersion(IMESSAGE, undefined);
    // The real WhatsApp provider fetches every group's roster once its
    // history is sealed; the chat list is complete once it has.
    const mod = await import("@omnesis/provider-whatsapp-synth");
    const controller = mod.getWhatsAppWrapsRealController(WHATSAPP);
    if (!controller) throw new Error(`no wraps-real controller registered for ${WHATSAPP}`);
    const store = controller.provider.getStore();
    const deadline = Date.now() + 30_000;
    while (!(
      store.getChat(WA_CREW)?.rosterComplete && store.getChat(WA_NEIGHBOURS)?.rosterComplete
    )) {
      if (Date.now() > deadline) throw new Error("WhatsApp group rosters never arrived");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await harness.triggerSyncAndWait(WHATSAPP, 60_000);
    await harness.triggerSyncAndWait(IMESSAGE, 60_000);
    await harness.triggerSyncAndWait(WHATSAPP, 60_000);

    const waProvider = providerIdOf(harness, WHATSAPP);
    const imProvider = providerIdOf(harness, IMESSAGE);
    await harness.pushDocuments(waFirstBuild(waProvider));
    await harness.pushDocuments([
      imFirstBuild(imProvider),
      { ...(imToday(imProvider) as unknown as Record<string, unknown>) },
    ]);
    whatsapp = readRecords(harness, [WHATSAPP], byExternalId(WA_KEYS));
    imessage = readRecords(harness, [IMESSAGE], byExternalId(IM_KEYS));
    await harness.reindexMissing();
    await harness.refreshSearchSnapshot();
    portal = await ownerPortal(harness);
    agent = await connectAgent(harness, "Invented chat reader", [grantRule("direct")]);
  }, 300_000);

  afterAll(async () => {
    await closeAgents([agent]);
    await harness?.destroy();
  }, 30_000);

  test("every record is at version 0, and person and chat filters are ready on both accounts", async () => {
    expect([...whatsapp.keys()].sort()).toEqual(Object.values(WA_KEYS).sort());
    expect([...imessage.keys()].sort()).toEqual(Object.values(IM_KEYS).sort());
    for (const records of [whatsapp, imessage])
      expect(new Set(versionsOf(harness, records).values())).toEqual(new Set([0]));
    for (const [sourceId, field] of [
      [WHATSAPP, WA_CHAT],
      [WHATSAPP, PEOPLE],
      [IMESSAGE, IM_CHAT],
      [IMESSAGE, PEOPLE],
    ] as const) {
      expect((await editorField(harness, sourceId, field)).state, `${sourceId} ${field}`).toEqual({
        status: "ready",
      });
      expect((await fieldCounts(harness, sourceId, field)).tooOld, `${sourceId} ${field}`).toBe(0);
    }
  }, 120_000);

  test("WhatsApp: a person typed from a contact card hides every day they are in, the day stored before the roster and the attachment", async () => {
    const jamie = await typedIdentifier(harness, portal, "phone", "+1 (202) 555-0142");
    expect(jamie).toEqual({ type: "phone", value: JAMIE });
    const filter = sourceFilter(WHATSAPP, "hide", [person("Jamie Lopez", jamie)]);
    await saveFilters(harness, agent, { direct: [filter] });
    await expectDirectReads(harness, agent, whatsapp, ["wa-direct"], QUERY);

    expect(await previewFilter(harness, portal, filter)).toMatchObject({
      total: whatsapp.size,
      visible: 1,
      tooOld: 0,
      unmatched: 1,
      unmatchedText: "1 record can’t be matched to a person and stays hidden.",
    });
    const level = async (key: string) =>
      (await documentAudit(harness, whatsapp.get(key)!)).levels.find(
        (entry) => entry.name === "Invented chat reader",
      )!.direct;
    expect(await level("wa-crew-before-roster")).toEqual({
      readable: false,
      code: "hidden-by-item",
      text: "Hidden by: person Jamie Lopez",
    });
    // A member known only by a LID could be anyone, Jamie included.
    expect(await level("wa-neighbours")).toEqual({
      readable: false,
      code: "detail-unknown",
      text: "Someone it involves cannot be identified",
    });
    expect((await level("wa-direct")).code).toBe("readable");
  }, 300_000);

  test("WhatsApp: a hidden chat hides its days, the one stored before the roster and the attachment", async () => {
    await saveFilters(harness, agent, {
      direct: [sourceFilter(WHATSAPP, "hide", [chat(WA_CHAT, WA_CREW)])],
    });
    await expectDirectReads(
      harness,
      agent,
      whatsapp,
      keysOf(whatsapp, ["wa-crew", "wa-crew-next", "wa-crew-before-roster", "wa-crew-attachment"]),
      QUERY,
    );
  }, 300_000);

  test("iMessage: a silent member hides the group's days through the chat's members", async () => {
    const jamie = await typedIdentifier(harness, portal, "phone", "+1 202-555-0142");
    expect(jamie).toEqual({ type: "phone", value: JAMIE });
    await saveFilters(harness, agent, {
      direct: [sourceFilter(IMESSAGE, "hide", [person("Jamie Lopez", jamie)])],
    });
    // The notices chat has a member with no number or address: hidden as unknown.
    await expectDirectReads(harness, agent, imessage, ["im-direct"], QUERY);
  }, 300_000);

  test("iMessage: an address typed in any case hides the first build's day its owner spoke on", async () => {
    const david = await typedIdentifier(harness, portal, "email", "David.Lin@Example.org");
    expect(david).toEqual({ type: "email", value: "david.lin@example.org" });
    const filter = sourceFilter(IMESSAGE, "hide", [person("David Lin", david)]);
    await saveFilters(harness, agent, { direct: [filter] });
    await expectDirectReads(
      harness,
      agent,
      imessage,
      keysOf(imessage, ["im-crew-first-build", "im-notices"]),
      QUERY,
    );
    expect(await previewFilter(harness, portal, filter)).toMatchObject({
      visible: imessage.size - 2,
      unmatched: 1,
    });
  }, 300_000);

  test("iMessage: a hidden chat hides every day of it, whichever build wrote it", async () => {
    await saveFilters(harness, agent, {
      direct: [sourceFilter(IMESSAGE, "hide", [chat(IM_CHAT, IM_CREW)])],
    });
    await expectDirectReads(harness, agent, imessage, ["im-direct", "im-notices"], QUERY);
  }, 300_000);
});
