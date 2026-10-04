// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, describe, expect, it, vi } from "vitest";
import { installNotesBackground } from "./notes-background.js";
import { NOTES_STATE_KEY } from "./notes-service.js";
import { NOTES_TOKEN_KEY } from "./notes-credential.js";
import { PAIRING_KEY, TOKEN_KEY } from "./storage.js";

afterEach(() => vi.unstubAllGlobals());

describe("notes worker adapter", () => {
  it("calls browser fetch with its native receiver and exposes capabilities only to extension pages", async () => {
    const storage: Record<string, unknown> = {
      [PAIRING_KEY]: JSON.stringify({
        gatewayUrl: "https://gateway.example.org",
        deviceId: "11111111-1111-4111-8111-111111111111",
        scopes: ["write:web"],
        pairedAt: 1,
      }),
      [TOKEN_KEY]: "fictional-web-token",
    };
    storage[NOTES_STATE_KEY] = {
      pairing: "https://gateway.example.org\0" + "11111111-1111-4111-8111-111111111111",
      supported: true,
      queue: [],
    };
    storage[NOTES_TOKEN_KEY] = {
      pairing: (storage[NOTES_STATE_KEY] as { pairing: string }).pairing,
      token: "fictional-notes-token",
    };
    let command: ((value: string, tab?: chrome.tabs.Tab) => void) | undefined;
    const open = vi.fn(async () => undefined);
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: async (keys: string | string[]) =>
            Object.fromEntries(
              (Array.isArray(keys) ? keys : [keys]).map((key) => [key, storage[key]]),
            ),
          set: async (items: Record<string, unknown>) => {
            Object.assign(storage, items);
          },
        },
      },
      runtime: {
        onInstalled: { addListener: vi.fn() },
        id: "test-extension",
        getURL: (path: string) => `chrome-extension://test-extension/${path}`,
      },
      commands: {
        onCommand: {
          addListener: (listener: typeof command) => {
            command = listener;
          },
        },
      },
      contextMenus: {
        onClicked: { addListener: vi.fn() },
        removeAll: vi.fn(async () => undefined),
        create: vi.fn(),
      },
      sidePanel: { open, setOptions: vi.fn(async () => undefined) },
      scripting: {
        executeScript: vi.fn(async () => [
          {
            result: {
              url: "https://example.org/article",
              canonical: null,
              selection: "Fictional selection",
            },
          },
        ]),
      },
      alarms: { create: vi.fn() },
    });
    vi.stubGlobal("fetch", function (this: unknown) {
      if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
      return Promise.resolve(
        new Response(JSON.stringify({ capabilities: { browserNotes: { min: 1, max: 1 } } }), {
          status: 200,
        }),
      );
    });
    const background = installNotesBackground();
    command?.("tell-omnesis", {
      id: 1,
      url: "https://example.org/article",
      title: "Example article",
    });
    // No storage/network promise has settled: native opening must consume the current gesture.
    expect(open).toHaveBeenCalledWith({ tabId: 1 });
    const result = await new Promise((resolve) => {
      expect(
        background.message(
          { type: "notes-status" },
          { id: "test-extension", url: "chrome-extension://test-extension/popup.html" },
          resolve,
        ),
      ).toBe(true);
    });
    expect(result).toMatchObject({ supported: true, enabled: true });
    await vi.waitFor(() =>
      expect((storage[NOTES_STATE_KEY] as { draft?: unknown }).draft).toBeDefined(),
    );
    expect(
      background.message(
        { type: "notes-status" },
        { id: "test-extension", url: "https://example.org/article", tab: { id: 1 } },
        vi.fn(),
      ),
    ).toBe(false);
  });
});
