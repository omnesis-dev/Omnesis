// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { conversationScopeWork, SOURCE_SCOPE_PAGE_WORK } from "@omnesis/source-sdk";
import { SourceId } from "@omnesis/types";
import { MessageStore } from "./message-store.js";
import { WhatsAppMessagesSource } from "./messages.js";
import { whatsappScopeMembership } from "./scope-membership.js";

const group = "scope-fixture@g.us";
const phone = "12025550101@s.whatsapp.net";
const quietPhone = "12025550102@s.whatsapp.net";
const lid = "scope-member@lid";

describe("WhatsApp native membership scopes", () => {
  let store: MessageStore;
  let source: WhatsAppMessagesSource;
  beforeEach(() => {
    store = new MessageStore();
    source = new WhatsAppMessagesSource(store, "+12025550100");
  });
  afterEach(() => store.close());
  it("publishes silent members and joins/leaves with no new message or day resync", async () => {
    store.addChats([{ jid: group, name: "Cedar planning", isGroup: true }]);
    store.updateGroupRoster(group, [phone, quietPhone]);
    store.addMessages([
      {
        id: "one",
        chatJid: group,
        senderJid: phone,
        senderName: "Maya",
        fromMe: false,
        timestamp: 1767225600,
        type: "text",
        text: "Fictional planning note.",
      },
    ]);
    const oldGateway = await source.sync(null);
    expect(oldGateway.scopeUpdates).toBeUndefined();
    expect(oldGateway.documents[0].metadata.extra?.scopeConversation).toBeUndefined();
    const negotiated = await source.sync(oldGateway.cursor, { scopeFactsSupported: true });
    expect(negotiated.documents).toEqual([]);
    const first = negotiated.scopeUpdates!.conversations!.find((update) => update.id === group)!;
    expect(first.mode).toBe("snapshot");
    expect(
      first.participants.some((person) =>
        person.identifiers?.some((id) => id.value === "+12025550102"),
      ),
    ).toBe(true);
    store.removeGroupParticipants(group, [phone]);
    const removed = await source.sync(negotiated.cursor, { scopeFactsSupported: true });
    expect(removed.documents).toEqual([]);
    const next = removed.scopeUpdates!.conversations![0]!;
    expect(next.revision.epoch).toBe(first.revision.epoch);
    expect(next.revision.sequence).toBeGreaterThan(first.revision.sequence);
    expect(
      next.participants.some((person) =>
        person.identifiers?.some((id) => id.value === "+12025550101"),
      ),
    ).toBe(false);
    store.addGroupParticipants(group, [phone]);
    const joined = await source.sync(removed.cursor, { scopeFactsSupported: true });
    expect(
      joined.scopeUpdates!.conversations![0]!.participants.some((person) =>
        person.identifiers?.some((id) => id.value === "+12025550101"),
      ),
    ).toBe(true);
    const idle = await source.sync(joined.cursor, { scopeFactsSupported: true });
    expect(idle.scopeUpdates!.conversations).toEqual([]);
  });
  it("replays rejected membership pages until the matching archive cursor acknowledges them", () => {
    store.addChats([
      { jid: group, name: "Cedar planning", isGroup: true },
      { jid: "another-scope", name: "Another planning", isGroup: true },
    ]);
    store.updateGroupRoster(group, [phone]);
    store.enrollScopeMembership();
    const first = store.drainScopeMembership(0, 1);
    expect(first.morePending).toBe(true);
    const retry = store.drainScopeMembership(0, 1);
    expect(retry.chats).toEqual(first.chats);
    const second = store.drainScopeMembership(retry.emitSeq, 1);
    expect(second.chats).toHaveLength(1);
    expect(second.chats[0]!.chat_jid).not.toBe(first.chats[0]!.chat_jid);
    expect(store.drainScopeMembership(second.emitSeq).chats).toEqual([]);
  });
  it("publishes native LID resolution and contested mapping changes without rewriting old days", async () => {
    store.addChats([{ jid: group, name: "Cedar planning", isGroup: true }]);
    store.updateGroupRoster(group, [lid]);
    const first = await source.sync(null, { scopeFactsSupported: true });
    expect(
      first.scopeUpdates!.conversations![0]!.participants.some((person) =>
        person.identifiers?.some((id) => id.kind === "lid"),
      ),
    ).toBe(true);
    store.setLIDPhone(lid, "+12025550101");
    const mapped = await source.sync(first.cursor, { scopeFactsSupported: true });
    expect(mapped.documents).toEqual([]);
    expect(
      mapped.scopeUpdates!.conversations![0]!.participants.some((person) =>
        person.identifiers?.some((id) => id.kind === "phone" && id.value === "+12025550101"),
      ),
    ).toBe(true);
    store.setLIDPhone(lid, "+12025550102");
    const contested = await source.sync(mapped.cursor, { scopeFactsSupported: true });
    const member = contested.scopeUpdates!.conversations![0]!.participants.find((person) =>
      person.identifiers?.some((id) => id.kind === "lid"),
    )!;
    expect(member.identifiers!.some((id) => id.kind === "phone")).toBe(false);
  });
  it("matches remove events across native LID and phone forms, and hides an unresolvable removal", () => {
    store.addChats([{ jid: group, name: "Cedar planning", isGroup: true }]);
    store.updateGroupRoster(group, [phone, quietPhone]);
    store.setLIDPhone(lid, "+12025550101");
    store.removeGroupParticipants(group, [lid]);
    expect(store.getChat(group)!.participants).toEqual([quietPhone]);
    store.removeGroupParticipants(group, ["unknown-scope-member@lid"]);
    expect(store.isScopeRosterAuthoritative(group)).toBe(false);
    expect(store.isScopeRosterUncertain(group)).toBe(true);
  });
  it("uses a full roster instead of historical speakers and never trusts a contested contact fallback", () => {
    const result = whatsappScopeMembership({
      chatJid: group,
      chat: { jid: group, name: "Cedar planning", isGroup: true, participants: [lid] },
      sourceId: SourceId("whatsapp-messages:+12025550100"),
      contacts: new Map([[phone, { jid: phone, name: "Maya", lid }]]),
      lidPhoneMap: new Map(),
      senders: [quietPhone],
      authoritativeRoster: true,
      contested: () => true,
      revision: { epoch: "fixture", sequence: 1 },
      observedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(result.mode).toBe("snapshot");
    expect(
      result.participants
        .flatMap((person) => person.identifiers ?? [])
        .some((id) => id.value === "+12025550102"),
    ).toBe(false);
    expect(
      result.participants
        .filter((person) => !person.isSelf)
        .flatMap((person) => person.identifiers ?? [])
        .every((id) => id.kind !== "phone"),
    ).toBe(true);
  });
  it("paginates an upgrade with more than 256 cached groups without dropping roster snapshots", async () => {
    store.setHistorySyncState("complete");
    const groups = Array.from({ length: 301 }, (_, index) => `scope-page-${index}@g.us`);
    store.addChats(groups.map((jid) => ({ jid, name: "scope group", isGroup: true })));
    for (const jid of groups) store.updateGroupRoster(jid, [phone]);
    const seen = new Set<string>();
    let cursor: Awaited<ReturnType<typeof source.sync>>["cursor"] | null = null;
    let hasMore = true;
    let pages = 0;
    while (hasMore && pages < 10) {
      const page = await source.sync(cursor, { scopeFactsSupported: true });
      const updates = page.scopeUpdates?.conversations ?? [];
      expect(updates.length).toBeLessThanOrEqual(200);
      for (const item of updates) {
        expect(seen.has(item.id)).toBe(false);
        seen.add(item.id);
      }
      cursor = page.cursor;
      hasMore = page.hasMore ?? false;
      pages += 1;
    }
    expect(hasMore).toBe(false);
    expect([...seen].sort()).toEqual(groups.sort());
    expect(pages).toBeGreaterThan(1);
  });
  it("bounds aggregate member work and carries remaining native rosters to later pages", async () => {
    store.setHistorySyncState("complete");
    const groups = Array.from({ length: 6 }, (_, index) => `scope-budget-${index}@g.us`);
    store.addChats(groups.map((jid) => ({ jid, name: "scope group", isGroup: true })));
    const members = Array.from({ length: 800 }, (_, index) => `scope-budget-${index}@lid`);
    for (const jid of groups) store.updateGroupRoster(jid, members);
    const first = await source.sync(null, { scopeFactsSupported: true });
    expect(first.hasMore).toBe(true);
    expect(
      first.scopeUpdates!.conversations!.reduce(
        (sum, update) => sum + conversationScopeWork(update),
        0,
      ),
    ).toBeLessThanOrEqual(SOURCE_SCOPE_PAGE_WORK);
    const seen = new Set(first.scopeUpdates!.conversations!.map((update) => update.id));
    let cursor = first.cursor;
    let hasMore = true;
    let pages = 1;
    while (hasMore && pages < 10) {
      const page = await source.sync(cursor, { scopeFactsSupported: true });
      const updates = page.scopeUpdates!.conversations!;
      expect(
        updates.reduce((sum, update) => sum + conversationScopeWork(update), 0),
      ).toBeLessThanOrEqual(SOURCE_SCOPE_PAGE_WORK);
      for (const update of updates) {
        expect(seen.has(update.id)).toBe(false);
        seen.add(update.id);
      }
      cursor = page.cursor;
      hasMore = page.hasMore ?? false;
      pages += 1;
    }
    expect(seen.size).toBe(6);
    expect(hasMore).toBe(false);
  });
  it("marks oversized legacy rosters unknown while keeping the wire page acceptable", () => {
    const result = whatsappScopeMembership({
      chatJid: group,
      chat: { jid: group, name: "scope group", isGroup: true },
      sourceId: SourceId("whatsapp-messages:+12025550100"),
      contacts: new Map(),
      lidPhoneMap: new Map(),
      senders: Array.from({ length: 5000 }, (_, index) => `scope-old-${index}@lid`),
      authoritativeRoster: false,
      contested: () => false,
      revision: { epoch: "fixture", sequence: 1 },
      observedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(result.participants).toHaveLength(4096);
    expect(result.participants.at(-1)!.identifiers).toEqual([]);
    expect(result.mode).toBe("observed");
  });
  it("rotates missing cut bookmarks once and echoes only freshly fetched native rosters", async () => {
    store.setHistorySyncState("complete");
    store.addChats([{ jid: group, name: "scope group", isGroup: true }]);
    store.updateGroupRoster(group, [phone]);
    let reachable = true;
    const fetches: string[][] = [];
    source = new WhatsAppMessagesSource(store, "+12025550100", {
      refreshScopeGroupRosters: (jids) => {
        fetches.push([...jids]);
        if (!reachable) return Promise.resolve(new Set());
        for (const jid of jids) store.updateGroupRoster(jid, [quietPhone]);
        return Promise.resolve(new Set(jids));
      },
    });
    const options = (epoch: string, requestId?: string, actorId = "collector-a") => ({
      scopeFactsSupported: true,
      scopeRefreshEpochsSupported: true,
      scopeRefreshEpochs: { participant: epoch },
      scopeRefreshActorId: actorId,
      ...(requestId ? { scopeRefreshRequestIds: { participant: requestId } } : {}),
    });
    const legacy = await source.sync(null, { scopeFactsSupported: true });
    const restart = await source.sync(legacy.cursor, options("required-b"));
    expect(restart.scopeUpdates?.refreshes).toEqual([
      {
        kind: "participant",
        active: true,
        epoch: "required-b",
        restart: true,
        requestId: expect.any(String),
      },
    ]);
    expect(restart.scopeUpdates?.conversations).toBeUndefined();
    const refreshed = await source.sync(
      restart.cursor,
      options("required-c", restart.scopeUpdates?.refreshes?.[0]?.requestId),
    );
    expect(fetches).toEqual([[group]]);
    expect(refreshed.scopeUpdates?.conversations?.[0]?.refreshEpoch).toBe("required-c");
    expect(
      refreshed.scopeUpdates?.conversations?.[0]?.participants
        .flatMap((p) => p.identifiers ?? [])
        .some((id) => id.value === "+12025550102"),
    ).toBe(true);
    expect(refreshed.scopeUpdates?.refreshes).toEqual([
      { kind: "participant", active: false, epoch: "required-c" },
    ]);
    const oldGateway = await source.sync(refreshed.cursor, { scopeFactsSupported: true });
    expect(oldGateway.cursor.scopeParticipantRefresh).toBeUndefined();
    expect(
      oldGateway.scopeUpdates?.conversations?.every((item) => item.refreshEpoch === undefined),
    ).toBe(true);
    reachable = false;
    const restartAgain = await source.sync(
      oldGateway.cursor,
      options("required-c", restart.scopeUpdates?.refreshes?.[0]?.requestId),
    );
    const inaccessible = await source.sync(
      restartAgain.cursor,
      options("required-d", restartAgain.scopeUpdates?.refreshes?.[0]?.requestId),
    );
    expect(inaccessible.scopeUpdates?.conversations?.[0]?.refreshEpoch).toBeUndefined();
    expect(inaccessible.scopeUpdates?.refreshes).toEqual([
      { kind: "participant", active: false, epoch: "required-d" },
    ]);
  });
  it("resumes a required native pass across more than 256 groups and restarts a changed cut", async () => {
    store.setHistorySyncState("complete");
    const groups = Array.from({ length: 301 }, (_, index) => `scope-page-${index}@g.us`);
    store.addChats(groups.map((jid) => ({ jid, name: "scope group", isGroup: true })));
    source = new WhatsAppMessagesSource(store, "+12025550100", {
      refreshScopeGroupRosters: (jids) => {
        for (const jid of jids) store.updateGroupRoster(jid, [phone]);
        return Promise.resolve(new Set(jids));
      },
    });
    const options = (epoch: string, requestId?: string, actorId = "collector-a") => ({
      scopeFactsSupported: true,
      scopeRefreshEpochsSupported: true,
      scopeRefreshEpochs: { participant: epoch },
      scopeRefreshActorId: actorId,
      ...(requestId ? { scopeRefreshRequestIds: { participant: requestId } } : {}),
    });
    const restart = await source.sync(null, options("required-b"));
    const first = await source.sync(
      restart.cursor,
      options("required-c", restart.scopeUpdates?.refreshes?.[0]?.requestId),
    );
    expect(first.scopeUpdates?.conversations).toHaveLength(200);
    expect(first.scopeUpdates?.refreshes).toBeUndefined();
    const replay = await source.sync(
      restart.cursor,
      options("required-c", restart.scopeUpdates?.refreshes?.[0]?.requestId),
    );
    expect(replay.scopeUpdates?.conversations?.map((item) => item.id)).toEqual(
      first.scopeUpdates?.conversations?.map((item) => item.id),
    );
    const changed = await source.sync(first.cursor, options("required-d"));
    expect(changed.scopeUpdates?.refreshes?.[0]).toEqual({
      kind: "participant",
      active: true,
      epoch: "required-d",
      restart: true,
      requestId: expect.any(String),
    });
    const fresh = await source.sync(
      changed.cursor,
      options("required-e", changed.scopeUpdates?.refreshes?.[0]?.requestId),
    );
    const final = await source.sync(
      fresh.cursor,
      options("required-e", changed.scopeUpdates?.refreshes?.[0]?.requestId),
    );
    expect(
      new Set(
        [...fresh.scopeUpdates!.conversations!, ...final.scopeUpdates!.conversations!].map(
          (item) => item.id,
        ),
      ).size,
    ).toBe(301);
    expect(
      final.scopeUpdates?.conversations?.every((item) => item.refreshEpoch === "required-e"),
    ).toBe(true);
    expect(final.scopeUpdates?.refreshes).toEqual([
      { kind: "participant", active: false, epoch: "required-e" },
    ]);
    const peer = await source.sync(
      final.cursor,
      options("required-e", changed.scopeUpdates?.refreshes?.[0]?.requestId, "collector-b"),
    );
    expect(peer.scopeUpdates?.refreshes?.[0]?.restart).toBe(true);
    expect(peer.cursor.scopeParticipantRefresh).toMatchObject({ actorId: "collector-b" });
  });
  const text = (id: string, chatJid: string, senderJid: string, type = "text") => ({
    id,
    chatJid,
    senderJid,
    senderName: "Fictional member",
    fromMe: false,
    timestamp: 1767225600,
    type,
    text: "Fictional planning note.",
  });
  const phones = (update: { participants: Array<{ identifiers?: Array<{ value: string }> }> }) =>
    update.participants.flatMap((person) => person.identifiers ?? []).map((id) => id.value);
  it("republishes a group without a roster under a new revision when someone first speaks", async () => {
    store.addMessages([text("one", group, phone)]);
    const first = await source.sync(null, { scopeFactsSupported: true });
    const before = first.scopeUpdates!.conversations!.find((update) => update.id === group)!;
    expect(before.mode).toBe("observed");
    expect(phones(before)).not.toContain("+12025550102");

    store.addMessages([text("two", group, phone)]);
    const repeat = await source.sync(first.cursor, { scopeFactsSupported: true });
    expect(repeat.scopeUpdates!.conversations).toEqual([]);
    expect(repeat.documents[0]!.metadata.extra?.scopeConversation).toMatchObject({
      revision: before.revision,
      participants: before.participants,
    });

    store.addMessages([text("three", group, quietPhone)]);
    const spoken = await source.sync(repeat.cursor, { scopeFactsSupported: true });
    const after = spoken.scopeUpdates!.conversations!.find((update) => update.id === group)!;
    expect(after.revision.epoch).toBe(before.revision.epoch);
    expect(after.revision.sequence).toBeGreaterThan(before.revision.sequence);
    expect(phones(after)).toContain("+12025550102");
    expect(spoken.documents[0]!.metadata.extra?.scopeConversation).toMatchObject({
      revision: after.revision,
    });
  });
  it("keeps the revision when a speaker changes nothing: a system message, or a full roster", async () => {
    store.addMessages([text("one", group, phone)]);
    const first = await source.sync(null, { scopeFactsSupported: true });
    expect(first.scopeUpdates!.conversations).toHaveLength(1);

    store.addMessages([text("two", group, quietPhone, "system")]);
    const system = await source.sync(first.cursor, { scopeFactsSupported: true });
    expect(system.scopeUpdates!.conversations).toEqual([]);

    store.updateGroupRoster(group, [phone]);
    const roster = await source.sync(system.cursor, { scopeFactsSupported: true });
    expect(roster.scopeUpdates!.conversations![0]!.mode).toBe("snapshot");

    store.addMessages([text("three", group, quietPhone)]);
    const spoken = await source.sync(roster.cursor, { scopeFactsSupported: true });
    expect(spoken.scopeUpdates!.conversations).toEqual([]);
  });
  it("republishes when a member dropped from the roster speaks after the roster stops being whole", async () => {
    store.updateGroupRoster(group, [phone, quietPhone]);
    store.updateGroupRoster(group, [phone]);
    store.removeGroupParticipants(group, ["unknown-scope-member@lid"]);
    const first = await source.sync(null, { scopeFactsSupported: true });
    const before = first.scopeUpdates!.conversations!.find((update) => update.id === group)!;
    expect(before.mode).toBe("observed");
    expect(phones(before)).not.toContain("+12025550102");

    store.addMessages([text("one", group, quietPhone)]);
    const spoken = await source.sync(first.cursor, { scopeFactsSupported: true });
    const after = spoken.scopeUpdates!.conversations!.find((update) => update.id === group)!;
    expect(after.revision.sequence).toBeGreaterThan(before.revision.sequence);
    expect(phones(after)).toContain("+12025550102");
  });
  it("republishes an imported archive's first-time speakers", async () => {
    store.addMessages([text("one", group, phone)]);
    const first = await source.sync(null, { scopeFactsSupported: true });
    const before = first.scopeUpdates!.conversations!.find((update) => update.id === group)!;

    store.importMessages([text("archived", group, quietPhone)]);
    const imported = await source.sync(first.cursor, { scopeFactsSupported: true });
    const after = imported.scopeUpdates!.conversations!.find((update) => update.id === group)!;
    expect(after.revision.sequence).toBeGreaterThan(before.revision.sequence);
    expect(phones(after)).toContain("+12025550102");
  });
  it("publishes membership for a chat that history sync creates before its messages", async () => {
    const enrolled = await source.sync(null, { scopeFactsSupported: true });
    expect(enrolled.scopeUpdates!.conversations).toEqual([]);

    store.addChats([{ jid: phone, name: "Maya", isGroup: false }]);
    const created = await source.sync(enrolled.cursor, { scopeFactsSupported: true });
    const update = created.scopeUpdates!.conversations!.find((item) => item.id === phone)!;
    expect(update.mode).toBe("snapshot");
    expect(phones(update)).toContain("+12025550101");

    store.addChats([{ jid: phone, name: "Maya (work)", isGroup: false }]);
    store.addMessages([text("one", phone, phone)]);
    const messaged = await source.sync(created.cursor, { scopeFactsSupported: true });
    expect(messaged.scopeUpdates!.conversations).toEqual([]);
    expect(messaged.documents[0]!.metadata.extra?.scopeConversation).toMatchObject({
      revision: update.revision,
      participants: update.participants,
    });
  });
  it("republishes a chat when a contact links or unlinks the phone behind a LID member", async () => {
    store.updateGroupRoster(group, [lid]);
    const first = await source.sync(null, { scopeFactsSupported: true });
    const before = first.scopeUpdates!.conversations!.find((update) => update.id === group)!;
    expect(phones(before)).not.toContain("+12025550101");

    store.addContacts([{ jid: phone, name: "Maya", lid }]);
    const linked = await source.sync(first.cursor, { scopeFactsSupported: true });
    const after = linked.scopeUpdates!.conversations!.find((update) => update.id === group)!;
    expect(after.revision.sequence).toBeGreaterThan(before.revision.sequence);
    expect(phones(after)).toContain("+12025550101");

    store.addContacts([{ jid: phone, name: "Maya", pushName: "Maya" }]);
    const renamed = await source.sync(linked.cursor, { scopeFactsSupported: true });
    expect(renamed.scopeUpdates!.conversations).toEqual([]);
  });
});
