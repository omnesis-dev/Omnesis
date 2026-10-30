# Telegram source: implementation design

Status: phases 1–4 implemented (1: skeleton, auth, session, gate, registration; 2: text sync, edits, deletions, gaps, day documents, synthetic twin; 3: media; 4: channels, forum topics, Takeout, docs), issue omnesis-dev/Omnesis#517. What only a real account and real devices can confirm is listed in §16. Each phase is built by a separate agent. Every path is relative to the repo root. "VERIFY" marked an mtcute API or behaviour that could not be confirmed from the published 0.32.7 types; phase 1 resolved every phase-1 item against the installed package and recorded the answer where the item was, marked **Resolved (phase 1)**. Section 15 collects them, with the deviations phases 1–4 made from this design (§15.10–§15.13).

---

## 1. Goal and scope

Add an **experimental** Telegram source. It archives the operator's own Telegram account (user account, MTProto, through mtcute) into Omnesis as one conversation document per chat per UTC day, the same shape WhatsApp uses.

**In scope:**

- private chats
- Saved Messages
- basic groups
- supergroups, including forums
- archived chats
- broadcast channels, opt-in
- edits and deletions
- voice-note transcription
- document and image extraction
- placeholders for other media

**Out of scope:**

- secret chats (end-to-end encrypted, never in the cloud API)
- view-once and self-destructing content
- stories
- sending, reading, or marking anything as read
- bots (no bot sessions)
- multi-device modes other than `exclusive`

Everything Telegram-specific lives in `packages/providers/telegram/`, its synth twin `packages/providers-synth/telegram/`, and its fixtures and docs. The descriptor is the only contract with shared code.

---

## 2. Decisions

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                                                       | Rationale                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | Package `@omnesis/provider-telegram`, provider id `telegram`, source id `telegram-messages`, declared with **`defineProvider()`** that has one source entry.                                                                                                                                                                                                                                                                   | `.claude/commands/source-review.md` §3 says shared app credentials and a shared live account context belong on `defineProvider()`, even with one source. This also leaves room for a later `telegram-contacts`.                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| D2  | `experimental: true` on the provider.                                                                                                                                                                                                                                                                                                                                                                                          | Gated by `OMNESIS_EXPERIMENTAL=1`; the collector hides it otherwise (`packages/source-sdk/src/define-source.ts`, `experimental`). Synthetic mode exposes it unconditionally, which the E2E relies on.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| D3  | The operator supplies `api_id` and `api_hash` through a `ProviderCredentialsSpec` with `required: true` and **without** `perAccount`. Stored at `<configDir>/telegram-credentials.json`. Nothing is bundled.                                                                                                                                                                                                                   | One app credential serves every account, like Plaid (`packages/providers/plaid/src/credentials-spec.ts`). Telegram API terms §2.1: "You must obtain your own api_id".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| D4  | QR login with automatic QR rotation, and an optional 2FA password asked through a `fields` challenge. The password is never stored.                                                                                                                                                                                                                                                                                            | `AuthSession.show` / `ask` (`packages/source-sdk/src/auth-session.ts`); WhatsApp's `authenticate` is the reference (`packages/providers/whatsapp/src/index.ts`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| D5  | Account id = the Telegram user id (decimal string). A re-auth that resolves another user fails with `AuthFailure("identity-mismatch")`, and the stray new authorization is logged out.                                                                                                                                                                                                                                         | Stable id: phone numbers and usernames change.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| D6  | **No** content-use acceptance step. Telegram API terms (§1.4 self-destructing content, §1.5 AI use, §2.x branding) go in the docs and the wizard instead.                                                                                                                                                                                                                                                                      | An acceptance step would put source-specific UI into shared clients.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| D7  | **Credential = mtcute session string** in a root-key-wrapped secret file (`writeProviderAccountCredentials`). mtcute's _cache_ (peers, update state, reference messages) lives in a **separate encrypted SQLite file** through a custom `BaseSqliteStorageDriver` over `better-sqlite3-multiple-ciphers`, keyed by the `telegram-store` storage key. **mtcute's own `SqliteStorage` (plain better-sqlite3 12) is never used.** | mtcute without persisted update state cannot catch up after a restart, so every restart would become a gap; without peer access hashes, history walks re-resolve everything. `BaseSqliteStorageDriver` has one abstract method, `_createDatabase(): ISqliteDatabase`, and `ISqliteDatabase` (`transaction`, `prepare`, `exec`, `close`; statements `run`, `get`, `all`) matches better-sqlite3-multiple-ciphers 13. The mtcute cache file is disposable: delete it and re-import the session string.                                                                                                                                                   |
| D8  | A missing **required** key blocks every plaintext write, for both the archive and the mtcute cache, and fails closed exactly like `MessageStore.readStoreEncryptionKey` (`packages/providers/whatsapp/src/message-store.ts:541`).                                                                                                                                                                                              | Same at-rest posture as WhatsApp.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| D9  | `multiDevice: { mode: "exclusive" }`, set explicitly.                                                                                                                                                                                                                                                                                                                                                                          | The archive is local to its host and the cursor is bound to that archive's `storeId`, so `handoff` would pass a cursor no other host can resume; Telegram's cloud is already the authoritative copy every host would read, so `replicated` adds nothing but a second session on the account (which would also trip `AUTH_KEY_DUPLICATED`).                                                                                                                                                                                                                                                                                                             |
| D10 | Broadcast channels are opt-in (`includeChannels`, default `false`). There is a per-chat exclusion list. Archived chats are included.                                                                                                                                                                                                                                                                                           | Volume and ban risk. Terms §3.3 (sponsored messages in channel content) is an open question.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| D11 | Exclude secret chats, view-once media (`ttl_seconds`), and messages with a self-destruct timer (`ttl_period`).                                                                                                                                                                                                                                                                                                                 | Terms §1.4 forbid "preventing self-destructing content from disappearing". Auto-delete deletions are honoured promptly.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| D12 | No time limit by default. The host's `CreateOptions.dataCutoff` (the operator knob) stops the walk and filters the drain.                                                                                                                                                                                                                                                                                                      | `applyDataCutoff` / `dataCutoff` contract.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| D13 | **No `historyImport`.** The full-history walk is a resumable part of bootstrap. `contentRetention: "complete"`.                                                                                                                                                                                                                                                                                                                | Each day document is re-rendered from a complete local archive, so derived links may be rebuilt.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| D14 | A local protected SQLite archive holds messages, chats, per-chat checkpoints, the deletion index, dirty days (the publish queue), and the emitted-attachment ledger. Rows are acknowledged only after the gateway accepts them, using the `emit_seq` / `committedSeq` cursor protocol.                                                                                                                                         | A direct mirror of WhatsApp's `drain()` and `state.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| D15 | Lazy media: never download eagerly across history. Bounded attempts per page, durable retry lifecycle, `FLOOD_WAIT` honoured.                                                                                                                                                                                                                                                                                                  | Ban risk and cost.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| D16 | Generic paper-plane glyph drawn by Omnesis (SVG data URI), not the Telegram logo.                                                                                                                                                                                                                                                                                                                                              | Terms §2.4.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| D17 | `selfIdentity: { aliasPrefix: "telegram-user", accountPattern: "^\\d+$" }`. `discover()` returns an `AccountDescriptor` with a `phone` subject when the account's phone is known. Mentions carry E.164 phones when visible, so people merge with WhatsApp.                                                                                                                                                                     | `packages/gateway/src/self-identity-sources.ts`, `packages/gateway/src/domain/ContactCardBootstrap.ts:422`, `packages/source-sdk/src/account-descriptor.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| D18 | Exactly two files import `@mtcute/*`: `src/client/mtcute/adapter.ts` and `src/client/mtcute/storage.ts`. Everything else talks to `TelegramAdapter`.                                                                                                                                                                                                                                                                           | Tests swap in a simulated adapter; TDLib could replace mtcute later.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| D19 | Pin `@mtcute/node` and `@mtcute/core` to **exactly `0.32.7`**. Add a root `package.json` `overrides` entry so `@mtcute/node`'s `better-sqlite3@^12.10.0` resolves to the workspace's `^13.0.3`.                                                                                                                                                                                                                                | `@mtcute/node/index.js` re-exports `sqlite/driver.js`, which statically imports `better-sqlite3`. Without the override npm installs and builds a second native better-sqlite3. mtcute only calls `sqlite3(filename, opts)` and `.pragma`, both API-stable in 13. **Resolved (phase 1):** confirmed from `@mtcute/node/sqlite/driver.js`, and at runtime: mtcute resolves `better-sqlite3@13.0.3` and its own `SqliteStorage` round-trips a session on it. The override is `"@mtcute/node": { "better-sqlite3": "^13.0.3" }`; the `$better-sqlite3` reference form cannot be used because the root manifest does not depend on `better-sqlite3` itself. |

---

## 3. Package layout

```
packages/providers/telegram/
  package.json            name @omnesis/provider-telegram, license AGPL-3.0-or-later, main src/index.ts,
                          exports { ".": "./src/index.ts", "./testing": "./src/testing/simulated-telegram.ts" },
                          deps: @omnesis/core, @omnesis/source-sdk, @omnesis/types, @mtcute/node 0.32.7 (exact),
                          @mtcute/core 0.32.7 (exact), better-sqlite3-multiple-ciphers ^13.0.3, better-sqlite3 ^13.0.3
                          (plaintext legacy open, as in WhatsApp); devDeps @types/better-sqlite3
  tsconfig.json           copy of packages/providers/whatsapp/tsconfig.json
  src/index.ts            defineProvider descriptor (section 9); lazy-imports provider.ts like WhatsApp
  src/credentials-spec.ts telegramCredentialsSpec (fileKey "telegram", wizard text, section 6)
  src/icons.ts            telegramIconDataUri (Omnesis-drawn SVG paper plane)
  src/limits.ts           every tunable in one place (section 7.8)
  src/types.ts            TelegramSyncCursor, StoredMessage, StoredChat, MediaDescriptor, ChatKind, MediaState
  src/state.ts            telegramStateSpec (mirrors whatsapp/src/state.ts)
  src/session-store.ts    read/write/revoke the per-account credential record (section 5.2)
  src/auth.ts             loginFlow(session, deps) — QR + 2FA + identity check (section 6)
  src/provider.ts         TelegramProvider: the account context; live adapter, update routing → archive,
                          suspend/resume, credentialState, revocation handling
  src/message-store.ts    TelegramArchive: protected SQLite (section 5.1); name mirrors WhatsApp
  src/message-extractor.ts TgMessage → StoredMessage (text/entities → markdown, media descriptor,
                          ephemeral filter, forward/reply/topic fields)
  src/history-walker.ts   dialog enumeration, per-chat paging, gap reconcile, presence check (section 7)
  src/messages.ts         TelegramMessagesSource.sync(): walk budget → drain → media → page (section 7.6)
  src/normalizer.ts       normalizeDayChat() → DocumentInput (section 8)
  src/links.ts            telegramSourceUrl / telegramAppUrl (section 8.4)
  src/media-retry.ts      media lifecycle states, outcomes, backoff and download-failure classes (phase 3)
  src/media.ts            the per-page media pass: voice-note transcription, attachment extraction (phase 3)
  src/client/download.ts  downloadWithReferenceRefresh: the stale-file-reference rule both adapters share (phase 3)
  src/client/types.ts     TelegramAdapter, TelegramAuthAdapter, DTOs, TelegramError (section 4) — no mtcute types
  src/client/mtcute/adapter.ts  the only runtime mtcute import: MtcuteTelegramAdapter implements TelegramAdapter
  src/client/mtcute/storage.ts  EncryptedSqliteStorageDriver extends BaseSqliteStorageDriver; createMtcuteStorage()
  src/client/errors.ts    mapRpcError(): RPC error → TelegramError (pure; unit-tested without mtcute)
  src/client/boundary.test.ts  fails when any file outside src/client/mtcute/ imports @mtcute/*
  src/protected-store.ts  readTelegramStoreKey (fail-closed), openProtectedDatabase, inspectProtectedStore:
                          the open/encryption/migration/quarantine both SQLite files share (phase 1)
  src/device.ts           telegramDeviceInfo() (section 6, device metadata)
  src/testing/simulated-telegram.ts  SimulatedTelegram (in-memory server) + SimulatedTelegramAdapter
  src/testing/fixtures.ts invented users, the app credential, a scripted AuthSession (tests only)
  src/**/*.test.ts        next to sources

packages/providers-synth/telegram/
  package.json            @omnesis/provider-telegram-synth, private
  tsconfig.json
  src/index.ts            spreads the real definition; discover → preDiscoveredAccounts; authenticate → fakeQrSession;
                          create → wraps-real when the universe ships fake-corpus.json, otherwise no accounts
  src/wraps-real.ts       drives the REAL TelegramProvider + source over SimulatedTelegramAdapter
                          (mirror of providers-synth/whatsapp/src/wraps-real.ts); getTelegramWrapsRealController()
```

Logger components: `provider:telegram`, `source:telegram-messages`, plus children (`log.child("walker")`, `log.child("store")`). Log lines are one-line template literals; never log message text, session strings, phone numbers, or api_hash.

---

## 4. Adapter interface (`src/client/types.ts`)

```ts
// Ids: chat ids use mtcute "marked" ids — user >0, basic group -id, channel/supergroup -100id.
export type ChatKind = "private" | "saved" | "group" | "supergroup" | "forum" | "channel";
export type MessageBox = "common" | `channel:${number}`; // common = private + basic groups (global id space); N is the MARKED channel id (-100…)

export interface TgUser {
  id: number;
  firstName?: string;
  lastName?: string;
  username?: string;
  phone?: string /* digits, may be absent */;
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
  fileId?: string;
  mimeType?: string;
  fileName?: string;
  size?: number;
  durationSec?: number;
  isViewOnce: boolean;
  summary?: string; /* poll question, venue title, webpage URL — render-only */
}
export interface TgMessage {
  chatId: number;
  id: number;
  box: MessageBox;
  date: number /* unix s */;
  editDate?: number;
  senderId?: number;
  senderName?: string;
  outgoing: boolean;
  text: string /* markdown */;
  replyToId?: number;
  topicId?: number;
  forwardFrom?: string;
  groupedId?: string;
  ttlPeriod?: number;
  media?: TgMediaRef;
  service?: string /* e.g. "joined", "pinned" */;
}
export type TgUpdate =
  | { kind: "new"; message: TgMessage; chat: TgChat; users: TgUser[] }
  | { kind: "edit"; message: TgMessage; chat: TgChat; users: TgUser[] }
  | { kind: "delete"; box: MessageBox; ids: number[] } // common box: no chat id
  | { kind: "gap"; scope: "account" | { channelId: number } } // channelDifferenceTooLong / detected gap
  | { kind: "connection"; state: "offline" | "connecting" | "updating" | "connected" }
  | { kind: "revoked"; reason: RevocationReason };
export type RevocationReason =
  | "AUTH_KEY_UNREGISTERED"
  | "SESSION_REVOKED"
  | "SESSION_EXPIRED"
  | "USER_DEACTIVATED"
  | "USER_DEACTIVATED_BAN"
  | "AUTH_KEY_DUPLICATED";

export class TelegramError extends Error {
  constructor(
    readonly code:
      | "flood-wait"
      | "revoked"
      | "file-reference-expired"
      | "not-found"
      | "forbidden"
      | "network"
      | "cancelled"
      | "unknown",
    message: string,
    readonly detail?: { seconds?: number; reason?: RevocationReason; rpc?: string },
  ) {
    super(message);
  }
}

export interface DeviceInfo {
  deviceModel: string;
  systemVersion: string;
  appVersion: string;
  langCode: string;
}
export interface AppCredentials {
  apiId: number;
  apiHash: string;
}

export interface TelegramAdapter {
  /** Import session, connect, start the updates loop with catch-up. Resolves to self. */
  connect(opts: { session: string; signal?: AbortSignal }): Promise<TgUser>;
  exportSession(): Promise<string>;
  /** One cheap request (updates.getState) that throws `revoked` when the key is gone. Phase 1 addition. */
  checkAuthorization(opts?: { signal?: AbortSignal }): Promise<void>;
  close(): Promise<void>; // stop updates, disconnect, close storage
  suspend(): Promise<void>;
  resume(): Promise<void>;
  onUpdate(handler: (u: TgUpdate) => void): () => void;
  iterDialogs(opts: { archived: "keep"; signal?: AbortSignal }): AsyncIterable<TgDialog>;
  /** Newest→oldest page strictly older than offsetId (0 = newest); minId bounds the low end. */
  getHistory(
    chatId: number,
    opts: { offsetId: number; limit: number; minId?: number; signal?: AbortSignal },
  ): Promise<{ messages: TgMessage[]; users: TgUser[] }>;
  getMessages(chatId: number, ids: number[]): Promise<(TgMessage | null)[]>; // channel or any chat
  getMessagesCommon(ids: number[]): Promise<(TgMessage | null)[]>; // common box, no peer
  // Phase 3 (§15.12): addressed by message, so a stale file reference can be refreshed.
  downloadMedia(
    target: { chatId: number; msgId: number; fileId: string; size?: number },
    opts: { maxBytes: number; signal?: AbortSignal },
  ): Promise<{ data: Uint8Array; refreshed?: TgMediaRef }>;
  iterForumTopics(
    chatId: number,
    opts?: { signal?: AbortSignal },
  ): AsyncIterable<{ id: number; title: string }>; // phase 4
  // Phase 4 (§15.13): a narrow reader, not a second adapter.
  takeout(scope: TakeoutScope): Promise<TelegramTakeout>;
}
interface TakeoutScope {
  messageUsers: boolean;
  messageChats: boolean;
  messageMegagroups: boolean;
  messageChannels: boolean;
}
interface TelegramTakeout {
  readonly scope: TakeoutScope;
  getHistory(
    chatId: number,
    opts: { offsetId: number; limit: number; signal?: AbortSignal },
  ): Promise<{ messages: TgMessage[]; users: TgUser[] }>;
  finish(success: boolean): Promise<void>;
}
export interface TelegramAuthAdapter {
  // in-memory storage; used only by auth.ts
  signInQr(opts: {
    onQr: (url: string, expires: Date) => void;
    onScanned?: () => void;
    password: () => Promise<string>;
    onInvalidPassword: () => Promise<void>;
    signal: AbortSignal;
  }): Promise<{ self: TgUser; session: string }>;
  logOut(): Promise<void>;
  close(): Promise<void>;
}
export interface AdapterFactory {
  live(
    creds: AppCredentials,
    storage: { dir: string; key: Buffer | null },
    device: DeviceInfo,
  ): TelegramAdapter;
  auth(creds: AppCredentials, device: DeviceInfo): TelegramAuthAdapter;
}
```

**mtcute mapping (`src/client/mtcute/adapter.ts`).** Every name below was checked against the installed 0.32.7 declarations and sources in phase 1.

| Adapter surface                | mtcute                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| construction                   | `new BaseTelegramClient({ apiId, apiHash, storage: createMtcuteStorage(...), initConnectionOptions: { ...device, systemLangCode }, updates: { catchUp: true, onChannelTooLong }, network: { middlewares } })` from `@mtcute/node`, then `new TelegramClient({ client: base })`. **Resolved (phase 1):** the base client is built first because `TelegramClient`'s own `updates` option is typed as the parsed-update handler's params, not `UpdatesManagerParams`. mtcute's log lines are routed into ours at WARN through `client.log.mgr.handler` / `.level` (`LogManager` lives in `@mtcute/core/utils.js`). The sign-in client uses `MemoryStorage` and `updates: false` — never `disableUpdates`, which wraps every call in `invokeWithoutUpdates` and would suppress the `updateLoginToken` that QR login waits for.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `connect`                      | `importSession(session, true)`, then `getMe()`, then `startUpdatesLoop()`. **Resolved (phase 1):** `importSession(session: string \| InputStringSessionData, force?: boolean)` and `startUpdatesLoop()` exist as named. Without `force` the import is skipped whenever the cache holds a key for the default DC, so `force` is always passed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `exportSession`                | `exportSession()`. **Resolved (phase 1):** exists; it re-reads the primary DC from storage, so the string changes after a DC migration — the provider rewrites the record when it does.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `checkAuthorization`           | `client.call({ _: "updates.getState" })` through the same error guard. Phase 1 addition, because of the next row.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `onUpdate`                     | `onNewMessage`, `onEditMessage`, `onDeleteMessage` (Emitters). `DeleteMessageUpdate.messageIds` and `.channelId: number \| null` (a **marked** id). `onChannelTooLong(channelId, upd)` receives a **bare** channel id; the adapter marks it (`-1e12 - id`) before emitting `gap`. **Resolved (phase 1):** `onConnectionState: Emitter<"offline" \| "connecting" \| "updating" \| "connected">` and `onError: Emitter<Error>` exist. mtcute does **not** surface a revoked key as an event: on `AUTH_KEY_UNREGISTERED` the updates manager stops its loop and logs at debug level. So every adapter request goes through one guard that classifies the error and emits `revoked` once, and the provider calls `checkAuthorization` at the top of each sync, so an idle account still notices.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `iterDialogs`                  | `iterDialogs({ archived: "keep" })`. The default is `"exclude"`, so passing `keep` is mandatory.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `getHistory`                   | `getHistory(chat, { offset, limit, minId })` / `iterHistory` (confirmed)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `getMessages`                  | `getMessages(chat, ids)` and `getMessagesUnsafe(ids)` (confirmed)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `downloadMedia`                | `downloadAsBuffer(fileId, { abortSignal, limit: maxBytes + 1, stallTimeout })`; on `FILE_REFERENCE_EXPIRED`, `getMessages(chat, [id])` and one retry with the fresh message's file id (`client/download.ts`, phase 3)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| auth                           | `signInQr({ onUrlUpdated, onQrScanned, password, invalidPasswordCallback, abortSignal })` (confirmed); `logOut()` (confirmed)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `iterForumTopics`              | `iterForumTopics(chat)` (confirmed)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `takeout`                      | **Resolved (phase 4):** `TelegramClient.initTakeoutSession(params: Omit<tl.account.RawInitTakeoutSessionRequest, '_'>): Promise<TakeoutSession>` (`@mtcute/core/highlevel/types/misc/takeout-session.js`). The session wraps a call in `invokeWithTakeout` (`session.call`); `session.createProxy()` returns the base client with `call` replaced, and mtcute's free functions from `@mtcute/core/methods.js` accept it, so history is `getHistory(proxy, chat, params)` — the same parsing as the normal read. `finish(success)` sends `account.finishTakeoutSession`. Requested with `{ messageUsers, messageChats, messageMegagroups: true, messageChannels: includeChannels, contacts: false, files: false }`. Flood: the proxy's calls go through the same network middleware, so the 10 s flood waiter applies and a longer wait surfaces as the walk's `FLOOD_WAIT` (`meta.flood_until`); downloads never use the session, so the media flood wait (`meta.media_flood_until`) is independent. `TAKEOUT_INIT_DELAY_%d` is **code 420** (mtcute normalises it with `seconds`); `mapRpcError` checks it before the flood rule and maps it, `TAKEOUT_INVALID` and `TAKEOUT_REQUIRED` to the new `TelegramError` code `takeout`. The flood waiter matches only `FLOOD_WAIT_`/`SLOWMODE_WAIT_`/`FLOOD_TEST_PHONE_WAIT_`/`FLOOD_PREMIUM_WAIT_`, so it never sleeps on the delay. |
| `close` / `suspend` / `resume` | `destroy()` (permanent: a destroyed client refuses to reconnect) / `disconnect()` / `connect()` + `startUpdatesLoop()`. A failed first connect is retried by calling `connect` again on the same client, never by closing it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| flood waits                    | **Resolved (phase 1):** there is no client-level `floodSleepThreshold`. The flood waiter is a network middleware: `network: { middlewares: networkMiddlewares.basic({ floodWaiter: { maxWait } }) }`, default `maxWait` 10 000 ms and `maxRetries` 5; `RpcCallOptions.floodSleepThreshold` overrides it per call. The adapter sets `maxWait` to `FLOOD_SLEEP_MAX_MS` (10 s) explicitly. A longer wait surfaces as `tl.RpcError` (code 420) whose `text` is normalised to `FLOOD_WAIT_%d` with a numeric `seconds` property (also `FLOOD_PREMIUM_WAIT_%d`, `SLOWMODE_WAIT_%d`), mapped to `TelegramError("flood-wait")`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

**Simulated adapter (`src/testing/simulated-telegram.ts`).** `SimulatedTelegram` holds an invented corpus `{ self, users[], chats[{ chat, messages[] }], commonBoxNextId, channelNextId{} }` and implements `TelegramAdapter` and `TelegramAuthAdapter` deterministically, with all async work through `setTimeout` so fake timers drive it. Script controls:

- `pushNew`, `pushEdit`, `pushDelete(box, ids)`
- `dropUpdates(n)`: lose updates, so a later `gap` fires
- `emitGap`
- `failNext(method, TelegramError)`, `floodWait(method, seconds)`
- `revoke(reason)`
- `qr.rotate()`, `qr.scan(userId)`, `requirePassword(pw)`
- `setMedia(fileId, bytes | "gone")`, `expireReference(chatId, msgId)` (phase 3: the old file id answers `FILE_REFERENCE_EXPIRED`, the message names a fresh one)
- `calls` (an assertion log of every request, for budget and pacing tests)

All ids, names and phones are invented: `+1 (555) 010-01xx`, `example.com`.

---

## 5. Storage

### 5.1 Archive `<stateDir>/archive.db` (`TelegramArchive`)

`stateDir` is the host's `<configDir>/telegram/<accountId>/`. **Resolved (phase 1):** `accountStateDir` in `packages/collector/src/source-host-builder.ts` is `join(configDir, safePathSegment(providerBaseId), safePathSegment(accountId))`, the same directory `providerAccountCredentialsPath("telegram", accountId)` writes the credential into, and the collector pre-creates it. Phase 1 implemented the open, the encryption, the quarantine and the schema; phase 2 the write and drain paths, and schema 2's additive columns (§15.11).

Open, pragmas, encryption, plaintext-to-encrypted migration through a staging rekey, corrupt-file quarantine, and `inspect…` probe are copied from `packages/providers/whatsapp/src/message-store.ts` (`openStoreDatabase`, `migratePlaintextStore`, `inspectMessageStore`, `readStoreEncryptionKey`, `configurePragmas`). The key name is `telegram-store`.

```sql
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  -- store_id, emit_seq_counter, schema_version, flood_until, last_full_reconcile_at,
  -- takeout_state (active|delayed|done|unavailable), takeout_retry_at, id_collisions (phase 4)
CREATE TABLE chats (
  chat_id INTEGER PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, username TEXT,
  is_archived INTEGER NOT NULL DEFAULT 0, is_forum INTEGER NOT NULL DEFAULT 0,
  walk_state TEXT NOT NULL DEFAULT 'pending',   -- pending|walking|done|excluded
  oldest_fetched_id INTEGER,                    -- checkpoint: next page = ids < this
  newest_seen_id INTEGER NOT NULL DEFAULT 0,    -- max id archived (live or walk)
  top_at_enumeration INTEGER NOT NULL DEFAULT 0,
  reconcile_from_id INTEGER,                    -- set by gap handling; null = none pending
  last_presence_check_at INTEGER, updated_at INTEGER NOT NULL,
  topics_listed_at INTEGER);                    -- phase 4 (schema 4)
CREATE TABLE users (user_id INTEGER PRIMARY KEY, display_name TEXT NOT NULL, username TEXT,
  phone_e164 TEXT, is_bot INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE messages (
  chat_id INTEGER NOT NULL, msg_id INTEGER NOT NULL, box TEXT NOT NULL,
  ts INTEGER NOT NULL, edit_ts INTEGER, sender_id INTEGER, sender_name TEXT, outgoing INTEGER NOT NULL,
  text TEXT NOT NULL, reply_to_id INTEGER, topic_id INTEGER, forward_from TEXT, grouped_id TEXT,
  service TEXT, media_json TEXT,
  deleted INTEGER NOT NULL DEFAULT 0, deleted_at INTEGER,
  transcript TEXT, media_state TEXT, media_attempts INTEGER NOT NULL DEFAULT 0,
  media_next_attempt INTEGER, media_last_error TEXT,
  PRIMARY KEY (chat_id, msg_id));
CREATE INDEX messages_by_chat_ts ON messages(chat_id, ts);
CREATE UNIQUE INDEX messages_by_box_id ON messages(box, msg_id);  -- deletion index (common box = global ids)
CREATE TABLE pending_deletions (box TEXT NOT NULL, msg_id INTEGER NOT NULL, observed_at INTEGER NOT NULL,
  PRIMARY KEY (box, msg_id));                    -- deletes for ids not yet archived
CREATE TABLE dirty_days (chat_id INTEGER NOT NULL, date TEXT NOT NULL, emit_seq INTEGER,
  PRIMARY KEY (chat_id, date));
CREATE INDEX dirty_days_emit_seq ON dirty_days(emit_seq);
CREATE TABLE emitted_attachments (chat_id INTEGER NOT NULL, date TEXT NOT NULL, external_id TEXT NOT NULL,
  emit_seq INTEGER NOT NULL, PRIMARY KEY (chat_id, date, external_id));
CREATE TABLE topics (chat_id INTEGER NOT NULL, topic_id INTEGER NOT NULL, title TEXT NOT NULL,
  PRIMARY KEY (chat_id, topic_id));             -- phase 4
```

Rules:

- **Every write that changes a message also upserts `dirty_days(chat_id, date(ts))` in the same transaction.** `date` is the UTC `YYYY-MM-DD`, as in WhatsApp's `messageDate()`.
- **Upsert** on `(chat_id, msg_id)`. `ON CONFLICT DO UPDATE` changes text and media fields only when `excluded.edit_ts > edit_ts`, or when the stored row came from an older render. It never resets `deleted` or the media lifecycle. This is the dedupe for walk-versus-live races. Ids are scoped by account because there is one archive per account.
- **Insert checks `pending_deletions`.** If a row matches, the message is stored with `deleted = 1` and the pending row is removed. Pending rows expire after `PENDING_DELETION_TTL_DAYS`.
- **Checkpoint updates (`oldest_fetched_id`, `walk_state`) commit in the same transaction as the page's messages.** This is "persist before advancing".
- `drain({ committedSeq, limit })`: same algorithm as `MessageStore.drain()`. It selects `deleted = 0` messages for each dirty day, stamps `emit_seq`, and returns `emitSeq` and `morePending`. It never garbage-collects messages.

### 5.2 Credential `<configDir>/telegram/<userId>/credentials.json`

Written with `writeProviderAccountCredentials("telegram", userId, record, configDir)`, a wrapped secret file. The record is `{ session, userId, apiId, phone?, username?, connectedAt, revokedAt?, revokedReason? }`.

- **Write it only after `getMe()` succeeds** on the new session.
- **On revocation, rewrite it with `session: ""` plus `revokedAt` and `revokedReason`.** The dead key is not kept, and `credentialState` can still answer offline.
- `discover()` = `listProviderAccountIds("telegram", ctx.configDir)`. It never lists directories, because a host-created `stateDir` is not a credential.
- `cleanupCredentials(accountId)` removes `<configDir>/telegram/<accountId>/` (the credential, archive and mtcute cache), and only that account.

### 5.3 mtcute cache `<stateDir>/mtcute.db`

```ts
class EncryptedSqliteStorageDriver extends BaseSqliteStorageDriver {
  _createDatabase() { /* openStoreDatabase(path, key) with the same sqlcipher pragmas; WAL */ }
}
createMtcuteStorage({ dir, key }) => new BaseSqliteStorage(new EncryptedSqliteStorageDriver(...))
```

- It is a separate file from the archive, because mtcute owns its own tables and migrations.
- The session string stays canonical. At each `connect`, call `importSession(session, true)` so a lost or corrupt `mtcute.db` is quarantined and rebuilt from the credential. **Resolved (phase 1):** with `force`, mtcute deletes every stored auth key and sets the session's primary key, so it works as intended; a test corrupts `mtcute.db` and round-trips the session through the rebuilt cache. `_createDatabase()` is called on every load — the first connect and again after each `disconnect()` — so the driver keeps the key for the adapter's lifetime and the adapter zeroes it on `close()`.
- `mtcute.db` is encrypted with the same key and the same fail-closed rule. It does **not** hold auth keys (next item).
- **Resolved (phase 1), adopted:** the storage provider is `{ driver, kv, peers, refMessages }` from `BaseSqliteStorage` plus `authKeys: new MemoryAuthKeysRepository(new MemoryStorageDriver())`. Because `importSession(…, true)` re-sets every key at each connect, a persisted key would never be read back; keeping keys in memory means the primary key exists only in the wrapped credential, even on an install with unencrypted provider stores (a test asserts the key bytes never reach the file). Keys for media DCs are re-exported on demand after a restart. `BaseSqliteStorage` still creates an empty `auth_keys` table.

### 5.4 Storage key registration

Add `"telegram-store"` to `STORAGE_KEY_NAMES` with host `collector` in `packages/core/src/storage-keys.ts`. That gets it minted at collector boot (`packages/collector/src/storage-encryption.ts`), listed by `keyring storage-init` and the doctor. This follows the existing `whatsapp-store` / `imessage-transcripts` precedent.

Encapsulation note: this is a name in a generic registry, not behaviour. The alternative, `provider:telegram-store` minted lazily by the provider, would be invisible to `storage-init` and the doctor. A descriptor-level `storageKeys` field is the long-term fix (open question Q6).

`probeLocalStores` returns two results: "Telegram message archive" and "Telegram connection cache".

---

## 6. Auth flow (`src/auth.ts`, the descriptor's `authenticate`)

1. Read the app credential with `readProviderCredentials("telegram", host.configDir)`. If it is absent or malformed, throw `MissingCredentialsError("telegram", "Telegram")`; the wizard path is Plaid's (`packages/providers/plaid/src/provider.ts:92`).
2. Build `factory.auth(creds, device)` with in-memory storage. Nothing touches disk before success.
3. Call `signInQr`. Each `onQr(url, expires)` runs `session.show({ kind: "qr", title: "Scan this code with Telegram", instructions: "On your phone: Telegram → Settings → Devices → Link Desktop Device, then scan.", data: url, expiresAt: expires.toISOString() })`. A rotation replaces the challenge. `onScanned` runs `session.show({ kind: "wait", title: "Signing in…" })`.
4. **2FA.** The `password` callback first checks `session.canShow("fields")`. If false, throw `AuthFailure("unsupported", …, { remedy: "Use the portal or an updated CLI to enter your Telegram two-step password." })`. Otherwise ask `{ kind: "fields", title: "Enter your two-step verification password", instructions: "This account has a Telegram cloud password. It is used once and never stored.", schema: object({ password: secret({ label: "Password", required: true }) }) }`. `onInvalidPassword` counts attempts; after `MAX_PASSWORD_ATTEMPTS` (3), throw `AuthFailure("credential-rejected")`. Never log the password and never keep it beyond the call.
5. **Identity.** `accountId = String(self.id)`. If `session.accountId` is set and differs, call `logOut()` on the new authorization and throw `AuthFailure("identity-mismatch", …, { remedy: "Scan with the Telegram account this connection belongs to, or add a new connection." })`.
6. Write the credential (section 5.2). On failure, throw `CredentialPersistError`. Return `{ accounts: [{ accountId, state: { status: "connected" } }] }`.
7. **Error mapping:**

   | Condition                                   | Mapping                                                               |
   | ------------------------------------------- | --------------------------------------------------------------------- |
   | Network                                     | `AuthFailure("unavailable")`                                          |
   | `FLOOD_WAIT`                                | `AuthFailure("unavailable", { retryAfterMs })`                        |
   | `API_ID_INVALID` / `API_ID_PUBLISHED_FLOOD` | `AuthFailure("missing-credentials")`; the remedy points to the wizard |
   | Abort                                       | `AuthFailure("cancelled")`                                            |
   | Expired QR without rotation                 | `AuthFailure("challenge-expired")`                                    |

**Device metadata (`DeviceInfo`)** is honest:

- `deviceModel: "Omnesis"`
- `systemVersion: \`${os.type()} ${os.release()}\``
- `appVersion`: the Omnesis product version from core
- `langCode: "en"`

No hostname. Per terms §2.3, never use the word "Telegram" in the device or app name.

**Wizard (`telegramCredentialsSpec.wizard`):**

- `intro`: Omnesis talks to Telegram through the Telegram API using your own developer app (terms §2.2: "users must know the app uses the Telegram API").
- `why`: the credential stays on this host; nothing is shared.
- Steps:
  1. Open `https://my.telegram.org/apps` and sign in. The login code arrives inside the Telegram app, not by SMS.
  2. Create an app. Use a title that does not contain "Telegram", e.g. "Omnesis archive"; short name 5–32 letters or digits; platform "Desktop".
  3. **If you see a bare "ERROR" popup:** disable VPN, proxy and ad blockers; try another browser or network; use a title without non-ASCII characters or the word "Telegram"; wait and retry, because a newly registered number is often refused.
  4. **Only one app per phone number.** If you already created one, reuse its `api_id` / `api_hash`; there is no second.
  5. Paste the `api_id` (pattern `^\d+$`) and `api_hash` (pattern `^[0-9a-f]{32}$`, secret).

`estMinutes: 5`.

**`credentialState(ctx)`** reads only the stored record:

| Record state                                                                                             | Result                                                                                |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| none                                                                                                     | `never-connected`                                                                     |
| `revokedReason` ∈ {`AUTH_KEY_UNREGISTERED`, `SESSION_REVOKED`, `SESSION_EXPIRED`, `AUTH_KEY_DUPLICATED`} | `unlinked` with detail "This Omnesis session was ended from another Telegram device." |
| `revokedReason` ∈ {`USER_DEACTIVATED`, `USER_DEACTIVATED_BAN`}                                           | `revoked`                                                                             |
| key or root unreadable                                                                                   | `unknown` (through `readConnectionState`, as WhatsApp does)                           |
| otherwise                                                                                                | `connected`                                                                           |

**Runtime revocation.** The adapter emits `{ kind: "revoked" }`. The provider then:

- rewrites the record (section 5.2);
- stops the updates loop;
- fires `onSourceError`;
- makes the next `sync()` throw `SyncError("auth", …, { remediation: { summary: "Telegram ended this connection", steps: ["Re-authenticate the Telegram source from Sources and scan the new code."], restartRequired: false } })`.

---

## 7. Sync algorithm

### 7.1 Lifecycle (`TelegramProvider`, the provider context)

- **`createContext`:** load the app credential and session record. If the record is revoked or missing, throw a clear message (create refuses). Open the archive; build `factory.live(...)`; call `adapter.connect({ session })`. Assert `self.id === accountId`; if not, mark revoked with `AUTH_KEY_DUPLICATED`-style detail and throw. Upsert self into `users`. Subscribe `onUpdate` and route updates into the archive (section 7.3).
- **Source `create`:** returns `sync`, `onPushEvent` (archive change → host), `onSourceError`, `onResync`, `suspend`/`resume` (delegate to `adapter.suspend`/`resume`), `probeLocalStores`, and the `icon`. `dispose` and `disposeContext` call `adapter.close()` and then `archive.close()`.

### 7.2 Bootstrap walk (`history-walker.ts`, called from `sync()` with a budget)

1. **Enumeration.** Runs when `chats` is empty, when `meta.last_full_reconcile_at` is older than `FULL_RECONCILE_INTERVAL_H`, or after a `gap` with account scope.
   - `iterDialogs({ archived: "keep" })` upserts `chats`, including `is_archived`, `kind`, `top_at_enumeration`.
   - Skip `channel` unless `includeChannels`. Skip chats in `excludedChats` (matched by marked id or `@username`).
   - Saved Messages = the dialog whose peer is self; it gets `kind: "saved"`.
   - New chats get `walk_state = 'pending'`.
2. **Ordering.** Chats are walked in dialog order, most recently active first, so recent history lands first.
3. **Paging, per chat, newest to oldest.** `getHistory(chatId, { offsetId: oldest_fetched_id ?? 0, limit: HISTORY_PAGE_SIZE })`. In **one transaction**:
   - upsert users and messages;
   - mark days dirty;
   - set `oldest_fetched_id = min(id)` and `newest_seen_id = max(newest_seen_id, max(id))`;
   - when the page is short or empty, or the oldest message is older than `dataCutoff`, set `walk_state = 'done'`.
4. **Budget per `sync()` page.** At most `WALK_REQUESTS_PER_PAGE` history calls, with at least `HISTORY_MIN_INTERVAL_MS` between calls, stopping early when `deadline - now < WALK_DEADLINE_MARGIN_MS`. The walk is resumable at any request boundary: an interrupted import restarts from `oldest_fetched_id`.
5. **Flood wait.** A `TelegramError("flood-wait", seconds)` stops the walk for this page and stores `meta.flood_until = now + seconds`. Later pages skip upstream calls until then, but still drain. A flood longer than `FLOOD_ISSUE_THRESHOLD_S` adds `SyncIssue { kind: "rate-limit", scope: "partition", severity: "info" }`. Flood waits never throw, because the drain still has value. The issue's count is the number of chats waiting.

### 7.3 Live updates (in the update handler, synchronous archive writes)

- **`new` / `edit`:** upsert the chat (pending walk if unknown) and its users. If `extractMessage` returns null (ephemeral, view-once, service noise), skip the message, but still advance `newest_seen_id`. Otherwise upsert the message and mark its day dirty.
- **`delete`:**
  - For `box = channel:N`, look up `(box, id)`.
  - For the **common box**, look up through the `messages_by_box_id` index. Telegram's `updateDeleteMessages` carries no peer, and ids are unique across the account's private chats and basic groups.
  - Found: set `deleted = 1`, `deleted_at`, and mark the day dirty.
  - **Unseen ids** go into `pending_deletions` and are applied when the id arrives (section 5.1).
- **`gap`:** account scope sets `meta.reconcile_requested = 1`. Channel scope sets `chats.reconcile_from_id = newest_seen_id` for that channel. Both fire `onPushEvent`.
- **`connection` back to `connected`:** if the store recorded an outage longer than `GAP_SUSPECT_OUTAGE_S`, request an account-scope reconcile.
- Every change fires the archive's change handler, so the host sees a push and calls `sync()`.

mtcute persists `pts` only after a dispatch tick. Archive writes are synchronous inside the handler, so they land first. **Resolved (phase 1):** dispatch is synchronous — `_onUpdate` emits `onRawUpdate`, whose parsed-update handler emits `onNewMessage` etc. in the same call stack (as long as no `messageGroupingInterval` is set, which would defer album messages to a timer) — and `_saveUpdatesStorage` runs at the end of the loop iteration. A handler that throws propagates into the loop, which logs "restarting", so the adapter catches every handler error. Async work started inside a handler is not awaited.

### 7.4 Gap reconciliation (`history-walker.reconcile()`)

mtcute does **not** report `updates.differenceTooLong`: it sets `pts` and logs at debug level. It reports only `channelDifferenceTooLong`, through `onChannelTooLong`. So reconciliation is driven by Omnesis:

1. **Forward gap.** During enumeration (boot, the periodic interval, or a requested reconcile), for each dialog with `lastMessageId > newest_seen_id`, page `getHistory(chat, { offsetId: 0, minId: newest_seen_id })` until reaching `newest_seen_id`. This uses the same transaction rule as the walk. Channels with `reconcile_from_id` are paged the same way.
2. **Presence check** for edits and deletions lost in a gap. For the chats involved (all chats on an account-scope gap), take non-deleted ids with `ts > now - RECONCILE_WINDOW_DAYS`, in batches of 100:
   - `getMessages(channel, ids)` for channels;
   - `getMessagesCommon(ids)` for the common box.

   A `null` result is a deletion. A newer `editDate` is applied as an edit. `last_presence_check_at` is updated.

3. Checkpoints (`reconcile_from_id = null`, `last_full_reconcile_at`) clear only in the transaction that wrote the results.
4. Optional, **not implemented (phase 2)**: a log-manager hook that matches mtcute's differenceTooLong debug line (`updates.getDifference returned updates.differenceTooLong`, logged at DEBUG from the `updates` tag) and turns it into `gap: account`. The phase-1 adapter forwards only WARN and above, so the hook would need its own level handling. Correctness never depends on it.

### 7.5 Exclusion and channel toggles

- When a chat becomes excluded (in the config, or channels switched off), mark every distinct day of that chat dirty, then purge its messages and media in **one transaction**, and set `walk_state = 'excluded'`.
- The next drain sees those days as empty, so it tombstones the day documents and their ledgered attachments (section 7.6).
- Re-including a chat resets `walk_state = 'pending'` and clears its checkpoints.

### 7.6 `sync()` page (`messages.ts`)

1. If the provider is revoked, throw the auth `SyncError` (section 6). If the connection is down after a bounded reconnect, throw `SyncError("network")`, as WhatsApp's `connectionFailure()` does.
2. Decode the cursor `{ phase, committedSeq, storeId }`. A foreign or legacy `storeId` means committedSeq 0 (WhatsApp `state.ts` semantics).
3. Run the walk and reconcile budget (sections 7.2 and 7.4) unless `flood_until > now`.
4. Media retry sweep (`markDueMediaDirty`, bounded by the page's media budget, most recent day first; skipped during a download flood wait).
5. Call `archive.drain({ committedSeq, limit: DRAIN_DAY_LIMIT })`. For each day: apply the cutoff filter, transcribe voice notes, run `normalizeDayChat`, and extract attachments (`media.ts`).
6. **Tombstones.** These are dirty days with no surviving messages, plus every `emitted_attachments` row for a drained day whose external id is not in this render. Ledger rows the render dropped are retired with `emitSeq` and leave the ledger when that page is acknowledged; the rows for emitted attachments are upserted, stamped with `emitSeq`. Every render emits the day's whole attachment set (§15.12), so the dropped rows are exactly the attachments that are gone.
7. **`hasMore` and phase.**
   - `hasMore = morePending || walkPending || reconcilePending || mediaContinues`. `mediaContinues` (phase 3): the page spent its media budget, other media is due, and the run has more than `MEDIA_CONTINUATION_MARGIN_MS` left.
   - `walkPending` is true while any chat is `pending`/`walking` and no flood wait is active.
   - `phase` is `"bootstrap"` while any walk is pending, otherwise `"incremental"`.
8. **Progress.** `progress: { phase, processed, coverage, coverageSubject: "history" }`. Coverage is `complete` when every included chat is `done`, `partial` while a flood wait or permanent errors leave chats unwalked, and `unknown` while the walk is running.
9. Return `{ documents, deletedExternalIds, cursor: { phase, committedSeq: emitSeq, storeId }, hasMore, issues? }`. No `presentExternalIds`: the source has a deletion signal, so no `snapshot-emitters.json` row is needed.

### 7.7 State spec (`state.ts`)

`version: 1`. `decode` validates `phase`, `committedSeq` (safe int ≥ 0) and `storeId?`. No `maxBytes`, since the shape is fixed. `onUnreadable: "rebootstrap"`, because the archive holds the corpus and only the in-flight backlog re-emits. `onResync()` = `archive.markAllDirty()` + `resetMediaForResync()` + request a full reconcile.

### 7.8 `limits.ts` (tunables; the operator-facing ones are also advanced config fields)

| Constant                       | Value                                               |
| ------------------------------ | --------------------------------------------------- |
| `HISTORY_PAGE_SIZE`            | 100                                                 |
| `WALK_REQUESTS_PER_PAGE`       | 20                                                  |
| `HISTORY_MIN_INTERVAL_MS`      | 1000                                                |
| `WALK_DEADLINE_MARGIN_MS`      | 120000                                              |
| `DRAIN_DAY_LIMIT`              | 200                                                 |
| `FULL_RECONCILE_INTERVAL_H`    | 24                                                  |
| `RECONCILE_WINDOW_DAYS`        | 14                                                  |
| `GAP_SUSPECT_OUTAGE_S`         | 900                                                 |
| `PENDING_DELETION_TTL_DAYS`    | 30                                                  |
| `FLOOD_ISSUE_THRESHOLD_S`      | 600                                                 |
| `MAX_PASSWORD_ATTEMPTS`        | 3                                                   |
| `MEDIA_ATTEMPTS_PER_PAGE`      | 1                                                   |
| `MEDIA_DOWNLOAD_CONCURRENCY`   | 1 (attempts run one at a time; no constant, §15.12) |
| `MEDIA_RETRY_BACKOFF_SEC`      | same as WhatsApp                                    |
| `MEDIA_MAX_ATTEMPTS`           | 12                                                  |
| `VOICE_NOTE_MAX_BYTES`         | 25 MiB (phase 3)                                    |
| `MEDIA_DOWNLOAD_STALL_MS`      | 60000 (phase 3)                                     |
| `MEDIA_CONTINUATION_MARGIN_MS` | 15 min (phase 3, as WhatsApp)                       |

---

## 8. Document model (`normalizer.ts`)

### 8.1 Ids

- Day document `externalId = \`${chatId}:${YYYY-MM-DD}\``, using the marked chat id. Examples: `123456789:2026-03-10`, `-4001234567:2026-03-10`, `-1001234567890:2026-03-10`.
- The date is UTC, like WhatsApp's `messageDate()`.
- Attachment documents come from `buildAttachmentDocument(parent, …, { seq, occurredAt })`, which gives `${dayId}/att/${stableId}` (`packages/core/src/attachments.ts:561`). `seq` is assigned per `(filename, size, mime)` in message-id order.
- `contentHash` uses `computeContentHash`. `sourceCreatedAt` is the first message `ts`; `sourceUpdatedAt` is `max(ts, edit_ts)` over the day, so edits re-emit.

### 8.2 Content (markdown, searchable text first)

- `# ${chatTitle} — ${date}`, then one line per message, mirroring WhatsApp's `renderMessage`:
  - `**HH:MM** Sender: text`
  - a reply becomes the prefix line `> _Sender: first line of quoted text_` (resolved from the archive when the replied-to message is known)
  - `(edited)` suffix when `edit_ts` is set
  - `(forwarded from X)`
  - forum messages get a `[#Topic title]` prefix (phase 4; phase 2 stores `topic_id` only)
  - media placeholders: `[Photo]`, `[Document: name.pdf]`, `[Voice note, m:ss]: transcript`, `[Audio, m:ss]`, `[Video, m:ss]`, `[Video message]`, `[Sticker 😀]`, `[Location]`, `[Poll: question]`
  - service lines in italics
- Self is "You". Entities are converted to markdown in `message-extractor.ts`.

### 8.3 Metadata

```ts
metadata: {
  documentType: "conversation",
  tags: isGroupish ? ["group"] : [],               // group, supergroup, forum
  sourceUrl, appUrl,                                // section 8.4
  people: PersonMention[],
  extra: { chatId: String(chatId), conversationId: String(chatId), chatName, chatKind,
           isGroup, isArchived, messageCount, mediaCount, participants: string[],
           topics?: string[],   // phase 4: topic titles in order of first appearance (§15.13)
           date, attachments? }
}
```

**People:**

- Everyone who spoke that day, plus the other party in a private chat, as `role: "participant"`, with `name` passed through `cleanPersonName`.
- `lids: [\`telegram-user:${id}\`]`.
- `phones: [E.164]` when the user's phone is visible, normalised by `normalizePhone` with `host.ingestion.phoneRegion`.
- Self: `{ role: "participant", name: "You", lids: ["telegram-user:<accountId>"], phones: [selfPhone] }`.
- Bots (`is_bot`) and deleted accounts are excluded from people.
- Phones and emails found in the text become `mentioned` with `allowPersonCreation: false`, as in WhatsApp.
- Group rosters are not fetched in v1 (cost); participants means that day's senders. This is an open question.

### 8.4 Deep links (`links.ts`)

| Chat                                                  | `sourceUrl` (first message of the day)                                                         | `appUrl`                                                                                                                                      |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| supergroup / forum / channel                          | `https://t.me/c/<bareChannelId>/<msgId>` (forum: `/<topicId>/<msgId>`), public or not (§15.14) | same                                                                                                                                          |
| private chat with a username                          | `https://t.me/<username>` (chat-level, the WhatsApp precedent)                                 | `tg://resolve?domain=<username>`                                                                                                              |
| private chat without a username / basic group / saved | omitted                                                                                        | `tg://openmessage?user_id=…&message_id=…` / `chat_id=…`, only if manual validation shows it opens the item on iOS and Android; otherwise omit |

**No `urlPatterns`.** A message link cannot be mapped to a day-document id by an RE2 capture group (WhatsApp declares none either; open question Q4). `ownedWebDomains: ["web.telegram.org"]`.

### 8.5 `documentEventProfile`

Mirrors WhatsApp's field-for-field, with these differences:

- types `["conversation", "attachment"]`, roles `["participant", "mentioned"]`;
- the fields are `tags` (`allowedValues ["group"]`), `extra.isGroup` (`semantics: "group-conversation"`), `extra.chatName` (`identifiesPeople`), `extra.chatId` (`identifiesPeople`: a private chat's id is the other user's id), `extra.chatKind` (`allowedValues` = `ChatKind`), `extra.isArchived`, `extra.participants` (`identifiesPeople`), `extra.messageCount` (`semantics: "message-count"`), `extra.mediaCount`;
- phase 4 adds `extra.topics`.

`extra.chatKind` and `extra.chatId` keep it distinguishable from WhatsApp.

---

## 9. Descriptor (`src/index.ts`)

```ts
export default defineProvider<TelegramProvider>({
  provider: { id: "telegram", name: "Telegram" },
  authType: "qr",
  experimental: true,
  multiDevice: { mode: "exclusive" },
  credentials: telegramCredentialsSpec,
  contract: { apiVersion: 2, requires: ["state-envelope", "scoped-host", "typed-config"] },
  discover,
  authenticate,
  cleanupCredentials,
  createContext,
  disposeContext,
  credentialState,
  sources: [
    {
      id: "telegram-messages",
      name: "Telegram Messages",
      description: "Sync your Telegram chats through your own Telegram API app (QR sign-in)",
      unitName: "messages",
      conversational: true,
      contentRetention: "complete",
      defaultSyncInterval: "15m",
      ownedWebDomains: ["web.telegram.org"],
      icon: {
        sfSymbol: "paperplane.fill",
        color: "#2AABEE",
        bgColor: "#0F2230",
        imageDataUri: telegramIconDataUri,
      },
      selfIdentity: { aliasPrefix: "telegram-user", accountPattern: "^\\d+$" },
      documentEventProfile, // section 8.5
      contract: { state: telegramStateSpec, outputRevision: 1 },
      config: object({
        includeChannels: boolean({
          label: "Include broadcast channels",
          default: false,
          help: "Off by default. Leave off to archive only your chats and groups.",
        }),
        excludedChats: list(string({ label: "Chat" }), {
          label: "Excluded chats",
          default: [],
          help: "Chat IDs or @usernames to skip. Already-archived content from them is removed. Leave empty to include every chat.",
        }),
        // advanced: historyRequestsPerPage, historyMinIntervalMs (section 7.8)
      }),
      create, // section 7.1
    },
  ],
});
```

- `discover()` returns `{ id, label: "@username" | display name, subject: phone ? { kind: "phone", value: E164 } : { kind: "opaque", value: id }, aliases: username ? [{ kind: "handle", value: username }] : [] }`. It reads the credential record (stored phone and username), never the network.
- `attribution` is unset.
- `historyImport` is unset in v1. Takeout in phase 4 runs inside bootstrap, not as `historyImport`.
- `config` field constructors come from `packages/source-sdk/src/config-schema.ts`.

---

## 10. Media (phase 3)

- `message-extractor.ts` stores a `MediaDescriptor` (`TgMediaRef` minus bytes) in `media_json`. View-once media and `ttlPeriod` messages are dropped (D11).
- **Voice notes (`voice`):** download and `host.transcribeAudio`, with the transcript inline (section 8.2). They follow WhatsApp's `transcribeVoiceNotes` lifecycle, including `TRANSCRIBER_UNAVAILABLE` and `transcriptionSyncIssues`.
- **`photo` and `document`:** go through `resolveAttachmentConfig(sourceConfig, { defaultEnabled: true })`, `shouldExtractAttachment(mime, size)` **before** download, then `download({ maxBytes })`, `host.extractAttachment`, and `buildAttachmentDocument`. Markers and `extra.attachments` follow WhatsApp's `extractMediaAttachments`.
- **`audio`, `video`, `video_note`, `sticker`, `animation`** stay placeholders and are never downloaded.
- **Lifecycle:** `media_state` takes the values `pending`, `done`, `empty`, `unavailable` and `skipped`, with the same backoff (`media-retry.ts` mirrors WhatsApp's). A missing transcriber is `pending` with `media_last_error = transcriber-unavailable`, as in WhatsApp (§15.12).
  - `FILE_REFERENCE_EXPIRED` → re-fetch the message (`getMessages`), update `media_json`, retry once in the same attempt.
  - `FLOOD_WAIT` → transient, `next_attempt = now + seconds`.
  - Not found or `forbidden` → terminal `unavailable`.
  - Cancellation (`signal`) or a revoked session → leave pending, record nothing, start no further download this page.
  - At most `MEDIA_ATTEMPTS_PER_PAGE` per page and `MEDIA_DOWNLOAD_CONCURRENCY` in parallel. Text is never blocked by media.
- **Lazy:** only messages in days being drained are candidates. A bootstrap enrols media as `pending` and the retry sweep processes it gradually. There is never a bulk download pass.

---

## 11. Registration checklist (outside the provider)

| File                                                           | Change                                                                                                                                                                                                                           |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `package.json` (root)                                          | `overrides: { "@mtcute/node": { "better-sqlite3": "$better-sqlite3" } }` (D19). Workspaces already glob `packages/providers/*` and `packages/providers-synth/*`.                                                                 |
| `package-lock.json`                                            | regenerate with `npm install`                                                                                                                                                                                                    |
| `tsconfig.json` (root)                                         | add `{ "path": "packages/providers/telegram" }` and `{ "path": "packages/providers-synth/telegram" }`                                                                                                                            |
| `packages/collector/package.json`                              | `dependencies["@omnesis/provider-telegram"] = "*"`; `devDependencies["@omnesis/provider-telegram-synth"] = "*"`. This is the registration, through `providerPackageNames` in `packages/collector/src/source-descriptors.ts:276`. |
| `knip.json`                                                    | add both packages to the collector `ignoreDependencies`                                                                                                                                                                          |
| `packages/core/src/storage-keys.ts`                            | add `"telegram-store"` → `collector` (section 5.4)                                                                                                                                                                               |
| `packages/collector/src/provider-conformance.test.ts`          | add a `"telegram-messages"` cursor fixture `{ phase: "incremental", committedSeq: 42, storeId: "store-1" }`                                                                                                                      |
| `scripts/nx/bundles.mjs`                                       | add `"telegram-*.e2e.test.ts"` to `ingestion-providers`                                                                                                                                                                          |
| `scripts/nx/no-unit-test-projects.json`                        | add `packages/providers-synth/telegram` if it has no unit tests                                                                                                                                                                  |
| `evals/universes/telegram-sync/`                               | `universe.json`, `cast.json` (self with `extra.telegramId`), `sources/telegram-messages/fake-corpus.json`. Not added to `default`, so the golden corpus is unchanged.                                                            |
| `docs/universes.md`                                            | universe table row                                                                                                                                                                                                               |
| `privacy/pii-allowlist.json`                                   | path-scoped entries for invented fixture identifiers, if the scan flags them                                                                                                                                                     |
| `packages/collector/src/e2e/telegram-sync.e2e.test.ts`         | new (phase 2)                                                                                                                                                                                                                    |
| `docs/collector-storage.md`                                    | rows for `telegram/<account>/archive.db`, `mtcute.db` and `credentials.json`; add `telegram-store` to the key-preparation paragraph                                                                                              |
| `TRADEMARKS.md`                                                | row: Telegram, Telegram FZ-LLC; strategy "Omnesis-drawn generic paper-plane glyph; the official logo is not used (Telegram API terms §2.4)"                                                                                      |
| `THIRD_PARTY_NOTICES.md`                                       | §7 runtime deps: `@mtcute/*` (MIT), `@fuman/*`. §3 only if the glyph comes from an icon set.                                                                                                                                     |
| `ios/Sources/Omnesis/UI/SourcesView.swift` (lines ~554, ~1056) | Flag only: it hardcodes unit and name switches. Prefer the generic fix; do not add a Telegram case (source-review §10).                                                                                                          |
| `CHANGELOG.md` / changeset                                     | entry through the release tooling                                                                                                                                                                                                |

No gateway route, worker or migration is needed.

---

## 12. Docs checklist

- `website/docs/sources.html`: a Telegram entry under "Email & messaging", clearly labelled **Experimental — offered only when the gateway and collector run with `OMNESIS_EXPERIMENTAL=1`**. It covers:
  - what it contributes (day conversations, attachments, transcribed voice notes);
  - that you need your own API app from my.telegram.org (one per phone number), plus the "ERROR" popup advice;
  - QR sign-in and the 2FA password (not stored);
  - channels are opt-in, with per-chat exclusions;
  - secret chats and self-destructing content are never archived;
  - one collector per account;
  - **Telegram's terms**: the API Terms of Service (https://core.telegram.org/api/terms) §1.5 prohibit "using, accessing or aggregating data obtained from the Telegram platform to train, fine-tune or otherwise engage in the development, enhancement or deployment of artificial intelligence, machine learning models and similar technologies", and the Terms of Service for Content Licensing (https://telegram.org/tos/content-licensing), section "Large Language Models and AI", prohibit "the scraping, indexing, harvesting, aggregation or use of data obtained from its platform" for those purposes, while permitting access to the data a legitimate third-party client needs to operate. Operators decide whether Omnesis's indexing and agent features over this data fit their reading of the terms (open question Q1);
  - the unofficial-client note: Telegram states (https://core.telegram.org/api/obtaining_api_id) that "all accounts that log in using unofficial Telegram API clients are automatically put under observation", and it can limit or ban accounts; the source paces its requests and backs off.

  This is the first experimental source in the catalogue, so establish the label style there.

- `website/docs/experimental.html`: one sentence that experimental sources (Telegram) appear in Add source under the gate, linking `/docs/sources#telegram`.
- `website/docs/building-sources.html`: no change unless the contract changes (Q6).
- `README.md`: the source table (line ~101) lists GA sources only; leave Telegram out while it is experimental.
- `docs/releasing.md` native-modules table: note that `@mtcute/node` pulls `better-sqlite3`, deduplicated to 13 through the override.
- `docs/conventions.md`: add a row if the adapter-boundary pattern ("one module imports the vendor SDK") is to be imitated. Canonical example: `packages/providers/telegram/src/client/mtcute/adapter.ts`.
- `docs/telegram-source.md`: this file. Keep it updated with resolved VERIFY items.

---

## 13. Test plan

All tests are vitest, next to the code. No model inference: the transcriber and extractor are stubs. Fixtures are invented. Temp dirs are unique.

- **Phase 1:**
  - `credentials-spec.test.ts`: patterns, wizard non-empty.
  - `auth.test.ts` (scripted `AuthSession` + simulated adapter): QR rotation emits replacement challenges with `expiresAt`; scan without 2FA connects; 2FA asks a `fields` challenge, a wrong password is re-asked, three wrong → `credential-rejected`; `canShow("fields")` false → `unsupported`; mismatch → `identity-mismatch` plus `logOut` called and nothing written; missing app credential → `MissingCredentialsError`; flood → `unavailable` with `retryAfterMs`; nothing persisted on any failure.
  - `session-store.test.ts`: wrapped write and read; revoke rewrite drops the session; `credentialState` for every status, including a locked root key → `unknown`.
  - `provider.test.ts`: revocation reasons → record, `onSourceError`, `SyncError("auth")` with remediation; restart without re-auth (a new provider over the same configDir reconnects through the session string; the mtcute cache reused); corrupt `mtcute.db` → quarantine and rebuild from the session; suspend/resume does not stack connections.
  - `message-store.test.ts` (encryption): with a key the file is not plaintext and opens only with it; storage encryption required and key missing → open throws, and no file or plaintext is written for either DB; plaintext migrates.
  - `client/errors.test.ts`: the RPC → `TelegramError` table.
  - `index.test.ts`: `experimental: true`, complete `SourceIcon`, `selfIdentity`, `multiDevice` exclusive, `discover` descriptor shape, two accounts get disjoint state.
- **Phase 2:**
  - `history-walker.test.ts`: full pagination across many pages; archived chats included; channels excluded by default; `excludedChats` honoured; interrupted walk resumes from its checkpoint (kill between pages) without duplicates; concurrent live `new` during the walk dedupes; `dataCutoff` stops the walk; flood wait stops the walk, sets `flood_until`, emits the issue, and later pages drain without calls; forward-gap reconcile after `dropUpdates`; `channelDifferenceTooLong` → channel re-page; presence check finds deletions and edits.
  - `message-store.test.ts`: edits bump `edit_ts` and dirty the day; common-box deletion through the index; channel deletion; **unseen-id deletion applied on later arrival**; pending expiry; drain ack protocol (`committedSeq`, foreign `storeId` replays).
  - `normalizer.test.ts`: per-day shape, ids, UTC day boundary, reply, forward, edited markers, people (self LID + phone, bots excluded), links table, ephemeral exclusion, profile parity.
  - `messages.test.ts`: bootstrap then incremental (second sync with the cursor yields nothing; one new message yields one day); empty day → day tombstone plus ledgered attachments tombstoned; exclusion purge tombstones; `expectUnchangedUpstreamIsNoOp` / `runSyncCycleContract`; `hasMore` terminates.
  - `state.test.ts`: decode and legacy handling.
  - `document-event-profile.test.ts`: parity over a real sync.
  - Synthetic E2E `telegram-sync.e2e.test.ts` on `SyntheticE2EHarness({ gatewayMode: "synthetic", universe: "telegram-sync" })`: day documents land and are searchable; a live edit and a delete through the controller are reflected; an empty day disappears; self is resolved to the cast self person through `selfIdentity`.
- **Phase 3:** `media.test.ts`: voice note transcribed inline; transcriber unavailable → placeholder plus issue, retried later; photo OCR and PDF extraction produce child docs with `occurredAt`; over-size skipped without download; `FILE_REFERENCE_EXPIRED` refresh; flood during download is transient; gone → `unavailable`; per-page attempt budget; cancellation; text drains while media fails; no eager downloads (`calls` assertion during bootstrap).
- **Phase 4:** channels opt-in toggling on and off (purge, tombstones); forum topics metadata and the topic prefix; Takeout happy path, the `TAKEOUT_INIT_DELAY` fallback to the normal walk with a notice, and Takeout cancelled mid-walk resuming from checkpoints.

---

## 14. Phasing

### Phase 1: skeleton, auth, session, gate, registration

Deliverables:

- the package skeleton and every registration row in section 11 (except the e2e and universe);
- `client/types.ts`, the mtcute adapter and storage, `client/errors.ts`, and `testing/simulated-telegram.ts` (auth, connect, revoke subset);
- `credentials-spec.ts`, `auth.ts`, `session-store.ts`, `provider.ts` (connect, revoke, suspend/resume, credentialState);
- `message-store.ts` open, encryption and schema; `index.ts` descriptor;
- `sync()` returning `emptySync` after connecting;
- the `telegram-store` key;
- resolving every VERIFY item in sections 4, 5.3 and D19.

Acceptance:

- [x] `npm run typecheck:fast -- packages/providers/telegram` and the unit tests are green; `npx knip` and the PII scan are clean.
- [x] No mtcute import outside `src/client/mtcute/` (grep test or ESLint `no-restricted-imports` scoped to the package).
- [x] Only one `better-sqlite3` version is in `package-lock.json`.
- [x] Hidden without `OMNESIS_EXPERIMENTAL=1`; listed with it.
- [x] Every phase-1 test in section 13 passes; no credential is written on any failed add.
- [ ] A manual run against a real test account: QR add, 2FA, collector restart without re-auth, terminating the session from a phone leads to needs-auth.

### Phase 2: text sync, edits, deletions, gaps, per-day docs, synthetic twin

Deliverables: `history-walker.ts`, `message-extractor.ts` (text only), `normalizer.ts`, `links.ts`, `messages.ts`, `state.ts`, `documentEventProfile`, config fields, the simulated adapter completed, the synth twin, the `telegram-sync` universe, the E2E.

Acceptance:

- [x] Every phase-2 test in section 13 passes, including the unseen-id deletion, gap reconcile and interrupted-resume tests.
- [x] `npm run validate-universes` passes; the E2E passes. `npm run checks:affected -- --base origin/main` could not run on the phase-2 host (no native dispatcher); its non-native steps were run by hand.
- [x] Walk pacing is respected, by `calls` assertions with fake timers.
- [x] A `/source-review` pass with no blocking findings left open (§15.11).

### Phase 3: media

Deliverables: media extraction, `media-retry.ts`, voice transcription, attachment ledger tombstoning, media health issues, `probeLocalStores` complete.

Acceptance:

- [x] Every phase-3 test passes (`media.test.ts`, `media-retry.test.ts`, the media-lifecycle block of `message-store.test.ts`, `client/download.test.ts`, the `downloadMedia` block of `client/mtcute/adapter.test.ts`, the attachment parity in `document-event-profile.test.ts`, and the voice-note and attachment cases of `telegram-sync.e2e.test.ts`).
- [x] No download during bootstrap except budgeted retries (`calls` assertions: one download per page).
- [x] Flood and cancellation are honoured.
- [x] Attachment tombstones appear when their message is deleted (unit and E2E).
- [ ] A manual run against a real account: a voice note, a photo, a PDF, and a download after the file reference expired (hours later).

### Phase 4: channels, forum topics, Takeout, docs polish

Deliverables:

- the `includeChannels` path hardened (purge on disable);
- the `topics` table, `iterForumTopics`, the topic prefix and `extra.topics` (plus profile parity);
- Takeout: `initTakeoutSession({ messageUsers, messageChats, messageMegagroups, messageChannels: includeChannels, files: false })` used for the bootstrap walk when available, with a `TAKEOUT_INIT_DELAY_X` fallback and an `AuthNotice` / `SyncIssue` telling the operator to approve the export request in Telegram;
- every docs item in section 12; TRADEMARKS and THIRD_PARTY_NOTICES rows; the manual validation list (source-review §17).

Acceptance:

- [x] Every phase-4 test passes (`takeout.test.ts`, `forum-topics.test.ts`, the channel toggle with media and the id-collision cases of `messages.test.ts` and `message-store.test.ts`, the takeout errors of `client/errors.test.ts`, the takeout block of `client/mtcute/adapter.test.ts`, the forum shape of `document-event-profile.test.ts`, and the forum and takeout cases of `telegram-sync.e2e.test.ts`).
- [x] The docs pages are updated in the same change and contain only fictional examples (`website/docs/sources.html#telegram`, one sentence in `website/docs/experimental.html`).
- [x] The source-review §17 manual list has been run as far as it can be without a real account; the rest is in §16.

---

## 15. Open questions and VERIFY items

1. **Q1, terms §1.5 (AI use) and content licensing.** Is indexing plus agent answering over Telegram data "deployment of artificial intelligence" (API terms §1.5), or the "indexing, harvesting, aggregation or use of data" the Terms of Service for Content Licensing ("Large Language Models and AI") prohibit for AI purposes, beyond the access a legitimate third-party client needs? Telegram also puts accounts that log in through unofficial API clients under observation and can limit them. A maintainer decision, recorded in the PR (source-review §1, blocking finding). Also §3.3 (sponsored messages on channel content): another reason channels are opt-in; needs a decision before graduation.
2. **Q2, `ttl_period`.** Should messages under an auto-delete timer be excluded entirely (D11, current), or stored until their deletion arrives? Current choice: exclude.
3. **Q3, api_id change.** Does an existing session keep working after the operator replaces the app credential? The credential record stores `apiId`. Phase 1 logs a warning on a mismatch and connects with the **current** app credential, because the record keeps no `api_hash` to connect with the old one. Whether Telegram accepts that is still unverified (needs a real account).
4. **Q4, link resolution.** Inbound `t.me/c/...` links cannot resolve to a day document without a contract extension (message-id → day-document lookup). WhatsApp has the same gap.
5. **Q5, deleted chats and group rosters.** Should a chat that disappears from dialogs ("delete chat for me") be purged? And should group rosters be fetched for participants? v1: neither.
6. **Q6, storage key registry.** Should there be a descriptor field (`storageKeys`) instead of core's list? It would remove both the `whatsapp-store` and `telegram-store` names from core.
7. **VERIFY (phase 1), mtcute API — resolved:**
   - `importSession` / `exportSession` / `startUpdatesLoop` / `destroy` / `onError` / `onConnectionState`: all exist as named (section 4). Revocation is not an event; see the `onUpdate` row.
   - The flood-sleep option: a network middleware (`networkMiddlewares.basic({ floodWaiter: { maxWait } })`, default 10 s), not a client option (section 4).
   - Sync update handlers complete before `pts` is saved: yes (section 7.3).
   - The memory auth-keys substitution: works and is adopted (section 5.3).
   - The better-sqlite3 13 override for `@mtcute/node`: works (D19).
   - `ttlSeconds` and `ttlPeriod`: `Message.ttlPeriod: number | null`; `ttlSeconds: number | null` on `Photo`, `Video` (which also covers round video notes) and `Voice` only. The adapter sets `TgMediaRef.isViewOnce` from it and `TgMessage.ttlPeriod` from the message.
   - File-id strings for `downloadAsBuffer`: accepted by type (`FileDownloadLocation = … | string`, "TDLib and Bot API compatible File ID"); `Photo` and every `RawDocument` expose `fileId`, and `FileDownloadParameters` takes `abortSignal` and `limit`. Not exercised against the network (phase 3 manual run).
   - `tg://openmessage` behaviour on iOS and Android: not verifiable without devices. Phase 2 emits no `tg://openmessage` link (section 8.4); still open.
8. **VERIFY (phase 1), `host.stateDir` — resolved:** it equals `<configDir>/telegram/<accountId>` (section 5.1).
9. **VERIFY (phase 4), Takeout — resolved from the installed package** (the `takeout` row of §4): calls are wrapped through `createProxy()` and mtcute's free `getHistory`; flood waits come back as ordinary `FLOOD_WAIT` on the walk; `TAKEOUT_INIT_DELAY_%d` is a 420 that must not be read as a flood wait. Not exercised against Telegram: whether approving the export in the app lets the next `initTakeoutSession` succeed at once, and whether an unfinished session left by a restart blocks a new one (§16).
10. **Phase 1 deviations and notes for later phases.**
    - **State spec in phase 1.** `state.ts` and the `telegram-messages` cursor fixture landed in phase 1: the collector's conformance test requires every stateful registered source to have one. The cursor is `{ phase, committedSeq, storeId? }`; phase 1's `sync()` connects, checks the authorization, and returns `emptySync` with `phase: "bootstrap"`, acknowledging a `committedSeq` only from its own `storeId`.
    - **Config declared, inert.** `includeChannels` and `excludedChats` are declared on the descriptor (so `typed-config` is honest) but nothing reads them until phase 2. `documentEventProfile` is not declared yet (phase 2).
    - **Background connect.** `createContext` opens the archive, builds the client and starts connecting, but does not wait for the network: a host that is offline at boot must still instantiate the source. Each sync waits up to `CONNECT_TIMEOUT_MS` (60 s) for the connect and retries a connect that finished in failure; a connect still pending is left to run. A session that resolves to another user is treated as a revocation with `AUTH_KEY_DUPLICATED`.
    - **Revocation path.** One `revoke(reason)` handles the adapter's `revoked` update, a revoked error at connect, and an identity mismatch: it rewrites the record without its session, suspends the client, fires `onSourceError` once, and every later sync throws `SyncError("auth")` with the remediation of section 6 after the rewrite has landed. `credentialState` waits for the rewrite too.
    - **Session record refresh.** After each successful connect the provider re-exports the session and rewrites the record when the string (DC migration), phone or username changed.
    - **Sign-in additions.** mtcute's `signInQr` re-issues the login token on expiry by itself, so a stale code never ends the flow; `LOGIN_TIMEOUT_MS` (13 min, under the gateway's 15-minute flow expiry) bounds the wait and maps to `AuthFailure("timeout")`, and `AUTH_TOKEN_EXPIRED` maps to `challenge-expired`. A first connection (no `session.accountId`) of an account that already has a live record is refused as `AuthFailure("duplicate")`, and a failed credential write, like an identity mismatch, logs the new authorization out before throwing so no stray session is left in Settings → Devices.
    - **Chat kinds.** A user peer is `private`, or `saved` when it is the account itself. A chat whose raw type is `channel`/`channelForbidden` lives in its own box and is `channel` when `chatType` is `channel`, `forum` when `isForum`, otherwise `supergroup` (this includes `gigagroup` and `monoforum`); any other chat is a basic `group`. A chat built from a live update carries `isArchived: false` because updates do not say: phase 2 must not overwrite `chats.is_archived` from an update.
    - **Registration deferred with the synth twin.** The synth package, its root `tsconfig.json` reference, its collector `devDependency`, its `knip.json` entry and its `no-unit-test-projects.json` row arrive with the twin in phase 2. TRADEMARKS and THIRD_PARTY_NOTICES rows, the `docs/collector-storage.md` rows and the `docs/releasing.md` override note landed in phase 1 with the dependency. No website page changes yet (section 12 is phase 4).
    - **Fixture phones.** `normalizePhone` validates numbers, so the NANP fiction range `555-01xx` normalises only inside a real area code (`+1 202 555 01xx`); `+1 555 010 01xx` and the Ofcom drama range do not. Fixture user ids use `55501001xx`.
    - **Not run.** No real-account run was possible in phase 1: QR add, two-step password, restart without re-auth, and ending the session from a phone (expected: needs-auth) remain to be checked by hand.
11. **Phase 2 deviations and notes for later phases.**
    - **Schema 2.** Additive columns, applied by `ALTER TABLE` to an archive schema 1 created: `chats.last_message_ts` (the walk's "most recently active first" order, from the dialog list and live messages), `chats.reconcile_offset_id` (a forward re-page resumes where it stopped instead of re-reading from the top), `chats.presence_after_id` (a presence check resumes by id), `chats.outage_floor_id` (where a chat stood when the connection dropped), `users.is_deleted` (deleted accounts are not people), `messages.extract_rev` (the "older render" rule of §5.1: a row rewritten only by a newer `edit_ts` or a newer extractor revision) and `emitted_attachments.retired_seq` (a ledgered attachment the render dropped is retired with the page's `emitSeq` and leaves the ledger only when that page is acknowledged, so a failed page tombstones it again).
    - **Walk state `failed`.** A chat Telegram refuses (`forbidden`, `not-found`, or an unclassified RPC error) is marked `failed`, skipped, reported as `partial` coverage, and offered again at the next full reconcile. Its gap floor, re-page offset and pending presence check are kept, and gap requests still floor it, so a refusal never loses a gap. A dialog listing that fails stops the page like a network error.
    - **Gap floors.** An account-scope gap stores, for every walked chat, `reconcile_from_id = newest_seen_id` at the moment of the gap, because live updates after the gap move `newest_seen_id` past the hole and the §7.4 "lastMessageId > newest_seen_id" test would then miss it. The enumeration that follows clears a floor without a request when the dialog's top message is not above it. The periodic full reconcile uses only the dialog test.
    - **Presence checks** run only after a gap (account-wide, a channel's `channelDifferenceTooLong`, or an outage), never on the periodic reconcile: a chat is due while `last_presence_check_at` is null, which a gap sets and a finished check clears. Chats without messages in the window cost no request.
    - **Outages.** A live drop snapshots every walked chat's `newest_seen_id` into `outage_floor_id`, because the catch-up after a reconnect raises `newest_seen_id` before `connected` arrives; a reconnect after more than `GAP_SUSPECT_OUTAGE_S` floors the account reconcile there, a short one clears the snapshot. Connection events before the first connect resolves are ignored. Across restarts, `meta.last_online_at` (written at each connect, sync and reconnect) is compared **before** the client connects, so the floors sit below anything the startup catch-up delivers. A second gap also restarts a half-done presence check from the first id.
    - **End of history.** mtcute's `getHistory` drops `messageEmpty` entries, so a short page is not the end: the backward walk and a forward re-page stop on an empty page (or the data cutoff), at the cost of one extra request per chat.
    - **Same-second edits.** Telegram's edit dates are whole seconds, so an upsert with an equal `edit_ts` and different text or media also rewrites the row; an identical re-read still changes nothing.
    - **`hasMore`** is `morePending` or a walk that stopped on its request budget. A walk stopped by the deadline margin, a flood wait, the network or a cancellation waits for the next scheduled or pushed sync, so a run always ends. Pending reconcile work is spent through the same budget, so it is covered.
    - **Phase and coverage** stay `bootstrap` / `unknown` until the dialog list has been read once (`meta.dialogs_listed_at`), so an account whose first page stopped before listing does not claim a complete history.
    - **Rendering.** Times are `HH:MM` in the collector host's local time, as WhatsApp writes them; the day boundary stays UTC so external ids are the same on every host (first shipped as UTC times; `RENDER_REVISION` 2 re-renders every published day once when an older archive is opened). A forward renders as a `(forwarded from X)` prefix; a reply quote is omitted when the archive does not hold its target; link previews (`webpage`) have no placeholder because the URL is in the text; animations render as `[GIF]`; kept service messages render as `_Sender pinned a message_`. Media is a placeholder with metadata only; `media_json` keeps the descriptor, including the file id phase 3 downloads with.
    - **Extraction.** Besides `ttlPeriod` and view-once media, the extractor drops empty messages and every service action outside a short list of meaningful ones (`SERVICE_PHRASES` in `message-extractor.ts`); a dropped message still advances the checkpoint and `newest_seen_id`.
    - **People** use `identifiers` (the non-deprecated form) for LIDs and phones. Senders with a non-positive id (a channel posting as itself, an anonymous admin) are not people. The universe's phones sit in the validator's `+1 555 01xx` range, which `normalizePhone` rejects (§15.10), so the E2E pairs self through the `selfIdentity` LID alone; the gateway creates a self person only from an identifier, so the E2E config gives self an email.
    - **Document event profile** declares only `conversation` until phase 3 emits attachment documents; a declared type no document carries would compile conditions that never fire. Phase 3 adds `attachment` with its parity test.
    - **Links.** No `tg://openmessage` is emitted (unvalidated, §15.7); basic groups, Saved Messages and private chats without a username carry no link. A supergroup, forum or channel message link is the `sourceUrl` only: `appUrl` is for a native scheme, and an `https://t.me` link already opens the app where it is installed (§8.4 said "same").
    - **Rate limits.** A flood wait surfacing at the sync boundary (the per-page authorization check) is a `SyncError("rate-limit")` with `quota: { kind: "account" }`: Telegram counts it against the signed-in account, not the shared app credential.
    - **Data cutoff.** Messages older than `dataCutoff` are neither stored (by the walk or by live updates) nor published by the drain; a day entirely before the cutoff is skipped, not tombstoned (WhatsApp semantics); since §15.14 a day the cutoff moved past after it was published is tombstoned.
    - **Config.** Two `advanced` fields, `historyRequestsPerPage` and `historyMinIntervalMs`, override `WALK_REQUESTS_PER_PAGE` and `HISTORY_MIN_INTERVAL_MS`. A config change rebuilds the source; the next page applies exclusions (purge or restore) before walking.
    - **Drain order** is most recent day first (WhatsApp drains oldest first), matching the walk's recent-first order.
    - **Adapter fixes found by the new conversion tests** (`client/mtcute/adapter.test.ts`, mtcute objects built from raw TL): a message that fails to convert becomes a text-less stub so the walk's checkpoint still moves past it; a forward header naming nobody no longer throws; a forum topic's header is a topic id, not a reply; a reply into another chat is not a reply here; TL boolean flags absent from an object read as `false`.
    - **Synthetic twin.** `packages/providers-synth/telegram` has no fixture-replay mode: `discover()` reports the universe self account only when the universe ships `sources/telegram-messages/fake-corpus.json`, and `createContext` seeds an invented app credential and a session the simulated server accepts (`SimulatedTelegram.seedAccount`) before the real context opens. Like every double it drops the real `contract.state` (`synth-double-isolation.test.ts` pins this); the real source still decodes its own cursor inside `sync()`.
    - **Left for phase 3 (done, §15.12):** media download, transcription, attachment documents and the `attachment` profile type; the ledger mechanics they rely on (`settleAttachments`, retirement, tombstones) are in place and tested. **Left for phase 4:** the topic prefix and `extra.topics` (rows already keep `topic_id`), Takeout, website docs.
12. **Phase 3 deviations and notes for later phases.**
    - **Adapter surface.** `download(media, opts)` became `downloadMedia({ chatId, msgId, fileId, size? }, opts)` returning `{ data, refreshed? }`. Refreshing a stale reference needs the message, which a bare media descriptor does not name. The rule (download; on `file-reference-expired`, `getMessages` and one retry with the fresh file id; a vanished message or a message without a file is `not-found`; the size limit before and after the fetch) lives in `client/download.ts`, free of mtcute, and both the mtcute and the simulated adapters download through it. The mtcute adapter adds `stallTimeout` (`MEDIA_DOWNLOAD_STALL_MS`) so a file the server never serves fails as a network error instead of hanging. The refreshed descriptor is written back to `media_json` without dirtying the day. Adapter-level tests drive the real `MtcuteTelegramAdapter` with its client's `downloadAsBuffer` and `getMessages` stubbed and mtcute documents built from raw TL; no network call was exercised (manual run).
    - **Schema 3.** One additive column, `messages.media_extract_json` (an attachment's `ExtractionResult`), and the index `messages_media_retry(media_state, media_next_attempt)`. Opening an archive an earlier schema created enrols its downloadable voice notes, photos and documents as `pending`, due now, for the sweep. New messages are enrolled at insert; an edit that replaces the media (anything but the file id differs) restarts the lifecycle and drops the old transcript and extraction, while the same file under a refreshed reference does not.
    - **Every render emits the day's whole attachment set.** WhatsApp emits an attachment document only on the render that extracted it. With a ledger that tombstones whatever a render did not emit, that would delete every attachment on the next re-render of its day, so the archive keeps each extraction and every render rebuilds the attachment documents from it without a download. That is also what makes a page the gateway never accepted harmless: the next render re-emits the attachments. Identical content re-emits with the same `contentHash`. A kept extraction is re-emitted even when a later attempt (a resync) finds the file gone; an attachment the settings now exclude (type, size, extraction switched off) is not emitted, so the ledger tombstones it on the day's next render. `seq` is assigned per `(filename, size, mime)` in message order over the day's photos and documents, whatever their processing state, so an id changes only when an earlier identical file is deleted, and the next render re-emits the survivor under its new id from the kept extraction.
    - **State `skipped`** replaces `transcriber-unavailable` in the state list: an attachment the settings exclude is never downloaded and is not counted as unavailable (WhatsApp marks it unavailable). A resync looks at it again; one the settings now admit is attempted when its day renders. A missing transcriber is WhatsApp's `pending` with `media_last_error = transcriber-unavailable`, retried at the capped backoff for ever, and surfaced through `transcriptionSyncIssues` as a warning with the fix.
    - **Flood waits on downloads** halt every further download of the page and record `meta.media_flood_until`; the sweep, the due check and the attempt gate all wait for it, and the media wake timer fires when it ends. The failed attempt is transient with `next_attempt = now + max(backoff, seconds)`. The walk's own flood wait is separate.
    - **Wake timer.** As WhatsApp's store does, the source arms one unref'd timer for the earliest pending media in scope and wakes a sync through the provider's change handlers when it comes due; media already due when a page ends re-checks every 60 s instead of every second. `create()`'s `dispose` clears it.
    - **Photos** are attachments named `photo.jpg` (Telegram photos are JPEG and carry no name), MIME `image/jpeg`, size from the largest thumbnail mtcute reports.
    - **Transcription context**: speaker and participants are `telegram-user:<id>` LIDs plus the phone when visible (`telegramPersonIdentifiers`, shared with the normalizer), the conversation thread is the marked chat id, and at most 32 participants are named.
    - **Concurrency** is one by construction (attempts are awaited one after another); no `MEDIA_DOWNLOAD_CONCURRENCY` constant exists because nothing would read it.
    - **Day-document size** is not bounded: WhatsApp does not bound its day documents either, and a very large group's busiest day is one large document. Revisit with WhatsApp if the indexer ever caps document size.
    - **`probeLocalStores`** was already complete from phase 1 (the two results of §5.4, tested in `message-store.test.ts` and `index.test.ts`); media bytes are never written to disk, so there is no third store.
    - **Synthetic twin and harness.** A fixture message's `media` may carry `content`, the file's bytes as UTF-8, which the simulated server serves (`size` defaults to its length). `SyntheticE2EHarness` gained `sourceMediaProcessing`, which hands every source the collector's production attachment extractor and gateway transcriber as `main.ts` does (off by default, so other suites are unchanged); with `transcriberBackend: "replay"` a voice note is transcribed without a model. Common-box ids in a fixture must be unique across all private chats, basic groups and Saved Messages, as they are on Telegram.
    - **Left for phase 4:** nothing media-specific. Channel media follows the same path once channels are opted in; Takeout is configured with `files: false` and must keep downloads on this lazy path.
13. **Phase 4 deviations and notes.**
    - **Takeout reader.** `TelegramAdapter.takeout(scope)` returns a `TelegramTakeout` (scope, `getHistory`, `finish`), not a second `TelegramAdapter`: only the backward walk reads through it. It is required on the interface (both adapters implement it); the source option `takeout` (on in the descriptor, off in the test rig unless a test asks) decides whether the walker uses it. The open session is held on the provider (`TelegramProvider.takeout`), so a config change that rebuilds the source reuses it.
    - **Takeout lifecycle.** The first backward page of a bootstrap opens the session (one request of the page budget). A `takeout` error with `seconds` stores `takeout_state = delayed` and `takeout_retry_at = now + seconds` and the walk goes on through the normal client; while chats are unwalked, each page returns an `info` `SyncIssue` (`kind: "permission"`, scope `partition`) with a remediation telling the operator to approve the export in Telegram and re-sync. A re-sync (`onResync`) clears the delay. Any other refusal is `unavailable`. A session that ends under the walk (`TAKEOUT_INVALID`) is dropped as `unavailable` and the same chat continues the normal way. When nothing is left to walk the session is finished with `success: true` and the state is `done`, which is final: chats found later are walked without a new export, so the owner's devices are not notified again. An export still held back when the walk finished without it settles as `done` too. A chat kind outside the session's scope (channels switched on after it opened) is read the normal way. A cancelled page keeps the session; the next page resumes from the chat's checkpoint through it. Not an `AuthNotice`: those exist only on the result of `authenticate`, and the delay arises during sync.
    - **Forum topics.** Schema 4 adds `chats.topics_listed_at`. A forum's topics are listed (one request, after enumeration and before the walk) when the column is null — every dialog listing clears it, so once per full reconcile — or when a message at or after the listing names a topic with no stored title. A listing Telegram refuses is logged and recorded as listed, never marking the chat failed. `recordTopics` marks dirty only the days holding a message in a topic whose title is new or changed, so an unchanged re-listing re-renders nothing. A message in a topic whose title is unknown renders without a prefix; messages outside any topic (the General topic) never carry one. The prefix sits after the time: `**HH:MM** [#Title] Sender: text`. Excluding a forum purges its topics with its messages.
    - **`extra.topics` is a `string[]`** of titles (first appearance order), only on days that name a topic, not the `{ id, title, messageCount }` objects of §8.3: `DocumentMetadataFieldSpec` has no object-array type, and a declared field must be addressable. The parity test checks it is present on forum days and absent on the others.
    - **Channels.** `applyExclusions` already purged an excluded chat's messages and dirtied its ledgered attachment days; phase 4 adds the topics purge and a test that switches channels on (the channel and its document attachment land) and off (day and attachment tombstoned, nothing on the next page). The E2E harness has no source manager to apply a config change, so the toggle is covered at unit level over the real source.
    - **Id collisions.** A message whose `(box, msg_id)` another chat already holds is skipped with a one-line warning and counted in `meta.id_collisions` (`idCollisionCount()`), instead of failing the page on the `messages_by_box_id` unique index on every sync. The archived message wins. Within its own chat the message still updates.
    - **Simulator.** Chats may carry `topics`; `iterForumTopics` serves them (a non-forum answers `not-found`); `setTopic`, `delayTakeout(seconds)`, `endTakeouts()` and `takeoutScopes` script and observe the export; history read through a session is logged as `takeoutGetHistory`, its end as `finishTakeout`. The universe fixture gains `topics` on a chat and `topic` on a message.
    - **Docs.** `website/docs/sources.html` gains a Telegram row and a `#telegram` section labelled experimental with the gate (the first experimental source in the catalogue: a `pill` and a `callout warn`); `experimental.html` gains one sentence linking it. The README source table, `building-sources.html` and `conventions.md` are unchanged (§12). The portal screenshot of §17.5 could not be taken at the time; fixed in §15.14.

14. **Source-review fixes.** Behaviour changes and decisions from the `/source-review` pass.
    - **One client per account directory.** The host rebuilds a context on every config change, enable and re-authentication, and opens the new one before its (unawaited) disposal of the old one finishes; two mtcute clients on one auth key trip `AUTH_KEY_DUPLICATED`, which reads as a revocation and forced a QR sign-in. `provider.ts` keeps a module-level registry keyed by `stateDir`: a provider connects only once every earlier provider of the same directory has closed (`accountClosed(stateDir)`). Accounts never wait on each other. A provider that fails to open after construction still releases its slot.
    - **Teardown by reference count, not by `disposeContext` alone.** The collector calls `disposeContext` only when no source registered (`source-instantiator.ts`, the one call site); a rebuild gives the new source a new context and only disposes the old source. Moving teardown to `disposeContext` would leak every replaced client. Instead each source `attach()`es to its context and its `dispose()` releases it; the context closes when the last source is released, so a sibling source on the same context would not be killed, and `disposeContext` still closes an unused one.
    - **Takeout across rebuilds and restarts.** The export session's id and scope are kept in archive meta (`takeout_session`) while `takeout_state = active`; a new context (rebuild or restart) resumes it with `TelegramAdapter.takeout(scope, { resumeId })`, which makes no request (mtcute: `new TakeoutSession(client, { id })`). A session Telegram no longer honours fails its first read as `TAKEOUT_INVALID` and the walk carries on the normal way (`unavailable`), as before. Archives from before this change with `active` and no kept id ask for one new export once.
    - **`emit_seq_counter` is read inside the drain transaction** rather than cached per archive handle, since two handles can be open on one archive while a context is replaced.
    - **Auth failures.** A revocation that surfaces mid-walk is mapped through `TelegramProvider.syncErrorFrom` (now public), so it is a `SyncError("auth")` with `REVOKED_REMEDIATION` like every other path. `TelegramProvider.open` refuses a missing or ended session with the same `SyncError("auth", …, { remediation })`; the instantiator carries the remediation into the setup failure.
    - **Abort signal** reaches `getHistory` (plain and takeout), `getMessages` / `getMessagesCommon`, `takeout()` / `finish()` (mtcute: `client.withParams({ abortSignal })`, `createProxy({ abortSignal })`, `session.call(…, { abortSignal })`), and the connect wait in `ensureUsable`, which gives up as a `network` failure once the sync is cancelled.
    - **Presence checks delete only on a conclusive answer.** A failed request deletes nothing (the batch commits after the answer). An answer whose length or ids do not line up with the ids asked ends the check for the chat without deleting. An answer that is empty for a whole batch is trusted only if the chat still reads: one more request (`getHistory` newest page, limit 1) must return a message that is not one of the ids called gone; otherwise (access lost, refusal) the check ends without deleting and the next reconcile asks again.
    - **A day that cannot render no longer fails the page.** Each day renders inside its own `try`; a throw quarantines it (`dirty_days.render_failures`, `retry_at`, schema 5): unstamped so the page's acknowledgement cannot clear it, held back on a doubling backoff (1 min → 6 h), logged once at warn (then debug), and reported as an `item` `warning` issue with its count while it waits. The other days publish. `normalizer.ts` computes `sourceUpdatedAt` with a loop instead of `Math.max(...spread)`.
    - **Data cutoff moved later.** A drained day with no message at or after the cutoff is now tombstoned and its attachment ledger settled (formerly skipped). Nothing older than the cutoff is ever stored, so this only happens to days published before the cutoff moved; tombstoning a never-published id is a no-op.
    - **`sourceUpdatedAt` follows content changes.** Schema 5 adds `messages.changed_at`, set when an archived message changes after its first write: an edit or extractor-revision rewrite, a deletion, a transcript, a renamed forum topic (not a topic's first title). The drain reports a day's `MAX(changed_at)` over all its rows, deleted ones included, and the normalizer takes the max of that, each message's `ts`/`editTs`/`changedAt` (a transcript recorded during the render). A first write never moves it, so a walked old day keeps its own date. Attachment documents keep their own timestamps.
    - **People hygiene.** Emails found in text are `mentioned` with `allowPersonCreation: false`, and no-reply/automated addresses (`isNonIdentifyingEmail`, `isAutomatedSenderAddress`) are dropped. Telegram's service-notifications account (user id `777000`) is never a person, and mtcute's `isSupport` users are archived as bots. A display name that is phone-shaped or all digits is not used as a person's name (the person keeps their LID); a user with no name or username is stored with an empty display name instead of their id, and renders as the message's own sender name or "Unknown".
    - **Message links use the chat id.** Supergroup, forum and channel links are always `t.me/c/<bare id>/[topic/]<msg>`: a username can be released and claimed by another chat, the id cannot, and the account archiving the chat is a member. Private chats keep `t.me/<username>` and `tg://resolve`; there is no id-based user link, so the same reclaim risk is accepted and documented in `links.ts`.
    - **Sign-in refusals.** `USER_DEACTIVATED`, `USER_DEACTIVATED_BAN` and `PHONE_NUMBER_BANNED` are `denied`; `*_FLOOD` is `unavailable`; any other `PHONE_*` / `AUTH_*` refusal and a revocation during sign-in are `credential-rejected`; `AUTH_TOKEN_EXPIRED` stays `challenge-expired`.
    - **Removing an account ends its Telegram session.** `cleanupCredentials` reads the record first (a record that cannot be read — a locked keyring — leaves the directory in place and throws, the Plaid precedent), waits for the account's client to close, logs the stored session out through a short-lived in-memory sign-in client (`TelegramAuthAdapter.logOutSession`, `LOGOUT_TIMEOUT_MS` = 20 s), then removes the directory. A failed or timed-out logout still removes the directory and then throws, naming Settings → Devices. `discover` and `cleanupCredentials` no longer fall back to `DEFAULT_CONFIG_DIR`; they throw without a host config directory.
    - **D9 rationale corrected** (§2): exclusive because handoff and replication cannot work for this source, not only because of `AUTH_KEY_DUPLICATED`.
    - **Synthetic twin on the demo-gateway path.** The twin's discovery counted only the shared pair marker, which a source seeded through `/admin/sources/add` never writes, so a collector restarted over a gateway that already held the source found no account. It now also runs the real discovery, which finds the session the twin's `createContext` seeded on disk. `scripts/shot-portal.sh sources --universe telegram-sync --wait .source-display-name` renders the Telegram row (paper-plane icon, "Telegram Messages", "7 messages"). Other twins share the marker-only discovery (not changed here).
    - **Tests added.** Rebuild serialisation, per-account independence and reference-counted release (`provider.test.ts`); takeout resume across a restart and an unhonoured resumed session (`takeout.test.ts`); presence-check inconclusive cases and signal propagation, revocation mid-walk (`history-walker.test.ts`); quarantine, cutoff tombstone, `sourceUpdatedAt` (`messages.test.ts`, `message-store.test.ts`); people hygiene and a chat-kind parity table (`normalizer.test.ts`); refusal mapping and logout timeout (`auth.test.ts`); two accounts syncing concurrently, one suspended, one removed (`index.test.ts`); Telegram's event profile told apart from WhatsApp's (`collector/src/document-event-profiles.test.ts`); installed bootstrap and storeId-less cursors, bare and enveloped (`collector/src/provider-conformance.test.ts`); the twin's discovery (`providers-synth/telegram/src/index.test.ts`).
    - **Decisions recorded, no code.**
      - _Very large supergroup days (§7, §8)._ Participants are not capped, as in WhatsApp, so one busy day of a very large group writes many person mentions through the gateway's single writer. Proposal for graduation: cap `participants`/people per day (e.g. the most active few hundred senders) and measure the writer cost on a large real group first.
      - _Q5._ A deletion older than the reconcile window that arrives without a live update is not found (presence checks cover `RECONCILE_WINDOW_DAYS`), and a chat that leaves the dialog list keeps its documents. Both stay as v1 behaviour.
      - _Storage key._ The `telegram-store` entry in the core storage-keys registry is the existing per-provider pattern, not source-specific code in core.
      - _App credential saved before Telegram verifies it._ The shared credentials wizard stores `api_id`/`api_hash` before any sign-in uses them (the shared precedent); a wrong one fails at sign-in as `missing-credentials` with a remedy.
      - _Universe._ Telegram stays out of the `default` universe until graduation; `telegram-sync` is its own universe.
      - _Basic group → supergroup migration_ is untested (the simulator has no migration) and stays a manual check (§16).

---

## 16. Outstanding for the operator

Nothing below can be checked without a real Telegram account or real devices.

1. **Real-account run (phases 1–4, source-review §17.1, §17.8, §17.9).** On a fresh install with `OMNESIS_EXPERIMENTAL=1` on gateway and collector: create the my.telegram.org app (note any `ERROR` popup cause), add the source through the portal and through `omnesis sources add`, with a two-step password; restart the collector without re-authenticating; terminate the Omnesis session from a phone and confirm needs-auth and `omnesis sources reauth telegram:<account>`; disable, re-enable, pause, remove, re-add and resync, and check the corpus matches the app.
2. **Takeout.** Confirm the first bootstrap gets `TAKEOUT_INIT_DELAY` or a session, that the Telegram service notification appears, that approving it and re-syncing lets the export start at once, that `finishTakeout` leaves no export pending in Telegram, and that a session resumed by its kept id after a collector restart or a source rebuild is honoured (§15.14; if Telegram answers `TAKEOUT_INVALID`, the walk carries on without an export). Note the flood waits seen through the session versus the normal walk.
3. **Media (phase 3 carry-over).** A voice note, a photo, a PDF, and a download hours later after the file reference expired.
4. **Forums and channels.** A real forum's topic titles and the General topic render as designed (mtcute's `isTopicMessage` / `threadId` mapping); switching channels on and off on a real account.
5. **Q3:** whether a session survives replacing the app credential (`api_id`).
6. **`tg://` links on devices (§17.3, §17.4).** "Open in source" for a supergroup message (`https://t.me/c/...`), a public channel and a private chat with a username, on desktop, iOS and Android, with and without the Telegram app; decide whether `tg://openmessage` links are worth emitting for chats that have none (§8.4, §15.7).
7. **§17.5 presentation.** The synthetic portal sources page renders the icon, name and unit noun (§15.14); timelines and mobile remain to be checked. The iOS `SourcesView.swift` hardcoded per-source unit and name switches (§11) still need the generic fix; no Telegram case was added.
8. **§17.6, §17.7.** Search by a Telegram person (and its merge with WhatsApp through a shared phone); a watch naming `telegram-messages` with `participant` or `extra.chatKind` compiles and fires.
9. **Q1, Telegram API terms §1.5 (AI use), the Terms of Service for Content Licensing ("Large Language Models and AI": indexing and aggregation)** and §3.3 (sponsored messages in channel content): a maintainer decision before graduation. The public docs cite both terms, state that accounts on unofficial API clients are put under observation and may be limited, and leave the decision to the operator.
10. **Q4, `urlPatterns`:** inbound `t.me/c/...` links still resolve to no document; needs a message-id → day-document contract extension (WhatsApp has the same gap).
11. **Q2, Q5, Q6** remain open as written in §15 (Q5's v1 behaviour is recorded in §15.14).
12. **Rebuild and removal on a real account (§15.14).** Change a config field and re-authenticate while the source is syncing: no `AUTH_KEY_DUPLICATED`, no forced sign-in. Remove the source: the Omnesis session leaves Telegram's device list.
13. **Basic group → supergroup migration.** Upgrade a basic group on a real account and check the old group's days stay and the supergroup's walk starts cleanly.
14. **Large supergroup writer cost** (§15.14 decision): measure before graduation and decide the participant cap.
