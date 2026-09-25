// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { SyncCursor } from "@omnesis/source-sdk";

export interface WhatsAppSyncCursor extends SyncCursor {
  phase: "bootstrap" | "incremental";
  /** Highest message timestamp we've processed */
  lastTimestamp: number;
  /**
   * Highest `dirty_days.emit_seq` the gateway has confirmed committed. The
   * engine persists the returned cursor atomically with the documents
   * (`upsertWithCursor`), so on the next `sync()` this value proves which
   * drained day-chats actually landed — the store then clears those dirty
   * rows. A failed/rejected POST leaves the cursor (and therefore this seq)
   * un-advanced, so the affected days re-emit. Replaces the old
   * `historySyncComplete` cursor field, which now lives durably in the
   * store's `meta.history_sync_state`.
   */
  committedSeq: number;
  /** Archive that emitted committedSeq; absent in legacy cursors (replay safely). */
  storeId?: string;
}

/**
 * Lifecycle of the one-shot history push WhatsApp streams to a freshly linked
 * companion device.
 * - `streaming`: a fresh-pair full-history push is expected / in flight.
 * - `complete`: a genuine completion was observed (explicit
 *   `messaging-history.status` or `isLatest`), so the corpus is whole.
 * - `interrupted`: the push stalled (quiet-gap / no-history timeout fired)
 *   without a genuine completion — the corpus is truncated and recovery is
 *   re-pair (refreshes the recent window) or a one-time backup import.
 *   Never silently promoted to `complete` by a timer.
 */
export type HistorySyncState = "streaming" | "interrupted" | "complete";

/** Group sub-kind. Only meaningful when `StoredChat.isGroup` is true. */
export type ChatKind = "group" | "community" | "community-subgroup";

/**
 * Lifecycle of a media message's download + processing (transcription for voice
 * notes, text extraction/OCR for images & documents). A companion device only
 * holds the CDN URL + decryption key, never the bytes; WhatsApp evicts old
 * blobs, and recovery depends on a device that still holds the media being
 * online to re-upload (see `media-retry.ts`). A single attempt is therefore
 * not enough — this state drives a backoff retry that is decoupled from chat
 * activity, plus a terminal classification so genuinely-gone media stops
 * churning and surfaces instead of silently staying blank.
 *
 * - `pending`     — needs a (first or retry) attempt; `media_next_attempt` gates when.
 * - `done`        — processed successfully (voice note: transcript present).
 * - `empty`       — processed, no content (no speech or no recognized text).
 * - `unavailable` — terminal: the media is gone from the CDN/phone, or retries
 *                   were exhausted. Not retried automatically; rendered as an
 *                   explicit placeholder rather than a silent blank.
 *
 * Legacy rows created before this column existed carry `undefined` and keep the
 * pre-existing opportunistic behavior (attempted only when their day re-dirties);
 * a resync resets every media row to `pending` to reprocess the whole archive.
 */
export type MediaState = "pending" | "done" | "empty" | "unavailable";

/**
 * Result of one media download + processing attempt, reported by the source to
 * `MessageStore.recordMediaOutcome`, which advances {@link MediaState} and
 * schedules the next retry.
 *
 * - `transcribed`    — voice note processed (`text === ""` ⇒ `empty`, else `done`).
 * - `extracted`      — attachment text/OCR succeeded (`done`).
 * - `empty`          — attachment extraction succeeded with no recognized text
 *                      (`empty`).
 * - `transient`      — the *download* failed recoverably (CDN blob momentarily
 *                      gone, phone offline): back off and retry, but give up
 *                      (→ `unavailable`) once attempts are exhausted, because
 *                      CDN media genuinely expires.
 * - `process-failed` — the download succeeded but *processing* failed (no
 *                      transcriber/OCR model assigned yet, or the backend was
 *                      down): back off and retry **indefinitely** — the bytes
 *                      exist, so it will succeed once the capability is present;
 *                      never auto-give-up to `unavailable`.
 * - `terminal`       — unrecoverable (media gone from the phone, undecryptable):
 *                      mark `unavailable`, stop retrying.
 */
export type MediaOutcome =
  | { kind: "transcribed"; text: string }
  | { kind: "extracted" }
  | { kind: "empty" }
  | { kind: "transient"; error: string }
  | { kind: "process-failed"; error: string }
  | { kind: "terminal"; error: string };

/** Simplified message representation for internal storage */
export interface StoredMessage {
  /** Unique message ID from WhatsApp */
  id: string;
  /** Chat JID (e.g. 1234567890@s.whatsapp.net or 123-456@g.us) */
  chatJid: string;
  /** Sender JID (in groups) or remoteJid (in 1:1) */
  senderJid: string;
  /** Sender display name */
  senderName: string;
  /** Whether sent by us */
  fromMe: boolean;
  /** Unix timestamp in seconds */
  timestamp: number;
  /** Message type: text, image, video, audio, document, sticker, location, contact, reaction, system */
  type: string;
  /** Text content (message text, caption, etc.) */
  text: string;
  /** Media metadata if applicable */
  media?: {
    mimetype?: string;
    filename?: string;
    fileLength?: number;
    seconds?: number;
    isVoiceNote?: boolean;
    width?: number;
    height?: number;
    /** CDN download URL (documents, images + voice notes — for download/extraction) */
    url?: string;
    /** Direct path on WhatsApp CDN (documents, images + voice notes) */
    directPath?: string;
    /** Base64-encoded media decryption key (documents, images + voice notes) */
    mediaKey?: string;
    /** Timestamp when media key was issued (documents, images + voice notes) */
    mediaKeyTimestamp?: number;
  };
  /** Reaction emoji (for reaction messages) */
  reactionEmoji?: string;
  /** Key of message being reacted to */
  reactionTargetId?: string;
  /** Quoted/replied message info */
  quotedText?: string;
  quotedSender?: string;
  /** Whether this message was deleted */
  deleted?: boolean;
  /**
   * Transcript of a voice note, produced by the gateway's speech-to-text model
   * and persisted so re-emits don't re-transcribe. `undefined` = no transcript
   * yet; `""` = transcribed but no speech detected (`mediaState === "empty"`).
   * A failed re-download keeps any existing transcript rather than losing it.
   */
  transcript?: string;
  /**
   * Media download/processing lifecycle (see {@link MediaState}). Carried on the
   * message so the normalizer can render an explicit placeholder for terminally
   * `unavailable` media. `undefined` for non-media messages and legacy rows.
   */
  mediaState?: MediaState;
  /**
   * Unix-seconds gate for the next media download attempt (the backoff clock).
   * The source attempts a `pending` voice note only once this has elapsed, so an
   * unrelated re-render of the day doesn't bypass the backoff. `undefined` for
   * non-media and legacy rows.
   */
  mediaNextAttempt?: number;
}

/** Chat metadata */
export interface StoredChat {
  jid: string;
  name: string;
  isGroup: boolean;
  /**
   * Group sub-kind (community announcement group, community sub-group, or a
   * plain group). Undefined for 1:1 chats and for groups not yet classified
   * via the community enumeration pass. Display-neutral today; carried
   * so consumers can distinguish a community from a plain group without
   * re-deriving it.
   */
  kind?: ChatKind;
  /** For a community sub-group: the JID of its parent community. */
  parentCommunityJid?: string;
  /**
   * For groups: bare JIDs of current members.
   * Undefined means the roster has not been fetched yet (fall back to message senders).
   * Always undefined for 1:1 chats.
   */
  participants?: string[];
  /** Last time the roster was refreshed (unix seconds). */
  participantsFetchedAt?: number;
}

/** Contact info */
export interface StoredContact {
  jid: string;
  /** Address-book name the user saved on their WhatsApp (Baileys Contact.name). */
  name: string;
  /** Self-set display name the contact chose (Baileys Contact.notify). */
  pushName?: string;
  /** Phone number JID (e.g. "1234567890@s.whatsapp.net") from Baileys Contact.phoneNumber */
  phoneNumber?: string;
  /** LID JID (e.g. "64171878182992@lid") from Baileys Contact.lid */
  lid?: string;
  /**
   * Business / officially-verified display name (Baileys Contact.verifiedName).
   * Used as a name fallback below the address-book name and pushName so a
   * business contact with no saved name renders its brand rather than a phone.
   */
  verifiedName?: string;
  /** WA-assigned username handle (Baileys Contact.username), when provided. */
  username?: string;
}

/**
 * The Baileys `LIDMappingStore` surface the provider consumes to resolve a
 * LID to the phone number Baileys persisted in its signal store. `pn` is
 * returned as a device-suffixed PN JID (e.g. `"447700900123:0@s.whatsapp.net"`),
 * so callers must strip the `:device@server` suffix before parsing the number.
 */
export interface LidMappingStoreLike {
  getPNsForLIDs(lids: string[]): Promise<Array<{ lid: string; pn: string }> | null>;
}

/** What `SocketFactory.createSocket()` returns, sync or async. */
export interface SocketFactoryResult {
  /** Persist a link verdict only while this socket's credential generation is current. */
  setLinkedState?(linked: boolean): Promise<void>;
  sock: {
    ev: any;
    end: (reason?: any) => void | Promise<void>;
    groupMetadata?: (jid: string) => Promise<any>;
    groupFetchAllParticipating?: () => Promise<any>;
    /**
     * Bulk LID → phone resolver, present on the real Baileys socket via
     * `signalRepository.lidMapping`. Optional so minimal mocks can omit it;
     * the provider guards every call with a presence check.
     */
    signalRepository?: {
      lidMapping: LidMappingStoreLike;
    };
    /**
     * Re-pull app-state collections (WhatsApp syncs saved contact names to
     * linked devices via the app-state "contacts" mutations). Optional so
     * minimal mocks can omit it; guarded with a `typeof` check. The collection
     * union mirrors Baileys' `WAPatchName` so the real `WASocket` is
     * assignable to this loose shape.
     */
    resyncAppState?: (
      collections: readonly (
        | "critical_block"
        | "critical_unblock_low"
        | "regular_high"
        | "regular_low"
        | "regular"
      )[],
      isInitialSync: boolean,
    ) => Promise<void>;
    /** Community enumeration. Optional. */
    communityFetchAllParticipating?: () => Promise<Record<string, unknown>>;
    communityFetchLinkedGroups?: (
      jid: string,
    ) => Promise<{ linkedGroups?: Array<{ id?: string; subject?: string }> } | unknown>;
    communityMetadata?: (jid: string) => Promise<unknown>;
  };
  saveCreds: () => Promise<void>;
  /** Auth directory owned by this socket generation, when it uses durable state. */
  authDir?: string;
  /**
   * Live credentials object — the factory contract is that callers may
   * read `creds.me?.id` after the socket emits `connection.update {open}`,
   * mirroring Baileys's in-place mutation of `state.creds`.
   */
  creds: { me?: { id: string; lid?: string } };
}

/**
 * Factory for creating a Baileys-like socket.
 *
 * The provider's connect path is built around this factory: the production
 * path supplies a default factory that wraps `useMultiFileAuthState +
 * makeWASocket`; tests inject a mock factory that returns an in-memory
 * event emitter. Either way the connection-update / reconnect logic lives
 * in one place. `createSocket` may be sync or async.
 *
 * The optional group methods are only consulted when present (the provider
 * uses `typeof === "function"` guards), so existing minimal mocks remain valid.
 */
export interface SocketFactory {
  createSocket(authDir?: string): SocketFactoryResult | Promise<SocketFactoryResult>;
}
