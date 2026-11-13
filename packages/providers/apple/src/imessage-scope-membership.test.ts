// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { ProviderId, SourceId } from "@omnesis/types";
import { projectNativeScopeParticipants } from "@omnesis/source-sdk";
import { normalizeDayChat } from "./imessage-normalizer.js";
import { imessageScopeMembership } from "./imessage-scope-membership.js";
import { scopeContracts } from "./scope-contracts.js";
import type { IMessageChatInfo, ParsedIMessage } from "./imessage-types.js";
const observation = {
  epoch: "native-fixture",
  sequence: 7,
  observedAt: "2026-01-01T00:00:00.000Z",
};
const oldSpeaker: ParsedIMessage = {
  rowId: 1,
  guid: "one",
  text: "Fictional plan",
  date: new Date("2026-01-01"),
  isFromMe: false,
  isSystemMessage: false,
  sender: "departed@example.org",
  service: "iMessage",
  attachments: [],
};

describe("iMessage native membership scopes", () => {
  it("uses current silent roster members and excludes departed historical speakers", () => {
    const chat: IMessageChatInfo = {
      chatIdentifier: "scope-group",
      displayName: "Cedar planning",
      isGroup: true,
      service: "iMessage",
      participantHandles: ["quiet@example.org", "+12025550101"],
    };
    const update = imessageScopeMembership(
      chat,
      SourceId("apple-imessage:owner@example.org"),
      [oldSpeaker],
      observation,
    );
    expect(update.mode).toBe("snapshot");
    expect(update.revision).toEqual({ epoch: "native-fixture", sequence: 7 });
    const ids = update.participants
      .flatMap((person) => person.identifiers ?? [])
      .map((id) => id.value);
    expect(ids).toContain("quiet@example.org");
    expect(ids).toContain("+12025550101");
    expect(ids).not.toContain("departed@example.org");
  });
  it("uses source-native observations when no complete roster was provided", () => {
    const update = imessageScopeMembership(
      { chatIdentifier: "scope-group", displayName: null, isGroup: true, service: "iMessage" },
      SourceId("apple-imessage:owner@example.org"),
      [oldSpeaker],
      observation,
    );
    expect(update.mode).toBe("observed");
    expect(update.participants.flatMap((person) => person.identifiers ?? [])).toContainEqual({
      kind: "email",
      value: "departed@example.org",
    });
  });
  it("stays complete for an account without an iCloud address, through both projections", () => {
    const sourceId = SourceId("apple-imessage:local");
    const chat: IMessageChatInfo = {
      chatIdentifier: "+12025550101",
      displayName: null,
      isGroup: false,
      service: "iMessage",
      participantHandles: ["+12025550101"],
    };
    const update = imessageScopeMembership(chat, sourceId, [], observation);
    expect(update.participants.find((person) => person.isSelf)?.identifiers).toEqual([]);
    const scopes = scopeContracts["apple-imessage"];
    expect(projectNativeScopeParticipants(update.participants, scopes)).toEqual({
      participants: [
        {
          nativeKey: "phone:+12025550101",
          identifiers: [{ type: "phone", value: "+12025550101" }],
          complete: true,
        },
      ],
      complete: true,
    });

    const day = normalizeDayChat(
      "2026-01-01",
      [{ ...oldSpeaker, sender: "+12025550101" }],
      chat,
      ProviderId("apple:local"),
      sourceId,
    );
    const legacy = projectNativeScopeParticipants(day.metadata.people, scopes);
    expect(legacy.complete).toBe(true);
    expect(legacy.participants.map((participant) => participant.nativeKey)).toEqual([
      "phone:+12025550101",
    ]);
  });
});
