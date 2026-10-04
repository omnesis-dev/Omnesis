// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, describe, expect, it, vi } from "vitest";
import { activateFindResult, browserIdentity, findOpenTab } from "./find-tabs.js";
import type { FindResult } from "./find-service.js";

const result: FindResult = {
  id: "result-1",
  documentId: "document-1",
  title: "Invented guide",
  url: "https://example.org/guide",
  snippet: "",
  source: "Example",
};
afterEach(() => vi.unstubAllGlobals());
describe("local document tab identity", () => {
  it("does not collapse domains, hash-only resources, account selectors or session parameters", () => {
    for (const [a, b] of [
      ["https://example.org/guide", "https://example.org/another-guide"],
      ["https://example.org/#doc=123", "https://example.org/#doc=456"],
      [
        "https://example.org/?authuser=alice@example.com",
        "https://example.org/?authuser=bob@example.com",
      ],
      ["https://example.org/?session=one", "https://example.org/?session=two"],
    ]) {
      expect(browserIdentity(a!, [])).not.toBe(browserIdentity(b!, []));
      expect(findOpenTab({ ...result, url: a! }, [{ id: 7, url: b! }], [])).toBeUndefined();
    }
  });
  it("uses provider-declared identity aliases and skips inaccessible/private tabs", () => {
    const canonicalizers = [
      {
        hosts: ["example.org"],
        rules: [],
        browserIdentity: { part: "path" as const, format: "uuid-suffix" as const },
      },
    ];
    const wanted = { ...result, url: "https://example.org/view-123456781234123412341234567890ab" };
    expect(
      findOpenTab(
        wanted,
        [
          { id: 1 },
          {
            id: 2,
            url: "https://example.org/edit-12345678-1234-1234-1234-1234567890ab",
            incognito: true,
          },
          { id: 3, url: "https://example.org/edit-12345678-1234-1234-1234-1234567890ab" },
        ],
        canonicalizers,
      )?.id,
    ).toBe(3);
  });
  it("focuses the matching tab and its window, while new copy explicitly creates a tab", async () => {
    const update = vi.fn().mockResolvedValue({}),
      focus = vi.fn().mockResolvedValue({}),
      create = vi.fn().mockResolvedValue({});
    vi.stubGlobal("chrome", {
      tabs: {
        query: vi.fn().mockResolvedValue([{ id: 9, windowId: 4, url: result.url }]),
        update,
        create,
      },
      windows: { update: focus },
    });
    await activateFindResult(result, []);
    expect(update).toHaveBeenCalledWith(9, { active: true });
    expect(focus).toHaveBeenCalledWith(4, { focused: true });
    expect(create).not.toHaveBeenCalled();
    await activateFindResult(result, [], true);
    expect(create).toHaveBeenCalledWith({ url: result.url });
  });
  it("opens the source if the exact tab closes, but does not create duplicates on window focus errors", async () => {
    const create = vi.fn().mockResolvedValue({}),
      update = vi.fn().mockRejectedValueOnce(new Error("closed")).mockResolvedValue({});
    vi.stubGlobal("chrome", {
      tabs: {
        query: vi.fn().mockResolvedValue([{ id: 9, windowId: 4, url: result.url }]),
        update,
        create,
      },
      windows: { update: vi.fn().mockRejectedValue(new Error("focus failed")) },
    });
    await activateFindResult(result, []);
    expect(create).toHaveBeenCalledTimes(1);
    await expect(activateFindResult(result, [])).rejects.toThrow("focus failed");
    expect(create).toHaveBeenCalledTimes(1);
  });
});
