// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test, vi } from "vitest";
import realDefinition from "@omnesis/provider-apple";
import { projectDocumentScopeFacts } from "@omnesis/source-sdk";
import { SourceId, ProviderId } from "@omnesis/types";

vi.mock("@omnesis/providers-synth-common", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@omnesis/providers-synth-common")>();
  const people = {
    self: { id: "owner", name: "Jamie Lopez" },
    owner: { id: "owner", name: "Jamie Lopez" },
    maya: { id: "maya", name: "Maya Reeves" },
    david: { id: "david", name: "David Lin" },
  };
  const getPerson = (ref: string) => {
    const person = people[ref as keyof typeof people];
    if (!person) throw new Error(`Unknown persona ${ref}`);
    return person;
  };
  return {
    ...actual,
    getPerson,
    personMention: (ref: string, role: string) => ({
      ...getPerson(ref),
      role,
      emails: [],
      phones: [
        { owner: "+12025550101", maya: "+12025550102", david: "+12025550103" }[
          getPerson(ref).id as "owner" | "maya" | "david"
        ],
      ],
      lids: [],
      isSelf: getPerson(ref).id === "owner",
    }),
  };
});
import { mapChat } from "./fixtures.js";

const ctx = {
  sourceId: SourceId("apple-imessage:fiction@example.com"),
  providerId: ProviderId("apple:fiction@example.com"),
};
const fixture = {
  externalId: "chat-day",
  chatId: "group",
  chatTitle: "Weekend plans",
  date: "2026-10-03",
  counterparty: "maya",
  messages: [
    { from: "self", at: "2026-10-03T10:00:00Z", text: "Which day?" },
    { from: "maya", at: "2026-10-03T10:01:00Z", text: "Saturday." },
    { from: "david", at: "2026-10-03T10:02:00Z", text: "Correction: Sunday." },
  ],
};
const first = (result: ReturnType<typeof mapChat>) => (Array.isArray(result) ? result[0]! : result);

describe("synthetic conversation identity", () => {
  test("canonical source metadata projects the same stable conversation and native phones", () => {
    const doc = first(mapChat({ ...fixture, participants: ["maya", "david"] }, ctx));
    const projected = projectDocumentScopeFacts(
      doc.metadata,
      realDefinition.sources.find((source) => source.id === "apple-imessage")!.scopes!,
    );
    expect(doc.metadata.extra).toMatchObject({
      chatId: "group",
      conversationId: "group",
      chatName: "Weekend plans",
    });
    expect(projected.facts).toContainEqual({ kind: "conversation", id: "group" });
    expect(projected.facts).toContainEqual({
      kind: "participant",
      identifier: { type: "phone", value: "+12025550102" },
    });
  });

  test("group speakers and all participants resolve through cast once", () => {
    const doc = first(
      mapChat({ ...fixture, participants: ["owner", "maya", "maya", "david"] }, ctx),
    );
    expect(doc.content).toContain("You: Which day?");
    expect(doc.content).toContain("Maya Reeves: Saturday.");
    expect(doc.content).toContain("David Lin: Correction: Sunday.");
    expect(doc.metadata.people?.map((person) => person.name)).toEqual([
      "Jamie Lopez",
      "Maya Reeves",
      "David Lin",
    ]);
  });
  test("legacy conversations retain their chat-title speaker and counterpart", () => {
    const doc = first(mapChat(fixture, ctx));
    expect(doc.content).toContain("Weekend plans: Saturday.");
    expect(doc.metadata.people?.map((person) => person.name)).toEqual([
      "Jamie Lopez",
      "Maya Reeves",
    ]);
  });
  test("undeclared group sender is included, but unknown cast sender fails loudly", () => {
    expect(
      first(mapChat({ ...fixture, participants: ["maya"] }, ctx)).metadata.people,
    ).toHaveLength(3);
    expect(() =>
      mapChat(
        {
          ...fixture,
          participants: ["maya"],
          messages: [{ from: "missing", at: "2026-10-03T10:00:00Z", text: "Hello" }],
        },
        ctx,
      ),
    ).toThrow("Unknown persona");
  });
});

describe("synthetic native roster refresh", () => {
  test("an unreadable current roster never falls back to an older day's departed members", async () => {
    const { createChatFixtureSource } = await import("./scope-source.js");
    const source = createChatFixtureSource(
      [
        { ...fixture, externalId: "older-day", date: "2026-10-03", participants: ["maya"] },
        { ...fixture, externalId: "current-day", date: "2026-10-04", participants: ["david"] },
      ],
      ctx,
    );
    vi.stubEnv("OMNESIS_SYNTH_READ_IMPAIRMENT", "*:degraded:1");
    try {
      const first = await source.sync(null, {
        scopeFactsSupported: true,
        scopeRefreshEpochsSupported: true,
        scopeRefreshEpochs: { participant: "required-b" },
      });
      const result = await source.sync(first.cursor, {
        scopeFactsSupported: true,
        scopeRefreshEpochsSupported: true,
        scopeRefreshEpochs: { participant: "required-c" },
        scopeRefreshRequestIds: { participant: first.scopeUpdates?.refreshes?.[0]?.requestId },
      });
      expect(result.scopeUpdates?.conversations).toEqual([]);
      expect(result.scopeUpdates?.readiness).toEqual([{ kind: "participant", complete: false }]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("negotiates real source snapshots, nonce acknowledgements and copied actor cursors", async () => {
    const { createChatFixtureSource } = await import("./scope-source.js");
    const source = createChatFixtureSource(
      [{ ...fixture, participants: ["maya", "david"], messages: fixture.messages.slice(0, 2) }],
      ctx,
    );
    const initial = await source.sync(null, { scopeFactsSupported: true });
    expect(initial.documents[0]?.metadata.extra?.scopeConversation).toMatchObject({
      id: "group",
      mode: "snapshot",
    });
    const options = (epoch: string, requestId?: string, actorId = "collector-a") => ({
      scopeFactsSupported: true,
      scopeRefreshEpochsSupported: true,
      scopeRefreshEpochs: { participant: epoch },
      scopeRefreshRequestIds: { participant: requestId },
      scopeRefreshActorId: actorId,
    });
    const handshake = await source.sync(initial.cursor, options("required-b"));
    const nonce = handshake.scopeUpdates?.refreshes?.[0]?.requestId;
    expect(nonce).toEqual(expect.any(String));
    const unacknowledged = await source.sync(handshake.cursor, options("unrelated-cut"));
    expect(unacknowledged.scopeUpdates?.refreshes?.[0]?.restart).toBe(true);
    const native = await source.sync(handshake.cursor, options("required-c", nonce));
    expect(native.documents).toEqual([]);
    const snapshot = native.scopeUpdates?.conversations?.[0];
    expect(snapshot?.refreshEpoch).toBe("required-c");
    expect(
      snapshot?.participants
        .flatMap((person) => person.identifiers ?? [])
        .some((id) => id.kind === "phone" && id.value === "+12025550103"),
    ).toBe(true);
    expect(native.scopeUpdates?.refreshes).toEqual([
      { kind: "participant", active: false, epoch: "required-c" },
    ]);
    const peer = await source.sync(native.cursor, options("required-c", nonce, "collector-b"));
    expect(peer.scopeUpdates?.refreshes?.[0]?.restart).toBe(true);
    const downgraded = await source.sync(native.cursor, { scopeFactsSupported: true });
    expect(downgraded.cursor.scopeFixtureRefresh).toBeUndefined();
  });
  test("pages more than256 native conversations without rewinding content or dropping silent members", async () => {
    const { createChatFixtureSource } = await import("./scope-source.js");
    const source = createChatFixtureSource(
      Array.from({ length: 301 }, (_, i) => ({
        ...fixture,
        externalId: `day-${i}`,
        chatId: `chat-${i}`,
        participants: ["maya", "david"],
      })),
      ctx,
    );
    const first = await source.sync(
      { offset: 301 },
      {
        scopeFactsSupported: true,
        scopeRefreshEpochsSupported: true,
        scopeRefreshEpochs: { participant: "required-b" },
      },
    );
    const options = {
      scopeFactsSupported: true,
      scopeRefreshEpochsSupported: true,
      scopeRefreshEpochs: { participant: "required-c" },
      scopeRefreshRequestIds: { participant: first.scopeUpdates?.refreshes?.[0]?.requestId },
    };
    let cursor = first.cursor;
    const ids = new Set<string>();
    let done = false;
    for (let page = 0; page < 5; page++) {
      const result = await source.sync(cursor, options);
      expect(result.documents).toEqual([]);
      expect(result.cursor.offset).toBe(301);
      expect(result.scopeUpdates?.conversations?.length ?? 0).toBeLessThanOrEqual(100);
      for (const update of result.scopeUpdates?.conversations ?? []) {
        expect(ids.has(update.id)).toBe(false);
        ids.add(update.id);
      }
      cursor = result.cursor;
      if (result.scopeUpdates?.refreshes?.some((refresh) => !refresh.active)) {
        done = true;
        break;
      }
    }
    expect(done).toBe(true);
    expect(ids.size).toBe(301);
  });
});
