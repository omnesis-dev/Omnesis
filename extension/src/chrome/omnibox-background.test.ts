// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, describe, expect, it, vi } from "vitest";
import { installOmniboxBackground } from "./omnibox-background.js";
import type { FindView } from "./find-service.js";
import type { FindResult } from "./find-results.js";

function harness() {
  let started: () => void = () => undefined;
  let changed: (
    text: string,
    suggest: (results: chrome.omnibox.SuggestResult[]) => void,
  ) => void = () => undefined;
  let entered: (text: string, disposition: chrome.omnibox.OnInputEnteredDisposition) => void = () =>
    undefined;
  let cancelled: () => void = () => undefined;
  const view = { enabled: true, canonicalizers: [] } as unknown as FindView;
  const ensureRead = vi.fn(async () => ({ ...view }));
  const suggest = vi.fn(async (_query: string, _signal?: AbortSignal): Promise<FindResult[]> => []);
  const defaultSuggestion = vi.fn(async () => undefined);
  const create = vi.fn(async () => ({}));
  const update = vi.fn(async () => ({}));
  const get = vi.fn(async () => ({ id: 7, windowId: 1 }));
  const queryTabs = vi.fn<() => Promise<chrome.tabs.Tab[]>>(async () => [
    { id: 7, windowId: 1, url: "https://example.org/article" },
  ]);
  vi.stubGlobal("chrome", {
    runtime: { getURL: (path: string) => `chrome-extension://test/${path}` },
    omnibox: {
      setDefaultSuggestion: defaultSuggestion,
      onInputStarted: {
        addListener: (listener: typeof started) => {
          started = listener;
        },
      },
      onInputChanged: {
        addListener: (listener: typeof changed) => {
          changed = listener;
        },
      },
      onInputEntered: {
        addListener: (listener: typeof entered) => {
          entered = listener;
        },
      },
      onInputCancelled: {
        addListener: (listener: typeof cancelled) => {
          cancelled = listener;
        },
      },
    },
    tabs: {
      query: queryTabs,
      get,
      create,
      update,
    },
    windows: { update: vi.fn(async () => undefined) },
  });
  const controller = installOmniboxBackground({ ensureRead, suggest });
  return {
    view,
    queryTabs,
    get,
    ensureRead,
    suggest,
    defaultSuggestion,
    create,
    update,
    controller,
    start: () => started(),
    change: (query: string, callback: (results: chrome.omnibox.SuggestResult[]) => void) =>
      changed(query, callback),
    enter: (text: string, disposition: chrome.omnibox.OnInputEnteredDisposition = "currentTab") =>
      entered(text, disposition),
    cancel: () => cancelled(),
  };
}
const card = (id: string, url = "https://example.org/article"): FindResult => ({
  id,
  url,
  title: "An invented <guide> & example",
  snippet: "",
  source: "Example",
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Omnesis omnibox", () => {
  it.each([
    ["/search invented guide", "Search directly in Omnesis", "direct"],
    ["/agent invented guide", "Agentic search in Omnesis", "agentic"],
  ])("preserves the explicit mode when submitting %s", async (query, label, mode) => {
    vi.useFakeTimers();
    const h = harness();
    h.start();
    await vi.advanceTimersByTimeAsync(0);
    h.change(query, vi.fn());
    await vi.advanceTimersByTimeAsync(150);
    expect(h.defaultSuggestion).toHaveBeenLastCalledWith(
      expect.objectContaining({ description: expect.stringContaining(label) }),
    );
    h.enter(query);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.create).toHaveBeenCalledExactlyOnceWith({
      url: `chrome-extension://test/find.html?q=invented+guide&mode=${mode}`,
      active: true,
    });
    expect(h.update).not.toHaveBeenCalled();
  });
  it("debounces index previews, escapes markup, deduplicates destinations and bounds URL suggestions", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.suggest.mockResolvedValue([
      card("first"),
      card("same", "https://example.org/article/"),
      ...Array.from({ length: 7 }, (_, index) =>
        card(String(index), `https://example.org/${index}`),
      ),
    ]);
    h.start();
    await vi.advanceTimersByTimeAsync(0);
    const first = vi.fn(),
      second = vi.fn();
    h.change("guide", first);
    h.change("guide revised", second);
    await vi.advanceTimersByTimeAsync(149);
    expect(h.suggest).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.suggest).toHaveBeenCalledExactlyOnceWith("guide revised", expect.any(AbortSignal));
    expect(first).not.toHaveBeenCalled();
    const suggestions = second.mock.calls[0]?.[0] as chrome.omnibox.SuggestResult[];
    expect(suggestions).toHaveLength(6);
    expect(suggestions[0]?.content).toBe("https://example.org/article");
    expect(suggestions[0]?.description).toContain("&lt;guide&gt; &amp;");
    h.enter(suggestions[0]!.content);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.update).toHaveBeenCalledWith(7, { url: "https://example.org/article" });
    expect(h.create).not.toHaveBeenCalled();
  });
  it("opens a selected URL after Chrome reports its address-bar text as changed", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.suggest.mockResolvedValue([card("first")]);
    h.start();
    await vi.advanceTimersByTimeAsync(0);
    const callback = vi.fn();
    h.change("invented guide", callback);
    await vi.advanceTimersByTimeAsync(150);
    const url = callback.mock.calls[0]![0][0].content;
    h.change(url, vi.fn());
    h.enter(url);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.update).toHaveBeenCalledExactlyOnceWith(7, { url: "https://example.org/article" });
    expect(h.create).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);
    expect(h.suggest).toHaveBeenCalledTimes(1);
  });
  it("opens a valid result URL without relying on an in-memory suggestion identifier", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.enter("https://example.org/a-saved-page");
    await vi.advanceTimersByTimeAsync(0);
    expect(h.ensureRead).toHaveBeenCalledOnce();
    expect(h.update).toHaveBeenCalledExactlyOnceWith(7, {
      url: "https://example.org/a-saved-page",
    });
    expect(h.create).not.toHaveBeenCalled();
  });
  it("navigates the originating tab even when the destination is already open elsewhere", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.queryTabs.mockResolvedValue([
      { id: 7, windowId: 1, url: "https://example.org/current" },
      { id: 9, windowId: 1, url: "https://example.org/article" },
    ]);
    h.start();
    await vi.advanceTimersByTimeAsync(0);
    h.enter("https://example.org/article");
    await vi.advanceTimersByTimeAsync(0);
    expect(h.update).toHaveBeenCalledExactlyOnceWith(7, { url: "https://example.org/article" });
    expect(h.queryTabs).toHaveBeenCalledOnce();
    expect(h.create).not.toHaveBeenCalled();
  });
  it("opens an unmatched suggestion in the originating tab on normal Enter", async () => {
    vi.useFakeTimers();
    const h = harness();
    const url = "https://example.org/another-guide";
    h.suggest.mockResolvedValue([card("first", url)]);
    h.start();
    await vi.advanceTimersByTimeAsync(0);
    const callback = vi.fn();
    h.change("invented guide", callback);
    await vi.advanceTimersByTimeAsync(150);
    h.enter(callback.mock.calls[0]![0][0].content);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.update).toHaveBeenCalledExactlyOnceWith(7, { url });
    expect(h.create).not.toHaveBeenCalled();
  });
  it("does not open a different tab when Chrome temporarily rejects editing the originating tab", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.start();
    await vi.advanceTimersByTimeAsync(0);
    h.update.mockRejectedValueOnce(new Error("Tabs cannot be edited right now"));
    h.enter("https://example.org/another-guide");
    await vi.advanceTimersByTimeAsync(0);
    expect(h.get).toHaveBeenCalledExactlyOnceWith(7);
    expect(h.create).not.toHaveBeenCalled();
  });
  it("opens a replacement tab if the originating tab closed before navigation", async () => {
    vi.useFakeTimers();
    const h = harness();
    const url = "https://example.org/another-guide";
    h.start();
    await vi.advanceTimersByTimeAsync(0);
    h.update.mockRejectedValueOnce(new Error("Tab closed"));
    h.get.mockRejectedValueOnce(new Error("No such tab"));
    h.enter(url);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.create).toHaveBeenCalledExactlyOnceWith({ url });
  });
  it.each(["currentTab", "newForegroundTab", "newBackgroundTab"] as const)(
    "opens raw Enter as full-page Find with disposition %s",
    async (disposition) => {
      vi.useFakeTimers();
      const h = harness();
      h.start();
      h.change("the link shared yesterday", vi.fn());
      await vi.advanceTimersByTimeAsync(0);
      h.enter("the link shared yesterday", disposition);
      await vi.advanceTimersByTimeAsync(0);
      const url = "chrome-extension://test/find.html?q=the+link+shared+yesterday";
      expect(h.create).toHaveBeenCalledExactlyOnceWith({
        url,
        active: disposition !== "newBackgroundTab",
      });
      expect(h.update).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(300);
      expect(h.suggest).not.toHaveBeenCalled();
    },
  );
  it.each(["a query entered immediately", "https://example.org/another-guide"])(
    "waits for the originating tab lookup on fast Enter: %s",
    async (text) => {
      vi.useFakeTimers();
      const h = harness();
      let finish: ((tabs: chrome.tabs.Tab[]) => void) | undefined;
      h.queryTabs.mockImplementation(
        async () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      h.start();
      h.enter(text);
      await vi.advanceTimersByTimeAsync(0);
      expect(h.create).not.toHaveBeenCalled();
      expect(h.update).not.toHaveBeenCalled();
      finish?.([{ id: 7, windowId: 1 }]);
      await vi.advanceTimersByTimeAsync(0);
      if (text.startsWith("https:")) {
        expect(h.update).toHaveBeenCalledExactlyOnceWith(7, { url: text });
        expect(h.create).not.toHaveBeenCalled();
      } else {
        expect(h.create).toHaveBeenCalledExactlyOnceWith({
          url: "chrome-extension://test/find.html?q=a+query+entered+immediately",
          active: true,
        });
        expect(h.update).not.toHaveBeenCalled();
      }
      expect(h.queryTabs).toHaveBeenCalledExactlyOnceWith({
        active: true,
        lastFocusedWindow: true,
      });
    },
  );
  it("does not navigate a delayed tab lookup after unpair invalidates the request", async () => {
    vi.useFakeTimers();
    const h = harness();
    let finish: ((tabs: chrome.tabs.Tab[]) => void) | undefined;
    h.queryTabs.mockImplementation(
      async () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    h.start();
    h.enter("a query entered immediately");
    await vi.advanceTimersByTimeAsync(0);
    h.controller.clear();
    finish?.([{ id: 7, windowId: 1 }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.update).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
  });
  it("does not overwrite the current tab when fresh gateway verification closes Find", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.start();
    await vi.advanceTimersByTimeAsync(0);
    h.view.enabled = false;
    h.enter("an unavailable query");
    await vi.advanceTimersByTimeAsync(0);
    expect(h.update).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
  });
  it("invalidates an accepted suggestion if unpair clears the session during its authorization recheck", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.suggest.mockResolvedValue([card("first")]);
    h.start();
    await vi.advanceTimersByTimeAsync(0);
    const callback = vi.fn();
    h.change("guide", callback);
    await vi.advanceTimersByTimeAsync(150);
    let finish: ((view: FindView) => void) | undefined;
    h.ensureRead.mockImplementation(
      async () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    h.enter(callback.mock.calls[0]![0][0].content);
    h.controller.clear();
    finish?.(h.view);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.update).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
  });
  it("ignores stale asynchronous replies and cancels previews when keyword input ends", async () => {
    vi.useFakeTimers();
    const h = harness();
    let finish: ((results: FindResult[]) => void) | undefined;
    h.suggest.mockImplementation(
      async () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    h.start();
    await vi.advanceTimersByTimeAsync(0);
    const callback = vi.fn();
    h.change("guide", callback);
    await vi.advanceTimersByTimeAsync(150);
    const signal = h.suggest.mock.calls[0]?.[1];
    h.cancel();
    finish?.([card("late")]);
    await vi.advanceTimersByTimeAsync(0);
    expect(signal?.aborted).toBe(true);
    expect(callback).not.toHaveBeenCalled();
    h.enter("omnesis-result:invented-stale-id");
  });
  it.each(["newForegroundTab", "newBackgroundTab"] as const)(
    "respects suggestion disposition %s",
    async (disposition) => {
      vi.useFakeTimers();
      const h = harness();
      h.suggest.mockResolvedValue([card("first")]);
      h.start();
      await vi.advanceTimersByTimeAsync(0);
      const callback = vi.fn();
      h.change("guide", callback);
      await vi.advanceTimersByTimeAsync(150);
      h.enter(callback.mock.calls[0]![0][0].content, disposition);
      await vi.advanceTimersByTimeAsync(0);
      expect(h.create).toHaveBeenCalledWith(
        disposition === "newBackgroundTab"
          ? { url: "https://example.org/article", active: false }
          : { url: "https://example.org/article", active: true },
      );
      expect(h.update).not.toHaveBeenCalled();
    },
  );
  it("stays inert on incompatible gateways and fences a preview revoked before selection", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.view.enabled = false;
    h.start();
    await vi.advanceTimersByTimeAsync(0);
    h.change("guide", vi.fn());
    await vi.advanceTimersByTimeAsync(150);
    h.enter("guide");
    expect(h.suggest).not.toHaveBeenCalled();
    expect(h.defaultSuggestion).toHaveBeenLastCalledWith({
      description: "<dim>Find is unavailable on this paired gateway</dim>",
    });
    h.view.enabled = true;
    h.suggest.mockResolvedValue([card("first")]);
    h.start();
    await vi.advanceTimersByTimeAsync(0);
    const callback = vi.fn();
    h.change("guide", callback);
    await vi.advanceTimersByTimeAsync(150);
    h.view.enabled = false;
    h.enter(callback.mock.calls[0]![0][0].content);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.create).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
  });
});
