// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, expect, vi } from "vitest";

vi.mock("@whiskeysockets/baileys", () => ({
  default: vi.fn(),
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
  const dir = mkdtempSync(join(tmpdir(), "wa-connerr-"));
  return new WhatsAppProvider("+15550100001", dir);
}

describe("WhatsAppProvider.onConnectionError/offConnectionError (push registration)", () => {
  test("offConnectionError stops the handler, and does not silence a later registration", () => {
    const provider = newProvider();
    const firstErrors: string[] = [];
    const secondErrors: string[] = [];
    const handlerA = (error: string): void => {
      firstErrors.push(error);
    };
    const handlerB = (error: string): void => {
      secondErrors.push(error);
    };

    provider.onConnectionError(handlerA);
    (
      provider as unknown as { connectionErrorHandler?: (error: string) => void }
    ).connectionErrorHandler?.("first failure");
    expect(firstErrors).toEqual(["first failure"]);

    provider.offConnectionError(handlerA);
    (
      provider as unknown as { connectionErrorHandler?: (error: string) => void }
    ).connectionErrorHandler?.("should not be delivered");
    expect(firstErrors).toEqual(["first failure"]);

    // A second registration replaces the first; the first handler's own
    // unsubscribe (called after B took over) must not silence B.
    provider.onConnectionError(handlerB);
    provider.offConnectionError(handlerA);
    (
      provider as unknown as { connectionErrorHandler?: (error: string) => void }
    ).connectionErrorHandler?.("second failure");
    expect(secondErrors).toEqual(["second failure"]);
    expect(firstErrors).toEqual(["first failure"]);
  });
});
