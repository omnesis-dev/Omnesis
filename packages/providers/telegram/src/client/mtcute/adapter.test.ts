// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The mtcute → boundary conversions the sync relies on, over mtcute's own
 * parsed objects built from raw TL (no network). Every id, name and number
 * is invented.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Dialog, Long, Message, PeersIndex, tl } from "@mtcute/node";
import {
  chatKind,
  convertMessage,
  markChannelId,
  mtcuteAdapterFactory,
  sendersOf,
  toTgChat,
  toTgDialog,
  toTgMessage,
} from "./adapter.js";

const SELF_ID = 5550100101;
const JAMIE_ID = 5550100103;
const GROUP_ID = 4001234567; // basic group, marked -4001234567
const CHANNEL_ID = 1234567890; // marked -1001234567890
const DATE = 1773133200; // 2026-03-10T09:00:00Z

function rawUser(id: number, extra: Partial<tl.RawUser> = {}): tl.RawUser {
  return {
    _: "user",
    id,
    accessHash: { low: 1, high: 0, unsigned: false } as never,
    firstName: "Jamie",
    lastName: "Lopez",
    username: "jamie_lopez_example",
    phone: "12025550103",
    ...extra,
  } as tl.RawUser;
}

function rawChannel(extra: Partial<tl.RawChannel> = {}): tl.RawChannel {
  return {
    _: "channel",
    id: CHANNEL_ID,
    accessHash: { low: 2, high: 0, unsigned: false } as never,
    title: "Studio Northstar crew",
    megagroup: true,
    date: DATE,
    photo: { _: "chatPhotoEmpty" },
    ...extra,
  } as tl.RawChannel;
}

function rawGroup(): tl.RawChat {
  return {
    _: "chat",
    id: GROUP_ID,
    title: "Riverside Estate residents",
    participantsCount: 3,
    date: DATE,
    version: 1,
    photo: { _: "chatPhotoEmpty" },
  } as tl.RawChat;
}

const PEERS = PeersIndex.from({
  users: [
    rawUser(JAMIE_ID),
    rawUser(SELF_ID, { firstName: "Maya", lastName: "Reeves", self: true }),
  ],
  chats: [rawChannel(), rawGroup()],
});

function message(raw: Partial<tl.RawMessage>): Message {
  return new Message(
    {
      _: "message",
      id: 10,
      peerId: { _: "peerUser", userId: JAMIE_ID },
      date: DATE,
      message: "",
      ...raw,
    } as tl.RawMessage,
    PEERS,
  );
}

describe("toTgMessage", () => {
  it("converts an incoming private message with entities to markdown in the common box", () => {
    const m = toTgMessage(
      message({
        message: "Q4 budget review",
        entities: [{ _: "messageEntityBold", offset: 0, length: 2 }],
      }),
    );
    expect(m).toMatchObject({
      chatId: JAMIE_ID,
      id: 10,
      box: "common",
      date: DATE,
      senderId: JAMIE_ID,
      senderName: "Jamie Lopez",
      outgoing: false,
      text: "**Q4** budget review",
    });
    expect(m.replyToId).toBeUndefined();
  });

  it("puts a supergroup message in its channel's box under the marked id", () => {
    const m = toTgMessage(
      message({
        peerId: { _: "peerChannel", channelId: CHANNEL_ID },
        fromId: { _: "peerUser", userId: SELF_ID },
        out: true,
        message: "Rehearsal at six",
        editDate: DATE + 60,
        replyTo: { _: "messageReplyHeader", replyToMsgId: 7 },
        ttlPeriod: 86_400,
      }),
    );
    expect(m).toMatchObject({
      chatId: -1001234567890,
      box: "channel:-1001234567890",
      senderId: SELF_ID,
      outgoing: true,
      editDate: DATE + 60,
      replyToId: 7,
      ttlPeriod: 86_400,
    });
  });

  it("tells a forum topic header from a reply inside the topic", () => {
    const peerId = { _: "peerChannel", channelId: CHANNEL_ID } as const;
    const inTopic = toTgMessage(
      message({ peerId, replyTo: { _: "messageReplyHeader", forumTopic: true, replyToMsgId: 3 } }),
    );
    expect(inTopic.topicId).toBe(3);
    expect(inTopic.replyToId).toBeUndefined();
    const reply = toTgMessage(
      message({
        peerId,
        replyTo: { _: "messageReplyHeader", forumTopic: true, replyToMsgId: 8, replyToTopId: 3 },
      }),
    );
    expect(reply).toMatchObject({ topicId: 3, replyToId: 8 });
  });

  it("names a forward's origin, hidden or not, and survives a header naming nobody", () => {
    const hidden = toTgMessage(
      message({ fwdFrom: { _: "messageFwdHeader", date: DATE, fromName: "Sarah Mendez" } }),
    );
    expect(hidden.forwardFrom).toBe("Sarah Mendez");
    const visible = toTgMessage(
      message({
        fwdFrom: { _: "messageFwdHeader", date: DATE, fromId: { _: "peerUser", userId: JAMIE_ID } },
      }),
    );
    expect(visible.forwardFrom).toBe("Jamie Lopez");
    const anonymous = toTgMessage(message({ fwdFrom: { _: "messageFwdHeader", date: DATE } }));
    expect(anonymous.forwardFrom).toBeUndefined();
  });

  it("records a service message's action type", () => {
    const m = new Message(
      {
        _: "messageService",
        id: 11,
        peerId: { _: "peerChat", chatId: GROUP_ID },
        fromId: { _: "peerUser", userId: JAMIE_ID },
        date: DATE,
        action: { _: "messageActionPinMessage" },
        replyTo: { _: "messageReplyHeader", replyToMsgId: 9 },
      } as tl.RawMessageService,
      PEERS,
    );
    expect(toTgMessage(m)).toMatchObject({
      chatId: -GROUP_ID,
      box: "common",
      service: "message_pinned",
      text: "",
    });
  });

  it("describes media without bytes and flags view-once", () => {
    const poll = toTgMessage(
      message({
        media: {
          _: "messageMediaPoll",
          poll: {
            _: "poll",
            id: { low: 3, high: 0, unsigned: false } as never,
            question: { _: "textWithEntities", text: "Which day?", entities: [] },
            answers: [],
          },
          results: { _: "pollResults" },
        } as never,
      }),
    );
    expect(poll.media).toEqual({ kind: "poll", summary: "Which day?", isViewOnce: false });
    const venue = toTgMessage(
      message({
        media: {
          _: "messageMediaVenue",
          geo: { _: "geoPoint", long: 1, lat: 2, accessHash: { low: 0, high: 0 } as never },
          title: "Riverside Estate",
          address: "42 Example Street",
          provider: "",
          venueId: "",
          venueType: "",
        },
      }),
    );
    expect(venue.media).toEqual({
      kind: "location",
      summary: "Riverside Estate",
      isViewOnce: false,
    });
    const contact = toTgMessage(
      message({
        media: {
          _: "messageMediaContact",
          phoneNumber: "12025550177",
          firstName: "Sarah",
          lastName: "Mendez",
          vcard: "",
          userId: 0,
        },
      }),
    );
    expect(contact.media?.kind).toBe("contact");
  });

  it("falls back to a text-less stub when a message cannot be converted", () => {
    const broken = message({ peerId: { _: "peerChannel", channelId: 999 } }); // unknown peer
    const stub = convertMessage(broken);
    expect(stub).toEqual({
      chatId: markChannelId(999),
      id: 10,
      box: `channel:${markChannelId(999)}`,
      date: DATE,
      outgoing: false,
      text: "",
    });
  });
});

describe("chats, dialogs and senders", () => {
  it("classifies every chat kind", () => {
    const channelPeer = message({ peerId: { _: "peerChannel", channelId: CHANNEL_ID } }).chat;
    expect(chatKind(channelPeer, SELF_ID)).toBe("supergroup");
    const groupPeer = message({ peerId: { _: "peerChat", chatId: GROUP_ID } }).chat;
    expect(chatKind(groupPeer, SELF_ID)).toBe("group");
    const userPeer = message({}).chat;
    expect(chatKind(userPeer, SELF_ID)).toBe("private");
    expect(chatKind(userPeer, JAMIE_ID)).toBe("saved");

    const broadcast = PeersIndex.from({
      chats: [rawChannel({ megagroup: false, broadcast: true })],
    });
    const forum = PeersIndex.from({ chats: [rawChannel({ forum: true })] });
    const peerOf = (index: PeersIndex) =>
      new Message(
        {
          _: "message",
          id: 1,
          peerId: { _: "peerChannel", channelId: CHANNEL_ID },
          date: DATE,
          message: "",
        } as tl.RawMessage,
        index,
      ).chat;
    expect(chatKind(peerOf(broadcast), SELF_ID)).toBe("channel");
    expect(chatKind(peerOf(forum), SELF_ID)).toBe("forum");
    expect(toTgChat(peerOf(forum), SELF_ID, { isArchived: false, topMessageId: 1 })).toMatchObject({
      id: -1001234567890,
      kind: "forum",
      title: "Studio Northstar crew",
    });
  });

  it("names Saved Messages and takes the archived flag from the dialog", () => {
    const selfChat = message({ peerId: { _: "peerUser", userId: SELF_ID } }).chat;
    expect(toTgChat(selfChat, SELF_ID, { isArchived: false, topMessageId: 0 }).title).toBe(
      "Saved Messages",
    );
    const top = {
      _: "message",
      id: 42,
      peerId: { _: "peerUser", userId: JAMIE_ID },
      date: DATE,
      message: "Latest",
    } as tl.RawMessage;
    const dialog = new Dialog(
      {
        _: "dialog",
        peer: { _: "peerUser", userId: JAMIE_ID },
        topMessage: 42,
        readInboxMaxId: 0,
        readOutboxMaxId: 0,
        unreadCount: 0,
        unreadMentionsCount: 0,
        unreadReactionsCount: 0,
        notifySettings: { _: "peerNotifySettings" },
        folderId: 1,
      } as tl.RawDialog,
      PEERS,
      new Map([[JAMIE_ID, top]]),
    );
    expect(toTgDialog(dialog, SELF_ID)).toEqual({
      chat: expect.objectContaining({
        id: JAMIE_ID,
        kind: "private",
        isArchived: true,
        topMessageId: 42,
      }),
      lastMessageId: 42,
      lastMessageDate: DATE,
    });
  });

  it("returns each sender once, and a private chat's peer", () => {
    const users = sendersOf([message({}), message({ id: 11 })], SELF_ID);
    expect(users).toEqual([
      expect.objectContaining({ id: JAMIE_ID, phone: "12025550103", isSelf: false, isBot: false }),
    ]);
  });
});

describe("MtcuteTelegramAdapter.downloadMedia", () => {
  /** A raw document whose file reference is `ref`, as a fresh `getMessages` returns it. */
  function documentMessage(ref: number): Message {
    return message({
      id: 7,
      media: {
        _: "messageMediaDocument",
        document: {
          _: "document",
          id: { low: 77, high: 0, unsigned: false } as never,
          accessHash: { low: 5, high: 0, unsigned: false } as never,
          fileReference: new Uint8Array([ref, ref, ref]),
          date: DATE,
          mimeType: "text/plain",
          size: 22,
          dcId: 2,
          attributes: [{ _: "documentAttributeFilename", fileName: "budget.txt" }],
        },
      } as never,
    });
  }

  /** A real adapter whose client never touches the network: its calls are stubbed. */
  function stubbedAdapter(stubs: {
    downloadAsIterable: (
      location: unknown,
      params: { limit?: number },
    ) => AsyncIterable<Uint8Array>;
    getMessages: () => Promise<(Message | null)[]>;
  }) {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-telegram-adapter-"));
    const adapter = mtcuteAdapterFactory.live(
      { apiId: 1234567, apiHash: "0123456789abcdef0123456789abcdef" },
      { dir, key: null },
      { deviceModel: "Test", systemVersion: "1", appVersion: "1", langCode: "en" },
    );
    const client = (adapter as unknown as { client: Record<string, unknown> }).client;
    client.downloadAsIterable = vi.fn(stubs.downloadAsIterable);
    client.getMessages = vi.fn(stubs.getMessages);
    return {
      adapter,
      client: client as unknown as {
        downloadAsIterable: ReturnType<typeof vi.fn>;
        getMessages: ReturnType<typeof vi.fn>;
      },
      dir,
    };
  }

  const BYTES = new TextEncoder().encode("Q4 budget review notes");

  async function* streaming(...chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
    for (const chunk of chunks) yield chunk;
  }

  // eslint-disable-next-line require-yield
  async function* failing(err: unknown): AsyncIterable<Uint8Array> {
    throw err;
  }

  it("stops reading a file once it passes the size cap, and refuses it", async () => {
    const chunk = new Uint8Array(4096);
    let read = 0;
    const { adapter, dir } = stubbedAdapter({
      downloadAsIterable: async function* () {
        for (let i = 0; i < 100; i++) {
          read += 1;
          yield chunk;
        }
      },
      getMessages: () => Promise.resolve([null]),
    });
    try {
      await expect(
        adapter.downloadMedia({ chatId: JAMIE_ID, msgId: 7, fileId: "x" }, { maxBytes: 10_000 }),
      ).rejects.toMatchObject({ code: "forbidden" });
      expect(read).toBe(3);
    } finally {
      await adapter.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refreshes a stale file reference from the message and returns the fresh descriptor", async () => {
    const stale = toTgMessage(documentMessage(1)).media!;
    const fresh = toTgMessage(documentMessage(2)).media!;
    expect(fresh.fileId).not.toBe(stale.fileId);
    const { adapter, client, dir } = stubbedAdapter({
      downloadAsIterable: (location) =>
        location === stale.fileId
          ? failing(new tl.RpcError(400, "FILE_REFERENCE_EXPIRED"))
          : streaming(BYTES),
      getMessages: () => Promise.resolve([documentMessage(2)]),
    });
    try {
      const result = await adapter.downloadMedia(
        { chatId: JAMIE_ID, msgId: 7, fileId: stale.fileId!, size: 22 },
        { maxBytes: 1000 },
      );
      expect(result.data).toEqual(BYTES);
      expect(result.refreshed).toMatchObject({
        kind: "document",
        fileId: fresh.fileId,
        fileName: "budget.txt",
      });
      expect(client.getMessages).toHaveBeenCalledWith(JAMIE_ID, [7]);
      // mtcute refuses a `limit` that does not divide 1 MiB, so none is sent.
      expect(client.downloadAsIterable.mock.calls[0]![1]).not.toHaveProperty("limit");
    } finally {
      await adapter.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("classifies a download flood wait and a vanished message", async () => {
    const flood = Object.assign(new tl.RpcError(420, "FLOOD_WAIT_%d"), { seconds: 45 });
    const { adapter, dir } = stubbedAdapter({
      downloadAsIterable: () => failing(flood),
      getMessages: () => Promise.resolve([null]),
    });
    try {
      await expect(
        adapter.downloadMedia({ chatId: JAMIE_ID, msgId: 7, fileId: "x" }, { maxBytes: 10 }),
      ).rejects.toMatchObject({ code: "flood-wait", detail: { seconds: 45 } });
    } finally {
      await adapter.close();
      rmSync(dir, { recursive: true, force: true });
    }
    const gone = stubbedAdapter({
      downloadAsIterable: () => failing(new tl.RpcError(400, "FILE_REFERENCE_EXPIRED")),
      getMessages: () => Promise.resolve([null]),
    });
    try {
      await expect(
        gone.adapter.downloadMedia({ chatId: JAMIE_ID, msgId: 7, fileId: "x" }, { maxBytes: 10 }),
      ).rejects.toMatchObject({ code: "not-found" });
    } finally {
      await gone.adapter.close();
      rmSync(gone.dir, { recursive: true, force: true });
    }
  });

  it("describes photos, voice notes and documents for download", () => {
    const voice = toTgMessage(
      message({
        media: {
          _: "messageMediaDocument",
          voice: true,
          document: {
            _: "document",
            id: { low: 78, high: 0, unsigned: false } as never,
            accessHash: { low: 5, high: 0, unsigned: false } as never,
            fileReference: new Uint8Array([1]),
            date: DATE,
            mimeType: "audio/ogg",
            size: 4096,
            dcId: 2,
            attributes: [{ _: "documentAttributeAudio", voice: true, duration: 7 }],
          },
        } as never,
      }),
    ).media;
    expect(voice).toMatchObject({
      kind: "voice",
      mimeType: "audio/ogg",
      size: 4096,
      durationSec: 7,
      isViewOnce: false,
    });
    expect(voice?.fileId).toEqual(expect.any(String));
    expect(toTgMessage(documentMessage(1)).media).toMatchObject({
      kind: "document",
      mimeType: "text/plain",
      fileName: "budget.txt",
      size: 22,
    });
  });
});

describe("MtcuteTelegramAdapter.takeout", () => {
  const SCOPE = {
    messageUsers: true,
    messageChats: true,
    messageMegagroups: true,
    messageChannels: false,
  };

  function adapterWith(initTakeoutSession: (params: unknown) => Promise<unknown>) {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-telegram-adapter-"));
    const adapter = mtcuteAdapterFactory.live(
      { apiId: 1234567, apiHash: "0123456789abcdef0123456789abcdef" },
      { dir, key: null },
      { deviceModel: "Test", systemVersion: "1", appVersion: "1", langCode: "en" },
    );
    const client = (adapter as unknown as { client: Record<string, unknown> }).client;
    const init = vi.fn(initTakeoutSession);
    client.initTakeoutSession = init;
    return {
      adapter,
      init,
      async dispose() {
        await adapter.close();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  }

  it("asks for an export of messages only, never files or contacts, and finishes it", async () => {
    const call = vi.fn((_req: unknown, _opts?: unknown) => Promise.resolve(true));
    const { adapter, init, dispose } = adapterWith(() =>
      Promise.resolve({ id: Long.fromInt(77), createProxy: () => ({}), call }),
    );
    try {
      const takeout = await adapter.takeout(SCOPE);
      expect(init).toHaveBeenCalledWith({ ...SCOPE, contacts: false, files: false });
      expect(takeout.scope).toEqual(SCOPE);
      expect(takeout.id).toBe("77");
      const controller = new AbortController();
      await takeout.finish(true, { signal: controller.signal });
      expect(call).toHaveBeenCalledWith(
        { _: "account.finishTakeoutSession", success: true },
        { abortSignal: controller.signal },
      );
    } finally {
      await dispose();
    }
  });

  it("resumes a kept export session by its id without asking Telegram for a new one", async () => {
    const { adapter, init, dispose } = adapterWith(() => Promise.reject(new Error("unused")));
    try {
      const takeout = await adapter.takeout(SCOPE, { resumeId: "9007199254740993" });
      expect(init).not.toHaveBeenCalled();
      expect(takeout.id).toBe("9007199254740993");
      expect(takeout.scope).toEqual(SCOPE);
    } finally {
      await dispose();
    }
  });

  it("reports an export held back for approval as a takeout error, not a flood wait", async () => {
    const delay = Object.assign(new tl.RpcError(420, "TAKEOUT_INIT_DELAY_%d"), { seconds: 86_400 });
    const { adapter, dispose } = adapterWith(() => Promise.reject(delay));
    try {
      await expect(adapter.takeout(SCOPE)).rejects.toMatchObject({
        code: "takeout",
        detail: { seconds: 86_400 },
      });
    } finally {
      await dispose();
    }
  });
});
