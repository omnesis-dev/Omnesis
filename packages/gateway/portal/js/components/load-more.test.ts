// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// @ts-expect-error — portal modules are plain JS.
import { cursorPageBoundaryState, LoadMore } from "./load-more.js";

interface ObserverEntry {
  isIntersecting: boolean;
}

class MockIntersectionObserver {
  static instances: MockIntersectionObserver[] = [];

  readonly observe = vi.fn();
  readonly disconnect = vi.fn();

  constructor(
    private readonly callback: (entries: ObserverEntry[]) => void,
    readonly options?: IntersectionObserverInit,
  ) {
    MockIntersectionObserver.instances.push(this);
  }

  intersect(isIntersecting = true): void {
    this.callback([{ isIntersecting }]);
  }
}

describe("LoadMore viewport sentinel", () => {
  let host: HTMLElement;
  let originalDocument: typeof globalThis.document | undefined;
  let originalWindow: typeof globalThis.window | undefined;

  beforeEach(() => {
    originalDocument = globalThis.document;
    originalWindow = globalThis.window;
    const parsed = parseHTML("<html><body><main id='root'></main></body></html>");
    Object.assign(globalThis, {
      document: parsed.document,
      window: parsed.window,
      IntersectionObserver: MockIntersectionObserver,
    });
    MockIntersectionObserver.instances = [];
    host = parsed.document.querySelector("#root") as unknown as HTMLElement;
  });

  afterEach(() => {
    render(null, host);
    vi.unstubAllGlobals();
    if (originalDocument === undefined) delete (globalThis as any).document;
    else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete (globalThis as any).window;
    else globalThis.window = originalWindow;
    delete (globalThis as any).IntersectionObserver;
  });

  test("requests exactly once for one visible observer ownership", async () => {
    const onLoadMore = vi.fn();
    await act(async () => {
      render(h(LoadMore, { hasMore: true, onLoadMore, label: "Older rows" }), host);
    });

    expect(host.querySelector("button")).toBeNull();
    expect(MockIntersectionObserver.instances).toHaveLength(1);
    const observer = MockIntersectionObserver.instances[0]!;
    expect(observer.observe).toHaveBeenCalledOnce();
    expect(observer.options).toEqual({ rootMargin: "0px 0px 160px 0px" });

    observer.intersect(false);
    observer.intersect();
    observer.intersect();

    expect(onLoadMore).toHaveBeenCalledOnce();
    expect(observer.disconnect).toHaveBeenCalled();
  });

  test("disconnects while loading and observes the next page after loading settles", async () => {
    const onLoadMore = vi.fn();
    await act(async () => {
      render(h(LoadMore, { hasMore: true, loading: false, onLoadMore }), host);
    });
    const first = MockIntersectionObserver.instances[0]!;

    await act(async () => {
      render(h(LoadMore, { hasMore: true, loading: true, onLoadMore }), host);
    });
    expect(first.disconnect).toHaveBeenCalled();
    expect(host.textContent).toContain("Loading…");

    await act(async () => {
      render(h(LoadMore, { hasMore: true, loading: false, onLoadMore }), host);
    });
    expect(MockIntersectionObserver.instances).toHaveLength(2);
  });

  test("pauses automatic loading after an error and exposes only Retry", async () => {
    const onLoadMore = vi.fn();
    await act(async () => {
      render(
        h(LoadMore, {
          hasMore: true,
          error: new Error("request timed out"),
          onLoadMore,
          label: "Load more inbound references",
        }),
        host,
      );
    });

    expect(MockIntersectionObserver.instances).toHaveLength(0);
    const button = host.querySelector("button") as HTMLButtonElement;
    expect(button.textContent).toBe("Retry");
    expect(button.getAttribute("aria-label")).toBe("Retry load more inbound references");
    button.click();
    expect(onLoadMore).toHaveBeenCalledOnce();
  });

  test("falls back to an explicit control when IntersectionObserver is unavailable", async () => {
    delete (globalThis as any).IntersectionObserver;
    const onLoadMore = vi.fn();
    await act(async () => {
      render(h(LoadMore, { hasMore: true, onLoadMore, label: "Older rows" }), host);
    });

    expect(onLoadMore).not.toHaveBeenCalled();
    const button = host.querySelector("button") as HTMLButtonElement;
    expect(button.textContent).toBe("Show more");
    expect(button.getAttribute("aria-label")).toBe("Older rows");
    button.click();
    expect(onLoadMore).toHaveBeenCalledOnce();
  });

  test("disconnects and ignores a queued intersection when the sentinel unmounts", async () => {
    const onLoadMore = vi.fn();
    await act(async () => {
      render(h(LoadMore, { hasMore: true, onLoadMore }), host);
    });
    const observer = MockIntersectionObserver.instances[0]!;

    await act(async () => {
      render(null, host);
    });
    expect(observer.disconnect).toHaveBeenCalled();

    observer.intersect();
    expect(onLoadMore).not.toHaveBeenCalled();
  });
});

describe("cursorPageBoundaryState", () => {
  test("keeps initial loading and failure states mounted and routes retry to reload", () => {
    const reload = vi.fn();
    const loadMore = vi.fn();
    const loading = cursorPageBoundaryState({
      loading: true,
      loadingMore: false,
      hasMore: false,
      error: null,
      loadMoreError: null,
      reload,
      loadMore,
    });
    expect(loading).toMatchObject({
      visible: true,
      hasMore: true,
      loading: true,
      error: null,
    });

    const initialError = new Error("first page unavailable");
    const failed = cursorPageBoundaryState({
      loading: false,
      loadingMore: false,
      hasMore: false,
      error: initialError,
      loadMoreError: null,
      reload,
      loadMore,
    });
    expect(failed).toMatchObject({
      visible: true,
      hasMore: true,
      loading: false,
      error: initialError,
      onLoadMore: reload,
    });
  });

  test("routes an append failure to loadMore without losing the cursor", () => {
    const reload = vi.fn();
    const loadMore = vi.fn();
    const appendError = new Error("later page unavailable");
    expect(
      cursorPageBoundaryState({
        loading: false,
        loadingMore: false,
        hasMore: true,
        error: null,
        loadMoreError: appendError,
        reload,
        loadMore,
      }),
    ).toMatchObject({
      visible: true,
      hasMore: true,
      error: appendError,
      onLoadMore: loadMore,
    });
  });
});
