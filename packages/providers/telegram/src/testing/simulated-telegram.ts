// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * An in-memory Telegram for tests and the synthetic twin.
 *
 * `SimulatedTelegram` holds an invented account and corpus and hands out
 * adapters (`factory`) that implement the same `TelegramAdapter` and
 * `TelegramAuthAdapter` the mtcute adapter does, deterministically. A test
 * scripts the server side — scan the code, require a password, end a session,
 * fail the next call — and reads `calls` to assert what the provider asked for.
 *
 * Waiting is done with `setTimeout`, so fake timers drive it. Every name,
 * number and id in a corpus built here must be invented.
 *
 * The corpus is the server's state: `pushNew`, `pushEdit` and `pushDelete`
 * change it and deliver the matching live update, so a later history read
 * agrees with what the updates said — unless `dropUpdates` lost them, which
 * is how a test makes a gap.
 *
 * Media bytes live beside the corpus, by file id (`setMedia`). A file id
 * whose reference `expireReference` made stale answers
 * `FILE_REFERENCE_EXPIRED` while the message itself already names a fresh
 * one, so a download recovers only by fetching the message again, as it must
 * against Telegram.
 */

import { writeProviderCredentials } from "@omnesis/core";
import { TELEGRAM_FILE_KEY } from "../credentials-spec.js";
import { downloadWithReferenceRefresh } from "../client/download.js";
import { writeSessionRecord } from "../session-store.js";
import {
  TelegramError,
  type AdapterFactory,
  type AppCredentials,
  type DeviceInfo,
  type MessageBox,
  type RevocationReason,
  type TakeoutScope,
  type TelegramAdapter,
  type TelegramTakeout,
  type TelegramAuthAdapter,
  type TgChat,
  type TgDialog,
  type TgDownloaded,
  type TgMediaDownload,
  type TgMediaRef,
  type TgMessage,
  type TgUpdate,
  type TgUser,
} from "../client/types.js";

/** The invented app credential a seeded account uses. */
const SIMULATED_API_ID = "1234567";
const SIMULATED_API_HASH = "0123456789abcdef0123456789abcdef";

/** How long a simulated login code lives before it rotates on its own. */
export const SIMULATED_QR_TTL_MS = 30_000;

export interface SimulatedCorpus {
  self: TgUser;
  users?: TgUser[];
  chats?: SimulatedChat[];
}

export interface SimulatedChat {
  chat: TgChat;
  messages: TgMessage[];
  /** A forum's topics; a message names its topic with `topicId`. */
  topics?: Array<{ id: number; title: string }>;
}

export interface SimulatedCall {
  method: string;
  args?: unknown;
  /** `Date.now()` when the request was served, for pacing assertions. */
  at: number;
}

/** What a test says about a new message; the server fills in the rest. */
export interface NewMessageInput {
  text?: string;
  /** Defaults to the other user of a private chat, else the account itself. */
  senderId?: number;
  outgoing?: boolean;
  /** Unix seconds; defaults to now. */
  date?: number;
  replyToId?: number;
  /** The forum topic the message is posted in. */
  topicId?: number;
  media?: TgMediaRef;
  ttlPeriod?: number;
  service?: string;
}

type Waiter = { resolve: () => void; reject: (err: unknown) => void };

export class SimulatedTelegram {
  /** Every request any adapter made, in order. */
  readonly calls: SimulatedCall[] = [];
  /** Live adapters currently holding an open connection. */
  activeConnections = 0;
  /** Device metadata each adapter was built with. */
  readonly devices: DeviceInfo[] = [];
  /** App credentials each adapter was built with. */
  readonly appCredentials: AppCredentials[] = [];

  private readonly accounts = new Map<number, SimulatedCorpus>();
  private readonly sessions = new Map<string, { userId: number; revoked?: RevocationReason }>();
  private readonly failures = new Map<string, TelegramError[]>();
  private readonly liveAdapters = new Set<SimulatedTelegramAdapter>();
  private sessionCounter = 0;
  private password: string | undefined;
  private qrCounter = 0;
  private pendingLogin: { waiter: Waiter; scannedBy?: number; rotate: () => void } | undefined;
  private droppedUpdates = 0;
  private readonly media = new Map<string, Uint8Array | "expired" | "gone">();
  private referenceGeneration = 0;
  private takeoutGeneration = 0;
  /** @internal The takeout session generation still valid; older ones answer `TAKEOUT_INVALID`. */
  validTakeout = 0;
  /** The scope of every takeout session opened, in order. */
  readonly takeoutScopes: TakeoutScope[] = [];

  constructor(corpus: SimulatedCorpus) {
    this.addAccount(corpus);
  }

  /** Another account a code can be scanned with (e.g. the wrong one). */
  addAccount(corpus: SimulatedCorpus): void {
    this.accounts.set(corpus.self.id, corpus);
  }

  readonly factory: AdapterFactory = {
    live: (creds, storage, device) => {
      this.appCredentials.push(creds);
      this.devices.push(device);
      const adapter = new SimulatedTelegramAdapter(this, storage);
      this.liveAdapters.add(adapter);
      return adapter;
    },
    auth: (creds, device) => {
      this.appCredentials.push(creds);
      this.devices.push(device);
      return new SimulatedAuthAdapter(this);
    },
  };

  /** Mint a valid session string for an account, as a completed sign-in would. */
  issueSession(userId: number): string {
    const session = `sim-session:${userId}:${++this.sessionCounter}`;
    this.sessions.set(session, { userId });
    return session;
  }

  /**
   * Leave `configDir` as a completed sign-in of `userId` would: an invented
   * app credential and a stored session this server accepts. What the
   * synthetic twin does instead of a QR scan.
   */
  async seedAccount(configDir: string, userId: number): Promise<void> {
    const self = this.account(userId).self;
    await writeProviderCredentials(
      TELEGRAM_FILE_KEY,
      { api_id: SIMULATED_API_ID, api_hash: SIMULATED_API_HASH },
      configDir,
    );
    await writeSessionRecord(
      {
        session: this.issueSession(userId),
        userId: String(userId),
        apiId: SIMULATED_API_ID,
        ...(self.phone ? { phone: self.phone } : {}),
        ...(self.username ? { username: self.username } : {}),
        connectedAt: new Date().toISOString(),
      },
      configDir,
    );
  }

  /** Whether a session is still valid. */
  sessionIsActive(session: string): boolean {
    const s = this.sessions.get(session);
    return !!s && !s.revoked;
  }

  // ── Server-side scripting ───────────────────────────────────────────

  /** Require this two-step password on the next sign-in. */
  requirePassword(password: string): void {
    this.password = password;
  }

  /** The login code controls of the sign-in in progress. */
  readonly qr = {
    /** Expire the current code now, so the client receives a fresh one. */
    rotate: (): void => this.pendingLogin?.rotate(),
    /** Scan the current code with this account. */
    scan: (userId: number): void => {
      const pending = this.pendingLogin;
      if (!pending) throw new Error("No sign-in is waiting for a scan");
      pending.scannedBy = userId;
      pending.waiter.resolve();
    },
  };

  /**
   * End every session of an account, as terminating it from a phone does.
   * The next request on it fails with `reason`.
   */
  revoke(reason: RevocationReason, userId?: number): void {
    for (const s of this.sessions.values()) {
      if (userId === undefined || s.userId === userId) s.revoked = reason;
    }
  }

  /** End one session, as `auth.logOut` does. */
  endSession(session: string): void {
    const s = this.sessions.get(session);
    if (s) s.revoked = "AUTH_KEY_UNREGISTERED";
  }

  /** Make the next call of `method` fail with `error`. */
  failNext(method: string, error: TelegramError): void {
    const queue = this.failures.get(method) ?? [];
    queue.push(error);
    this.failures.set(method, queue);
  }

  /** Make the next call of `method` fail with a flood wait. */
  floodWait(method: string, seconds: number): void {
    this.failNext(
      method,
      new TelegramError("flood-wait", `FLOOD_WAIT_${seconds}`, { seconds, rpc: "FLOOD_WAIT_%d" }),
    );
  }

  /**
   * Hold the next data export back, as Telegram does until the owner approves
   * it on another device (`TAKEOUT_INIT_DELAY_%d`).
   */
  delayTakeout(seconds: number): void {
    this.failNext(
      "initTakeout",
      new TelegramError("takeout", `TAKEOUT_INIT_DELAY_${seconds}`, {
        seconds,
        rpc: "TAKEOUT_INIT_DELAY_%d",
      }),
    );
  }

  /** End every open takeout session server-side; its next read answers `TAKEOUT_INVALID`. */
  endTakeouts(): void {
    this.validTakeout = Number.POSITIVE_INFINITY;
  }

  /** @internal Open a takeout session, returning its generation. */
  openTakeout(scope: TakeoutScope): number {
    this.takeoutScopes.push(scope);
    this.validTakeout = ++this.takeoutGeneration;
    return this.validTakeout;
  }

  /** Add a forum topic, or rename one. */
  setTopic(chatId: number, id: number, title: string, ownerId?: number): void {
    const entry = this.chatEntry(this.ownerAccount(ownerId), chatId);
    entry.topics = [...(entry.topics ?? []).filter((t) => t.id !== id), { id, title }];
  }

  /** Deliver an update to every live adapter, unless it is one `dropUpdates` loses. */
  emit(update: TgUpdate): void {
    if (this.droppedUpdates > 0 && update.kind !== "connection" && update.kind !== "revoked") {
      this.droppedUpdates--;
      return;
    }
    for (const adapter of this.liveAdapters) adapter.deliver(update);
  }

  /** Lose the next `n` message updates, as a long disconnection would. */
  dropUpdates(n: number): void {
    this.droppedUpdates += n;
  }

  /** Report an update gap, as `channelDifferenceTooLong` does. */
  emitGap(scope: "account" | { channelId: number }): void {
    this.emit({ kind: "gap", scope });
  }

  /** Report a connection state change. */
  setConnectionState(state: "offline" | "connecting" | "updating" | "connected"): void {
    this.emit({ kind: "connection", state });
  }

  /**
   * Post a message to a chat of `ownerId`'s account (the first account by
   * default) and deliver it live. Returns the stored message.
   */
  pushNew(chatId: number, input: NewMessageInput, ownerId?: number): TgMessage {
    const account = this.ownerAccount(ownerId);
    const entry = this.chatEntry(account, chatId);
    const { chat } = entry;
    const box = chatBox(chat);
    const all = (account.chats ?? []).flatMap((c) => c.messages);
    const id =
      Math.max(
        0,
        ...(box === "common" ? all.filter((m) => m.box === "common") : entry.messages).map(
          (m) => m.id,
        ),
      ) + 1;
    const outgoing = input.outgoing ?? input.senderId === account.self.id;
    const senderId =
      input.senderId ??
      (outgoing ? account.self.id : chat.kind === "private" ? chat.id : account.self.id);
    const sender = [account.self, ...(account.users ?? [])].find((u) => u.id === senderId);
    const message: TgMessage = {
      chatId,
      id,
      box,
      date: input.date ?? Math.floor(Date.now() / 1000),
      senderId,
      ...(sender
        ? { senderName: [sender.firstName, sender.lastName].filter(Boolean).join(" ") }
        : {}),
      outgoing,
      text: input.text ?? "",
      ...(input.replyToId ? { replyToId: input.replyToId } : {}),
      ...(input.topicId ? { topicId: input.topicId } : {}),
      ...(input.media ? { media: input.media } : {}),
      ...(input.ttlPeriod ? { ttlPeriod: input.ttlPeriod } : {}),
      ...(input.service ? { service: input.service } : {}),
    };
    entry.messages.push(message);
    this.emit({
      kind: "new",
      message,
      chat: liveChat(chat),
      users: this.usersOf(account, [message], chat),
    });
    return message;
  }

  /** Edit a message server-side and deliver the edit live. */
  pushEdit(
    chatId: number,
    id: number,
    text: string,
    editDate?: number,
    ownerId?: number,
  ): TgMessage {
    const account = this.ownerAccount(ownerId);
    const entry = this.chatEntry(account, chatId);
    const index = entry.messages.findIndex((m) => m.id === id);
    if (index < 0) throw new Error(`No simulated message ${id} in chat ${chatId}`);
    const edited: TgMessage = {
      ...entry.messages[index]!,
      text,
      editDate: editDate ?? Math.floor(Date.now() / 1000),
    };
    entry.messages[index] = edited;
    this.emit({
      kind: "edit",
      message: edited,
      chat: liveChat(entry.chat),
      users: this.usersOf(account, [edited], entry.chat),
    });
    return edited;
  }

  /**
   * Delete messages server-side and deliver the deletion live. For a private
   * chat or basic group the update names no chat, as Telegram's does.
   */
  pushDelete(chatId: number, ids: number[], ownerId?: number): void {
    const account = this.ownerAccount(ownerId);
    const entry = this.chatEntry(account, chatId);
    entry.messages = entry.messages.filter((m) => !ids.includes(m.id));
    this.emit({ kind: "delete", box: chatBox(entry.chat), ids });
  }

  /** Change a message server-side without telling anyone (an update lost in a gap). */
  silentlyEdit(chatId: number, id: number, text: string, editDate: number, ownerId?: number): void {
    const entry = this.chatEntry(this.ownerAccount(ownerId), chatId);
    const index = entry.messages.findIndex((m) => m.id === id);
    if (index < 0) throw new Error(`No simulated message ${id} in chat ${chatId}`);
    entry.messages[index] = { ...entry.messages[index]!, text, editDate };
  }

  /** Serve `bytes` for `fileId`, or make it `gone` (Telegram no longer has the file). */
  setMedia(fileId: string, bytes: Uint8Array | "gone"): void {
    this.media.set(fileId, bytes);
  }

  /**
   * Let a message's file reference go stale: its old file id answers
   * `FILE_REFERENCE_EXPIRED`, and the message, fetched again, names a fresh
   * file id serving the same bytes. Returns the fresh id.
   */
  expireReference(chatId: number, msgId: number, ownerId?: number): string {
    const entry = this.chatEntry(this.ownerAccount(ownerId), chatId);
    const index = entry.messages.findIndex((m) => m.id === msgId);
    const message = entry.messages[index];
    const oldId = message?.media?.fileId;
    if (!message || !oldId) throw new Error(`No simulated media on message ${msgId}`);
    const bytes = this.media.get(oldId);
    const freshId = `${oldId.split("~")[0]}~ref${++this.referenceGeneration}`;
    if (bytes !== undefined) this.media.set(freshId, bytes);
    this.media.set(oldId, "expired");
    entry.messages[index] = { ...message, media: { ...message.media!, fileId: freshId } };
    return freshId;
  }

  /** @internal The bytes behind a file id, or the error Telegram would answer. */
  fileBytes(fileId: string): Uint8Array {
    const bytes = this.media.get(fileId);
    if (bytes === "expired") {
      throw new TelegramError("file-reference-expired", "FILE_REFERENCE_EXPIRED", {
        rpc: "FILE_REFERENCE_EXPIRED",
      });
    }
    if (bytes === undefined || bytes === "gone") {
      throw new TelegramError("not-found", "FILE_ID_INVALID", { rpc: "FILE_ID_INVALID" });
    }
    return bytes;
  }

  private ownerAccount(ownerId: number | undefined): SimulatedCorpus {
    if (ownerId !== undefined) return this.account(ownerId);
    const first = this.accounts.values().next().value;
    if (!first) throw new Error("No simulated account");
    return first;
  }

  private chatEntry(account: SimulatedCorpus, chatId: number): SimulatedChat {
    const entry = account.chats?.find((c) => c.chat.id === chatId);
    if (!entry) throw new Error(`No simulated chat ${chatId}`);
    return entry;
  }

  /** @internal The users a page or an update carries: its senders and a private chat's peer. */
  usersOf(account: SimulatedCorpus, messages: readonly TgMessage[], chat?: TgChat): TgUser[] {
    const ids = new Set<number>(
      messages.flatMap((m) => (m.senderId !== undefined ? [m.senderId] : [])),
    );
    if (chat?.kind === "private") ids.add(chat.id);
    return [account.self, ...(account.users ?? [])].filter((u) => ids.has(u.id));
  }

  // ── Internals the adapters use ──────────────────────────────────────

  /** @internal */
  record(method: string, args?: unknown): void {
    this.calls.push(
      args === undefined ? { method, at: Date.now() } : { method, args, at: Date.now() },
    );
    const queued = this.failures.get(method);
    const failure = queued?.shift();
    if (failure) throw failure;
  }

  /** @internal Throws a revoked error when the session no longer works. */
  authorize(session: string): number {
    const s = this.sessions.get(session);
    if (!s) {
      throw new TelegramError("revoked", "AUTH_KEY_UNREGISTERED", {
        reason: "AUTH_KEY_UNREGISTERED",
        rpc: "AUTH_KEY_UNREGISTERED",
      });
    }
    if (s.revoked) {
      throw new TelegramError("revoked", s.revoked, { reason: s.revoked, rpc: s.revoked });
    }
    return s.userId;
  }

  /** @internal */
  account(userId: number): SimulatedCorpus {
    const account = this.accounts.get(userId);
    if (!account) throw new Error(`No simulated account ${userId}`);
    return account;
  }

  /** @internal */
  forget(adapter: SimulatedTelegramAdapter): void {
    this.liveAdapters.delete(adapter);
  }

  /** @internal Run one QR sign-in to completion. */
  async signIn(opts: Parameters<TelegramAuthAdapter["signInQr"]>[0]): Promise<{
    self: TgUser;
    session: string;
  }> {
    let scannedBy: number | undefined;
    while (scannedBy === undefined) {
      opts.signal.throwIfAborted();
      const token = `tg://login?token=sim-${++this.qrCounter}`;
      const expires = new Date(Date.now() + SIMULATED_QR_TTL_MS);
      opts.onQr(token, expires);
      scannedBy = await new Promise<number | undefined>((resolve, reject) => {
        const finish = (value: number | undefined) => {
          clearTimeout(timer);
          opts.signal.removeEventListener("abort", onAbort);
          this.pendingLogin = undefined;
          resolve(value);
        };
        const onAbort = () => {
          clearTimeout(timer);
          this.pendingLogin = undefined;
          reject(new TelegramError("cancelled", "Sign-in aborted"));
        };
        const timer = setTimeout(() => finish(undefined), SIMULATED_QR_TTL_MS);
        const login = {
          waiter: { resolve: () => finish(login.scannedBy), reject },
          rotate: () => finish(undefined),
          scannedBy: undefined as number | undefined,
        };
        this.pendingLogin = login;
        opts.signal.addEventListener("abort", onAbort, { once: true });
      });
    }
    opts.onScanned?.();
    if (this.password !== undefined) {
      while ((await opts.password()) !== this.password) {
        this.record("checkPassword");
        await opts.onInvalidPassword();
      }
      this.record("checkPassword");
    }
    const self = this.account(scannedBy).self;
    return { self, session: this.issueSession(self.id) };
  }
}

export class SimulatedTelegramAdapter implements TelegramAdapter {
  private session: string | undefined;
  private connected = false;
  private suspended = false;
  private closed = false;
  private revokedEmitted = false;
  private readonly handlers = new Set<(u: TgUpdate) => void>();

  constructor(
    private readonly server: SimulatedTelegram,
    /** What the provider handed over, for assertions. */
    readonly storage: { dir: string; key: Buffer | null },
  ) {}

  async connect(opts: { session: string; signal?: AbortSignal }): Promise<TgUser> {
    if (this.closed) throw new TelegramError("cancelled", "closed");
    if (this.connected) throw new Error("Simulated adapter connected twice");
    const userId = await this.request("connect", () => {
      opts.signal?.throwIfAborted();
      return this.server.authorize(opts.session);
    });
    this.session = opts.session;
    this.connected = true;
    this.server.activeConnections++;
    return { ...this.server.account(userId).self, isSelf: true };
  }

  exportSession(): Promise<string> {
    return this.request("exportSession", () => {
      if (!this.session) throw new TelegramError("unknown", "Not connected");
      return this.session;
    });
  }

  async checkAuthorization(): Promise<void> {
    await this.request("checkAuthorization", () => this.authorizeCurrent());
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.server.record("close");
    this.closed = true;
    this.disconnect();
    this.handlers.clear();
    this.server.forget(this);
  }

  async suspend(): Promise<void> {
    if (this.closed || this.suspended) return;
    this.server.record("suspend");
    this.suspended = true;
    this.disconnect();
  }

  async resume(): Promise<void> {
    if (this.closed || !this.suspended) return;
    this.server.record("resume");
    this.suspended = false;
    if (!this.session || this.connected) return;
    this.connected = true;
    this.server.activeConnections++;
  }

  onUpdate(handler: (u: TgUpdate) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async *iterDialogs(): AsyncIterable<TgDialog> {
    const userId = await this.request("iterDialogs", () => this.authorizeCurrent());
    // Most recently active first, as Telegram orders its dialog list.
    const dialogs = (this.server.account(userId).chats ?? []).map(({ chat, messages }) => {
      const last = messages.reduce<TgMessage | undefined>(
        (a, m) => (!a || m.id > a.id ? m : a),
        undefined,
      );
      return {
        chat: { ...chat, topMessageId: last?.id ?? 0 },
        lastMessageId: last?.id ?? 0,
        lastMessageDate: last?.date ?? 0,
      };
    });
    dialogs.sort((a, b) => b.lastMessageDate - a.lastMessageDate);
    yield* dialogs;
  }

  getHistory(
    chatId: number,
    opts: { offsetId: number; limit: number; minId?: number; signal?: AbortSignal },
  ): Promise<{ messages: TgMessage[]; users: TgUser[] }> {
    const { signal, ...args } = opts;
    return this.request(
      "getHistory",
      () => {
        abortedCheck(signal);
        return this.historyPage(chatId, args);
      },
      { chatId, ...args },
    );
  }

  private historyPage(
    chatId: number,
    opts: { offsetId: number; limit: number; minId?: number },
  ): { messages: TgMessage[]; users: TgUser[] } {
    const corpus = this.server.account(this.authorizeCurrent());
    const chat = corpus.chats?.find((c) => c.chat.id === chatId);
    const messages = (chat?.messages ?? [])
      .filter((m) => (opts.offsetId === 0 || m.id < opts.offsetId) && m.id > (opts.minId ?? 0))
      .sort((a, b) => b.id - a.id)
      .slice(0, opts.limit);
    return { messages, users: this.server.usersOf(corpus, messages, chat?.chat) };
  }

  /**
   * A takeout session: `initTakeout`, then `takeoutGetHistory` and
   * `finishTakeout` in `calls`. A chat outside the session's scope answers
   * `TAKEOUT_REQUIRED`, as Telegram does.
   */
  async takeout(
    scope: TakeoutScope,
    opts?: { signal?: AbortSignal; resumeId?: string },
  ): Promise<TelegramTakeout> {
    const generation = opts?.resumeId
      ? Number(opts.resumeId)
      : await this.request(
          "initTakeout",
          () => {
            abortedCheck(opts?.signal);
            this.authorizeCurrent();
            return this.server.openTakeout(scope);
          },
          scope,
        );
    const valid = (): void => {
      if (this.server.validTakeout !== generation) {
        throw new TelegramError("takeout", "TAKEOUT_INVALID", { rpc: "TAKEOUT_INVALID" });
      }
    };
    return {
      id: String(generation),
      scope,
      getHistory: (chatId, page) =>
        this.request(
          "takeoutGetHistory",
          () => {
            abortedCheck(page.signal);
            valid();
            const chat = this.server
              .account(this.authorizeCurrent())
              .chats?.find((c) => c.chat.id === chatId)?.chat;
            if (chat && !inTakeoutScope(chat, scope)) {
              throw new TelegramError("takeout", "TAKEOUT_REQUIRED", { rpc: "TAKEOUT_REQUIRED" });
            }
            return this.historyPage(chatId, page);
          },
          { chatId, offsetId: page.offsetId, limit: page.limit },
        ),
      finish: (success, finishOpts) =>
        this.request(
          "finishTakeout",
          () => {
            abortedCheck(finishOpts?.signal);
            valid();
            this.server.validTakeout = 0;
          },
          { success },
        ),
    };
  }

  getMessages(
    chatId: number,
    ids: number[],
    opts?: { signal?: AbortSignal },
  ): Promise<(TgMessage | null)[]> {
    return this.request(
      "getMessages",
      () => {
        abortedCheck(opts?.signal);
        const chat = this.server
          .account(this.authorizeCurrent())
          .chats?.find((c) => c.chat.id === chatId);
        return ids.map((id) => chat?.messages.find((m) => m.id === id) ?? null);
      },
      { chatId, ids },
    );
  }

  getMessagesCommon(ids: number[], opts?: { signal?: AbortSignal }): Promise<(TgMessage | null)[]> {
    return this.request(
      "getMessagesCommon",
      () => {
        abortedCheck(opts?.signal);
        const chats = this.server.account(this.authorizeCurrent()).chats ?? [];
        const common = chats.flatMap((c) => c.messages).filter((m) => m.box === "common");
        return ids.map((id) => common.find((m) => m.id === id) ?? null);
      },
      { ids },
    );
  }

  downloadMedia(
    target: TgMediaDownload,
    opts: { maxBytes: number; signal?: AbortSignal },
  ): Promise<TgDownloaded> {
    return downloadWithReferenceRefresh(target, opts.maxBytes, {
      download: (fileId) =>
        this.request(
          "download",
          () => {
            opts.signal?.throwIfAborted();
            this.authorizeCurrent();
            return this.server.fileBytes(fileId);
          },
          { chatId: target.chatId, msgId: target.msgId, fileId },
        ),
      refetch: async (chatId, msgId) => (await this.getMessages(chatId, [msgId]))[0] ?? null,
    });
  }

  async *iterForumTopics(chatId: number): AsyncIterable<{ id: number; title: string }> {
    const topics = await this.request(
      "iterForumTopics",
      () => {
        const entry = this.server
          .account(this.authorizeCurrent())
          .chats?.find((c) => c.chat.id === chatId);
        if (!entry?.chat.isForum) {
          throw new TelegramError("not-found", "CHANNEL_FORUM_MISSING", {
            rpc: "CHANNEL_FORUM_MISSING",
          });
        }
        return [...(entry.topics ?? [])];
      },
      { chatId },
    );
    yield* topics;
  }

  /** @internal */
  deliver(update: TgUpdate): void {
    if (!this.connected) return;
    for (const handler of this.handlers) handler(update);
  }

  private disconnect(): void {
    if (!this.connected) return;
    this.connected = false;
    this.server.activeConnections--;
  }

  private authorizeCurrent(): number {
    if (!this.session) throw new TelegramError("unknown", "Not connected");
    if (!this.connected) throw new TelegramError("network", "Disconnected");
    return this.server.authorize(this.session);
  }

  /** One request, asynchronously, with revocation announced like the real adapter. */
  private request<T>(method: string, fn: () => T, args?: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      setTimeout(() => {
        try {
          this.server.record(method, args);
          resolve(fn());
        } catch (err) {
          if (err instanceof TelegramError && err.code === "revoked" && !this.revokedEmitted) {
            this.revokedEmitted = true;
            const reason = err.detail?.reason ?? "AUTH_KEY_UNREGISTERED";
            for (const handler of this.handlers) handler({ kind: "revoked", reason });
          }
          reject(err);
        }
      }, 0);
    });
  }
}

/** A cancelled request, classified as the real adapter classifies an abort. */
function abortedCheck(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new TelegramError("cancelled", "The request was aborted");
}

/** Where a chat's ids live, as the real adapter reports it. */
function chatBox(chat: TgChat): MessageBox {
  return chat.kind === "supergroup" || chat.kind === "forum" || chat.kind === "channel"
    ? `channel:${chat.id}`
    : "common";
}

function inTakeoutScope(chat: TgChat, scope: TakeoutScope): boolean {
  switch (chat.kind) {
    case "private":
    case "saved":
      return scope.messageUsers;
    case "group":
      return scope.messageChats;
    case "supergroup":
    case "forum":
      return scope.messageMegagroups;
    case "channel":
      return scope.messageChannels;
  }
}

/** A chat as a live update carries it: Telegram's updates do not say whether it is archived. */
function liveChat(chat: TgChat): TgChat {
  return { ...chat, isArchived: false };
}

class SimulatedAuthAdapter implements TelegramAuthAdapter {
  private session: string | undefined;

  constructor(private readonly server: SimulatedTelegram) {}

  async signInQr(opts: Parameters<TelegramAuthAdapter["signInQr"]>[0]): Promise<{
    self: TgUser;
    session: string;
  }> {
    this.server.record("signInQr");
    const result = await this.server.signIn(opts);
    this.session = result.session;
    return result;
  }

  async logOut(): Promise<void> {
    this.server.record("logOut");
    if (this.session) this.server.endSession(this.session);
  }

  async logOutSession(session: string, opts: { signal: AbortSignal }): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
    opts.signal.throwIfAborted();
    this.server.record("logOutSession", { session });
    this.server.endSession(session);
  }

  async close(): Promise<void> {
    this.server.record("authClose");
  }
}
