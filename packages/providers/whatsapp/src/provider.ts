// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { join } from "node:path";
import { existsSync, readFileSync, readdirSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  downloadMediaMessage,
  Browsers,
  ALL_WA_PATCH_NAMES,
  type WASocket,
  type BaileysEventMap,
  type ConnectionState,
  type GroupParticipant,
  type proto,
  type Contact,
  type LIDMapping,
  type WAMessageKey,
} from "@whiskeysockets/baileys";
import pino from "pino";
import {
  createLogger,
  DEFAULT_CONFIG_DIR,
  isEncryptedSecretFile,
  isSecretFileRootKeyUnavailableError,
  readSecretTextFileSync,
} from "@omnesis/core";
import {
  readConnectionState,
  type ConnectionState as CredentialState,
  AuthFailure,
  type ImportCallbacks,
  type ImportSummary,
  type Provider,
} from "@omnesis/source-sdk";
import { ProviderId, AccountId } from "@omnesis/types";
import { MessageStore, isDownloadableMedia } from "./message-store.js";
import { extractMessage } from "./message-extractor.js";
import { buildMediaRetryContext, classifyMediaDownloadError } from "./media-retry.js";
import { MediaByteCache } from "./media-cache.js";
import {
  createWhatsAppPairingOrder,
  promoteOmnesisMultiFileAuthState,
  WhatsAppPairingSupersededError,
  quiesceOmnesisMultiFileAuthState,
  sealOmnesisMultiFileAuthState,
  useOmnesisMultiFileAuthState,
  isOmnesisAuthUnlinked,
} from "./baileys-auth-state.js";
import type { Boom } from "@hapi/boom";
import type { SocketFactory, SocketFactoryResult, StoredMessage } from "./types.js";
import type { MediaDownloadFn, MediaDownloadResult } from "./messages.js";

const log = createLogger("provider:whatsapp");

/**
 * Reconstruct the inner WhatsApp message for a stored media message so Baileys
 * can decrypt and download it.
 *
 * Decryption derives keys from the media TYPE — audio (voice notes), images,
 * and documents each use a different HKDF info string — so the rebuilt message
 * kind must match the original: a voice note rebuilt as a `documentMessage`, or
 * an image rebuilt as a `documentMessage`, would fail to decrypt. The caller
 * guarantees `msg.media.mediaKey` and a `url`/`directPath` are present. Exported
 * so the per-type reconstruction is unit-testable without a live socket.
 */
export function buildMediaDownloadMessage(msg: StoredMessage): proto.IMessage {
  const media = msg.media!;
  const mediaKey = Buffer.from(media.mediaKey!, "base64");
  if (msg.type === "audio") {
    return {
      audioMessage: {
        url: media.url,
        directPath: media.directPath,
        mediaKey,
        mimetype: media.mimetype,
        fileLength: media.fileLength,
        seconds: media.seconds,
        ptt: media.isVoiceNote ?? undefined,
        mediaKeyTimestamp: media.mediaKeyTimestamp,
      },
    };
  }
  if (msg.type === "image") {
    return {
      imageMessage: {
        url: media.url,
        directPath: media.directPath,
        mediaKey,
        mimetype: media.mimetype,
        fileLength: media.fileLength,
        width: media.width,
        height: media.height,
        mediaKeyTimestamp: media.mediaKeyTimestamp,
      },
    };
  }
  return {
    documentMessage: {
      url: media.url,
      directPath: media.directPath,
      mediaKey,
      mimetype: media.mimetype,
      fileName: media.filename,
      fileLength: media.fileLength,
      mediaKeyTimestamp: media.mediaKeyTimestamp,
    },
  };
}

/**
 * Upper bound on a single media download. The Baileys re-upload path blocks
 * until a device holding the media answers, which never resolves if the phone
 * is offline — so the download is raced against this timeout to keep one dead
 * blob from stalling the whole sync. Generous enough that a real re-upload
 * round-trip completes well within it.
 */
const MEDIA_DOWNLOAD_TIMEOUT_MS = 60_000;

/**
 * Minimum gap between connect-triggered media-retry nudges. Bounds the damage
 * of a flapping connection: without it, reconnecting every few seconds would
 * keep resetting every pending media to "due now" and burn through the backoff.
 */
const MEDIA_RETRY_NUDGE_MIN_INTERVAL_MS = 60_000;

/**
 * Eager media cache: download a just-received media item's bytes the instant it
 * arrives (while the sender's upload is freshest and the CDN blob is guaranteed
 * present), and hand them to the drain so it never has to re-fetch a possibly-
 * evicted blob. This is what keeps newly-received voice notes reliable — the
 * same "grab on receipt" approach a live chat agent uses. Bytes live only in
 * RAM, transiently (consumed by the drain, or evicted), so audio is never
 * persisted to disk. Only small items are cached (voice notes / typical images);
 * large attachments fall back to the normal at-drain download.
 */
const EAGER_MEDIA_MAX_ITEM_BYTES = 2 * 1024 * 1024; // 2 MB
const EAGER_CACHE_MAX_ENTRIES = 64;
const EAGER_CACHE_MAX_BYTES = 64 * 1024 * 1024; // 64 MB total
const EAGER_CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 h — drop bytes a drain never consumed
/** Cap on concurrent eager downloads, so a burst (20 photos at once) can't spike RAM / socket load — the overflow falls back to the at-drain download. */
const EAGER_MAX_CONCURRENT = 6;

/**
 * Resolve `p`, or reject with a timeout error after `ms`. The underlying promise
 * is not cancellable (Baileys gives us no abort handle); it's left to settle and
 * be GC'd, while the timer is always cleared so it can't leak or hold the event
 * loop open.
 */
export async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  // Swallow a late rejection from the abandoned (uncancellable) promise so it
  // can't surface as an unhandledRejection after we've already lost the race.
  p.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms: ${label}`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Cache key for a message's media bytes — shared by the eager `put` and the
 * drain `take` so the two can never drift out of sync. */
function mediaCacheKey(msg: StoredMessage): string {
  return `${msg.chatJid}:${msg.id}`;
}

/**
 * Whether a message is worth eager-downloading on receipt: a fetchable media
 * item (same predicate the drain enrolls — {@link isDownloadableMedia}) that is
 * also small. Large attachments (and unknown-size non-audio) are left to the
 * normal at-drain download so a single big blob can't bloat the RAM cache.
 */
export function isEagerEligible(msg: StoredMessage): boolean {
  if (!isDownloadableMedia(msg)) return false;
  const size = msg.media?.fileLength ?? 0;
  if (size > EAGER_MEDIA_MAX_ITEM_BYTES) return false;
  if (size === 0 && msg.type !== "audio") return false; // unknown size: only trust voice notes
  return true;
}

/**
 * Discover all configured WhatsApp accounts.
 * Returns an array of phone numbers (account IDs).
 */
/**
 * Staging-directory prefix used while a pair flow runs, before the phone number
 * is known. Directories under it are never real accounts, so `discoverAccounts`
 * skips them and the promotion step refuses to treat one as a resolved id.
 */
const STAGING_ACCOUNT_PREFIX = "_pairing";

/** Whether an account id is a pair-flow staging directory rather than a phone number. */
export function isStagingAccount(accountId: string): boolean {
  return accountId.startsWith(STAGING_ACCOUNT_PREFIX);
}

export function discoverAccounts(configDir?: string): AccountId[] {
  const waDir = join(configDir ?? DEFAULT_CONFIG_DIR, "whatsapp");
  if (!existsSync(waDir)) return [];

  return readdirSync(waDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("_"))
    .filter((d) => existsSync(join(waDir, d.name, "auth", "creds.json")))
    .map((d) => AccountId(d.name));
}

/**
 * Run the WhatsApp pairing flow interactively.
 * Returns the phone number of the paired account.
 */
export interface PairFlowOptions {
  configDir?: string;
  /** A renewal must not promote credentials for another account. */
  expectedAccountId?: string;
  socketFactory?: SocketFactory;
  /** Called with QR code data instead of rendering to terminal */
  onQrCode?: (qr: string) => void;
}

export async function pairFlow(
  configDirOrOpts?: string | PairFlowOptions,
  socketFactory?: SocketFactory,
): Promise<AccountId> {
  const opts =
    typeof configDirOrOpts === "string"
      ? { configDir: configDirOrOpts, socketFactory }
      : (configDirOrOpts ?? {});
  const dir = opts.configDir ?? DEFAULT_CONFIG_DIR;

  // The phone number is only known after the QR is scanned, so pairing writes
  // into a staging directory and promotes it once the account is resolved.
  //
  // The staging name is unique per attempt. A fixed name is shared state: two
  // pair flows running at once (adding a second number while a first attempt is
  // still open) would write interleaved Baileys credentials into one directory,
  // and whichever finished first would promote the other's half-written
  // `creds.json` — which fails with a 440 on the next connect and can only be
  // escaped by wiping the directory by hand. The `_` prefix keeps every staging
  // directory out of `discoverAccounts`.
  //
  // The try/finally below removes failed pre-auth staging. Once WhatsApp has
  // issued complete credentials, a failed promotion retains its ignored `_`
  // directory so recoverable encrypted state is not destroyed.
  const stagingAccount = `${STAGING_ACCOUNT_PREFIX}-${randomUUID()}`;
  const tempDir = join(dir, "whatsapp", stagingAccount);
  mkdirSync(join(tempDir, "auth"), { recursive: true });

  const provider = new WhatsAppProvider(stagingAccount, dir, opts.socketFactory, opts.onQrCode);
  let disconnected = false;
  let preserveStagingOnFailure = false;
  let promotedToPermanent = false;
  try {
    await provider.initialize();
    await provider.authenticate();

    const phone = provider.accountId;
    const pairingOrder = provider.accountPairingOrder ?? createWhatsAppPairingOrder();
    if (!phone || isStagingAccount(phone)) {
      throw new Error("Could not resolve WhatsApp phone number after pairing");
    }
    if (opts.expectedAccountId !== undefined && phone !== opts.expectedAccountId) {
      throw new AuthFailure(
        "identity-mismatch",
        "The paired phone is not the account being renewed",
        {
          remedy: "Scan the code with the phone for this connection, or add another connection.",
        },
      );
    }

    const permanentDir = join(dir, "whatsapp", phone);
    const stagingAuthDir = join(tempDir, "auth");
    preserveStagingOnFailure = isEncryptedSecretFile(
      readFileSync(join(stagingAuthDir, "creds.json"), "utf8"),
    );
    const permanentAuthDir = join(permanentDir, "auth");

    // Stop Baileys, reject late writes from this staged auth-state instance,
    // and drain every write already in flight before taking a snapshot.
    await provider.disconnect();
    disconnected = true;
    await sealOmnesisMultiFileAuthState(stagingAuthDir);

    if (existsSync(permanentAuthDir)) {
      // The new QR has already invalidated the old credentials. Keep every
      // other source-owned file, especially the durable message store.
      log.info("Replacing existing WhatsApp credentials");
    }
    await promoteOmnesisMultiFileAuthState(stagingAuthDir, permanentAuthDir, dir, pairingOrder);
    rmSync(tempDir, { recursive: true, force: true });
    preserveStagingOnFailure = false;
    promotedToPermanent = true;

    // Migrate old auth dir if it exists (from pre-multi-account)
    const oldAuthDir = join(dir, "whatsapp-auth");
    if (existsSync(oldAuthDir)) {
      rmSync(oldAuthDir, { recursive: true, force: true });
      log.info("Removed old whatsapp-auth directory (migrated to account directory)");
    }
    const oldStorePath = join(dir, "whatsapp-message-store.json");
    const accountStorePath = join(permanentDir, "message-store.json");
    if (existsSync(oldStorePath) && !existsSync(accountStorePath)) {
      renameSync(oldStorePath, accountStorePath);
      log.info("Moved old message store to account directory");
    }

    return AccountId(phone);
  } catch (err) {
    if (err instanceof WhatsAppPairingSupersededError) preserveStagingOnFailure = false;
    throw err;
  } finally {
    if (!disconnected) {
      try {
        await provider.disconnect();
      } catch (err) {
        log.warn(
          `disconnect() during pairFlow cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (!promotedToPermanent && existsSync(tempDir)) {
      if (preserveStagingOnFailure) {
        log.warn("Retained encrypted WhatsApp pairing state after failed promotion");
      } else {
        rmSync(tempDir, { recursive: true, force: true });
        log.info("Cleaned up pairing staging directory after failed pair attempt");
      }
    }
  }
}

/**
 * WhatsApp provider using Baileys (WhatsApp Web multi-device protocol).
 * Each instance represents one WhatsApp account.
 */
export class WhatsAppProvider implements Provider {
  readonly name = "WhatsApp";

  private sock: SocketFactoryResult["sock"] | null = null;
  private activeAuthDir: string | null = null;
  private store: MessageStore;
  private configDir: string;
  private resolvedAccountPairingOrder: string | null = null;
  private connected = false;
  // True while a message-history sync is expected on the current connection
  // (i.e. `historySyncComplete` was false at connect time): a fresh device
  // link or the first connect after a store reset. WhatsApp streams history
  // in batches that can lag the initial chat-list batch by tens of seconds,
  // so while this is set we wait far longer before declaring history
  // "complete" — otherwise we truncate it (the bug that left the store with
  // 103 chats but 0 messages). Genuine reconnects have it complete already.
  private expectingFullHistory = false;
  // Per-connection history-progress flags driving the tri-state history seal.
  // Reset on every fresh-pair connect (see the connect handler).
  /** Any non-ON_DEMAND `messaging-history.set` batch arrived this connection. */
  private historyBatchSeen = false;
  /** A RECENT/FULL history chunk arrived (deep history started streaming). */
  private deepHistorySeen = false;
  /** Baileys signalled INITIAL_BOOTSTRAP completion (the first recent slice). */
  private bootstrapCompleteSeen = false;
  /**
   * The settle backstop for the connection currently streaming history.
   *
   * Held so a reconnect can cancel it. Left untracked, each connect armed
   * another and the earliest one won: a drop five minutes in restarts the
   * history push, and the previous connection's timer then seals the fresh
   * attempt as finished seconds after it began.
   */
  private historySettleTimer: ReturnType<typeof setTimeout> | null = null;
  /** This provider exists only to pair; it must not consume the bootstrap. */
  private readonly pairingOnly: boolean;
  /** Community enumeration runs once per provider lifetime. */
  private communitiesEnumerated = false;
  /** Wall-clock ms of the last connect-triggered media-retry nudge (rate limit). */
  private lastMediaRetryNudgeMs = 0;
  /** Eager-downloaded media bytes, keyed by `chatJid:id`, consumed by the drain. */
  private readonly mediaCache = new MediaByteCache({
    maxEntries: EAGER_CACHE_MAX_ENTRIES,
    maxBytes: EAGER_CACHE_MAX_BYTES,
    ttlMs: EAGER_CACHE_TTL_MS,
  });
  /** Keys with an eager download in flight, to avoid duplicate fetches. */
  private readonly eagerInFlight = new Set<string>();
  private pinoLogger = pino({ level: "silent" });
  private _accountId: string;
  private socketFactory: SocketFactory | undefined;
  private onQrCode: ((qr: string) => void) | undefined;
  private connectionErrorHandler?: (error: string) => void;
  // True once the bounded fast-retry loop has exhausted and surfaced a degraded
  // state to the operator. Gates the one-time error report and triggers a sync
  // recovery on the next successful reconnect.
  private surfacedConnectionError = false;
  // Bumped by every `connect()`, `suspend()`, and `disconnect()`. Each
  // `connectWithFactory` closure captures the value at its start; its
  // connection-update handler and reconnect runner bail when the live counter
  // has moved on. Baileys' `sock.end()` emits its close event asynchronously,
  // so without this a socket torn down by `suspend()`/`disconnect()` could fire
  // a late close into a stale closure and resurrect a second reconnect loop
  // (mutual 428 eviction) after `resume()` had cleared `shuttingDown`.
  private connectionGeneration = 0;
  /**
   * Set true by `disconnect()` to short-circuit the auto-reconnect loop in
   * the `connection.update` handler. Without this, `cli remove
   * whatsapp-messages:<phone>` calls `disconnect()` → `sock.end()` → the
   * close event handler treats it as a transient disconnect and calls
   * `startSocket()`, which re-creates the auth dir Baileys is supposed to
   * load from. After `cleanupCredentials` rmSync's the dir, each retry
   * lands on `useMultiFileAuthState` reading then writing creds.json into
   * a deleted parent — every ~30s — until the next collector restart.
   * Closes the dangling-timer half of cli-remove-toctou-leaves-orphan-state.
   */
  private shuttingDown = false;
  private unlinked = false;

  get id(): ProviderId {
    return ProviderId(`whatsapp:${this._accountId}`);
  }

  get accountId(): AccountId {
    return AccountId(this._accountId);
  }

  get accountPairingOrder(): string | undefined {
    return this.resolvedAccountPairingOrder ?? undefined;
  }

  constructor(
    accountId: string,
    configDir?: string,
    socketFactory?: SocketFactory,
    onQrCode?: (qr: string) => void,
  ) {
    this._accountId = accountId;
    // A provider built on a staging account exists only to obtain credentials.
    // It must never become the socket WhatsApp delivers the once-per-link
    // bootstrap to; see the `connection === "open"` handler.
    this.pairingOnly = isStagingAccount(accountId);
    this.configDir = configDir ?? DEFAULT_CONFIG_DIR;
    this.socketFactory = socketFactory;
    this.onQrCode = onQrCode;
    this.store = new MessageStore(join(this.configDir, "whatsapp", accountId));
  }

  private get authDir(): string {
    return join(this.configDir, "whatsapp", this._accountId, "auth");
  }

  async initialize(): Promise<void> {
    log.info("WhatsApp provider initialized");
    log.debug(`Auth dir: ${this.authDir}`);
  }

  async authenticate(): Promise<void> {
    await this.connect();
  }

  async isAuthenticated(): Promise<boolean> {
    if (this.unlinked || (await isOmnesisAuthUnlinked(this.authDir))) return false;
    const credsPath = join(this.authDir, "creds.json");
    if (!existsSync(credsPath)) return false;

    try {
      const raw = readSecretTextFileSync(credsPath, { configDir: this.configDir });
      if (!raw) return false;
      const creds = JSON.parse(raw);
      return !!creds.me?.id;
    } catch (err) {
      if (isSecretFileRootKeyUnavailableError(err)) throw err;
      return false;
    }
  }

  credentialState(): Promise<CredentialState> {
    return readConnectionState(async () => {
      if (this.unlinked || (await isOmnesisAuthUnlinked(this.authDir))) {
        return { status: "unlinked", detail: "This linked device was removed; pair it again." };
      }
      const raw = readSecretTextFileSync(join(this.authDir, "creds.json"), {
        configDir: this.configDir,
      });
      if (raw === null) return { status: "never-connected" };
      const creds = JSON.parse(raw);
      return creds.me?.id ? { status: "connected" } : { status: "never-connected" };
    });
  }

  /**
   * Seed self's LID → phone mapping in the store.
   *
   * Baileys's `creds.me` carries `id` (PN-form JID, e.g. "447700000000:6@s.whatsapp.net")
   * and may also carry `lid` (LID-form JID, e.g. "64171878182992:6@lid"). Without this
   * mapping, group rosters that list self by LID can't be deduped against the "You"
   * entry — self ends up appearing twice (once as "You" and once under their contact name).
   */
  private seedSelfLidMapping(me: { id?: string; lid?: string }): void {
    if (!me.lid || !me.id) return;
    const bareLid = me.lid.split("@")[0].split(":")[0];
    const phoneDigits = me.id.split("@")[0].split(":")[0];
    if (!bareLid || !phoneDigits) return;
    this.store.setLIDPhone(bareLid, `+${phoneDigits}`);
  }

  /**
   * Bulk-resolve every lid-only JID we know about against Baileys' persisted
   * reverse store (`lid-mapping-<lid>_reverse`) and fold the resulting phones
   * into the store's lid→phone map.
   *
   * The `lid-mapping.update` event + `messaging-history.set.lidPnMappings`
   * only cover mappings that arrive *after* this code is wired; mappings
   * Baileys persisted on an earlier connection (the common case for a
   * long-lived companion device) never re-fire. This bulk read of the
   * already-persisted store is what surfaces those — without it, lid-only
   * participants linked before the provider learned to ask keep
   * `phones: undefined` forever and can't be unified by phone across sources.
   *
   * Candidate lids come from the group rosters and contact records the store
   * already holds. Non-fatal and fire-and-forget; the mapping store coalesces
   * lookups, so a single batched call per refresh is cheap.
   */
  private async backfillLidMappings(sock: SocketFactoryResult["sock"]): Promise<void> {
    const lidStore = sock.signalRepository?.lidMapping;
    if (!lidStore) return;

    const lidJids = this.store.collectUnmappedLidJids();
    if (lidJids.length === 0) return;

    try {
      const pairs = await lidStore.getPNsForLIDs(lidJids);
      let resolved = 0;
      for (const { lid, pn } of pairs ?? []) {
        if (!this.store.hasLIDPhone(lid)) resolved++;
        this.store.setLIDPhoneFromPn(lid, pn);
      }
      if (resolved > 0) {
        log.info(`Backfilled ${resolved} lid→phone mappings from Baileys store`);
      }
    } catch (err) {
      log.debug(`lid→phone backfill failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Trigger an incremental app-state resync of the contact-name collections.
   * Passes `isInitialSync=false` (this device is already synced — we just want
   * a refresh). Resyncing the full `ALL_WA_PATCH_NAMES` set mirrors what
   * Baileys does internally during a fresh history pass; the contactAction
   * mutations that carry saved names live across the critical_* / regular
   * patches. Fire-and-forget and guarded — the mock socket has no
   * `resyncAppState`, and a connection without app-state keys self-heals
   * (Baileys defers the blocked collection until the key arrives).
   */
  private resyncContactNames(sock: SocketFactoryResult["sock"]): void {
    const resync = sock.resyncAppState;
    if (typeof resync !== "function") return;
    resync([...ALL_WA_PATCH_NAMES], false).catch((err) => {
      log.debug(
        `App-state contact resync failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  private resolveAccountIdFromJid(jid: string): void {
    const phone = jid.split("@")[0].split(":")[0];
    if (phone && isStagingAccount(this._accountId)) {
      this._accountId = `+${phone}`;
      this.resolvedAccountPairingOrder = createWhatsAppPairingOrder();
      log.info(`WhatsApp account resolved: ${this._accountId}`);
    }
  }

  async disconnect(): Promise<void> {
    // Set BEFORE sock.end() so the connection.update close handler sees
    // it and skips the auto-reconnect path — otherwise removing the
    // source kicks off an infinite reconnect loop that re-creates the
    // auth dir cleanupCredentials is about to delete. The generation bump
    // additionally neutralizes the current closure so a late async close
    // can't act after teardown.
    this.connectionGeneration++;
    this.shuttingDown = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const sock = this.sock;
    this.sock = null;
    this.connected = false;
    try {
      if (sock) await sock.end(undefined);
    } finally {
      if (this.activeAuthDir) {
        await quiesceOmnesisMultiFileAuthState(this.activeAuthDir);
        this.activeAuthDir = null;
      }
      // Close the durable store handle so its WAL/SHM siblings are released
      // before `cleanupCredentials` removes the account dir (no orphans).
      this.store.close();
    }
  }

  /**
   * Pause the live connection for a disabled source without the full
   * `disconnect()` teardown: stop the reconnect loop and close the socket, but
   * keep the store (and its push wiring) intact so `resume()` can re-establish
   * a single fresh connection. Leaving the loop running while disabled is what
   * lets a later re-enable stack a second socket that fights this one for the
   * one allowed device connection (mutual 428 eviction).
   */
  async suspend(): Promise<void> {
    // Bump first: neutralizes the current closure's handler/runner so the
    // async close from `sock.end()` below can't drive a reconnect.
    this.connectionGeneration++;
    this.shuttingDown = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const sock = this.sock;
    this.sock = null;
    try {
      if (sock) await sock.end(undefined);
    } finally {
      this.connected = false;
      this.surfacedConnectionError = false;
      const authDir = this.activeAuthDir;
      this.activeAuthDir = null;
      if (authDir) await quiesceOmnesisMultiFileAuthState(authDir);
    }
  }

  /**
   * Re-establish the connection paused by `suspend()`. Idempotent: a no-op when
   * already connected. Forces a clean slate first (a prior failed `suspend()`
   * may have left a socket + loop alive) so we never end up with two sockets,
   * then connects in the background — a transient outage self-heals via the
   * cool-down loop, so the caller isn't blocked on the handshake.
   */
  async resume(): Promise<void> {
    if (this.connected) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const sock = this.sock;
    this.sock = null;
    if (sock) {
      try {
        await sock.end(undefined);
      } catch {
        // already dead
      }
    }
    this.shuttingDown = false;
    void this.connect(false).catch((err) =>
      log.warn(
        `WhatsApp resume failed to start: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
  }

  getStore(): MessageStore {
    return this.store;
  }

  /**
   * One-time full-history import from a local encrypted iOS backup.
   * Decrypts + parses the backup's ChatStorage.sqlite and merges it into the
   * durable store by stable id. Runs against the live store (single writer) —
   * the dirty-day marking means the normal sync drain publishes the result.
   * Planned: dispatch on a backup-variant value for #29 (Android crypt15)
   * and #28 (Tier-2 targeted pull); both reuse the merge below.
   */
  async importHistory(
    values: Record<string, string>,
    callbacks?: ImportCallbacks,
  ): Promise<ImportSummary> {
    const backupPath = values.backupPath?.trim();
    const passphrase = values.passphrase ?? "";
    if (!backupPath) throw new Error("A backup folder path is required");
    if (!passphrase) throw new Error("The backup password is required");
    const { importWhatsAppHistory } = await import("./import/importer.js");
    const ownDigits = this._accountId.replace(/\D/g, "");
    return importWhatsAppHistory({
      backupPath,
      passphrase,
      store: this.store,
      own: { jid: `${ownDigits}@s.whatsapp.net`, name: "You" },
      callbacks,
    });
  }

  /**
   * Register a callback for connection errors (e.g. device unlinked).
   * Called when Baileys detects the device was logged out.
   */
  onConnectionError(handler: (error: string) => void): void {
    this.connectionErrorHandler = handler;
  }

  /**
   * Stop reporting to `handler`, if it is the one currently registered.
   *
   * Identity-guarded: a source torn down after another took over must not
   * silence the live listener.
   */
  offConnectionError(handler: (error: string) => void): void {
    if (this.connectionErrorHandler === handler) this.connectionErrorHandler = undefined;
  }

  /**
   * Create a media download function that uses Baileys to download document
   * attachments and voice notes. Returns null if the socket is not connected
   * or the download fails.
   *
   * The decryption derives keys from the media TYPE (audio vs document use
   * different HKDF info strings), so the reconstructed inner message must match
   * the original — a voice note downloaded as a `documentMessage` would fail to
   * decrypt. We rebuild the matching message kind from the stored descriptors.
   */
  getMediaDownloader(): MediaDownloadFn {
    return async (msg: StoredMessage): Promise<MediaDownloadResult> => {
      // Serve from the eager cache if we already grabbed these bytes on receipt
      // (consume-once: the drain processes them and won't ask again on success).
      const cached = this.mediaCache.take(mediaCacheKey(msg));
      if (cached) return { kind: "ok", data: cached };
      return this.downloadOnce(msg);
    };
  }

  /** One media download attempt from the CDN (with re-upload retry context). */
  private async downloadOnce(msg: StoredMessage): Promise<MediaDownloadResult> {
    if (!msg.media?.mediaKey || (!msg.media.url && !msg.media.directPath)) {
      return { kind: "terminal", error: "no-decryption-keys" };
    }
    // Socket down isn't a real download outcome — report transient so the
    // caller backs off and retries once the connection (and thus the media
    // re-upload path) is available again.
    if (!this.sock || !this.connected) {
      return { kind: "transient", error: "socket-disconnected" };
    }

    try {
      // Reconstruct a minimal proto.IWebMessageInfo for downloadMediaMessage
      const fakeProto: proto.IWebMessageInfo = {
        key: {
          remoteJid: msg.chatJid,
          id: msg.id,
          fromMe: msg.fromMe,
        },
        message: buildMediaDownloadMessage(msg),
      };
      // Pass the media re-upload retry context so a CDN 404/410 (media that
      // originated on another device or arrived across a reconnect) triggers
      // a re-upload + retry instead of throwing and silently dropping the
      // voice note. See `buildMediaRetryContext`.
      const ctx = buildMediaRetryContext(this.sock as Partial<WASocket>, this.pinoLogger);
      // Bound the wait: the re-upload path blocks until a device that holds
      // the media answers, which never resolves if the phone is offline.
      // Without a timeout a single dead blob would hang the whole sync until
      // the engine's wall-clock kill (failing the entire page); a bounded
      // timeout instead yields a transient failure that backs off per-message.
      const buffer = await withTimeout(
        downloadMediaMessage(fakeProto as any, "buffer", {}, ctx),
        MEDIA_DOWNLOAD_TIMEOUT_MS,
        `media download ${msg.id}`,
      );
      return { kind: "ok", data: new Uint8Array(buffer as Buffer) };
    } catch (err) {
      const classification = classifyMediaDownloadError(err);
      const reason = err instanceof Error ? err.message : String(err);
      log.debug(`Media download (${classification}) failed for ${msg.id}: ${reason}`);
      return { kind: classification, error: reason };
    }
  }

  /**
   * Eagerly download a just-received media item into the in-memory cache, so the
   * drain gets the bytes without re-fetching a possibly-evicted blob. Fire-and-
   * forget from the `messages.upsert` handler; best-effort (a failure just leaves
   * the normal at-drain retry path to handle it). Only small, downloadable media
   * is cached; large attachments fall back to the at-drain download.
   */
  private async eagerCacheMedia(msg: StoredMessage): Promise<void> {
    if (!isEagerEligible(msg)) return;
    const key = mediaCacheKey(msg);
    if (this.mediaCache.has(key) || this.eagerInFlight.has(key)) return;
    // Bound a burst (e.g. 20 photos at once); the overflow is left to the drain.
    if (this.eagerInFlight.size >= EAGER_MAX_CONCURRENT) return;
    // Skip media that isn't awaiting a download — e.g. a `notify` re-delivery of
    // an already-processed message, which would otherwise waste a fetch into the
    // cache that the drain never consumes. New media is `pending` here.
    if (this.store.getMessageById(msg.chatJid, msg.id)?.mediaState !== "pending") return;
    this.eagerInFlight.add(key);
    try {
      const res = await this.downloadOnce(msg);
      if (res.kind === "ok") this.mediaCache.put(key, res.data);
    } finally {
      this.eagerInFlight.delete(key);
    }
  }

  /**
   * On (re)connect, pull pending media forward so the retry sweep attempts it
   * immediately while the phone is reachable. Rate-limited (see
   * `MEDIA_RETRY_NUDGE_MIN_INTERVAL_MS`) so a flapping connection can't reset
   * the backoff repeatedly.
   */
  private nudgeMediaRetriesOnConnect(): void {
    const now = Date.now();
    if (now - this.lastMediaRetryNudgeMs < MEDIA_RETRY_NUDGE_MIN_INTERVAL_MS) return;
    this.lastMediaRetryNudgeMs = now;
    const nudged = this.store.pullForwardMediaRetries();
    if (nudged > 0)
      log.info(`Connection up — re-armed ${nudged} pending media for immediate retry`);
  }

  /**
   * Baileys `getMessage` hook. Answers the socket's message-retry / decryption
   * lookups from our durable store instead of returning `undefined` (the prior
   * no-op, which left those flows unable to find a message we actually have).
   * Rebuilds the matching media kind for downloadable media — so a media
   * re-upload request can be served — or the plain text body; returns
   * `undefined` for anything we can't faithfully represent.
   */
  private lookupMessageForBaileys(key: WAMessageKey): proto.IMessage | undefined {
    if (!key.remoteJid || !key.id) return undefined;
    const msg = this.store.getMessageById(key.remoteJid, key.id);
    if (!msg) return undefined;
    if (
      msg.media?.mediaKey &&
      (msg.media.url || msg.media.directPath) &&
      (msg.type === "audio" || msg.type === "image" || msg.type === "document")
    ) {
      return buildMediaDownloadMessage(msg);
    }
    return msg.text ? { conversation: msg.text } : undefined;
  }

  /**
   * Backoff schedule for the post-handshake reconnect loop. Base 2s, doubling
   * up to a 60s ceiling, ±25% jitter, with a 10-attempt cap before we
   * surface the failure to the engine via `onConnectionError`. Without the
   * cap, a persistent transient (corporate firewall blocking wss to
   * web.whatsapp.com after a network change) used to keep the recursion
   * spinning forever, re-allocating a fresh `useMultiFileAuthState` per
   * attempt.
   */
  private static readonly RECONNECT_BASE_MS = 2_000;
  private static readonly RECONNECT_MAX_MS = 60_000;
  private static readonly RECONNECT_JITTER_PCT = 0.25;
  private static readonly MAX_RECONNECT_ATTEMPTS = 10;
  // Gap between fast-retry bursts once the bounded loop has exhausted. Long
  // enough not to hammer WhatsApp during a sustained outage, short enough that
  // the source self-heals within minutes of the link coming back.
  private static readonly RECONNECT_COOLDOWN_MS = 5 * 60_000;

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private static computeReconnectDelay(attempt: number): number {
    const exp = Math.min(
      WhatsAppProvider.RECONNECT_MAX_MS,
      WhatsAppProvider.RECONNECT_BASE_MS * 2 ** (attempt - 1),
    );
    const band = exp * WhatsAppProvider.RECONNECT_JITTER_PCT;
    const jitter = (Math.random() * 2 - 1) * band;
    return Math.max(0, Math.floor(exp + jitter));
  }

  /**
   * Build the production socket factory: per-attempt `useMultiFileAuthState`
   * read + `makeWASocket`. The version fetch happens once outside the
   * factory so a reconnect storm doesn't hammer Baileys's version endpoint.
   */
  private async createDefaultSocketFactory(): Promise<SocketFactory> {
    const { version } = await fetchLatestBaileysVersion();
    log.info("Connecting to WhatsApp");
    log.debug("WhatsApp Web version", { version });

    // Pair as a macOS desktop companion. Baileys only unlocks full-history
    // sync when the `browser` tuple is "Mac OS"/"Desktop" (upstream maps that
    // exact tuple to the DARWIN web sub-platform; every other tuple gets only a
    // recent-message window). WhatsApp shows the linked device as "Mac OS".
    // NB: this tuple only pairs because of the vendored Baileys patch in
    // patches/ (WhatsApp 428-rejects WEB+DARWIN registrations; the patch
    // advertises the native MACOS platform instead — upstream PR
    // WhiskeySockets/Baileys#2693). Keep the patch until that ships.
    const browser = Browsers.macOS("Desktop");

    return {
      createSocket: async (): Promise<SocketFactoryResult> => {
        const authDir = this.authDir;
        const { state, saveCreds, setLinkedState } = await useOmnesisMultiFileAuthState(
          authDir,
          this.configDir,
        );
        // Only request a full-history sync when one is actually outstanding (a
        // fresh pair or an interrupted pass). WhatsApp terminates the
        // connection with statusCode 428 ("Connection Terminated", Precondition
        // Required) when an already-synced companion re-requests full history on
        // every reconnect, which strands the source in a permanent reconnect
        // loop. Gate on the same `historySyncComplete` signal `expectingFullHistory`
        // reads below — read per attempt so a reconnect after a completed pass
        // stops asking.
        const syncFullHistory = !this.store.historySyncComplete;
        const sock = makeWASocket({
          version,
          auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, this.pinoLogger),
          },
          browser,
          syncFullHistory,
          markOnlineOnConnect: false,
          logger: this.pinoLogger,
          getMessage: async (key) => this.lookupMessageForBaileys(key),
        });
        return { sock, saveCreds, setLinkedState, creds: state.creds, authDir };
      },
    };
  }

  /**
   * @param initial true for the create-time connection (an unrecoverable
   * failure rejects so `create()` fails loudly); false for a `resume()`
   * reconnect (exhaustion self-heals via the cool-down loop instead).
   */
  private async connect(initial = true): Promise<void> {
    // Bump synchronously, before any await, so a concurrent suspend/resume can't
    // race a stale closure in via the factory-creation await window.
    const generation = ++this.connectionGeneration;
    const factory = this.socketFactory ?? (await this.createDefaultSocketFactory());
    if (this.shuttingDown || generation !== this.connectionGeneration) {
      throw new Error("WhatsApp connection was cancelled");
    }
    return this.connectWithFactory(factory, initial);
  }

  /**
   * Drive the connection lifecycle through a SocketFactory. Both production
   * and tests funnel through here — the only difference is which factory
   * supplies the underlying socket. The post-handshake reconnect loop is
   * bounded (`MAX_RECONNECT_ATTEMPTS`) and backoffed (exponential + jitter,
   * capped at `RECONNECT_MAX_MS`) so a persistent transient surfaces
   * cleanly to `onConnectionError` instead of spinning forever.
   */
  private async connectWithFactory(factory: SocketFactory, initial = true): Promise<void> {
    // Snapshot of the generation this closure belongs to. If `suspend()`,
    // `disconnect()`, or a newer `connect()` bumps the counter, this closure is
    // stale and its handler/runner must stop acting (a late async close would
    // otherwise resurrect a competing socket).
    const myGeneration = this.connectionGeneration;
    const isStale = (): boolean => myGeneration !== this.connectionGeneration;

    await new Promise<void>((resolve, reject) => {
      // 5-min handshake timeout protects only the *first* connection
      // attempt. Once we resolve, the reconnect loop's own attempt cap
      // takes over.
      const handshakeTimeout = setTimeout(
        () => {
          reject(new Error("WhatsApp connection timed out (5 minutes)"));
        },
        5 * 60 * 1000,
      );

      let firstConnect = true;
      let reconnectAttempts = 0;

      const startSocket = async (): Promise<void> => {
        if (this.shuttingDown || isStale()) return;

        let result: SocketFactoryResult;
        try {
          result = await Promise.resolve(factory.createSocket(this.authDir));
        } catch (err) {
          log.error(
            `Failed to create WhatsApp socket: ${err instanceof Error ? err.message : String(err)}`,
          );
          if (firstConnect) {
            clearTimeout(handshakeTimeout);
            reject(err instanceof Error ? err : new Error(String(err)));
            return;
          }
          // A createSocket() failure during reconnect counts as a failed
          // attempt: bump the counter, honour the cap, and schedule a real
          // retry with `startSocket` as the runner. A bare
          // `scheduleReconnect()` here would leave `runner` undefined — the
          // timer fires, no-ops, and the reconnect loop stalls silently.
          this.connected = false;
          reconnectAttempts++;
          if (reconnectAttempts > WhatsAppProvider.MAX_RECONNECT_ATTEMPTS) {
            const msg =
              `WhatsApp reconnect failed after ${WhatsAppProvider.MAX_RECONNECT_ATTEMPTS} attempts ` +
              `(socket creation error: ${err instanceof Error ? err.message : String(err)})`;
            log.error(msg);
            this.connectionErrorHandler?.(msg);
            return;
          }
          this.scheduleReconnect(startSocket, reconnectAttempts);
          return;
        }
        const { sock, saveCreds, creds, authDir } = result;
        if (this.shuttingDown || isStale()) {
          clearTimeout(handshakeTimeout);
          try {
            await sock.end(undefined);
          } finally {
            if (authDir) await quiesceOmnesisMultiFileAuthState(authDir);
          }
          if (firstConnect) reject(new Error("WhatsApp connection was cancelled"));
          return;
        }
        this.sock = sock;
        this.activeAuthDir = authDir ?? null;

        // Expect a full message-history sync whenever it hasn't completed yet
        // (a fresh device link, or the first connect after a store reset).
        // Pairing happens in a separate auth step, so the sync socket already
        // carries `creds.me` even on that first post-link connect — `creds.me`
        // therefore can't tell us "history is coming", but the store's own
        // `historySyncComplete` flag can. Genuine reconnects have it true and
        // skip the long wait entirely.
        this.expectingFullHistory = !this.store.historySyncComplete;
        if (this.expectingFullHistory) {
          // Fresh pair, or recovery after an interrupted/streaming pass:
          // (re)enter the streaming wait and reset per-connection progress
          // flags so a prior connection's state can't seal this one.
          this.historyBatchSeen = false;
          this.deepHistorySeen = false;
          this.bootstrapCompleteSeen = false;
          this.store.setHistorySyncState("streaming");
          log.info("WhatsApp history sync expected (not yet complete) — awaiting full history");
        }

        sock.ev.on("connection.update", async (update: Partial<ConnectionState>) => {
          // A superseded connection (this socket was torn down by
          // suspend/disconnect or replaced by a newer connect) must not act on
          // late events — Baileys flushes a close asynchronously after end().
          if (isStale()) return;
          const { connection, lastDisconnect, qr } = update;

          if (qr) {
            if (this.onQrCode) {
              this.onQrCode(qr);
            } else {
              log.info("Scan this QR code with WhatsApp on your phone:");
              try {
                const qrTerminal = await import("qrcode-terminal");
                qrTerminal.default.generate(qr, { small: true });
              } catch {
                log.info(`QR code string (use a QR reader): ${qr}`);
              }
            }
          }

          if (connection === "open") {
            this.unlinked = false;
            // A pairing attempt must not be the connection WhatsApp delivers
            // the once-per-link bootstrap to. Everything that arrives after
            // this point on a pairing socket is acknowledged to WhatsApp and
            // then thrown away — `quiesce()` turns its key writes into no-ops,
            // `rotateGeneration()` makes them stale, and `end()` aborts the
            // history download mid-flight — and WhatsApp does not send it
            // twice. The account is then linked, live messages flow, and the
            // archive is simply gone.
            //
            // So end it here, in this tick, before returning to the event loop
            // gives Baileys a chance to dispatch an inbound message. The
            // source's own connection is then the first to open, and the
            // bootstrap is delivered to a socket that keeps what it receives.
            if (this.pairingOnly) {
              if (creds.me?.id) this.resolveAccountIdFromJid(creds.me.id);
              this.connected = true;
              clearTimeout(handshakeTimeout);
              // Not awaited: `pairFlow` disconnects straight after, and that
              // path is idempotent against an already-ended socket.
              void sock.end(undefined);
              resolve();
              return;
            }
            // Not awaited: a filesystem write under the auth lock has no
            // business delaying the connection the bootstrap arrives on.
            void result.setLinkedState?.(true).catch(() => {
              log.warn("Could not clear the linked-device status marker");
            });
            if (creds.me?.id) {
              this.resolveAccountIdFromJid(creds.me.id);
              this.seedSelfLidMapping(creds.me as Contact);
            }
            if (firstConnect) {
              log.info("WhatsApp connected successfully");
              firstConnect = false;
              clearTimeout(handshakeTimeout);
              resolve();
            } else {
              log.info(
                `WhatsApp reconnected (after ${reconnectAttempts} attempt${reconnectAttempts === 1 ? "" : "s"})`,
              );
            }
            reconnectAttempts = 0;
            this.connected = true;
            // The link is healthy again after a surfaced failure: poke a sync so
            // the source flips out of `error` now, even on a quiet reconnect that
            // delivers no message to fire the push path on its own.
            if (this.surfacedConnectionError) {
              this.surfacedConnectionError = false;
              this.store.wakeSync();
            }
            // Reconnect of an already-complete source won't re-seal, so refresh
            // group rosters here — which also (re)tags community membership from
            // group metadata (the seal-only path is skipped on a reconnect).
            if (this.store.historySyncComplete) {
              this.refreshAllGroupRosters(sock as WASocket);
            }
            // Enumerate communities once per provider lifetime (server-driven;
            // independent of history completion — it can surface chats absent
            // from the initial push).
            if (!this.communitiesEnumerated) {
              this.communitiesEnumerated = true;
              void this.enumerateCommunities(sock as WASocket);
            }

            // The phone is freshly reachable — the best moment to recover media
            // that needs a device to re-upload it. Pull pending media forward so
            // the next sweep retries it now. Rate-limited so connection flapping
            // can't repeatedly reset the backoff into a retry storm.
            this.nudgeMediaRetriesOnConnect();

            // Re-pull the address-book contact-name app-state collections.
            // WhatsApp syncs saved contact names (e.g. full names) to linked
            // devices via the app-state "contacts" mutations; Baileys only
            // auto-resyncs these during a fresh history pass, so on a
            // long-lived companion device that paired once and reconnects
            // forever, names added/edited after the first connect never
            // arrive. Resyncing explicitly on connect surfaces them — they
            // land via contacts.upsert/update and flow into
            // StoredContact.name. Fire-and-forget; guarded for the mock
            // socket which has no resyncAppState.
            this.resyncContactNames(sock);

            // Surface lid→phone mappings Baileys already persisted (the
            // reverse-store entries for lid-only participants) so they reach
            // the people array even when they predate this code.
            void this.backfillLidMappings(sock);

            if (!this.store.historySyncComplete) {
              // Settle timer: a backstop for when neither `isLatest` nor an
              // explicit `messaging-history.status` ever arrives. On a fresh
              // pair history can lag minutes; a reconnect won't re-stream so
              // settle quickly. The resolution (complete vs interrupted) is
              // decided by `resolveHistoryOnQuiet` — it does NOT blindly seal
              // complete.
              //
              // It measures THIS connection's quiet time. A dropped connection
              // restarts the history push, so a timer armed by the connection
              // before it is counting down against a stream that no longer
              // exists — and firing it seals the new attempt as finished.
              this.clearHistorySettleTimer();
              const noHistoryFallbackMs = this.expectingFullHistory ? 5 * 60_000 : 15_000;
              this.historySettleTimer = setTimeout(() => {
                this.historySettleTimer = null;
                if (this.store.historySyncComplete) return;
                log.info(`History settle timer fired after ${noHistoryFallbackMs}ms`);
                this.resolveHistoryOnQuiet();
              }, noHistoryFallbackMs);
            }
          }

          if (connection === "close") {
            // The stream this timer was watching is gone. Whatever replaces it
            // arms its own window; leaving this one running would let it judge
            // a connection it never saw.
            this.clearHistorySettleTimer();
            const boom = lastDisconnect?.error as Boom | undefined;
            const statusCode = boom?.output?.statusCode;
            // The bare status code rarely explains a close (428 covers every
            // un-classified termination). Surface the server's own reason so a
            // recurring failure is diagnosable from the logs alone.
            const reason = boom?.output?.payload?.message ?? boom?.message;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut || !creds.me?.id;

            // `disconnect()` flipped `shuttingDown` before calling
            // `sock.end()`. Honour it — every reconnect after that point
            // races `cleanupCredentials` rmSync'ing the auth dir.
            if (this.shuttingDown) {
              log.debug("Connection closed during shutdown — skipping reconnect");
              this.connected = false;
              return;
            }

            if (!shouldReconnect) {
              this.unlinked = true;
              try {
                await result.setLinkedState?.(false);
              } catch {
                log.warn("Could not persist the linked-device status marker");
              }
              if (this.shuttingDown || isStale()) return;
              log.error("WhatsApp logged out — need to re-pair");
              this.connected = false;
              this.connectionErrorHandler?.(
                "WhatsApp logged out — device was unlinked. Run 'add whatsapp' to re-pair.",
              );
              clearTimeout(handshakeTimeout);
              reject(new Error("WhatsApp logged out"));
              return;
            }

            this.connected = false;
            reconnectAttempts++;
            if (reconnectAttempts > WhatsAppProvider.MAX_RECONNECT_ATTEMPTS) {
              const msg =
                `WhatsApp reconnect failed after ${WhatsAppProvider.MAX_RECONNECT_ATTEMPTS} attempts ` +
                `(lastStatusCode=${statusCode ?? "unknown"}${reason ? `: ${reason}` : ""})`;
              log.error(msg);
              // The create-time connection can't hang `create()`, so surface the
              // failure and reject — setup fails loudly and the operator sees it.
              // A `resume()` reconnect (initial=false) instead falls through to
              // the self-healing cool-down even on its first attempt, so a source
              // re-enabled during a transient outage isn't left dead.
              if (firstConnect && initial) {
                this.connectionErrorHandler?.(msg);
                clearTimeout(handshakeTimeout);
                reject(new Error(msg));
                return;
              }
              // An established (or resumed) source lost its link. Surface the
              // degraded state once for visibility, then keep retrying on a slow
              // cool-down so a transient WhatsApp-side outage self-heals without a
              // manual restart (the bounded fast loop alone would strand it).
              if (!this.surfacedConnectionError) {
                this.surfacedConnectionError = true;
                this.connectionErrorHandler?.(msg);
              }
              reconnectAttempts = 0;
              this.scheduleCooldownRetry(startSocket, statusCode, reason);
              return;
            }
            this.scheduleReconnect(startSocket, reconnectAttempts, statusCode, reason);
          }
        });

        sock.ev.on("creds.update", saveCreds);
        this.registerEventHandlers(sock as any);
      };

      void startSocket();
    });
  }

  /**
   * Schedule the next reconnect attempt with exponential-backoff +
   * jitter. Tracks the timer on `this.reconnectTimer` so `disconnect()`
   * can cancel a pending retry rather than letting it fire after the
   * source has been removed.
   */
  private scheduleReconnect(
    runner?: () => Promise<void>,
    attempt: number = 1,
    statusCode?: number,
    reason?: string,
  ): void {
    if (this.shuttingDown) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const delay = WhatsAppProvider.computeReconnectDelay(attempt);
    log.warn(
      `WhatsApp connection closed (statusCode=${statusCode ?? "unknown"}${reason ? `: ${reason}` : ""}); ` +
        `reconnect attempt ${attempt}/${WhatsAppProvider.MAX_RECONNECT_ATTEMPTS} in ${delay}ms`,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.shuttingDown) return;
      if (runner) void runner();
    }, delay);
  }

  /**
   * Schedule a slow cool-down retry after the bounded fast loop has exhausted.
   * Keeps a stranded-but-enabled source trying indefinitely (until it
   * reconnects or `disconnect()` cancels the timer) so a transient WhatsApp
   * outage self-heals. The fast-retry budget is reset by the caller, so each
   * cool-down fire kicks off a fresh bounded burst before the next cool-down.
   */
  private scheduleCooldownRetry(
    runner: () => Promise<void>,
    statusCode?: number,
    reason?: string,
  ): void {
    if (this.shuttingDown) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const delay = WhatsAppProvider.RECONNECT_COOLDOWN_MS;
    log.warn(
      `WhatsApp still unreachable (statusCode=${statusCode ?? "unknown"}${reason ? `: ${reason}` : ""}); ` +
        `cooling down, next retry in ${Math.round(delay / 1000)}s`,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.shuttingDown) return;
      void runner();
    }, delay);
  }

  /**
   * Map a Baileys `Contact` (or `Partial<Contact>` from contacts.update) to
   * our `StoredContact`, capturing every identity field Baileys exposes:
   * the saved address-book `name`, the contact's self-set `notify`
   * (pushName), the business/verified display name, the WA username handle,
   * and the phone/lid JIDs. addContacts merges these, preferring non-empty
   * values, so a later event that carries fewer fields never erases more.
   */
  private toStoredContact(c: Partial<Contact>): {
    jid: string;
    name: string;
    pushName?: string;
    phoneNumber?: string;
    lid?: string;
    verifiedName?: string;
    username?: string;
  } {
    return {
      jid: c.id ?? "",
      name: c.name ?? "",
      pushName: c.notify ?? undefined,
      phoneNumber: c.phoneNumber ?? undefined,
      lid: c.lid ?? undefined,
      verifiedName: c.verifiedName ?? undefined,
      username: c.username ?? undefined,
    };
  }

  private registerEventHandlers(sock: WASocket): void {
    // Baileys `proto.HistorySync.HistorySyncType` numeric values.
    const SYNC_INITIAL_BOOTSTRAP = 0;
    const SYNC_FULL = 2;
    const SYNC_RECENT = 3;
    let historySyncTimer: ReturnType<typeof setTimeout> | null = null;
    const armQuietGap = () => {
      if (historySyncTimer) clearTimeout(historySyncTimer);
      const quietGapMs = this.expectingFullHistory ? 120_000 : 10_000;
      historySyncTimer = setTimeout(() => {
        if (this.store.historySyncComplete) return;
        log.info(`History quiet-gap fired after ${quietGapMs}ms`);
        this.resolveHistoryOnQuiet();
      }, quietGapMs);
    };

    sock.ev.on(
      "messaging-history.set",
      ({ chats, contacts, messages, isLatest, lidPnMappings, syncType }) => {
        log.info(
          `History batch: ${chats.length} chats, ${contacts.length} contacts, ${messages.length} messages, isLatest=${isLatest}, syncType=${syncType ?? "—"}`,
        );

        this.store.addChats(
          chats.map((c) => ({
            jid: c.id ?? "",
            name: c.name ?? c.id ?? "",
            isGroup: (c.id ?? "").endsWith("@g.us"),
          })),
        );
        this.store.addContacts(contacts.map((c) => this.toStoredContact(c)));
        // Resolved lid→phone pairs delivered alongside history. Fold them in so
        // lid-only senders in the just-synced messages carry a phone.
        for (const { lid, pn } of lidPnMappings ?? []) {
          this.store.setLIDPhoneFromPn(lid, pn);
        }
        const stored = messages
          .map((m) => extractMessage(m))
          .filter((m): m is NonNullable<typeof m> => m !== null);
        this.store.addMessages(stored);

        this.historyBatchSeen = true;
        if ((syncType === SYNC_RECENT || syncType === SYNC_FULL) && stored.length > 0) {
          this.deepHistorySeen = true;
        }

        if (isLatest) {
          log.info("History sync complete (isLatest)");
          if (historySyncTimer) clearTimeout(historySyncTimer);
          this.markHistoryComplete();
        } else {
          // No genuine completion yet — arm the quiet-gap backstop. Resolution
          // (complete vs interrupted) is decided by `resolveHistoryOnQuiet`,
          // which never blindly seals complete.
          armQuietGap();
        }
      },
    );

    // Baileys' own history-sync milestone. `explicit:true` means the server
    // confirmed completion (progress===100 / initial bootstrap done); a
    // `paused`/`explicit:false` is a timeout-inferred stall. This is a cleaner
    // completion signal than our wall-clock timer, so prefer it.
    sock.ev.on("messaging-history.status", ({ syncType, status, explicit }) => {
      log.debug(`History status: syncType=${syncType}, status=${status}, explicit=${explicit}`);
      if (this.store.historySyncComplete) return;
      if (status === "complete" && explicit) {
        if (syncType === SYNC_INITIAL_BOOTSTRAP) {
          // First recent slice is in, but deep history (RECENT/FULL) may still
          // be coming — don't seal complete. Record it so a subsequent quiet
          // period with no deep chunks resolves to complete (small account).
          this.bootstrapCompleteSeen = true;
        } else {
          if (historySyncTimer) clearTimeout(historySyncTimer);
          this.markHistoryComplete();
        }
      } else if (status === "paused") {
        this.resolveHistoryOnQuiet("paused");
      }
    });

    sock.ev.on("messages.upsert", ({ messages, type }) => {
      // "notify" is the real-time delivery; "append" is how Baileys tags
      // messages WhatsApp queued while this companion was offline and delivers
      // on reconnect (`node.attrs.offline`). Both are messages we have never
      // seen — dropping "append" loses everything sent while the collector was
      // down. The other "append" emitters are harmless here: own-sent echoes
      // never fire (this provider never sends), and group-event stubs extract
      // as `system` messages the normalizer already skips.
      if (type !== "notify" && type !== "append") return;

      const stored = messages
        .map((m) => extractMessage(m))
        .filter((m): m is NonNullable<typeof m> => m !== null);
      this.store.addMessages(stored);

      // Grab fresh media now, while the sender's upload is freshest and the CDN
      // blob is guaranteed present — so the drain reads cached bytes instead of
      // racing eviction. Fire-and-forget; failures fall back to the retry path.
      for (const m of stored) void this.eagerCacheMedia(m);

      log.debug("Real-time messages received", { count: stored.length });
    });

    sock.ev.on("messages.update", (updates) => {
      for (const update of updates) {
        if (!update.key?.id || !update.key.remoteJid) continue;

        // Deletion: messageStubType 1 = "revoke" ("delete for everyone").
        // NB: do NOT treat status === 5 as a deletion — in Baileys'
        // WAMessageStatus enum 5 is PLAYED (the receipt emitted once a voice
        // note / view-once media is listened to or viewed), not a deletion.
        // Misreading it silently soft-deleted every played voice note.
        if (update.update?.messageStubType === 1) {
          this.store.markDeleted(
            update.key.remoteJid,
            update.key.id,
            Math.floor(Date.now() / 1000),
          );
          continue;
        }

        // Edit: the update contains a new message with edited content
        const edited = update.update?.message;
        if (edited) {
          const newText =
            edited.conversation ??
            edited.extendedTextMessage?.text ??
            edited.editedMessage?.message?.conversation ??
            edited.editedMessage?.message?.extendedTextMessage?.text ??
            edited.protocolMessage?.editedMessage?.conversation ??
            edited.protocolMessage?.editedMessage?.extendedTextMessage?.text;
          if (newText !== undefined && newText !== null) {
            log.debug(`Message edited: ${update.key.remoteJid} ${update.key.id}`);
            this.store.updateMessage(update.key.remoteJid, update.key.id, newText);
          }
        }
      }
    });

    // "Delete for everyone" — Baileys emits this separately from messages.update
    sock.ev.on("messages.delete", (item) => {
      if ("keys" in item) {
        for (const key of item.keys) {
          if (key.id && key.remoteJid) {
            this.store.markDeleted(key.remoteJid, key.id, Math.floor(Date.now() / 1000));
          }
        }
      }
    });

    sock.ev.on("chats.upsert", (chats) => {
      this.store.addChats(
        chats.map((c) => ({
          jid: c.id ?? "",
          name: c.name ?? c.id ?? "",
          isGroup: (c.id ?? "").endsWith("@g.us"),
        })),
      );
    });

    sock.ev.on("contacts.upsert", (contacts) => {
      this.store.addContacts(contacts.map((c) => this.toStoredContact(c)));
    });

    // App-state-synced address-book names also arrive here (processed
    // contactAction mutations) plus incoming-message identity refreshes
    // (notify / verifiedName). `Partial<Contact>` — entries can lack an id,
    // and addContacts merges fields so an empty name never clobbers a stored
    // one. This is the channel that surfaces saved names after a resync.
    sock.ev.on("contacts.update", (updates) => {
      this.store.addContacts(updates.filter((c) => c.id).map((c) => this.toStoredContact(c)));
    });

    // Push-based lid→phone mapping (incoming receipts, app-state actions).
    // Single LIDMapping per event. Populates the same map the normalizer
    // reads to attach phones to lid-only participants.
    sock.ev.on("lid-mapping.update", ({ lid, pn }: LIDMapping) => {
      this.store.setLIDPhoneFromPn(lid, pn);
    });

    // New group surfaced — fetch its full roster so members who haven't
    // messaged yet still appear as participants on day-documents.
    sock.ev.on("groups.upsert", async (groups) => {
      for (const g of groups) {
        if (!g.id) continue;
        await this.fetchAndStoreGroupRoster(sock, g.id);
      }
    });

    // Group rename — keep the stored subject (the real group name) current so
    // day-document titles reflect the new name on the next message.
    sock.ev.on("groups.update", (updates) => {
      for (const g of updates) {
        if (g.id && g.subject && g.subject.length > 0) {
          this.store.addChats([{ jid: g.id, name: g.subject, isGroup: true }]);
        }
      }
    });

    // Membership changes — reflect adds/removes incrementally so we don't
    // need to re-fetch the full roster on every change. Baileys's typed
    // payload is GroupParticipant[]; the test mock emits string[]; accept
    // both by normalizing to JID strings.
    sock.ev.on("group-participants.update", ({ id, participants, action }) => {
      if (!id || !participants?.length) return;
      const jids = (participants as Array<string | { id?: string }>)
        .map((p) => (typeof p === "string" ? p : p?.id))
        .filter((j): j is string => typeof j === "string" && j.length > 0);
      if (jids.length === 0) return;
      if (action === "add") {
        this.store.addGroupParticipants(id, jids);
      } else if (action === "remove") {
        this.store.removeGroupParticipants(id, jids);
      }
      // promote/demote/modify don't change membership — ignored.
    });
  }

  /**
   * Harvest the identity a group's metadata carries beyond bare member JIDs:
   * the real group subject (the actual group name, used instead of deriving a
   * title from participants), per-participant names (each `GroupParticipant`
   * is a `Contact`), and any lid↔phone pairing a participant exposes
   * (`lid` + `phoneNumber`). Returns the bare member JIDs for the roster.
   */
  private ingestGroupMetadata(
    jid: string,
    meta:
      | {
          subject?: string;
          participants?: GroupParticipant[];
          linkedParent?: string;
          isCommunity?: boolean;
          isCommunityAnnounce?: boolean;
        }
      | undefined,
  ): string[] {
    if (meta?.subject && meta.subject.length > 0) {
      this.store.addChats([{ jid, name: meta.subject, isGroup: true }]);
    }
    // Community membership comes reliably from the group's own metadata
    // (`linkedParent` / `isCommunity`), which we already fetch here — far more
    // dependable than the dedicated communityFetchAllParticipating API, which is
    // flaky and frequently returns nothing.
    if (meta?.isCommunity || meta?.isCommunityAnnounce) {
      this.store.setChatKind(jid, "community");
    } else if (meta?.linkedParent) {
      this.store.setChatKind(jid, "community-subgroup", meta.linkedParent);
    }
    const ids: string[] = [];
    const contactUpdates: Array<Partial<Contact>> = [];
    for (const p of meta?.participants ?? []) {
      if (typeof p.id !== "string" || p.id.length === 0) continue;
      ids.push(p.id);
      if (p.lid && p.phoneNumber) this.store.setLIDPhoneFromPn(p.lid, p.phoneNumber);
      if (p.name || p.notify || p.verifiedName) contactUpdates.push(p);
    }
    if (contactUpdates.length > 0) {
      this.store.addContacts(contactUpdates.map((c) => this.toStoredContact(c)));
    }
    return ids;
  }

  /**
   * Seal the history sync as genuinely complete. Idempotent. Fetches full group
   * rosters so day-documents include members who didn't speak (fire-and-forget).
   */
  private clearHistorySettleTimer(): void {
    if (this.historySettleTimer === null) return;
    clearTimeout(this.historySettleTimer);
    this.historySettleTimer = null;
  }

  private markHistoryComplete(): void {
    this.clearHistorySettleTimer();
    if (this.store.historySyncComplete) return;
    this.store.setHistorySyncState("complete");
    log.info("History sync complete");
    if (this.sock) this.refreshAllGroupRosters(this.sock as WASocket);
  }

  /**
   * Record that the fresh-pair history push stalled without a genuine
   * completion. The recent-window corpus is truncated; recovery is
   * re-pair (refreshes the recent window) or a one-time backup import.
   * Never silently promoted to `complete` by a timer.
   */
  private markHistoryInterrupted(): void {
    if (this.store.historySyncComplete) return;
    if (this.store.historySyncState === "interrupted") return;
    this.store.setHistorySyncState("interrupted");
    log.warn(
      "History sync interrupted — recent-window corpus may be truncated. Re-pair to refresh, or import full history from a phone backup.",
    );
  }

  /**
   * Discover WhatsApp communities and their linked sub-groups, tagging
   * `chats.kind` / `parent_community_jid` so a community group absent from the
   * initial chat-list push is still surfaced. Runs
   * once per connection; best-effort and non-fatal.
   */
  private async enumerateCommunities(sock: WASocket): Promise<void> {
    const sockAny = sock as unknown as {
      communityFetchAllParticipating?: () => Promise<Record<string, unknown>>;
      communityFetchLinkedGroups?: (
        jid: string,
      ) => Promise<{ linkedGroups?: Array<{ id?: string; subject?: string }> }>;
    };
    if (typeof sockAny.communityFetchAllParticipating !== "function") return;
    try {
      const communities = await sockAny.communityFetchAllParticipating();
      const jids = Object.keys(communities ?? {});
      // Space the per-community linked-group queries so enumeration is a paced
      // trickle (one request at a time, short gap), not a burst.
      const gapMs = 5_000;
      let subGroups = 0;
      for (let i = 0; i < jids.length; i++) {
        const communityJid = jids[i];
        this.store.setChatKind(communityJid, "community");
        if (typeof sockAny.communityFetchLinkedGroups === "function") {
          if (i > 0) await new Promise((r) => setTimeout(r, gapMs));
          const linked = await sockAny.communityFetchLinkedGroups(communityJid);
          for (const sub of linked?.linkedGroups ?? []) {
            if (!sub.id) continue;
            if (sub.subject) {
              this.store.addChats([{ jid: sub.id, name: sub.subject, isGroup: true }]);
            }
            this.store.setChatKind(sub.id, "community-subgroup", communityJid);
            subGroups++;
          }
        }
      }
      log.info(`Community enumeration: ${jids.length} communities, ${subGroups} sub-groups tagged`);
    } catch (err) {
      log.debug(
        `Community enumeration failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Decide the history-sync outcome when the stream goes quiet (quiet-gap /
   * settle timer fired, or Baileys reported `paused`). This is where the seal
   * fix lives: an interrupted fresh-pair push resolves to `interrupted`, NOT
   * `complete`.
   */
  private resolveHistoryOnQuiet(cause: "paused" | "quiet" = "quiet"): void {
    if (this.store.historySyncComplete) return;
    // Reconnect (history already streamed once): nothing more is coming.
    if (!this.expectingFullHistory) {
      this.markHistoryComplete();
      return;
    }
    // WhatsApp said it stopped, which is not the same as having nothing to
    // send. A phone that backgrounds mid-push reports `paused`, and on a fresh
    // pair that arrives before the first batch — so the no-batches branch below
    // would read an explicit interruption as an empty account and seal a
    // truncated corpus as complete. An account that pauses has something to
    // pause.
    if (cause === "paused") {
      this.markHistoryInterrupted();
      return;
    }
    // Bootstrap slice completed and no deep history ever started: a small
    // account whose whole history fit in the bootstrap — genuinely complete.
    if (this.bootstrapCompleteSeen && !this.deepHistorySeen) {
      this.markHistoryComplete();
      return;
    }
    // We received history batches but the stream stalled before completing —
    // the truncated-corpus case.
    if (this.historyBatchSeen) {
      this.markHistoryInterrupted();
      return;
    }
    // No history batches arrived. That is only an empty account if the account
    // really is empty — and the chat list reaches a linked device long before
    // its messages do, so the store already knows the difference. Reading
    // silence as emptiness is what sealed a 72-chat account as complete
    // holding four messages, and reported it to the operator as synced.
    if (this.store.totalChats > 0) {
      log.warn(
        `History push delivered no messages for ${this.store.totalChats} known chat(s) — ` +
          `recording the sync as interrupted rather than complete.`,
      );
      this.markHistoryInterrupted();
      return;
    }
    // Nothing arrived and nothing is known: a genuinely empty or brand-new
    // account, where silence is the account's own answer.
    this.markHistoryComplete();
  }

  /**
   * Fetch all groups the account is participating in and store their rosters.
   * Called after history sync to seed group memberships.
   */
  private async refreshAllGroupRosters(sock: WASocket): Promise<void> {
    if (typeof sock.groupFetchAllParticipating !== "function") return;
    try {
      const groups = await sock.groupFetchAllParticipating();
      const rosters = new Map<string, string[]>();
      for (const [jid, meta] of Object.entries(groups)) {
        rosters.set(jid, this.ingestGroupMetadata(jid, meta));
      }
      this.store.updateGroupRosters(rosters);
      log.info(`Refreshed rosters for ${rosters.size} groups`);
      // Rosters are the main source of lid-only JIDs — backfill their phones
      // from Baileys' persisted reverse store now that we know the members.
      await this.backfillLidMappings(sock);
    } catch (err) {
      log.debug(
        `Failed to refresh group rosters: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Fetch a single group's metadata and store its roster.
   */
  private async fetchAndStoreGroupRoster(sock: WASocket, jid: string): Promise<void> {
    if (typeof sock.groupMetadata !== "function") return;
    try {
      const meta = await sock.groupMetadata(jid);
      const ids = this.ingestGroupMetadata(jid, meta);
      this.store.updateGroupRoster(jid, ids);
      log.debug(`Fetched roster for group ${jid}: ${ids.length} members`);
      await this.backfillLidMappings(sock);
    } catch (err) {
      log.debug(
        `Failed to fetch roster for ${jid}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
