// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, describe, expect, it, vi } from "vitest";
import { installFindBackground } from "./find-background.js";
import { FIND_STATE_KEY } from "./find-service.js";
import { FIND_TOKEN_KEY } from "./find-credential.js";
import { PAIRING_KEY, TOKEN_KEY } from "./storage.js";

afterEach(() => vi.unstubAllGlobals());
describe("Find worker entrypoints", () => {
  it("accepts only full-page Find messages and navigates its originating tab", async () => {
    const identity = "https://gateway.example.org\0" + "11111111-1111-4111-8111-111111111111";
    const stored: Record<string, unknown> = {
      [PAIRING_KEY]: JSON.stringify({
        gatewayUrl: "https://gateway.example.org",
        deviceId: "11111111-1111-4111-8111-111111111111",
        scopes: ["write:web"],
        pairedAt: 1,
      }),
      [TOKEN_KEY]: "web-token",
      [FIND_STATE_KEY]: {
        pairing: identity,
        supported: true,
        experimental: true,
        automatic: true,
        query: "",
        results: [
          {
            id: "first",
            title: "Invented guide",
            url: "https://example.org/guide",
            source: "Example",
            snippet: "Invented passage",
          },
        ],
      },
      [FIND_TOKEN_KEY]: { pairing: identity, token: "read-token" },
    };
    const commandListener = vi.fn();
    const update = vi.fn().mockResolvedValue({});
    const create = vi.fn().mockResolvedValue({});
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
      commands: { onCommand: { addListener: commandListener } },
      sidePanel: { open, setOptions: vi.fn().mockResolvedValue(undefined) },
      alarms: { create: vi.fn() },
      tabs: { query: vi.fn().mockResolvedValue([]), create, update },
      permissions: { contains: vi.fn().mockResolvedValue(false) },
    });
    vi.stubGlobal("fetch", function (this: unknown, input: string | URL | Request) {
      if (this !== undefined && this !== globalThis) throw new Error("Illegal invocation");
      return Promise.resolve(
        new Response(
          JSON.stringify(
            String(input).endsWith("/health")
              ? {
                  experimental: true,
                  capabilities: {
                    browserFind: { min: 1, max: 1 },
                    browserFeatures: { min: 1, max: 1 },
                  },
                }
              : { experimental: true, enabled: true, canonicalizers: [] },
          ),
        ),
      );
    });
    const background = installFindBackground();
    expect(commandListener).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
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
          { id: "test", url: "chrome-extension://test/find.html?q=invented", tab: { id: 17 } },
          resolve,
        ),
      ).toBe(true);
    });
    expect(view).toMatchObject({ supported: true, enabled: true });
    expect(JSON.stringify(view)).not.toContain("read-token");
    expect(JSON.stringify(stored[FIND_STATE_KEY])).not.toContain("read-token");
    const fullPage = {
      id: "test",
      url: "chrome-extension://test/find.html?q=invented%20query",
      tab: { id: 17 },
    };
    const result = await new Promise((resolve) => {
      expect(
        background.message({ type: "find-result", resultId: "first" }, fullPage, resolve),
      ).toBe(true);
    });
    expect(result).toMatchObject({ ok: true });
    expect(update).toHaveBeenCalledExactlyOnceWith(17, { url: "https://example.org/guide" });
    expect(create).not.toHaveBeenCalled();
    await new Promise((resolve) =>
      background.message(
        { type: "find-result", resultId: "first", newCopy: true },
        fullPage,
        resolve,
      ),
    );
    expect(create).toHaveBeenCalledExactlyOnceWith({ url: "https://example.org/guide" });
    for (const page of ["notes.html", "popup.html", "options.html"])
      expect(
        background.message(
          { type: "find-view" },
          { id: "test", url: `chrome-extension://test/${page}` },
          vi.fn(),
        ),
      ).toBe(false);

    const updated = await new Promise((resolve) => {
      expect(
        background.message({ type: "find-update", query: "invented query" }, fullPage, resolve),
      ).toBe(true);
    });
    expect(updated).toMatchObject({ enabled: true, query: "invented query" });
    expect(background.message({ type: "find-open", tabId: 9 }, fullPage, vi.fn())).toBe(false);
    expect(background.message({ type: "notes-begin" }, fullPage, vi.fn())).toBe(false);
    expect(
      background.message(
        { type: "find-view" },
        { id: "test", url: "https://example.org/find.html?q=anything" },
        vi.fn(),
      ),
    ).toBe(false);
    await background.clear();
    expect(stored[FIND_TOKEN_KEY]).toBeNull();
    expect(stored[FIND_STATE_KEY]).toBeNull();
    expect(open).not.toHaveBeenCalled();
  });
});
