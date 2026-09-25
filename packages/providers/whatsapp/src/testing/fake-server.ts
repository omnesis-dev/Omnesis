// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { Boom } from "@hapi/boom";
import { DisconnectReason, type proto } from "@whiskeysockets/baileys";
import { makeWAMessage } from "./mock-socket.js";
import type { SocketFactory, SocketFactoryResult } from "../types.js";

/**
 * High-fidelity, stateful fake of the WhatsApp companion-device protocol at the
 * Baileys-socket-API boundary. Holds a synthetic server-side corpus
 * and models the *phone + WhatsApp server*: the one-shot chunked history push,
 * `messaging-history.status` milestones, group and community enumeration, the
 * LID reverse store, reconnect/conflict and the 14-day de-link.
 *
 * It is injected via the existing `SocketFactory` seam so it drives the REAL
 * `WhatsAppProvider` (real event handling, real durable store, real seal state
 * machine) — unlike the synthetic provider, which bypasses all of that.
 * Deterministic: all asynchronous emissions go through `setTimeout`, so tests
 * with `vi.useFakeTimers()` advance them precisely.
 *
 * Used today at the provider-integration level; wiring it through the
 * spawned-gateway SyntheticE2EHarness is tracked separately.
 */

// Baileys proto.HistorySync.HistorySyncType numeric values.
const SYNC_INITIAL_BOOTSTRAP = 0;
const SYNC_RECENT = 3;

export interface FakeMsgSpec {
  id: string;
  /** Unix seconds. */
  ts: number;
  text?: string;
  fromMe?: boolean;
  /** Sender JID for group messages (defaults to the chat JID for 1:1). */
  senderJid?: string;
  pushName?: string;
  /** Raw proto override (for media / reactions / edits). */
  message?: proto.IMessage;
}

export interface FakeChatSpec {
  jid: string;
  name?: string;
  isGroup?: boolean;
  /** Group roster member JIDs. */
  participants?: string[];
  /** Community metadata surfaced via group metadata (the reliable path). */
  isCommunity?: boolean;
  linkedParent?: string;
  messages: FakeMsgSpec[];
}

export interface FakeContactSpec {
  id: string;
  name?: string;
  notify?: string;
  phoneNumber?: string;
  lid?: string;
  verifiedName?: string;
}

export interface FakeCommunitySpec {
  jid: string;
  name?: string;
  /** JIDs of linked sub-groups (each should also exist as a chat). */
  subGroups: string[];
}

export interface FakeCorpus {
  meJid: string;
  meLid?: string;
  chats: FakeChatSpec[];
  contacts?: FakeContactSpec[];
  /** Bare-lid-digits → bare-phone-digits, for the LID reverse store. */
  lidPnReverseMap?: Record<string, string>;
  communities?: FakeCommunitySpec[];
}

export interface PushHistoryOptions {
  /** Messages per `messaging-history.set` batch. Default 50 (WhatsApp Desktop scroll size). */
  chunkSize?: number;
  /** Most-recent N messages per chat delivered in the push. Default: all. */
  initialDepth?: number;
  /**
   * How the push terminates — drives the history-seal state machine.
   * - `isLatest` / `status`: a genuine completion → `complete`.
   * - `bootstrap-only`: the whole account fits the initial recent slice →
   *   `complete` once the quiet period resolves.
   * - `interrupt`: emit nothing further — the provider's quiet-gap / settle
   *   timer resolves it to `interrupted` (needs a timer advance to observe).
   * - `paused`: emit a `messaging-history.status {status:"paused"}` after the
   *   deep-history batches, which drives `resolveHistoryOnQuiet()` to
   *   `interrupted` SYNCHRONOUSLY — the real-time path for an interrupted
   *   bootstrap that doesn't want to wait out the 120s quiet-gap.
   */
  terminate?: "isLatest" | "status" | "interrupt" | "bootstrap-only" | "paused";
  /** syncType stamped on the message batches. Default RECENT. */
  syncType?: number;
}

class FakeEmitter {
  private listeners = new Map<string, Array<(d: unknown) => void>>();
  on(event: string, fn: (d: unknown) => void): void {
    const l = this.listeners.get(event) ?? [];
    l.push(fn);
    this.listeners.set(event, l);
  }
  emit(event: string, data: unknown): void {
    for (const fn of [...(this.listeners.get(event) ?? [])]) fn(data);
  }
  removeAllListeners(): void {
    this.listeners.clear();
  }
  // No-op buffered-emitter surface the real Baileys `ev` also exposes, so a
  // future provider switch to ev.process/buffer doesn't silently break the fake.
  process(): () => void {
    return () => {};
  }
  buffer(): void {}
  flush(): boolean {
    return false;
  }
  isBuffering(): boolean {
    return false;
  }
  createBufferedFunction<A extends unknown[], T>(work: (...a: A) => Promise<T>) {
    return work;
  }
  destroy(): void {
    this.removeAllListeners();
  }
}

export class FakeWhatsAppServer {
  /** The emitter of the most-recently-created socket (real Baileys gives each socket a fresh `ev`). */
  private active: FakeEmitter | null = null;
  private chats = new Map<string, FakeChatSpec>();
  private corpus: FakeCorpus;
  private endCalled = false;
  private socketCount = 0;

  // Assertion records.
  readonly groupFetchAllCount = { n: 0 };
  readonly communityFetchAllCount = { n: 0 };
  readonly lidLookupCalls: string[][] = [];

  constructor(corpus: FakeCorpus) {
    this.corpus = corpus;
    for (const c of corpus.chats) {
      this.chats.set(c.jid, { ...c, messages: [...c.messages].sort((a, b) => a.ts - b.ts) });
    }
  }

  // ─────────────────────────────── factory ──────────────────────────────────

  /** Emitter of the active (most recent) socket. */
  get emitter(): FakeEmitter {
    if (!this.active) this.active = new FakeEmitter();
    return this.active;
  }

  get factory(): SocketFactory {
    return {
      createSocket: (): SocketFactoryResult => {
        this.socketCount++;
        this.endCalled = false;
        const ev = new FakeEmitter();
        this.active = ev;
        return {
          sock: {
            ev,
            end: () => {
              this.endCalled = true;
            },
            groupMetadata: async (jid: string) => this.groupMetadata(jid),
            groupFetchAllParticipating: async () => {
              this.groupFetchAllCount.n++;
              return this.allGroupMetadata();
            },
            resyncAppState: async () => {},
            signalRepository: this.corpus.lidPnReverseMap
              ? { lidMapping: { getPNsForLIDs: (lids) => this.getPNsForLIDs(lids) } }
              : undefined,
            communityFetchAllParticipating: async () => {
              this.communityFetchAllCount.n++;
              return this.allCommunityMetadata();
            },
            communityFetchLinkedGroups: async (jid: string) => this.communityLinkedGroups(jid),
            communityMetadata: async (jid: string) => this.groupMetadata(jid),
          },
          saveCreds: async () => {},
          creds: {
            me: { id: this.corpus.meJid, ...(this.corpus.meLid ? { lid: this.corpus.meLid } : {}) },
          },
        };
      },
    };
  }

  socketCreateCount(): number {
    return this.socketCount;
  }
  wasEnded(): boolean {
    return this.endCalled;
  }

  // ─────────────────────────── connection driving ───────────────────────────

  /** Bring the socket up (emits connection.update {open}). */
  connect(): void {
    this.emitter.emit("connection.update", { connection: "open" });
  }

  emitQr(qr: string): void {
    this.emitter.emit("connection.update", { qr });
  }

  /** Drop the connection. statusCode mirrors Baileys' DisconnectReason. */
  close(statusCode = DisconnectReason.connectionClosed): void {
    this.emitter.emit("connection.update", {
      connection: "close",
      lastDisconnect: { error: new Boom("closed", { statusCode }), date: new Date(0) },
    });
  }

  /** Server unlinked the device after ~14 days idle (or the user removed it). */
  delink(): void {
    this.close(DisconnectReason.loggedOut);
  }

  // ──────────────────────────── history push ────────────────────────────────

  /**
   * Emit the one-shot initial history push the server streams to a freshly
   * linked companion device, terminating per `opts.terminate`.
   */
  pushInitialHistory(opts: PushHistoryOptions = {}): void {
    const chunkSize = opts.chunkSize ?? 50;
    const initialDepth = opts.initialDepth ?? Infinity;
    const terminate = opts.terminate ?? "isLatest";
    // bootstrap-only models a small account whose whole history fits the initial
    // recent slice — every batch is INITIAL_BOOTSTRAP (no deep RECENT/FULL).
    const syncType =
      terminate === "bootstrap-only" ? SYNC_INITIAL_BOOTSTRAP : (opts.syncType ?? SYNC_RECENT);

    // Batch 0: chats + contacts + lid mappings (no messages), like the real push.
    this.emitter.emit("messaging-history.set", {
      chats: [...this.chats.values()].map((c) => ({
        id: c.jid,
        name: c.name ?? c.jid,
      })),
      contacts: this.corpus.contacts ?? [],
      messages: [],
      isLatest: false,
      syncType,
      lidPnMappings: this.lidPnMappings(),
    });

    // The most-recent `initialDepth` messages per chat, flattened + chunked.
    const recent: proto.IWebMessageInfo[] = [];
    for (const c of this.chats.values()) {
      const slice = initialDepth === Infinity ? c.messages : c.messages.slice(-initialDepth);
      for (const m of slice) recent.push(this.toWAMessage(c, m));
    }

    const batches: proto.IWebMessageInfo[][] = [];
    for (let i = 0; i < recent.length; i += chunkSize) batches.push(recent.slice(i, i + chunkSize));
    if (batches.length === 0) batches.push([]);

    batches.forEach((batch, i) => {
      const last = i === batches.length - 1;
      this.emitter.emit("messaging-history.set", {
        chats: [],
        contacts: [],
        messages: batch,
        isLatest: last && terminate === "isLatest" ? true : false,
        syncType,
      });
    });

    if (terminate === "status") {
      this.emitter.emit("messaging-history.status", {
        syncType: SYNC_RECENT,
        status: "complete",
        explicit: true,
      });
    } else if (terminate === "bootstrap-only") {
      this.emitter.emit("messaging-history.status", {
        syncType: SYNC_INITIAL_BOOTSTRAP,
        status: "complete",
        explicit: true,
      });
    } else if (terminate === "paused") {
      // The server gave up streaming the rest of the deep history — a real
      // companion sees this as a `paused` milestone. The provider resolves it
      // to `interrupted` (not `complete`) immediately, with no timer to wait
      // out. Pair with deep RECENT/FULL batches above so the resolution lands
      // on the truncated-corpus branch, not the small-account branch.
      this.emitter.emit("messaging-history.status", {
        syncType: SYNC_RECENT,
        status: "paused",
        explicit: false,
      });
    }
    // "interrupt": emit nothing further — the test advances the provider's
    // quiet-gap / settle timer to resolve to `interrupted`.
  }

  // ───────────────────────── group / community APIs ─────────────────────────

  private groupMetadata(jid: string): {
    subject?: string;
    participants: Array<{ id: string }>;
    isCommunity?: boolean;
    linkedParent?: string;
  } {
    const c = this.chats.get(jid);
    return {
      subject: c?.name,
      participants: (c?.participants ?? []).map((id) => ({ id })),
      ...(c?.isCommunity ? { isCommunity: true } : {}),
      ...(c?.linkedParent ? { linkedParent: c.linkedParent } : {}),
    };
  }

  private allGroupMetadata(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const c of this.chats.values()) {
      if (c.isGroup || c.jid.endsWith("@g.us")) out[c.jid] = this.groupMetadata(c.jid);
    }
    return out;
  }

  private allCommunityMetadata(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const com of this.corpus.communities ?? []) {
      out[com.jid] = { subject: com.name, participants: [] };
    }
    return out;
  }

  private communityLinkedGroups(jid: string): {
    linkedGroups: Array<{ id: string; subject?: string }>;
  } {
    const com = (this.corpus.communities ?? []).find((c) => c.jid === jid);
    return {
      linkedGroups: (com?.subGroups ?? []).map((id) => ({
        id,
        subject: this.chats.get(id)?.name,
      })),
    };
  }

  private async getPNsForLIDs(lids: string[]): Promise<Array<{ lid: string; pn: string }> | null> {
    this.lidLookupCalls.push(lids);
    const map = this.corpus.lidPnReverseMap ?? {};
    const out: Array<{ lid: string; pn: string }> = [];
    for (const lidJid of lids) {
      const bare = lidJid.split("@")[0].split(":")[0];
      const phone = map[bare];
      if (phone) out.push({ lid: lidJid, pn: `${phone}:0@s.whatsapp.net` });
    }
    return out.length > 0 ? out : null;
  }

  // ───────────────────────────────── helpers ────────────────────────────────

  private lidPnMappings(): Array<{ lid: string; pn: string }> {
    return Object.entries(this.corpus.lidPnReverseMap ?? {}).map(([lid, pn]) => ({
      lid: `${lid}@lid`,
      pn: `${pn}@s.whatsapp.net`,
    }));
  }

  private toWAMessage(chat: FakeChatSpec, m: FakeMsgSpec): proto.IWebMessageInfo {
    const isGroup = chat.isGroup || chat.jid.endsWith("@g.us");
    return makeWAMessage({
      id: m.id,
      remoteJid: chat.jid,
      participant: isGroup
        ? (m.senderJid ?? (m.fromMe ? this.corpus.meJid : undefined))
        : undefined,
      fromMe: m.fromMe ?? false,
      timestamp: m.ts,
      pushName: m.pushName,
      text: m.text,
      message: m.message,
    });
  }
}
