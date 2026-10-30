// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The boundary between this provider and the Telegram client library.
 *
 * Everything outside `client/mtcute/` talks to Telegram through these types and
 * nothing else: no mtcute class, enum or TL object crosses this line. That is
 * what lets the tests drive the whole provider against an in-memory simulation
 * (`testing/simulated-telegram.ts`), and what would let another client library
 * replace mtcute without touching the sync logic.
 *
 * Ids are mtcute "marked" ids: a user is positive, a basic group is `-id`, and
 * a channel or supergroup is `-100…id`. A message id is unique within its
 * {@link MessageBox}: private chats and basic groups share one account-wide id
 * space (`common`), and each channel or supergroup has its own.
 */

export type ChatKind = "private" | "saved" | "group" | "supergroup" | "forum" | "channel";

/**
 * Where a message id is unique. `common` covers private chats and basic groups,
 * whose ids are account-wide; a channel or supergroup is `channel:<marked id>`.
 */
export type MessageBox = "common" | `channel:${number}`;

export interface TgUser {
  id: number;
  firstName?: string;
  lastName?: string;
  username?: string;
  /** Digits only, as Telegram reports them; absent when the user hides it. */
  phone?: string;
  isBot: boolean;
  isDeleted: boolean;
  isSelf: boolean;
}

export interface TgChat {
  id: number;
  kind: ChatKind;
  title: string;
  username?: string;
  isArchived: boolean;
  topMessageId: number;
  isForum: boolean;
  participantsCount?: number;
}

export interface TgDialog {
  chat: TgChat;
  lastMessageId: number;
  /** Unix seconds. */
  lastMessageDate: number;
}

export type TgMediaKind =
  | "photo"
  | "document"
  | "voice"
  | "audio"
  | "video"
  | "video_note"
  | "sticker"
  | "animation"
  | "location"
  | "contact"
  | "poll"
  | "webpage"
  | "other";

export interface TgMediaRef {
  kind: TgMediaKind;
  /** A Bot API compatible file id, which the adapter accepts back for download. */
  fileId?: string;
  mimeType?: string;
  fileName?: string;
  size?: number;
  durationSec?: number;
  /** View-once media (`ttl_seconds`): never stored. */
  isViewOnce: boolean;
  /** Poll question, venue title, web page URL: for rendering only. */
  summary?: string;
}

/** Which message's media to download, and the file id the archive last saw for it. */
export interface TgMediaDownload {
  chatId: number;
  msgId: number;
  fileId: string;
  size?: number;
}

export interface TgDownloaded {
  data: Uint8Array;
  /** The message's media as Telegram describes it now, when the reference was refreshed. */
  refreshed?: TgMediaRef;
}

export interface TgMessage {
  chatId: number;
  id: number;
  box: MessageBox;
  /** Unix seconds. */
  date: number;
  editDate?: number;
  senderId?: number;
  senderName?: string;
  outgoing: boolean;
  /** Message text as markdown. */
  text: string;
  replyToId?: number;
  topicId?: number;
  forwardFrom?: string;
  groupedId?: string;
  /** The chat's auto-delete timer, in seconds, when one applies to this message. */
  ttlPeriod?: number;
  media?: TgMediaRef;
  /** A service message's action, e.g. `user_joined`, `message_pinned`. */
  service?: string;
}

export type TgUpdate =
  | { kind: "new"; message: TgMessage; chat: TgChat; users: TgUser[] }
  | { kind: "edit"; message: TgMessage; chat: TgChat; users: TgUser[] }
  /** The common box carries no chat id: Telegram names only the message ids. */
  | { kind: "delete"; box: MessageBox; ids: number[] }
  /** `channelDifferenceTooLong`, or a gap detected some other way. */
  | { kind: "gap"; scope: "account" | { channelId: number } }
  | { kind: "connection"; state: "offline" | "connecting" | "updating" | "connected" }
  | { kind: "revoked"; reason: RevocationReason };

/** The RPC errors that mean this authorization is gone for good. */
export const REVOCATION_REASONS = [
  "AUTH_KEY_UNREGISTERED",
  "SESSION_REVOKED",
  "SESSION_EXPIRED",
  "USER_DEACTIVATED",
  "USER_DEACTIVATED_BAN",
  "AUTH_KEY_DUPLICATED",
] as const;

export type RevocationReason = (typeof REVOCATION_REASONS)[number];

export function isRevocationReason(value: unknown): value is RevocationReason {
  return typeof value === "string" && (REVOCATION_REASONS as readonly string[]).includes(value);
}

export type TelegramErrorCode =
  | "flood-wait"
  | "revoked"
  | "file-reference-expired"
  | "not-found"
  | "forbidden"
  | "network"
  | "cancelled"
  /**
   * A takeout (data export) session cannot be used: Telegram holds a new one
   * back until the owner approves it (`TAKEOUT_INIT_DELAY_%d`, with
   * `seconds`), or the one in use ended (`TAKEOUT_INVALID`, `TAKEOUT_REQUIRED`).
   */
  | "takeout"
  | "unknown";

/** Every failure the adapter reports, already classified. */
export class TelegramError extends Error {
  constructor(
    readonly code: TelegramErrorCode,
    message: string,
    readonly detail?: { seconds?: number; reason?: RevocationReason; rpc?: string },
  ) {
    super(message);
    this.name = "TelegramError";
  }
}

/** What the session reports to Telegram about this client. */
export interface DeviceInfo {
  deviceModel: string;
  systemVersion: string;
  appVersion: string;
  langCode: string;
}

/** The operator's own `api_id` / `api_hash` from my.telegram.org. */
export interface AppCredentials {
  apiId: number;
  apiHash: string;
}

/** A live, authorized client for one account. */
export interface TelegramAdapter {
  /**
   * Import the session, connect, confirm the authorization with `getMe`, and
   * start the updates loop with catch-up. Resolves to the account's own user.
   * Calling it again on a connected adapter is an error.
   */
  connect(opts: { session: string; signal?: AbortSignal }): Promise<TgUser>;
  /** The current session string; differs from the imported one after a DC migration. */
  exportSession(): Promise<string>;
  /**
   * Confirm the authorization is still valid with one cheap request. Throws a
   * `revoked` {@link TelegramError} (and emits `revoked`) when it is not.
   * Exists because the updates loop stops silently on a revoked key.
   */
  checkAuthorization(opts?: { signal?: AbortSignal }): Promise<void>;
  /** Stop updates, disconnect, and close the local cache. Idempotent. */
  close(): Promise<void>;
  /** Disconnect without tearing down; {@link resume} reconnects. Idempotent. */
  suspend(): Promise<void>;
  /** Reconnect after {@link suspend}. A no-op when not suspended. */
  resume(): Promise<void>;
  onUpdate(handler: (u: TgUpdate) => void): () => void;
  iterDialogs(opts: { archived: "keep"; signal?: AbortSignal }): AsyncIterable<TgDialog>;
  /** Newest→oldest page strictly older than offsetId (0 = newest); minId bounds the low end. */
  getHistory(
    chatId: number,
    opts: { offsetId: number; limit: number; minId?: number; signal?: AbortSignal },
  ): Promise<{ messages: TgMessage[]; users: TgUser[] }>;
  /** Messages by id in one chat; `null` for an id that no longer exists. */
  getMessages(
    chatId: number,
    ids: number[],
    opts?: { signal?: AbortSignal },
  ): Promise<(TgMessage | null)[]>;
  /** Messages by id in the common box, which needs no peer. */
  getMessagesCommon(ids: number[], opts?: { signal?: AbortSignal }): Promise<(TgMessage | null)[]>;
  /**
   * Download one message's media, at most `maxBytes` (a larger file fails as
   * `forbidden`). A stale file reference is refreshed by fetching the message
   * again and retrying once; the fresh descriptor comes back as `refreshed` so
   * the caller can store it. A message that is gone fails as `not-found`.
   */
  downloadMedia(
    target: TgMediaDownload,
    opts: { maxBytes: number; signal?: AbortSignal },
  ): Promise<TgDownloaded>;
  /** A forum's topics, every page of them. */
  iterForumTopics(
    chatId: number,
    opts?: { signal?: AbortSignal },
  ): AsyncIterable<{ id: number; title: string }>;
  /**
   * Open a takeout (data export) session: history read through it counts
   * against Telegram's export limits instead of the interactive ones. Fails
   * with a `takeout` error carrying `seconds` while Telegram waits for the
   * owner to approve the export on another device.
   *
   * With `resumeId`, no request is made: the session of that id, opened
   * earlier on this authorization, is used again (a rebuilt context or a
   * restart continues the same export). One Telegram no longer honours fails
   * its first read with a `takeout` error.
   */
  takeout(
    scope: TakeoutScope,
    opts?: { signal?: AbortSignal; resumeId?: string },
  ): Promise<TelegramTakeout>;
}

/** Which kinds of chat a takeout session may export. Files are never exported through it. */
export interface TakeoutScope {
  messageUsers: boolean;
  messageChats: boolean;
  messageMegagroups: boolean;
  messageChannels: boolean;
}

/** An open takeout session: only what the backward history walk needs. */
export interface TelegramTakeout {
  /** Telegram's id for the session, kept so a later client can resume it. */
  readonly id: string;
  readonly scope: TakeoutScope;
  /** As {@link TelegramAdapter.getHistory}, through the export session. */
  getHistory(
    chatId: number,
    opts: { offsetId: number; limit: number; signal?: AbortSignal },
  ): Promise<{ messages: TgMessage[]; users: TgUser[] }>;
  /** End the session; `success` says the export finished. */
  finish(success: boolean, opts?: { signal?: AbortSignal }): Promise<void>;
}

/** A client used only to sign in. It keeps nothing on disk. */
export interface TelegramAuthAdapter {
  signInQr(opts: {
    /** Called for every login URL; a rotation calls it again with a new one. */
    onQr: (url: string, expires: Date) => void;
    onScanned?: () => void;
    /** Asked only when the account has a two-step password. */
    password: () => Promise<string>;
    /** Called after Telegram rejected the password; throw to stop retrying. */
    onInvalidPassword: () => Promise<void>;
    signal: AbortSignal;
  }): Promise<{ self: TgUser; session: string }>;
  /** End the authorization this client just created. */
  logOut(): Promise<void>;
  /**
   * End a stored authorization: import `session` into this client's memory
   * and log it out. A session Telegram already ended counts as ended.
   */
  logOutSession(session: string, opts: { signal: AbortSignal }): Promise<void>;
  close(): Promise<void>;
}

export interface AdapterFactory {
  /**
   * A client for a connected account. `storage.dir` is the account's own
   * directory, which holds the connection cache; `storage.key` encrypts it,
   * and `null` means this install keeps provider stores unencrypted.
   */
  live(
    creds: AppCredentials,
    storage: { dir: string; key: Buffer | null },
    device: DeviceInfo,
  ): TelegramAdapter;
  auth(creds: AppCredentials, device: DeviceInfo): TelegramAuthAdapter;
}
