// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { SourceId } from "@omnesis/core";
import { whatsappPersonIdentifiers } from "../../../providers/whatsapp/src/normalizer.js";
import { whatsappScopeMembership } from "../../../providers/whatsapp/src/scope-membership.js";
import { imessageScopeMembership } from "../../../providers/apple/src/imessage-scope-membership.js";
import { portalJson } from "./mcp-oauth-helper.js";
import { SyntheticE2EHarness } from "./synth-harness.js";
import { startScopeScriptedAgent, type ScopeScriptedAgent } from "./scope-scripted-agent.js";
import { pushScopeUpdates } from "./source-scope-fixtures.js";
import { closeScoped } from "./source-scope-external-helpers.js";
import {
  createFilterAccount,
  expectAnswerBoundary,
  expectDirectBoundary,
  expectFilterBoundary,
  filterPolicy,
  closeFilterContext,
  nextDirect,
  openFilterConnection,
  openFilterContext,
  pickPerson,
  pushFilterRecords,
  readyFilterAccounts,
  saveFilters,
  type FilterAccount,
  type FilterCapability,
  type FilterContext,
  type FilterCorpus,
  type FilterRecordInput,
} from "./source-filter-corpus.js";
import type { ScopeRef, SourceScopeConversationUpdate } from "@omnesis/types";

const CAPABILITIES = ["direct", "answer"] as const;
const MAYA = "+12025550123";
const JAMIE = "+12025550145";
const DAVID = "+12025550167";
const jid = (phone: string) => `${phone.slice(1)}@s.whatsapp.net`;
const JAMIE_LID = "224466880011";
const STRANGER_LID = "335577990022";
const GROUP_ALL = "120363000000000001@g.us";
const GROUP_REST = "120363000000000002@g.us";
const JAMIE_EMAIL = "Jamie.Lopez@Example.org";
const IMESSAGE_GROUP = "chat100200300400";

const person = (typed: string, type: "phone" | "email" = "phone"): ScopeRef => ({
  kind: "participant",
  label: typed,
  identifiers: [{ type, value: typed }],
});
const conversationDay = (key: string, conversationId: string): FilterRecordInput => ({
  key,
  documentType: "conversation",
  metadata: { extra: { conversationId, chatId: conversationId, chatName: `Invented ${key}` } },
});

/**
 * Each source's membership is built by the provider's own code from native
 * addresses, forwarded on the wire a collector uses, and read back over MCP
 * through a filter saved the way an owner types it. Nothing in between is
 * spelled by the test, so a disagreement about how a number or an address is
 * written anywhere on that path withholds or shares the wrong conversation.
 */
describe("conversation and person filters over MCP, from native addresses to typed filters", () => {
  let harness: SyntheticE2EHarness;
  let model: ScopeScriptedAgent;
  let whatsapp: FilterAccount;
  let whatsappRecords: FilterCorpus;
  let imessage: FilterAccount;
  let imessageRecords: FilterCorpus;
  let context: FilterContext;

  beforeAll(async () => {
    model = await startScopeScriptedAgent();
    harness = new SyntheticE2EHarness({
      gatewayMode: "synthetic-experimental",
      universe: "e2e-minimal",
      extraInference: {
        backends: { filterChats: { type: "http", url: model.url } },
        assignments: {
          agent: `filterChats/${model.modelId}`,
          "privacy-reviewer": `filterChats/${model.modelId}`,
        },
      },
    });
    await harness.start();

    whatsapp = await createFilterAccount(harness, "whatsapp-messages", "12025550199");
    whatsappRecords = await pushFilterRecords(harness, whatsapp, [
      {
        ...conversationDay("maya", jid(MAYA)),
        metadata: {
          ...conversationDay("maya", jid(MAYA)).metadata,
          people: [
            {
              role: "participant",
              name: "Maya Reeves",
              identifiers: whatsappPersonIdentifiers(
                jid(MAYA),
                SourceId(whatsapp.sourceId),
                new Map(),
                new Map(),
              ),
            },
          ],
        },
      },
      { key: "maya-photo", documentType: "attachment", attachmentOf: "maya" },
      conversationDay("jamie", jid(JAMIE)),
      conversationDay("group-all-monday", GROUP_ALL),
      conversationDay("group-all-tuesday", GROUP_ALL),
      { key: "group-all-file", documentType: "attachment", attachmentOf: "group-all-tuesday" },
      conversationDay("group-rest", GROUP_REST),
      conversationDay("stranger", `${STRANGER_LID}@lid`),
      conversationDay("no-roster", "120363000000000003@g.us"),
      { key: "no-conversation", documentType: "conversation" },
    ]);
    const lidPhoneMap = new Map([[JAMIE_LID, JAMIE]]);
    const membership = (
      chatJid: string,
      participants: string[] | undefined,
      senders: string[],
    ): SourceScopeConversationUpdate =>
      whatsappScopeMembership({
        chatJid,
        chat: {
          jid: chatJid,
          name: "Invented chat",
          isGroup: chatJid.endsWith("@g.us"),
          ...(participants ? { participants } : {}),
        },
        sourceId: SourceId(whatsapp.sourceId),
        contacts: new Map(),
        lidPhoneMap,
        senders,
        authoritativeRoster: participants !== undefined,
        contested: () => false,
        revision: { epoch: "invented-whatsapp", sequence: 1 },
        observedAt: "2026-01-05T00:00:00.000Z",
      });
    await pushScopeUpdates(harness, whatsapp, {
      conversations: [
        membership(jid(MAYA), undefined, [`${MAYA.slice(1)}:7@s.whatsapp.net`]),
        membership(jid(JAMIE), undefined, []),
        // Maya never speaks in the group; Jamie is known there only by an
        // opaque id the source has mapped to a phone number.
        membership(GROUP_ALL, [jid(MAYA), `${JAMIE_LID}@lid`, jid(DAVID)], [jid(DAVID)]),
        membership(GROUP_REST, [`${JAMIE_LID}@lid`, jid(DAVID)], []),
        membership(`${STRANGER_LID}@lid`, undefined, [`${STRANGER_LID}@lid`]),
      ],
    });

    imessage = await createFilterAccount(harness, "apple-imessage", "owner@example.org");
    imessageRecords = await pushFilterRecords(harness, imessage, [
      conversationDay("maya", MAYA),
      { key: "maya-photo", documentType: "attachment", attachmentOf: "maya" },
      conversationDay("jamie", JAMIE_EMAIL),
      conversationDay("group", IMESSAGE_GROUP),
      conversationDay("david", DAVID),
      conversationDay("short-code", "262966"),
    ]);
    const chat = (chatIdentifier: string, participantHandles: string[]) =>
      imessageScopeMembership(
        {
          chatIdentifier,
          displayName: null,
          isGroup: participantHandles.length > 1,
          service: "iMessage",
          participantHandles,
        },
        SourceId(imessage.sourceId),
        [],
        { epoch: "invented-imessage", sequence: 1, observedAt: "2026-01-05T00:00:00.000Z" },
      );
    await pushScopeUpdates(harness, imessage, {
      conversations: [
        chat(MAYA, [MAYA]),
        chat(JAMIE_EMAIL, [JAMIE_EMAIL]),
        chat(IMESSAGE_GROUP, ["+1 (202) 555-0123", JAMIE_EMAIL.toLowerCase()]),
        chat(DAVID, [DAVID]),
        chat("262966", ["262966"]),
      ],
    });
    await readyFilterAccounts(harness, [whatsapp, imessage]);
    context = await openFilterContext(harness, model);
  }, 240_000);

  afterAll(async () => {
    await closeFilterContext(context);
    await harness?.destroy();
    await model?.close();
  }, 30_000);

  const check = (
    account: () => FilterAccount,
    corpus: () => FilterCorpus,
    capability: FilterCapability,
    action: "share" | "hide",
    match: ScopeRef[],
    shared: string[],
  ) => expectFilterBoundary(context, account(), corpus(), capability, action, match, shared);

  describe.each(CAPABILITIES)("WhatsApp, %s", (capability) => {
    const run = (action: "share" | "hide", match: ScopeRef[], shared: string[]) =>
      check(
        () => whatsapp,
        () => whatsappRecords,
        capability,
        action,
        match,
        shared,
      );

    test("share only a person typed with spaces and brackets: their chat and every group they are in", async () => {
      await run(
        "share",
        [person("+1 (202) 555-0123")],
        ["maya", "maya-photo", "group-all-monday", "group-all-tuesday", "group-all-file"],
      );
    }, 420_000);

    test("hide a person typed with an international call prefix: nothing they are part of remains", async () => {
      await run("hide", [person("0012025550123")], ["jamie", "group-rest"]);
    }, 420_000);

    test("a member known by an opaque id is matched by the phone number the source mapped", async () => {
      await run(
        "share",
        [person("+1 202-555-0145")],
        ["jamie", "group-all-monday", "group-all-tuesday", "group-all-file", "group-rest"],
      );
      await run("hide", [person("+1.202.555.0145")], ["maya", "maya-photo"]);
    }, 420_000);

    test("a person picked from the list carries the number the source declared, and counts what it governs", async () => {
      const picked = await pickPerson(harness, nextDirect(context), whatsapp, "maya", MAYA);
      expect(picked.count).toBe(5);
      await run(
        "share",
        [picked.ref],
        ["maya", "maya-photo", "group-all-monday", "group-all-tuesday", "group-all-file"],
      );
      await run("hide", [picked.ref], ["jamie", "group-rest"]);
    }, 420_000);

    test("share only one group conversation, by its native id", async () => {
      await run(
        "share",
        [{ kind: "conversation", id: GROUP_ALL }],
        ["group-all-monday", "group-all-tuesday", "group-all-file"],
      );
    }, 420_000);

    test("hide one group conversation: conversations with unknown members stay readable, a record with no conversation does not", async () => {
      await run(
        "hide",
        [{ kind: "conversation", id: GROUP_ALL }],
        ["maya", "maya-photo", "jamie", "group-rest", "stranger", "no-roster"],
      );
    }, 420_000);

    test("a conversation and a person together share their union, and need both facts known", async () => {
      await run(
        "share",
        [{ kind: "conversation", id: GROUP_REST }, person(MAYA)],
        [
          "maya",
          "maya-photo",
          "group-all-monday",
          "group-all-tuesday",
          "group-all-file",
          "group-rest",
        ],
      );
      await run("hide", [{ kind: "conversation", id: GROUP_REST }, person(MAYA)], ["jamie"]);
    }, 420_000);

    test("a number nobody has shares nothing and hides nothing that is known", async () => {
      await run("share", [person("+12025550188")], []);
      await run(
        "hide",
        [person("+12025550188")],
        [
          "maya",
          "maya-photo",
          "jamie",
          "group-all-monday",
          "group-all-tuesday",
          "group-all-file",
          "group-rest",
        ],
      );
    }, 420_000);
  });

  describe.each(CAPABILITIES)("iMessage, %s", (capability) => {
    const run = (action: "share" | "hide", match: ScopeRef[], shared: string[]) =>
      check(
        () => imessage,
        () => imessageRecords,
        capability,
        action,
        match,
        shared,
      );

    test("a phone handle is matched however the number was typed", async () => {
      await run("share", [person("+1 202 555 0123")], ["maya", "maya-photo", "group"]);
      await run("hide", [person("001 (202) 555-0123")], ["jamie", "david"]);
    }, 420_000);

    test("an email handle is matched whatever its capitals", async () => {
      await run("share", [person("JAMIE.LOPEZ@example.org", "email")], ["jamie", "group"]);
      await run(
        "hide",
        [person("Jamie Lopez <jamie.lopez@EXAMPLE.org>", "email")],
        ["maya", "maya-photo", "david"],
      );
    }, 420_000);

    test("one person saved with both a number and an address is matched by either", async () => {
      const both: ScopeRef = {
        kind: "participant",
        label: "Invented contact with two handles",
        identifiers: [
          { type: "phone", value: "+1 (202) 555-0167" },
          { type: "email", value: JAMIE_EMAIL },
        ],
      };
      await run("share", [both], ["jamie", "group", "david"]);
      await run("hide", [both], ["maya", "maya-photo"]);
    }, 420_000);
  });

  test("a number typed without a country code is refused when the filter is saved, never stored as a filter that matches nothing", async () => {
    const client = nextDirect(context);
    const kept = [filterPolicy(whatsapp, "direct", "hide", [person(MAYA)])];
    await saveFilters(harness, client, [{ capability: "direct", policies: kept }]);
    for (const typed of ["12025550123", "(202) 555-0123", jid(MAYA), "+44 (0)7700 900123"]) {
      await expect(
        saveFilters(harness, client, [
          {
            capability: "direct",
            policies: [filterPolicy(whatsapp, "direct", "hide", [person(typed)])],
          },
        ]),
        typed,
      ).rejects.toThrow(/HTTP 400/);
    }
    // A refused save leaves the filter that was already enforced.
    await expectDirectBoundary(harness, client, whatsapp, whatsappRecords, ["jamie", "group-rest"]);
  }, 420_000);

  test("a filter is stored in one spelling whatever was typed, and its preview counts what it enforces", async () => {
    const client = nextDirect(context);
    await saveFilters(harness, client, [
      {
        capability: "direct",
        policies: [filterPolicy(whatsapp, "direct", "share", [person("00 1 202 555 0123")])],
      },
    ]);
    const overview = await portalJson<{
      levels?: Array<{ rules: Array<{ scopePolicies?: unknown }> }>;
    }>(harness.gatewayUrl, client.portal, "/admin/access");
    const saved = JSON.stringify(overview.levels?.flatMap((level) => level.rules));
    expect(saved).toContain(`"value":"${MAYA}"`);
    expect(saved).not.toContain(`"value":"00`);
    const preview = await portalJson<{ visible: number; unknown: number; total: number }>(
      harness.gatewayUrl,
      client.portal,
      `/admin/access/source-filters/${encodeURIComponent(whatsapp.sourceId)}/preview`,
      { policy: filterPolicy(whatsapp, "direct", "share", [person("+1 (202) 555-0123")]) },
    );
    expect(preview).toMatchObject({ visible: 5, unknown: 3, total: whatsappRecords.size });
  }, 420_000);

  test("Answer and Direct on one level each keep their own filter, and two levels read at once do not bleed", async () => {
    const split = await openFilterConnection(harness, ["direct", "answer"]);
    const other = nextDirect(context);
    try {
      await saveFilters(harness, split, [
        {
          capability: "direct",
          policies: [filterPolicy(whatsapp, "direct", "hide", [person(MAYA)])],
        },
        {
          capability: "answer",
          policies: [filterPolicy(whatsapp, "answer", "share", [person(MAYA)])],
        },
      ]);
      await saveFilters(harness, other, [
        {
          capability: "direct",
          policies: [
            filterPolicy(whatsapp, "direct", "share", [{ kind: "conversation", id: GROUP_ALL }]),
            filterPolicy(imessage, "direct", "hide", [person(JAMIE_EMAIL, "email")]),
          ],
        },
      ]);
      const tools = await split.client.listTools();
      const names = tools.tools.map((tool) => tool.name);
      for (const unfiltered of ["lookup_people", "trace_connections", "temporal_query"])
        expect(names).not.toContain(unfiltered);
      await Promise.all([
        expectDirectBoundary(harness, split, whatsapp, whatsappRecords, ["jamie", "group-rest"]),
        expectAnswerBoundary(model, split, whatsapp, whatsappRecords, [
          "maya",
          "maya-photo",
          "group-all-monday",
          "group-all-tuesday",
          "group-all-file",
        ]),
        expectDirectBoundary(harness, other, whatsapp, whatsappRecords, [
          "group-all-monday",
          "group-all-tuesday",
          "group-all-file",
        ]),
        expectDirectBoundary(harness, other, imessage, imessageRecords, [
          "maya",
          "maya-photo",
          "david",
        ]),
      ]);
      // Removing a level's filters returns the whole account on the next request.
      await saveFilters(harness, other, []);
      await expectDirectBoundary(harness, other, whatsapp, whatsappRecords, [
        ...whatsappRecords.keys(),
      ]);
    } finally {
      await closeScoped(split);
    }
  }, 420_000);

  // Open product questions. Each names behaviour the suite deliberately does
  // not pin, because the intended rule has not been decided.
  test.todo(
    "should one phone number written under two national conventions (a mobile prefix some countries insert after the country code) be one identifier, so a filter typed the way a contact card shows it meets the address a messaging source declares?",
  );
  test.todo(
    "should a member whose number the phone-number library does not recognize still be addressable by its digits, instead of leaving every conversation they are in unknown under a person filter?",
  );
});
