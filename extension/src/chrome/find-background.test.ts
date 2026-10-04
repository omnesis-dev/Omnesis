// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, describe, expect, it, vi } from "vitest";
import { installFindBackground } from "./find-background.js";
import { FIND_STATE_KEY } from "./find-service.js";
import { FIND_TOKEN_KEY } from "./find-credential.js";
import { PAIRING_KEY, TOKEN_KEY } from "./storage.js";

afterEach(() => vi.unstubAllGlobals());
describe("Find worker entrypoints", () => {
  it("opens a cold command synchronously, fences content messages and keeps read credentials out of views", async () => {
    const identity = "https://gateway.example.org\0" + "11111111-1111-4111-8111-111111111111";
    const stored: Record<string, unknown> = {
      [PAIRING_KEY]: JSON.stringify({
        gatewayUrl: "https://gateway.example.org",
        deviceId: "11111111-1111-4111-8111-111111111111",
        scopes: ["write:web"],
        pairedAt: 1,
      }),
      [TOKEN_KEY]: "web-token",
      [FIND_STATE_KEY]: { pairing: identity, supported: true, query: "", results: [] },
      [FIND_TOKEN_KEY]: { pairing: identity, token: "read-token" },
    };
    let command: ((name: string, tab?: chrome.tabs.Tab) => void) | undefined;
    const open = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: async (keys: string | string[]) =>
            Object.fromEntries(
              (Array.isArray(keys) ? keys : [keys]).map((key) => [key, stored[key]]),
            ),
          set: async (items: Record<string, unknown>) => {
            Object.assign(stored, items);
          },
        },
      },
      runtime: { id: "test", getURL: (path: string) => `chrome-extension://test/${path}` },
      commands: {
        onCommand: {
          addListener: (value: typeof command) => {
            command = value;
          },
        },
      },
      sidePanel: { open, setOptions: vi.fn().mockResolvedValue(undefined) },
      alarms: { create: vi.fn() },
      tabs: { query: vi.fn().mockResolvedValue([]), create: vi.fn().mockResolvedValue({}) },
      permissions: { contains: vi.fn().mockResolvedValue(false) },
    });
    vi.stubGlobal("fetch", function (this: unknown, input: string | URL | Request) {
      if (this !== undefined && this !== globalThis) throw new Error("Illegal invocation");
      return Promise.resolve(
        new Response(
          JSON.stringify(
            String(input).endsWith("/health")
              ? { capabilities: { browserFind: { min: 1, max: 1 } } }
              : { enabled: true, canonicalizers: [] },
          ),
        ),
      );
    });
    const background = installFindBackground();
    command?.("find-omnesis", { id: 9, url: "https://example.org/guide" });
    expect(open).toHaveBeenCalledWith({ tabId: 9 });
    expect(
      background.message(
        { type: "find-status" },
        { id: "test", url: "https://example.org/guide" },
        vi.fn(),
      ),
    ).toBe(false);
    const view = await new Promise((resolve) => {
      expect(
        background.message(
          { type: "find-status" },
          { id: "test", url: "chrome-extension://test/popup.html" },
          resolve,
        ),
      ).toBe(true);
    });
    expect(view).toMatchObject({ supported: true, enabled: true });
    expect(JSON.stringify(view)).not.toContain("read-token");
    expect(JSON.stringify(stored[FIND_STATE_KEY])).not.toContain("read-token");
    await background.clear();
    expect(stored[FIND_TOKEN_KEY]).toBeNull();
    expect(stored[FIND_STATE_KEY]).toBeNull();
    const count = open.mock.calls.length;
    command?.("find-omnesis", { id: 9 });
    expect(open).toHaveBeenCalledTimes(count);
  });
});
