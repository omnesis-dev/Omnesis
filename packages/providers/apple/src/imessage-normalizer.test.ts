// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import { ProviderId, SourceId } from "@omnesis/types";
import {
  imessageDateToDate,
  formatDateKey,
  getTapbackLabel,
  isTapback,
  isTapbackRemoval,
  buildChatTitle,
  buildIMessageSourceUrl,
  normalizeDayChat,
} from "./imessage-normalizer.js";
import { appleIMessageDocumentProfile } from "./document-profiles.js";
import type { ParsedIMessage, IMessageChatInfo } from "./imessage-types.js";

function makeMsg(overrides: Partial<ParsedIMessage> = {}): ParsedIMessage {
  return {
    rowId: 1,
    guid: "msg-1",
    text: "Hello",
    date: new Date("2024-03-08T10:30:00Z"),
    isFromMe: false,
    isSystemMessage: false,
    sender: "+14085550123",
    service: "iMessage",
    attachments: [],
    ...overrides,
  };
}

const oneToOneChat: IMessageChatInfo = {
  chatIdentifier: "+14085550123",
  displayName: null,
  isGroup: false,
  service: "iMessage",
};

const groupChat: IMessageChatInfo = {
  chatIdentifier: "chat123",
  displayName: "Family",
  isGroup: true,
  service: "iMessage",
};

describe("imessageDateToDate", () => {
  test("converts nanosecond timestamp", () => {
    // 2026-03-06T10:28:01Z in iMessage nanoseconds
    const date = imessageDateToDate(794485681398758016);
    expect(date.getFullYear()).toBe(2026);
    expect(date.getMonth()).toBe(2); // March
    expect(date.getDate()).toBe(6);
  });

  test("converts second timestamp", () => {
    // Fallback for older format
    const date = imessageDateToDate(731548800);
    expect(date.getFullYear()).toBe(2024);
    expect(date.getMonth()).toBe(2); // March
    expect(date.getDate()).toBe(8);
  });

  test("handles zero", () => {
    const date = imessageDateToDate(0);
    expect(date.getTime()).toBe(0);
  });
});

describe("formatDateKey", () => {
  test("formats date as YYYY-MM-DD", () => {
    expect(formatDateKey(new Date("2024-03-08T10:30:00Z"))).toBe("2024-03-08");
  });
});

describe("getTapbackLabel", () => {
  test("returns label for known types", () => {
    expect(getTapbackLabel(2000)).toBe("Loved");
    expect(getTapbackLabel(2001)).toBe("Liked");
    expect(getTapbackLabel(2005)).toBe("Questioned");
  });

  test("returns emoji when provided", () => {
    expect(getTapbackLabel(2006, "❤️")).toBe("❤️");
  });

  test("returns undefined for unknown types", () => {
    expect(getTapbackLabel(9999)).toBeUndefined();
  });
});

describe("isTapback / isTapbackRemoval", () => {
  test("identifies tapback add", () => {
    expect(isTapback(2000)).toBe(true);
    expect(isTapback(2005)).toBe(true);
    expect(isTapback(2006)).toBe(true);
  });

  test("identifies tapback removal", () => {
    expect(isTapbackRemoval(3000)).toBe(true);
    expect(isTapbackRemoval(3005)).toBe(true);
  });

  test("regular messages are not tapbacks", () => {
    expect(isTapback(0)).toBe(false);
    expect(isTapbackRemoval(0)).toBe(false);
  });
});

describe("buildChatTitle", () => {
  test("uses contact for 1-to-1", () => {
    expect(buildChatTitle(oneToOneChat)).toBe("+14085550123");
  });

  test("uses display name for group", () => {
    expect(buildChatTitle(groupChat)).toBe("Family");
  });

  test("falls back for group without name", () => {
    expect(buildChatTitle({ ...groupChat, displayName: null })).toBe("Group Chat");
  });
});

describe("buildIMessageSourceUrl", () => {
  test("links to the message so Messages opens the existing conversation", () => {
    expect(buildIMessageSourceUrl("00000000-0000-4000-8000-000000000001")).toBe(
      "messages://open?message-guid=00000000-0000-4000-8000-000000000001",
    );
  });

  test("percent-encodes a guid carrying URL-reserved characters", () => {
    expect(buildIMessageSourceUrl("p:0/AB&CD")).toBe(
      "messages://open?message-guid=p%3A0%2FAB%26CD",
    );
  });

  test("emits no link without a message to anchor on", () => {
    expect(buildIMessageSourceUrl(undefined)).toBeUndefined();
    expect(buildIMessageSourceUrl("")).toBeUndefined();
  });
});

describe("normalizeDayChat", () => {
  test("renders a simple 1-to-1 conversation", () => {
    const messages = [
      makeMsg({
        guid: "m1",
        text: "Hey",
        sender: "+14085550123",
        date: new Date("2024-03-08T10:00:00Z"),
      }),
      makeMsg({
        guid: "m2",
        text: "Hi!",
        sender: "You",
        isFromMe: true,
        date: new Date("2024-03-08T10:01:00Z"),
      }),
    ];

    const doc = normalizeDayChat(
      "2024-03-08",
      messages,
      oneToOneChat,
      ProviderId("apple:test"),
      SourceId("apple-imessage:test"),
    );

    expect(doc.title).toBe("+14085550123 — 2024-03-08");
    expect(doc.externalId).toBe("+14085550123:2024-03-08");
    expect(doc.content).toContain("**10:00** +14085550123: Hey");
    expect(doc.content).toContain("**10:01** You: Hi!");
    expect(doc.metadata.sourceUrl).toBe("messages://open?message-guid=m1");
    expect(doc.metadata.documentType).toBe("conversation");
    expect(doc.metadata.extra?.messageCount).toBe(2);
    expect(doc.metadata.extra?.isGroup).toBe(false);
  });

  test("renders group chat with name header", () => {
    const messages = [makeMsg({ guid: "m1", text: "Hello everyone", sender: "Alice" })];

    const doc = normalizeDayChat(
      "2024-03-08",
      messages,
      groupChat,
      ProviderId("apple:test"),
      SourceId("apple-imessage:test"),
    );

    expect(doc.title).toBe("Family — 2024-03-08");
    expect(doc.content).toContain("**Group:** Family");
    expect(doc.metadata.sourceUrl).toBe("messages://open?message-guid=m1");
    expect(doc.metadata.extra?.isGroup).toBe(true);
  });

  test("keeps name-only participants when iMessage has no handle id", () => {
    const messages = [
      makeMsg({
        guid: "m1",
        text: "Joining shortly",
        sender: "Teammate",
        contactId: undefined,
      }),
    ];

    const doc = normalizeDayChat(
      "2024-03-08",
      messages,
      groupChat,
      ProviderId("apple:test"),
      SourceId("apple-imessage:test"),
    );

    expect(doc.metadata.people).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "participant",
          name: "Teammate",
        }),
      ]),
    );
  });

  test("links to the day's earliest message whatever the input order", () => {
    const messages = [
      makeMsg({ guid: "late", text: "Later", date: new Date("2024-03-08T18:00:00Z") }),
      makeMsg({ guid: "early", text: "Morning", date: new Date("2024-03-08T08:00:00Z") }),
    ];

    const doc = normalizeDayChat(
      "2024-03-08",
      messages,
      { ...groupChat, participantHandles: ["+14085550123", "maya.reeves@example.com"] },
      ProviderId("apple:test"),
      SourceId("apple-imessage:test"),
    );

    expect(doc.metadata.sourceUrl).toBe("messages://open?message-guid=early");
  });

  test("renders attachments as placeholders", () => {
    const messages = [
      makeMsg({
        guid: "m1",
        text: "",
        sender: "+14085550123",
        attachments: [
          {
            filename: "photo.jpg",
            mimeType: "image/jpeg",
            filePath: "~/Library/Messages/Attachments/photo.jpg",
            totalBytes: 5000,
          },
        ],
      }),
    ];

    const doc = normalizeDayChat(
      "2024-03-08",
      messages,
      oneToOneChat,
      ProviderId("apple:test"),
      SourceId("apple-imessage:test"),
    );
    expect(doc.content).toContain("[Image: photo.jpg]");
  });

  test("renders system messages in italics", () => {
    const messages = [
      makeMsg({ guid: "m1", text: "Alice named the conversation", isSystemMessage: true }),
    ];

    const doc = normalizeDayChat(
      "2024-03-08",
      messages,
      groupChat,
      ProviderId("apple:test"),
      SourceId("apple-imessage:test"),
    );
    expect(doc.content).toContain("_Alice named the conversation_");
  });

  test("renders tapback reactions inline", () => {
    const messages = [
      makeMsg({
        guid: "m1",
        text: "Great news!",
        sender: "Alice",
        date: new Date("2024-03-08T10:00:00Z"),
      }),
      makeMsg({
        guid: "m2",
        text: "",
        sender: "You",
        date: new Date("2024-03-08T10:01:00Z"),
        tapback: { type: "Loved", targetGuid: "m1", action: "add" },
      }),
    ];

    const doc = normalizeDayChat(
      "2024-03-08",
      messages,
      oneToOneChat,
      ProviderId("apple:test"),
      SourceId("apple-imessage:test"),
    );
    expect(doc.content).toContain("Great news!");
    expect(doc.content).toContain("→ You Loved");
    // Tapback should not appear as a regular message
    expect(doc.metadata.extra?.messageCount).toBe(1);
  });

  test("renders emoji tapbacks", () => {
    const messages = [
      makeMsg({
        guid: "m1",
        text: "Check this out",
        sender: "Bob",
        date: new Date("2024-03-08T10:00:00Z"),
      }),
      makeMsg({
        guid: "m2",
        text: "",
        sender: "Alice",
        date: new Date("2024-03-08T10:01:00Z"),
        tapback: { type: "❤️", targetGuid: "m1", emoji: "❤️", action: "add" },
      }),
    ];

    const doc = normalizeDayChat(
      "2024-03-08",
      messages,
      groupChat,
      ProviderId("apple:test"),
      SourceId("apple-imessage:test"),
    );
    expect(doc.content).toContain("→ Alice ❤️");
  });

  test("tapback removals cancel matching active reactions", () => {
    const messages = [
      makeMsg({
        guid: "m1",
        text: "Ship it",
        sender: "Bob",
        date: new Date("2024-03-08T10:00:00Z"),
      }),
      makeMsg({
        guid: "m2",
        text: "",
        sender: "Alice",
        date: new Date("2024-03-08T10:01:00Z"),
        tapback: { type: "Liked", targetGuid: "m1", action: "add" },
      }),
      makeMsg({
        guid: "m3",
        text: "",
        sender: "Alice",
        date: new Date("2024-03-08T10:02:00Z"),
        tapback: { type: "Liked", targetGuid: "m1", action: "remove" },
      }),
    ];

    const doc = normalizeDayChat(
      "2024-03-08",
      messages,
      groupChat,
      ProviderId("apple:test"),
      SourceId("apple-imessage:test"),
    );
    expect(doc.content).toContain("Ship it");
    expect(doc.content).not.toContain("→");
  });

  test("sorts messages by date", () => {
    const messages = [
      makeMsg({
        guid: "m2",
        text: "Second",
        sender: "Alice",
        date: new Date("2024-03-08T10:05:00Z"),
      }),
      makeMsg({ guid: "m1", text: "First", sender: "Bob", date: new Date("2024-03-08T10:00:00Z") }),
    ];

    const doc = normalizeDayChat(
      "2024-03-08",
      messages,
      groupChat,
      ProviderId("apple:test"),
      SourceId("apple-imessage:test"),
    );
    const firstIdx = doc.content.indexOf("First");
    const secondIdx = doc.content.indexOf("Second");
    expect(firstIdx).toBeLessThan(secondIdx);
  });

  test("collects unique participants", () => {
    const messages = [
      makeMsg({ guid: "m1", sender: "Alice" }),
      makeMsg({ guid: "m2", sender: "Bob" }),
      makeMsg({ guid: "m3", sender: "Alice" }),
    ];

    const doc = normalizeDayChat(
      "2024-03-08",
      messages,
      groupChat,
      ProviderId("apple:test"),
      SourceId("apple-imessage:test"),
    );
    const participants = doc.metadata.extra?.participants as string[];
    expect(participants).toContain("Alice");
    expect(participants).toContain("Bob");
    expect(participants).toHaveLength(2);
  });

  test("sets correct service tag", () => {
    const smsChat: IMessageChatInfo = { ...oneToOneChat, service: "SMS" };
    const messages = [makeMsg({ guid: "m1" })];

    const doc = normalizeDayChat(
      "2024-03-08",
      messages,
      smsChat,
      ProviderId("apple:test"),
      SourceId("apple-imessage:test"),
    );
    expect(doc.metadata.tags).toEqual(["SMS"]);
  });

  // The declared profile is what subscription compilation reads when it turns
  // "when the trail-crew group chat gets busy" into a document predicate, so
  // each declared role and path has to be something a normalized day really
  // carries. The final assertion re-lists the declared paths, so adding one
  // without proving the normalizer emits it fails here.
  test("emits every person role and metadata field the document profile declares", () => {
    const chat: IMessageChatInfo = {
      chatIdentifier: "chat-trail-crew",
      displayName: "Trail crew",
      isGroup: true,
      service: "iMessage",
      participantHandles: ["+15550100142", "maya.reeves@example.com"],
    };
    const messages = [
      makeMsg({
        guid: "m1",
        text: "Ask david.lin@example.com about the permit",
        sender: "Maya",
        contactId: "maya.reeves@example.com",
      }),
      makeMsg({ guid: "m2", text: "Will do", sender: "You", isFromMe: true }),
    ];

    const doc = normalizeDayChat(
      "2024-03-08",
      messages,
      chat,
      ProviderId("apple:test@example.com"),
      SourceId("apple-imessage:test@example.com"),
    );

    expect(appleIMessageDocumentProfile.documentTypes).toContain(doc.metadata.documentType);
    expect(new Set(doc.metadata.people?.map((p) => p.role))).toEqual(
      new Set(appleIMessageDocumentProfile.personRoles),
    );
    expect(doc.metadata.tags).toEqual(["iMessage"]);
    expect(doc.metadata.extra?.service).toBe("iMessage");
    expect(doc.metadata.extra?.isGroup).toBe(true);
    expect(doc.metadata.extra?.messageCount).toBe(2);
    expect(doc.metadata.extra?.chatName).toBe("Trail crew");
    // The service the normalizer stamps has to be spelled the way the
    // declaration spells it, or a condition compiled against the vocabulary
    // matches nothing.
    for (const path of ["tags", "extra.service"]) {
      expect(
        appleIMessageDocumentProfile.metadataFields?.find((f) => f.path === path)?.canonicalValues,
      ).toContain(doc.metadata.extra?.service);
    }
    expect(appleIMessageDocumentProfile.metadataFields?.map((f) => f.path)).toEqual([
      "tags",
      "extra.service",
      "extra.isGroup",
      "extra.messageCount",
      "extra.chatName",
    ]);
  });

  test("extracts people from phone contactId", () => {
    const messages = [
      makeMsg({
        guid: "m1",
        text: "Hey",
        sender: "+14085550123",
        contactId: "+14085550123",
        isFromMe: false,
      }),
      makeMsg({ guid: "m2", text: "Hi!", sender: "You", isFromMe: true }),
    ];

    const doc = normalizeDayChat(
      "2024-03-08",
      messages,
      oneToOneChat,
      ProviderId("apple:test"),
      SourceId("apple-imessage:test"),
    );
    const people = doc.metadata.people!;
    expect(people).toBeDefined();
    // Should have You + the other party (from chat identifier, deduplicated with message sender)
    const other = people.find((p) => p.name !== "You" && p.phones?.length);
    expect(other).toBeDefined();
    expect(other!.phones!.length).toBe(1);
  });

  test("extracts people from email contactId", () => {
    const messages = [
      makeMsg({
        guid: "m1",
        text: "Hey",
        sender: "Alice",
        contactId: "alice@example.com",
        isFromMe: false,
      }),
    ];

    const doc = normalizeDayChat(
      "2024-03-08",
      messages,
      oneToOneChat,
      ProviderId("apple:test"),
      SourceId("apple-imessage:test"),
    );
    const people = doc.metadata.people!;
    expect(people).toBeDefined();
    const alice = people.find((p) => p.name === "Alice");
    expect(alice).toBeDefined();
    expect(alice!.emails).toEqual(["alice@example.com"]);
  });

  test("extracts mentioned emails from content", () => {
    const messages = [
      makeMsg({
        guid: "m1",
        text: "Contact me at bob@example.com",
        sender: "Alice",
        contactId: "alice@example.com",
        isFromMe: false,
      }),
    ];

    const doc = normalizeDayChat(
      "2024-03-08",
      messages,
      oneToOneChat,
      ProviderId("apple:test"),
      SourceId("apple-imessage:test"),
    );
    const people = doc.metadata.people!;
    const mentioned = people.find(
      (p) => p.role === "mentioned" && p.emails?.[0] === "bob@example.com",
    );
    expect(mentioned).toBeDefined();
  });

  test("deduplicates participant contactIds", () => {
    const messages = [
      makeMsg({
        guid: "m1",
        text: "Hey",
        sender: "Alice",
        contactId: "alice@example.com",
        isFromMe: false,
      }),
      makeMsg({
        guid: "m2",
        text: "Hello",
        sender: "Alice",
        contactId: "alice@example.com",
        isFromMe: false,
      }),
    ];

    const doc = normalizeDayChat(
      "2024-03-08",
      messages,
      groupChat,
      ProviderId("apple:test"),
      SourceId("apple-imessage:test"),
    );
    const people = doc.metadata.people!;
    const participants = people.filter((p) => p.role === "participant");
    // You + Alice (deduplicated)
    expect(participants).toHaveLength(2);
    expect(participants.filter((p) => p.name === "Alice")).toHaveLength(1);
  });

  test("includes You as participant for isFromMe messages", () => {
    const messages = [makeMsg({ guid: "m1", text: "Hi!", sender: "You", isFromMe: true })];

    const doc = normalizeDayChat(
      "2024-03-08",
      messages,
      oneToOneChat,
      ProviderId("apple:test"),
      SourceId("apple-imessage:test"),
    );
    const people = doc.metadata.people ?? [];
    const you = people.find((p) => p.name === "You");
    expect(you).toBeDefined();
    expect(you!.role).toBe("participant");
  });

  test("only-self messages still have You participant", () => {
    const plainChat: IMessageChatInfo = {
      chatIdentifier: "chat999",
      displayName: "Test",
      isGroup: true,
      service: "iMessage",
    };
    const messages = [makeMsg({ guid: "m1", text: "Hello", sender: "You", isFromMe: true })];

    const doc = normalizeDayChat(
      "2024-03-08",
      messages,
      plainChat,
      ProviderId("apple:test"),
      SourceId("apple-imessage:test"),
    );
    const people = doc.metadata.people!;
    expect(people).toBeDefined();
    expect(people.find((p) => p.name === "You")).toBeDefined();
  });

  describe("mentioned-vs-participant dedup", () => {
    test("drops mentioned phone that matches a participant's phone", () => {
      // Group chat with two known participants by phone. The body of one
      // message redundantly mentions one of those phones plus an email
      // that's NOT in the roster. We expect:
      //  - participant mentions for both phones (canonical)
      //  - exactly one mentioned mention, for the email
      //  - NO mentioned mention for the redundant phone
      const messages = [
        makeMsg({
          guid: "m1",
          sender: "+447700000321",
          contactId: "+447700000321",
          text: "ping me at +447700000321 or david.lin@example.com",
          isFromMe: false,
          date: new Date("2024-03-08T10:00:00Z"),
        }),
        makeMsg({
          guid: "m2",
          sender: "+447700000000",
          contactId: "+447700000000",
          text: "ok",
          isFromMe: false,
          date: new Date("2024-03-08T10:01:00Z"),
        }),
      ];

      const doc = normalizeDayChat(
        "2024-03-08",
        messages,
        groupChat,
        ProviderId("apple:test"),
        SourceId("apple-imessage:test"),
      );

      const people = doc.metadata.people!;
      const participants = people.filter((p) => p.role === "participant");
      const mentioned = people.filter((p) => p.role === "mentioned");

      // Both phones should appear on participants
      const participantPhones = participants.flatMap((p) => p.phones ?? []);
      expect(participantPhones).toContain("+447700000321");
      expect(participantPhones).toContain("+447700000000");

      // Exactly one mentioned, and it's the email — phone was deduped.
      expect(mentioned).toHaveLength(1);
      expect(mentioned[0].emails).toEqual(["david.lin@example.com"]);
      const mentionedPhones = mentioned.flatMap((p) => p.phones ?? []);
      expect(mentionedPhones).not.toContain("+447700000321");
    });

    test("keeps mentioned phone for someone NOT in the participant roster", () => {
      // Body mentions a phone whose owner is not a chat participant.
      // That mention must survive — it represents a third party the
      // chat is talking ABOUT.
      const messages = [
        makeMsg({
          guid: "m1",
          sender: "+447700000321",
          contactId: "+447700000321",
          text: "ask Dana on +442071234567",
          isFromMe: false,
          date: new Date("2024-03-08T10:00:00Z"),
        }),
      ];

      const doc = normalizeDayChat(
        "2024-03-08",
        messages,
        groupChat,
        ProviderId("apple:test"),
        SourceId("apple-imessage:test"),
      );

      const people = doc.metadata.people!;
      const mentionedPhones = people
        .filter((p) => p.role === "mentioned")
        .flatMap((p) => p.phones ?? []);
      expect(mentionedPhones).toContain("+442071234567");
    });

    test("drops mentioned email that matches a participant's email", () => {
      const messages = [
        makeMsg({
          guid: "m1",
          sender: "Alice",
          contactId: "alice@example.com",
          text: "you can also reach me at alice@example.com",
          isFromMe: false,
          date: new Date("2024-03-08T10:00:00Z"),
        }),
      ];

      const doc = normalizeDayChat(
        "2024-03-08",
        messages,
        oneToOneChat,
        ProviderId("apple:test"),
        SourceId("apple-imessage:test"),
      );

      const people = doc.metadata.people!;
      const aliceEntries = people.filter((p) => p.emails?.includes("alice@example.com"));
      // Exactly one entry for alice@example.com, and it's the participant.
      expect(aliceEntries).toHaveLength(1);
      expect(aliceEntries[0].role).toBe("participant");
    });
  });

  describe("audio attachment rendering (inline transcript)", () => {
    const audioAtt = (overrides = {}) => ({
      filename: "Audio Message.caf",
      mimeType: "audio/x-caf",
      filePath: "~/Library/Messages/Attachments/ab/clip.caf",
      totalBytes: 4096,
      ...overrides,
    });

    function renderAudioMessage(att: ReturnType<typeof audioAtt>): string {
      const doc = normalizeDayChat(
        "2024-03-08",
        [makeMsg({ guid: "a1", text: "", sender: "+14085550123", attachments: [att] })],
        oneToOneChat,
        ProviderId("apple:test"),
        SourceId("apple-imessage:test"),
      );
      return doc.content;
    }

    test("renders [Audio, M:SS]: transcript when transcript and duration are present", () => {
      const content = renderAudioMessage(
        audioAtt({ transcript: "Running ten minutes late", durationSec: 75 }),
      );
      expect(content).toContain("[Audio, 1:15]: Running ten minutes late");
    });

    test("zero-padded seconds in the M:SS duration", () => {
      const content = renderAudioMessage(audioAtt({ transcript: "ok", durationSec: 5 }));
      expect(content).toContain("[Audio, 0:05]: ok");
    });

    test("renders [Audio]: transcript when duration is absent", () => {
      const content = renderAudioMessage(audioAtt({ transcript: "no duration here" }));
      expect(content).toContain("[Audio]: no duration here");
      expect(content).not.toContain("[Audio,");
    });

    test("keeps the [Audio: filename] placeholder when there is no transcript", () => {
      const content = renderAudioMessage(audioAtt());
      expect(content).toContain("[Audio: Audio Message.caf]");
    });

    test("an empty transcript (no speech) still renders the inline form, not the placeholder", () => {
      const content = renderAudioMessage(audioAtt({ transcript: "", durationSec: 3 }));
      expect(content).toContain("[Audio, 0:03]: ");
      expect(content).not.toContain("[Audio: Audio Message.caf]");
    });

    test("non-audio attachments are unaffected by the audio path", () => {
      const doc = normalizeDayChat(
        "2024-03-08",
        [
          makeMsg({
            guid: "img1",
            text: "",
            sender: "+14085550123",
            attachments: [
              {
                filename: "photo.jpg",
                mimeType: "image/jpeg",
                filePath: "~/Library/Messages/Attachments/cd/photo.jpg",
                totalBytes: 9000,
              },
            ],
          }),
        ],
        oneToOneChat,
        ProviderId("apple:test"),
        SourceId("apple-imessage:test"),
      );
      expect(doc.content).toContain("[Image: photo.jpg]");
    });
  });
});
