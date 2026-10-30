// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The wraps-real Telegram twin: the REAL provider, archive, history walker,
 * normalizer and source, over the in-memory `SimulatedTelegram` instead of
 * mtcute and the network. The only seams are the adapter factory (the
 * production `AdapterFactory` interface) and the sign-in, which a synthetic
 * universe replaces by seeding an app credential and a session the
 * simulated server accepts (`docs/telegram-source.md` §3).
 *
 * The corpus comes from the active universe's
 * `sources/telegram-messages/fake-corpus.json`, a compact form of the
 * simulation's corpus. A test reaches the live server through
 * {@link getTelegramWrapsRealController} to post, edit and delete messages,
 * which arrive as live updates exactly as Telegram's would. Media whose
 * fixture carries `content` is downloadable, so the real media pass runs too.
 */

import { loadActiveUniverse, loadSourceFixtureJson } from "@omnesis/providers-synth-common";
import { SimulatedTelegram, type SimulatedChat } from "@omnesis/provider-telegram/testing";
import type {
  ChatKind,
  MessageBox,
  TelegramProvider,
  TgMediaRef,
  TgUser,
} from "@omnesis/provider-telegram";

const FIXTURE_FILE = "fake-corpus.json";

interface FixtureUser {
  id: number;
  firstName: string;
  lastName?: string;
  username?: string;
  /** International digits, no `+`. */
  phone?: string;
  isBot?: boolean;
}

interface FixtureMessage {
  id: number;
  /** ISO 8601. */
  at: string;
  /** A user id; the account itself when it is the self user. */
  from: number;
  text: string;
  replyTo?: number;
  /** The forum topic the message is posted in (a `topics` id of its chat). */
  topic?: number;
  /**
   * The message's media. `content` is the file's bytes as UTF-8 text, which
   * the simulated server serves for download: a document's text, or what a
   * voice note says to the replay transcriber. `size` defaults to its length.
   */
  media?: TgMediaRef & { content?: string };
}

interface FixtureChat {
  /** Marked id: a user id, `-<id>` for a basic group, `-100<id>` for a supergroup or channel. */
  id: number;
  kind: ChatKind;
  title: string;
  username?: string;
  isArchived?: boolean;
  /** A forum's topics. */
  topics?: Array<{ id: number; title: string }>;
  messages: FixtureMessage[];
}

/** `sources/telegram-messages/fake-corpus.json`. */
export interface TelegramFakeCorpusFixture {
  self: FixtureUser;
  users: FixtureUser[];
  chats: FixtureChat[];
}

let cachedFixture: TelegramFakeCorpusFixture | null = null;

function loadTelegramFixture(): TelegramFakeCorpusFixture {
  cachedFixture ??= loadSourceFixtureJson<TelegramFakeCorpusFixture>(
    loadActiveUniverse(),
    "telegram-messages",
    FIXTURE_FILE,
  );
  return cachedFixture;
}

/** True when the active universe ships a Telegram corpus. */
export function universeHasTelegramCorpus(): boolean {
  try {
    loadTelegramFixture();
    return true;
  } catch {
    return false;
  }
}

function toUser(u: FixtureUser, selfId: number): TgUser {
  return {
    id: u.id,
    firstName: u.firstName,
    ...(u.lastName ? { lastName: u.lastName } : {}),
    ...(u.username ? { username: u.username } : {}),
    ...(u.phone ? { phone: u.phone } : {}),
    isBot: u.isBot === true,
    isDeleted: false,
    isSelf: u.id === selfId,
  };
}

function boxOf(chat: FixtureChat): MessageBox {
  return chat.kind === "supergroup" || chat.kind === "forum" || chat.kind === "channel"
    ? `channel:${chat.id}`
    : "common";
}

/** The fixture as the simulated server's corpus. */
function simulatedCorpus(fixture: TelegramFakeCorpusFixture): {
  self: TgUser;
  users: TgUser[];
  chats: SimulatedChat[];
} {
  const selfId = fixture.self.id;
  const users = fixture.users.map((u) => toUser(u, selfId));
  const names = new Map(
    [fixture.self, ...fixture.users].map((u) => [
      u.id,
      [u.firstName, u.lastName].filter(Boolean).join(" "),
    ]),
  );
  return {
    self: toUser(fixture.self, selfId),
    users,
    chats: fixture.chats.map((c) => ({
      chat: {
        id: c.id,
        kind: c.kind,
        title: c.title,
        ...(c.username ? { username: c.username } : {}),
        isArchived: c.isArchived === true,
        topMessageId: Math.max(0, ...c.messages.map((m) => m.id)),
        isForum: c.kind === "forum",
      },
      ...(c.topics ? { topics: c.topics } : {}),
      messages: c.messages.map((m) => ({
        chatId: c.id,
        id: m.id,
        box: boxOf(c),
        date: Math.floor(Date.parse(m.at) / 1000),
        senderId: m.from,
        ...(names.get(m.from) ? { senderName: names.get(m.from)! } : {}),
        outgoing: m.from === selfId,
        text: m.text,
        ...(m.replyTo ? { replyToId: m.replyTo } : {}),
        ...(m.topic ? { topicId: m.topic } : {}),
        ...(m.media ? { media: fixtureMedia(m.media) } : {}),
      })),
    })),
  };
}

/** A fixture's media as Telegram describes it: no bytes, the size they would have. */
function fixtureMedia(media: NonNullable<FixtureMessage["media"]>): TgMediaRef {
  const { content, ...ref } = media;
  return content === undefined || ref.size !== undefined
    ? ref
    : { ...ref, size: Buffer.byteLength(content, "utf8") };
}

/** Serve every fixture file that has content. */
function seedMedia(sim: SimulatedTelegram, fixture: TelegramFakeCorpusFixture): void {
  for (const chat of fixture.chats) {
    for (const m of chat.messages) {
      if (m.media?.fileId && m.media.content !== undefined) {
        sim.setMedia(m.media.fileId, new TextEncoder().encode(m.media.content));
      }
    }
  }
}

/** The test's handle on a live wraps-real source. */
export interface TelegramWrapsRealController {
  /** The simulated server: `pushNew`, `pushEdit`, `pushDelete`, `dropUpdates`, `calls`, … */
  server: SimulatedTelegram;
  provider: TelegramProvider;
}

const controllers = new Map<string, TelegramWrapsRealController>();
let server: SimulatedTelegram | null = null;

/** The one simulated server of this process, built from the universe on first use. */
export function simulatedServer(): SimulatedTelegram {
  if (!server) {
    const fixture = loadTelegramFixture();
    server = new SimulatedTelegram(simulatedCorpus(fixture));
    seedMedia(server, fixture);
  }
  return server;
}

export function registerController(
  sourceId: string,
  controller: TelegramWrapsRealController,
): void {
  controllers.set(sourceId, controller);
}

export function unregisterController(sourceId: string): void {
  controllers.delete(sourceId);
}

/** The controller of a fully qualified `telegram-messages:<account>` source. */
export function getTelegramWrapsRealController(
  sourceId: string,
): TelegramWrapsRealController | undefined {
  return controllers.get(sourceId);
}
