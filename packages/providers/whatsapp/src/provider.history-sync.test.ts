// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, expect, vi, beforeEach } from "vitest";

// Stub the baileys module so we can spy on the `makeWASocket` options the
// production socket factory builds — without opening a real WhatsApp connection.
// `vi.hoisted` so the spy exists when the hoisted `vi.mock` factory runs.
const { makeWASocketSpy } = vi.hoisted(() => ({
  makeWASocketSpy: vi.fn((_opts?: Record<string, unknown>) => ({
    ev: { on: vi.fn() },
    end: vi.fn(),
  })),
}));

vi.mock("@whiskeysockets/baileys", () => ({
  default: makeWASocketSpy,
  BufferJSON: {
    replacer: (_key: string, value: unknown) => value,
    reviver: (_key: string, value: unknown) => value,
  },
  initAuthCreds: vi.fn(() => ({ me: { id: "self" } })),
  proto: {
    Message: {
      AppStateSyncKeyData: { fromObject: vi.fn((value: unknown) => value) },
    },
  },
  fetchLatestBaileysVersion: vi.fn(async () => ({ version: [2, 3000, 1], isLatest: true })),
  makeCacheableSignalKeyStore: vi.fn((keys: unknown) => keys),
  downloadMediaMessage: vi.fn(),
  Browsers: { macOS: vi.fn(() => ["Mac OS", "Desktop", "1.0"]) },
  ALL_WA_PATCH_NAMES: [],
  DisconnectReason: { loggedOut: 401, connectionClosed: 428 },
}));

import { WhatsAppProvider } from "./provider.js";

function newProvider(): WhatsAppProvider {
  const dir = mkdtempSync(join(tmpdir(), "wa-hist-"));
  return new WhatsAppProvider("+15550100001", dir);
}

/**
 * Build the production socket factory and invoke its `createSocket`, returning
 * the options handed to `makeWASocket`.
 */
async function capturedSocketOptions(provider: WhatsAppProvider): Promise<Record<string, unknown>> {
  const factory = await (
    provider as unknown as {
      createDefaultSocketFactory: () => Promise<{ createSocket: () => Promise<unknown> }>;
    }
  ).createDefaultSocketFactory();
  await factory.createSocket();
  const lastCall = makeWASocketSpy.mock.calls.at(-1);
  return (lastCall?.[0] ?? {}) as Record<string, unknown>;
}

describe("WhatsApp syncFullHistory gating", () => {
  beforeEach(() => {
    makeWASocketSpy.mockClear();
  });

  test("requests full history when the store has not completed a history sync", async () => {
    const provider = newProvider();
    // Fresh store → historySyncComplete is false.
    expect(provider.getStore().historySyncComplete).toBe(false);

    const opts = await capturedSocketOptions(provider);
    expect(opts.syncFullHistory).toBe(true);
  });

  test("does NOT request full history once the store reports a completed sync", async () => {
    const provider = newProvider();
    // An already-synced companion. Re-requesting full history here is what makes
    // WhatsApp terminate the handshake with statusCode 428, stranding the source.
    provider.getStore().setHistorySyncState("complete");
    expect(provider.getStore().historySyncComplete).toBe(true);

    const opts = await capturedSocketOptions(provider);
    expect(opts.syncFullHistory).toBe(false);
  });
});
