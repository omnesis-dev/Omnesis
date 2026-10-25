// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { expect, it, vi } from "vitest";
// @ts-expect-error Portal module is plain JavaScript.
import { observeKnowledgeBoundary } from "./knowledge-infinite-scroll.js";

function fixture(root: object | null = null) {
  let emit: (entries: Array<{ isIntersecting: boolean }>) => void = () => {};
  let options: { root: object | null; rootMargin: string };
  const disconnect = vi.fn(), observe = vi.fn();
  class Observer {
    constructor(callback: typeof emit, supplied: typeof options) { emit = callback; options = supplied; }
    observe = observe;
    disconnect = disconnect;
  }
  const page = { hasMore: true, loading: false, loadingMore: false, error: null as unknown, loadMoreError: null as unknown, loadMore: vi.fn() };
  const cleanup = observeKnowledgeBoundary({ target: {}, root, current: () => page, Observer });
  return { page, cleanup, disconnect, enter: (visible: boolean) => emit([{ isIntersecting: visible }]), options: () => options };
}
it("uses the actual scroll root and admits only once while an always-visible boundary remains visible", () => {
  const root = {}, f = fixture(root);
  expect(f.options()).toEqual({ root, rootMargin: "0px 0px 100px 0px" });
  f.enter(true); f.enter(true); f.enter(true);
  expect(f.page.loadMore).toHaveBeenCalledTimes(1);
  f.enter(false); f.enter(true);
  expect(f.page.loadMore).toHaveBeenCalledTimes(2);
  f.cleanup(); f.enter(false); f.enter(true);
  expect(f.page.loadMore).toHaveBeenCalledTimes(2);
  expect(f.disconnect).toHaveBeenCalledOnce();
});
it("uses the viewport on mobile, skips busy/error/exhausted pages, and reads current state without remount", () => {
  const f = fixture();
  expect(f.options().root).toBeNull();
  for (const key of ["loading", "loadingMore", "error", "loadMoreError"] as const) {
    f.page[key] = true; f.enter(false); f.enter(true); f.page[key] = false;
  }
  f.page.hasMore = false; f.enter(false); f.enter(true);
  expect(f.page.loadMore).not.toHaveBeenCalled();
  f.page.hasMore = true; f.enter(false); f.enter(true);
  expect(f.page.loadMore).toHaveBeenCalledOnce();
});
