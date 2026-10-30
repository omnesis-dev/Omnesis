// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `TelegramAdapter` over mtcute 0.32.7.
 *
 * With `storage.ts`, the only module that imports `@mtcute/*` at runtime (a
 * test enforces it). Everything mtcute returns is converted to the plain DTOs
 * of `../types.ts` here, and every error is classified into a `TelegramError`
 * before it leaves, so nothing past this file knows which library it is.
 *
 * Two behaviours of mtcute shape this file (`docs/telegram-source.md` §4):
 *
 * - It stops its updates loop silently when the key is revoked
 *   (`AUTH_KEY_UNREGISTERED`), and only logs at debug level. So every request
 *   goes through {@link MtcuteTelegramAdapter.guard}, which turns the
 *   revocation errors into a `revoked` update, and the provider asks once per
 *   sync with {@link MtcuteTelegramAdapter.checkAuthorization}.
 * - Update handlers run synchronously inside its dispatch, before it saves
 *   `pts`, and a handler that throws restarts the loop. Handlers here never
 *   throw.
 */

import {
  BaseTelegramClient,
  Long,
  MemoryStorage,
  TakeoutSession,
  TelegramClient,
  getMarkedPeerId,
  md,
  networkMiddlewares,
  tl,
  type Chat,
  type Dialog,
  type Message,
  type MessageMedia,
  type Peer,
  type User,
} from "@mtcute/node";
import { LogManager } from "@mtcute/core/utils.js";
import { getHistory as getHistoryThrough } from "@mtcute/core/methods.js";
import { createLogger, toErrorMessage } from "@omnesis/core";
import { FLOOD_SLEEP_MAX_MS, MEDIA_DOWNLOAD_STALL_MS } from "../../limits.js";
import { downloadWithReferenceRefresh } from "../download.js";
import { mapRpcError } from "../errors.js";
import {
  TelegramError,
  type AdapterFactory,
  type AppCredentials,
  type ChatKind,
  type DeviceInfo,
  type MessageBox,
  type TelegramAdapter,
  type TakeoutScope,
  type TelegramAuthAdapter,
  type TelegramTakeout,
  type TgChat,
  type TgDialog,
  type TgDownloaded,
  type TgMediaDownload,
  type TgMediaRef,
  type TgMessage,
  type TgUpdate,
  type TgUser,
} from "../types.js";
import { createMtcuteStorage } from "./storage.js";

const log = createLogger("provider:telegram").child("mtcute");

type ClientOptions = ConstructorParameters<typeof BaseTelegramClient>[0];
type HistoryParams = NonNullable<Parameters<TelegramClient["getHistory"]>[1]>;

function clientOptions(creds: AppCredentials, device: DeviceInfo): Omit<ClientOptions, "storage"> {
  return {
    apiId: creds.apiId,
    apiHash: creds.apiHash,
    initConnectionOptions: {
      deviceModel: device.deviceModel,
      systemVersion: device.systemVersion,
      appVersion: device.appVersion,
      langCode: device.langCode,
      systemLangCode: device.langCode,
    },
    // mtcute sleeps through a flood wait up to this long on its own; a longer
    // one comes back as FLOOD_WAIT so a sync can stop instead of hanging.
    network: {
      middlewares: networkMiddlewares.basic({ floodWaiter: { maxWait: FLOOD_SLEEP_MAX_MS } }),
    },
  };
}

/** Route mtcute's own log lines into ours, warnings and errors only. */
function routeLogs(client: BaseTelegramClient): void {
  const mgr = client.log.mgr;
  mgr.level = LogManager.WARN;
  mgr.handler = (_color, level, tag, fmt, args) => {
    const line = `${tag}: ${formatMtcuteLog(fmt, args)}`;
    if (level <= LogManager.ERROR) log.error(line);
    else log.warn(line);
  };
}

/** mtcute's printf-style placeholders, rendered without dumping objects. */
function formatMtcuteLog(fmt: string, args: unknown[]): string {
  let i = 0;
  return fmt.replace(/%[sdeijJ]/gu, () => {
    const arg = args[i++];
    if (arg instanceof Error) return arg.message;
    if (typeof arg === "object" && arg !== null) return "[object]";
    return String(arg);
  });
}

/** Any error out of mtcute, classified. */
function toTelegramError(err: unknown): TelegramError {
  if (err instanceof TelegramError) return err;
  if (tl.RpcError.is(err)) {
    const seconds = (err as { seconds?: unknown }).seconds;
    return mapRpcError({
      code: err.code,
      text: err.text,
      ...(typeof seconds === "number" ? { seconds } : {}),
    });
  }
  if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
    return new TelegramError("cancelled", err.message);
  }
  return new TelegramError("network", toErrorMessage(err));
}

class MtcuteTelegramAdapter implements TelegramAdapter {
  private readonly base: BaseTelegramClient;
  private readonly client: TelegramClient;
  private readonly handlers = new Set<(u: TgUpdate) => void>();
  private selfId: number | undefined;
  private connected = false;
  private suspended = false;
  private closed = false;
  private revokedEmitted = false;

  constructor(
    creds: AppCredentials,
    private readonly storage: { dir: string; key: Buffer | null },
    device: DeviceInfo,
  ) {
    this.base = new BaseTelegramClient({
      ...clientOptions(creds, device),
      storage: createMtcuteStorage(storage),
      updates: {
        catchUp: true,
        onChannelTooLong: (channelId) =>
          this.emit({ kind: "gap", scope: { channelId: markChannelId(channelId) } }),
      },
    });
    routeLogs(this.base);
    this.client = new TelegramClient({ client: this.base });
    this.client.onNewMessage.add((msg) => this.emitMessage("new", msg));
    this.client.onEditMessage.add((msg) => this.emitMessage("edit", msg));
    this.client.onDeleteMessage.add((upd) => {
      const box: MessageBox = upd.channelId === null ? "common" : `channel:${upd.channelId}`;
      this.emit({ kind: "delete", box, ids: upd.messageIds });
    });
    this.client.onConnectionState.add((state) => this.emit({ kind: "connection", state }));
    this.client.onError.add((err) => {
      const mapped = toTelegramError(err);
      if (mapped.code === "revoked") this.emitRevoked(mapped);
      else log.warn(`Telegram client error: ${mapped.message}`);
    });
  }

  async connect(opts: { session: string; signal?: AbortSignal }): Promise<TgUser> {
    if (this.closed) throw new TelegramError("cancelled", "The Telegram client is closed");
    return this.guard(async () => {
      // `force`: the credential is canonical. A cache rebuilt after a
      // quarantine, or one from an older session, never wins over it.
      await this.client.importSession(opts.session, true);
      opts.signal?.throwIfAborted();
      const me = await this.client.getMe();
      this.selfId = me.id;
      await this.client.startUpdatesLoop();
      this.connected = true;
      return toTgUser(me, me.id);
    });
  }

  exportSession(): Promise<string> {
    return this.guard(() => this.client.exportSession());
  }

  async checkAuthorization(opts?: { signal?: AbortSignal }): Promise<void> {
    await this.guard(() =>
      this.client.call({ _: "updates.getState" }, { abortSignal: opts?.signal }),
    );
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.handlers.clear();
    try {
      await this.client.destroy();
    } finally {
      this.storage.key?.fill(0);
    }
  }

  async suspend(): Promise<void> {
    if (this.closed || this.suspended) return;
    this.suspended = true;
    await this.client.disconnect();
  }

  async resume(): Promise<void> {
    if (this.closed || !this.suspended) return;
    this.suspended = false;
    if (!this.connected) return;
    await this.guard(async () => {
      await this.client.connect();
      await this.client.startUpdatesLoop();
    });
  }

  onUpdate(handler: (u: TgUpdate) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async *iterDialogs(opts: { archived: "keep"; signal?: AbortSignal }): AsyncIterable<TgDialog> {
    // "keep" is mandatory: mtcute's default excludes archived chats.
    const iterator = this.client.iterDialogs({ archived: opts.archived })[Symbol.asyncIterator]();
    while (true) {
      opts.signal?.throwIfAborted();
      const next = await this.guard(() => iterator.next());
      if (next.done) return;
      yield toTgDialog(next.value, this.requireSelf());
    }
  }

  getHistory(
    chatId: number,
    opts: { offsetId: number; limit: number; minId?: number; signal?: AbortSignal },
  ): Promise<{ messages: TgMessage[]; users: TgUser[] }> {
    return this.historyPage(
      (params) => this.withSignal(opts.signal).getHistory(chatId, params),
      opts,
    );
  }

  /** The client with every call it makes bound to `signal`. */
  private withSignal(signal: AbortSignal | undefined): TelegramClient {
    return signal ? this.client.withParams({ abortSignal: signal }) : this.client;
  }

  /** One history page through `read`, converted; shared by the plain and the takeout reads. */
  private historyPage(
    read: (params: HistoryParams) => Promise<Message[]>,
    opts: { offsetId: number; limit: number; minId?: number },
  ): Promise<{ messages: TgMessage[]; users: TgUser[] }> {
    return this.guard(async () => {
      const page = await read({
        limit: opts.limit,
        ...(opts.offsetId ? { offset: { id: opts.offsetId, date: 0 } } : {}),
        ...(opts.minId ? { minId: opts.minId } : {}),
      });
      const self = this.requireSelf();
      return { messages: page.map((m) => convertMessage(m)), users: sendersOf(page, self) };
    });
  }

  /**
   * `account.initTakeoutSession` with `files: false`, so media stays on the
   * lazy download path of the normal client. History is read with mtcute's
   * own `getHistory` over the session's proxy, which wraps every call in
   * `invokeWithTakeout`; the flood waiter middleware applies to it as to any
   * call, and its waits surface as the walk's own flood wait.
   */
  async takeout(
    scope: TakeoutScope,
    opts?: { signal?: AbortSignal; resumeId?: string },
  ): Promise<TelegramTakeout> {
    const session = opts?.resumeId
      ? new TakeoutSession(this.client, {
          _: "account.takeout",
          id: Long.fromString(opts.resumeId),
        })
      : await this.guard(() =>
          this.withSignal(opts?.signal).initTakeoutSession({
            ...scope,
            contacts: false,
            files: false,
          }),
        );
    return {
      id: session.id.toString(),
      scope,
      getHistory: (chatId, page) =>
        this.historyPage(
          (params) =>
            getHistoryThrough(
              session.createProxy(page.signal ? { abortSignal: page.signal } : undefined),
              chatId,
              params,
            ),
          page,
        ),
      finish: (success, finishOpts) =>
        this.guard(async () => {
          const done = await session.call(
            { _: "account.finishTakeoutSession", success },
            finishOpts?.signal ? { abortSignal: finishOpts.signal } : undefined,
          );
          if (!done) throw new TelegramError("unknown", "Telegram did not finish the data export");
        }),
    };
  }

  getMessages(
    chatId: number,
    ids: number[],
    opts?: { signal?: AbortSignal },
  ): Promise<(TgMessage | null)[]> {
    return this.guard(async () =>
      (await this.withSignal(opts?.signal).getMessages(chatId, ids)).map((m) =>
        m ? convertMessage(m) : null,
      ),
    );
  }

  getMessagesCommon(ids: number[], opts?: { signal?: AbortSignal }): Promise<(TgMessage | null)[]> {
    return this.guard(async () =>
      (await this.withSignal(opts?.signal).getMessagesUnsafe(ids)).map((m) =>
        m ? convertMessage(m) : null,
      ),
    );
  }

  downloadMedia(
    target: TgMediaDownload,
    opts: { maxBytes: number; signal?: AbortSignal },
  ): Promise<TgDownloaded> {
    return downloadWithReferenceRefresh(target, opts.maxBytes, {
      download: (fileId) =>
        this.guard(() => this.downloadCapped(fileId, opts.maxBytes, opts.signal)),
      refetch: async (chatId, msgId) => {
        const [fresh] = await this.getMessages(chatId, [msgId]);
        return fresh ?? null;
      },
    });
  }

  /**
   * The file's bytes, read chunk by chunk and stopped once past `maxBytes`, so
   * the caller can refuse an oversized file without fetching all of it.
   * mtcute's `limit` cannot cap a download: it accepts only divisors of 1 MiB
   * or the exact file size, and anything else throws before a byte is read.
   */
  private async downloadCapped(
    fileId: string,
    maxBytes: number,
    signal: AbortSignal | undefined,
  ): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of this.client.downloadAsIterable(fileId, {
      abortSignal: signal,
      stallTimeout: MEDIA_DOWNLOAD_STALL_MS,
    })) {
      chunks.push(chunk);
      total += chunk.byteLength;
      if (total > maxBytes) break;
    }
    const data = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
      data.set(chunk, at);
      at += chunk.byteLength;
    }
    return data;
  }

  async *iterForumTopics(
    chatId: number,
    opts?: { signal?: AbortSignal },
  ): AsyncIterable<{ id: number; title: string }> {
    const iterator = this.client.iterForumTopics(chatId)[Symbol.asyncIterator]();
    while (true) {
      opts?.signal?.throwIfAborted();
      const next = await this.guard(() => iterator.next());
      if (next.done) return;
      yield { id: next.value.id, title: next.value.title };
    }
  }

  /** Run one request; classify its failure, and announce a revocation once. */
  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      const mapped = toTelegramError(err);
      if (mapped.code === "revoked") this.emitRevoked(mapped);
      throw mapped;
    }
  }

  private requireSelf(): number {
    if (this.selfId === undefined) throw new TelegramError("unknown", "Not connected");
    return this.selfId;
  }

  private emitRevoked(err: TelegramError): void {
    if (this.revokedEmitted || !err.detail?.reason) return;
    this.revokedEmitted = true;
    this.emit({ kind: "revoked", reason: err.detail.reason });
  }

  private emitMessage(kind: "new" | "edit", msg: Message): void {
    if (this.selfId === undefined) return;
    try {
      this.emit({
        kind,
        message: toTgMessage(msg),
        chat: toTgChat(msg.chat, this.selfId, { isArchived: false, topMessageId: msg.id }),
        users: sendersOf([msg], this.selfId),
      });
    } catch (err) {
      log.error(`Could not convert a Telegram update: ${toErrorMessage(err)}`);
    }
  }

  private emit(update: TgUpdate): void {
    for (const handler of this.handlers) {
      try {
        handler(update);
      } catch (err) {
        // A throwing handler would restart mtcute's updates loop.
        log.error(`Telegram update handler failed: ${toErrorMessage(err)}`);
      }
    }
  }
}

class MtcuteAuthAdapter implements TelegramAuthAdapter {
  private readonly client: TelegramClient;

  constructor(creds: AppCredentials, device: DeviceInfo) {
    const base = new BaseTelegramClient({
      ...clientOptions(creds, device),
      // Nothing of a half-finished sign-in is written anywhere.
      storage: new MemoryStorage(),
      // No updates manager; the login token still arrives as a server update.
      updates: false,
    });
    routeLogs(base);
    this.client = new TelegramClient({ client: base });
  }

  async signInQr(opts: Parameters<TelegramAuthAdapter["signInQr"]>[0]): Promise<{
    self: TgUser;
    session: string;
  }> {
    try {
      const me = await this.client.signInQr({
        onUrlUpdated: opts.onQr,
        onQrScanned: opts.onScanned,
        password: opts.password,
        invalidPasswordCallback: opts.onInvalidPassword,
        abortSignal: opts.signal,
      });
      return { self: toTgUser(me, me.id), session: await this.client.exportSession() };
    } catch (err) {
      // An error our own callbacks raised (an AuthFailure) passes through.
      if (err instanceof Error && err.name === "AuthFailure") throw err;
      throw toTelegramError(err);
    }
  }

  async logOut(): Promise<void> {
    try {
      await this.client.logOut();
    } catch (err) {
      throw toTelegramError(err);
    }
  }

  async logOutSession(session: string, opts: { signal: AbortSignal }): Promise<void> {
    try {
      await this.client.importSession(session, true);
      opts.signal.throwIfAborted();
      await this.client.withParams({ abortSignal: opts.signal }).logOut();
    } catch (err) {
      const mapped = toTelegramError(err);
      // Already ended elsewhere: nothing is left to log out.
      if (mapped.code !== "revoked") throw mapped;
    }
  }

  async close(): Promise<void> {
    await this.client.destroy();
  }
}

export const mtcuteAdapterFactory: AdapterFactory = {
  live: (creds, storage, device) => new MtcuteTelegramAdapter(creds, storage, device),
  auth: (creds, device) => new MtcuteAuthAdapter(creds, device),
};

// ── Conversion ─────────────────────────────────────────────────────────
//
// Pure functions from mtcute's parsed objects to the boundary DTOs, exported
// for `adapter.test.ts`, which builds mtcute objects from raw TL.

/** mtcute reports a bare channel id to `onChannelTooLong`; everything else is marked. */
export function markChannelId(bare: number): number {
  return -1_000_000_000_000 - bare;
}

function toTgUser(u: User, selfId: number): TgUser {
  return {
    id: u.id,
    firstName: u.firstName || undefined,
    lastName: u.lastName ?? undefined,
    username: u.username ?? undefined,
    phone: u.phoneNumber ?? undefined,
    // TL flags are absent rather than false when unset.
    // Telegram's support accounts are not people either.
    isBot: u.isBot === true || u.isSupport === true,
    isDeleted: u.isDeleted === true,
    isSelf: u.isSelf === true || u.id === selfId,
  };
}

function isChannelPeer(chat: Chat): boolean {
  return chat.raw._ === "channel" || chat.raw._ === "channelForbidden";
}

export function chatKind(peer: Peer, selfId: number): ChatKind {
  if (peer.type === "user") return peer.id === selfId ? "saved" : "private";
  if (!isChannelPeer(peer)) return "group";
  if (peer.chatType === "channel") return "channel";
  return peer.isForum ? "forum" : "supergroup";
}

export function toTgChat(
  peer: Peer,
  selfId: number,
  extra: { isArchived: boolean; topMessageId: number },
): TgChat {
  const kind = chatKind(peer, selfId);
  return {
    id: peer.id,
    kind,
    title: kind === "saved" ? "Saved Messages" : peer.displayName,
    username: peer.username ?? undefined,
    isArchived: extra.isArchived,
    topMessageId: extra.topMessageId,
    isForum: peer.type === "chat" && peer.isForum,
  };
}

export function toTgDialog(dialog: Dialog, selfId: number): TgDialog {
  const last = dialog.lastMessage;
  const topMessageId = last?.id ?? 0;
  return {
    chat: toTgChat(dialog.peer, selfId, { isArchived: dialog.isArchived, topMessageId }),
    lastMessageId: topMessageId,
    lastMessageDate: last ? Math.floor(last.date.getTime() / 1000) : 0,
  };
}

function boxOf(chat: Peer): MessageBox {
  return chat.type === "chat" && isChannelPeer(chat) ? `channel:${chat.id}` : "common";
}

/**
 * A message that cannot be converted still occupies its id: a stub with no
 * text keeps the walk's checkpoint moving past it, and the extractor drops it.
 */
export function convertMessage(msg: Message): TgMessage {
  try {
    return toTgMessage(msg);
  } catch (err) {
    log.warn(`Could not convert Telegram message ${msg.raw.id}: ${toErrorMessage(err)}`);
    const peer = msg.raw.peerId;
    const chatId = getMarkedPeerId(peer);
    return {
      chatId,
      id: msg.raw.id,
      box: peer._ === "peerChannel" ? `channel:${chatId}` : "common",
      date: msg.raw.date,
      outgoing: false,
      text: "",
    };
  }
}

/** Who a forward came from; a forward header naming nobody is answered with nothing. */
function forwardName(msg: Message): string | undefined {
  try {
    return msg.forward?.sender.displayName || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The message this one replies to, in the same chat. In a forum topic the
 * reply header always names the topic; it is a reply only when it also names
 * a message other than the topic's root.
 */
function replyTarget(msg: Message): { replyToId?: number; topicId?: number } {
  const reply = msg.replyToMessage;
  if (!reply?.id) return {};
  const topicId = msg.isTopicMessage ? (reply.threadId ?? reply.id) : undefined;
  const isReply = reply.origin === "same_chat" && reply.id !== topicId;
  return { ...(isReply ? { replyToId: reply.id } : {}), ...(topicId ? { topicId } : {}) };
}

export function toTgMessage(msg: Message): TgMessage {
  const sender = msg.sender;
  const forwardFrom = forwardName(msg);
  const media = toTgMedia(msg.media);
  return {
    chatId: msg.chat.id,
    id: msg.id,
    box: boxOf(msg.chat),
    date: Math.floor(msg.date.getTime() / 1000),
    ...(msg.editDate ? { editDate: Math.floor(msg.editDate.getTime() / 1000) } : {}),
    senderId: sender.id,
    senderName: sender.displayName,
    outgoing: msg.isOutgoing === true,
    text: msg.text ? md.unparse(msg.textWithEntities) : "",
    ...replyTarget(msg),
    ...(forwardFrom ? { forwardFrom } : {}),
    ...(msg.groupedIdUnique ? { groupedId: msg.groupedIdUnique } : {}),
    ...(msg.ttlPeriod ? { ttlPeriod: msg.ttlPeriod } : {}),
    ...(media ? { media } : {}),
    ...(msg.action ? { service: msg.action.type } : {}),
  };
}

export function sendersOf(messages: readonly Message[], selfId: number): TgUser[] {
  const users = new Map<number, TgUser>();
  for (const m of messages) {
    if (m.sender.type === "user") users.set(m.sender.id, toTgUser(m.sender, selfId));
    if (m.chat.type === "user") users.set(m.chat.id, toTgUser(m.chat, selfId));
  }
  return [...users.values()];
}

function toTgMedia(media: MessageMedia): TgMediaRef | undefined {
  if (!media) return undefined;
  switch (media.type) {
    case "photo":
      return {
        kind: "photo",
        fileId: media.fileId,
        mimeType: "image/jpeg",
        ...(media.fileSize ? { size: media.fileSize } : {}),
        isViewOnce: media.ttlSeconds !== null,
      };
    case "video":
      return {
        kind: media.isRound
          ? "video_note"
          : media.isAnimation || media.isLegacyGif
            ? "animation"
            : "video",
        fileId: media.fileId,
        mimeType: media.mimeType,
        ...(media.fileSize ? { size: media.fileSize } : {}),
        durationSec: media.duration,
        isViewOnce: media.ttlSeconds !== null,
      };
    case "voice":
      return {
        kind: "voice",
        fileId: media.fileId,
        mimeType: media.mimeType,
        ...(media.fileSize ? { size: media.fileSize } : {}),
        durationSec: media.duration,
        isViewOnce: media.ttlSeconds !== null,
      };
    case "audio":
      return {
        kind: "audio",
        fileId: media.fileId,
        mimeType: media.mimeType,
        ...(media.fileName ? { fileName: media.fileName } : {}),
        ...(media.fileSize ? { size: media.fileSize } : {}),
        durationSec: media.duration,
        isViewOnce: false,
      };
    case "document":
      return {
        kind: "document",
        fileId: media.fileId,
        mimeType: media.mimeType,
        ...(media.fileName ? { fileName: media.fileName } : {}),
        ...(media.fileSize ? { size: media.fileSize } : {}),
        isViewOnce: false,
      };
    case "sticker":
      return { kind: "sticker", summary: media.emoji, isViewOnce: false };
    case "location":
    case "live_location":
      return { kind: "location", isViewOnce: false };
    case "venue":
      return { kind: "location", summary: media.title, isViewOnce: false };
    case "contact":
      return { kind: "contact", isViewOnce: false };
    case "poll":
      return { kind: "poll", summary: media.question, isViewOnce: false };
    case "webpage":
      return { kind: "webpage", summary: media.preview.url, isViewOnce: false };
    default:
      return { kind: "other", isViewOnce: false };
  }
}
