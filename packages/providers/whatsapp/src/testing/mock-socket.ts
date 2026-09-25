// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { proto } from "@whiskeysockets/baileys";
import type { SocketFactory } from "../types.js";

type Listener = (...args: any[]) => void;

/**
 * Mock Baileys event emitter for testing.
 * Stores listeners per event name and exposes emit() for tests to fire events.
 */
export class MockBaileysEventEmitter {
  private listeners = new Map<string, Listener[]>();

  on(event: string, listener: Listener): void {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
  }

  emit(event: string, data: any): void {
    const list = this.listeners.get(event);
    if (list) {
      for (const fn of list) {
        fn(data);
      }
    }
  }

  removeAllListeners(): void {
    this.listeners.clear();
  }
}

/**
 * Minimal group-metadata shape the mock returns from groupMetadata /
 * groupFetchAllParticipating. Participants can carry the richer identity
 * fields Baileys exposes (name, lid, phoneNumber) so tests can exercise the
 * provider's per-participant identity harvesting.
 */
export interface MockGroupMetadata {
  subject?: string;
  participants: Array<{
    id: string;
    name?: string;
    notify?: string;
    lid?: string;
    phoneNumber?: string;
    verifiedName?: string;
  }>;
}

export interface MockSocketFactoryOptions {
  /** JID to set on creds.me (e.g. "1234567890:0@s.whatsapp.net") */
  meJid?: string;
  /** LID to set on creds.me.lid (e.g. "64171878182992:0@lid") */
  meLid?: string;
  /** Pre-canned response for sock.groupFetchAllParticipating(). */
  groupRosters?: Record<string, MockGroupMetadata>;
  /** Pre-canned per-JID responses for sock.groupMetadata(jid). */
  groupMetadataByJid?: Record<string, MockGroupMetadata>;
  /**
   * Persisted lid→phone reverse store, keyed by bare lid digits → bare phone
   * digits (e.g. { "200000000000001": "15550100123" }). Synthesizes
   * `sock.signalRepository.lidMapping.getPNsForLIDs`, returning the
   * device-suffixed PN-JID shape the real Baileys store returns. When absent,
   * the socket has no `signalRepository` (mirrors a minimal socket).
   */
  lidPnReverseMap?: Record<string, string>;
  /**
   * When provided, called at the start of every `createSocket()` with the
   * 1-based call count. Returning an `Error` makes that call reject (modelling
   * a transient `useMultiFileAuthState`/`makeWASocket` failure during a
   * reconnect); returning `null`/`undefined` lets the call succeed normally.
   */
  throwOnCreateSocket?: (callCount: number) => Error | null | undefined;
}

export interface MockSocketFactoryResult {
  factory: SocketFactory;
  emitter: MockBaileysEventEmitter;
  /** Returns true if sock.end() was called */
  endCalled: () => boolean;
  /** Returns the number of times createSocket() has been called. Useful for
   *  asserting that auto-reconnect (re-invocation of startSocket) did or
   *  did not fire after a connection.update close event. */
  createSocketCount: () => number;
  /** Records of group method calls, for assertions */
  groupCalls: {
    fetchAllCount: number;
    metadataJids: string[];
  };
  /**
   * Records of app-state resync calls (collections + isInitialSync), for
   * asserting the provider triggers a contact-name resync on connect.
   */
  resyncCalls: Array<{ collections: readonly string[]; isInitialSync: boolean }>;
  /** Lids passed to signalRepository.lidMapping.getPNsForLIDs, for assertions. */
  lidLookupCalls: string[][];
}

/**
 * Create a mock SocketFactory for testing WhatsAppProvider.
 * Returns the factory, a shared emitter for firing events, and
 * a function to check if end() was called.
 */
export function createMockSocketFactory(
  options?: MockSocketFactoryOptions,
): MockSocketFactoryResult {
  const emitter = new MockBaileysEventEmitter();
  let _endCalled = false;
  let _createSocketCount = 0;
  const groupCalls = { fetchAllCount: 0, metadataJids: [] as string[] };
  const resyncCalls: Array<{ collections: readonly string[]; isInitialSync: boolean }> = [];
  const lidLookupCalls: string[][] = [];

  // Only attach a signalRepository when the test supplies a reverse map, so
  // the default mock socket stays "minimal" (no signalRepository) and the
  // provider's presence guards are exercised on both paths.
  const reverseMap = options?.lidPnReverseMap;
  const signalRepository = reverseMap
    ? {
        lidMapping: {
          getPNsForLIDs: async (lids: string[]) => {
            lidLookupCalls.push(lids);
            const out: Array<{ lid: string; pn: string }> = [];
            for (const lidJid of lids) {
              const bare = lidJid.split("@")[0].split(":")[0];
              const phone = reverseMap[bare];
              // Mirror the real store: device-suffixed PN JID, returns the
              // entries it has and null when none resolve.
              if (phone) out.push({ lid: lidJid, pn: `${phone}:0@s.whatsapp.net` });
            }
            return out.length > 0 ? out : null;
          },
        },
      }
    : undefined;

  const creds = {
    me: options?.meJid
      ? { id: options.meJid, ...(options.meLid ? { lid: options.meLid } : {}) }
      : undefined,
  };

  const factory: SocketFactory = {
    createSocket() {
      _createSocketCount++;
      const err = options?.throwOnCreateSocket?.(_createSocketCount);
      if (err) throw err;
      _endCalled = false;
      return {
        sock: {
          ev: emitter,
          end: (_reason?: any) => {
            _endCalled = true;
          },
          groupMetadata: async (jid: string) => {
            groupCalls.metadataJids.push(jid);
            return options?.groupMetadataByJid?.[jid] ?? { participants: [] };
          },
          groupFetchAllParticipating: async () => {
            groupCalls.fetchAllCount++;
            return options?.groupRosters ?? {};
          },
          resyncAppState: async (collections: readonly string[], isInitialSync: boolean) => {
            resyncCalls.push({ collections, isInitialSync });
          },
          ...(signalRepository ? { signalRepository } : {}),
        },
        saveCreds: async () => {},
        creds,
      };
    },
  };

  return {
    factory,
    emitter,
    endCalled: () => _endCalled,
    createSocketCount: () => _createSocketCount,
    groupCalls,
    resyncCalls,
    lidLookupCalls,
  };
}

/**
 * Build a minimal proto.IWebMessageInfo for testing.
 */
export function makeWAMessage(
  overrides: {
    id?: string;
    remoteJid?: string;
    participant?: string;
    fromMe?: boolean;
    timestamp?: number;
    pushName?: string;
    text?: string;
    message?: proto.IMessage;
  } = {},
): proto.IWebMessageInfo {
  return {
    key: {
      id: overrides.id ?? `msg-${Math.random().toString(36).slice(2, 8)}`,
      remoteJid: overrides.remoteJid ?? "1234567890@s.whatsapp.net",
      participant: overrides.participant,
      fromMe: overrides.fromMe ?? false,
    },
    messageTimestamp: overrides.timestamp ?? Math.floor(Date.now() / 1000),
    pushName: overrides.pushName ?? "TestUser",
    message: overrides.message ?? {
      conversation: overrides.text ?? "Hello from test",
    },
  };
}

/**
 * Build a messaging-history.set event payload.
 */
type MockContact = {
  id: string;
  name?: string;
  notify?: string;
  phoneNumber?: string;
  lid?: string;
  verifiedName?: string;
  username?: string;
};

export function makeHistorySyncEvent(opts?: {
  messages?: proto.IWebMessageInfo[];
  chats?: Array<{ id: string; name?: string }>;
  contacts?: MockContact[];
  isLatest?: boolean;
  lidPnMappings?: Array<{ lid: string; pn: string }>;
}): {
  chats: Array<{ id: string; name?: string }>;
  contacts: MockContact[];
  messages: proto.IWebMessageInfo[];
  isLatest: boolean;
  lidPnMappings?: Array<{ lid: string; pn: string }>;
} {
  return {
    chats: opts?.chats ?? [],
    contacts: opts?.contacts ?? [],
    messages: opts?.messages ?? [],
    isLatest: opts?.isLatest ?? false,
    lidPnMappings: opts?.lidPnMappings,
  };
}

/**
 * Build a messages.upsert event payload.
 */
export function makeMessageUpsertEvent(
  messages: proto.IWebMessageInfo[],
  type: "notify" | "append" = "notify",
): { messages: proto.IWebMessageInfo[]; type: string } {
  return { messages, type };
}
