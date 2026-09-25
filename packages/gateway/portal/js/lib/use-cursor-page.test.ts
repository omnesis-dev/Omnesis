// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// @ts-expect-error — portal modules are plain JS.
import { cursorPageResult, mergeCursorPageItems, useCursorPage } from "./use-cursor-page.js";

describe("cursor page helpers", () => {
  test("normalises canonical and root-cursor response shapes", () => {
    expect(
      cursorPageResult({
        items: [{ id: "a" }],
        pageInfo: { nextCursor: "canonical" },
      }),
    ).toEqual({ items: [{ id: "a" }], nextCursor: "canonical" });
    expect(
      cursorPageResult({ rows: [1], nextCursor: "legacy" }, (value: any) => value.rows),
    ).toEqual({ items: [1], nextCursor: "legacy" });
    expect(cursorPageResult({ items: [], pageInfo: {} })).toEqual({
      items: [],
      nextCursor: null,
    });
  });

  test("appends while de-duplicating stable ids", () => {
    expect(
      mergeCursorPageItems(
        [{ id: "a" }, { id: "b" }],
        [{ id: "b" }, { id: "c" }],
        { itemKey: (item: any) => item.id },
      ).map((item: any) => item.id),
    ).toEqual(["a", "b", "c"]);
  });

  test("prepends chronological history without duplicating the boundary", () => {
    expect(
      mergeCursorPageItems(
        [{ id: "m3" }, { id: "m4" }],
        [{ id: "m1" }, { id: "m2" }, { id: "m3" }],
        { itemKey: (item: any) => item.id, merge: "prepend" },
      ).map((item: any) => item.id),
    ).toEqual(["m1", "m2", "m3", "m4"]);
  });

  test("supports rows without stable ids", () => {
    expect(
      mergeCursorPageItems([[3]], [[1], [2]], {
        itemKey: null,
        merge: "prepend",
      }),
    ).toEqual([[1], [2], [3]]);
  });
});

describe("useCursorPage mounted request ownership", () => {
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
    });
    host = parsed.document.querySelector("#root") as unknown as HTMLElement;
  });

  afterEach(() => {
    render(null, host);
    if (originalDocument === undefined) delete (globalThis as any).document;
    else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete (globalThis as any).window;
    else globalThis.window = originalWindow;
  });

  test("ignores a stale response after resetKey changes", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const loadPage = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    let page: ReturnType<typeof useCursorPage> | undefined;
    const Harness = ({ resetKey }: { resetKey: string }) => {
      page = useCursorPage({ resetKey, loadPage });
      return null;
    };

    await act(async () => {
      render(h(Harness, { resetKey: "first" }), host);
    });
    await act(async () => {
      render(h(Harness, { resetKey: "second" }), host);
    });
    expect(loadPage).toHaveBeenCalledTimes(2);

    await act(async () => {
      second.resolve({ items: [{ id: "current" }], nextCursor: null });
      await second.promise;
    });
    expect(page?.items).toEqual([{ id: "current" }]);

    await act(async () => {
      first.resolve({ items: [{ id: "stale" }], nextCursor: "stale-cursor" });
      await first.promise;
    });
    expect(page?.items).toEqual([{ id: "current" }]);
    expect(page?.nextCursor).toBeNull();
  });

  test("does not restore a removed item from an older collection response", async () => {
    const initial = deferred<unknown>();
    const staleNextPage = deferred<unknown>();
    const loadPage = vi
      .fn()
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(staleNextPage.promise);
    let page: ReturnType<typeof useCursorPage> | undefined;
    const Harness = () => {
      page = useCursorPage({ resetKey: "stable", loadPage });
      return null;
    };

    await act(async () => {
      render(h(Harness, {}), host);
    });
    await act(async () => {
      initial.resolve({
        items: [{ id: "keep" }, { id: "delete" }],
        nextCursor: "page-2",
      });
      await initial.promise;
    });

    await act(async () => {
      void page?.loadMore();
    });
    await act(async () => {
      page?.removeItem("delete");
    });
    expect(page?.items).toEqual([{ id: "keep" }]);

    await act(async () => {
      staleNextPage.resolve({ items: [{ id: "delete" }, { id: "later" }], nextCursor: null });
      await staleNextPage.promise;
    });

    expect(page?.items).toEqual([{ id: "keep" }, { id: "later" }]);
    expect(page?.nextCursor).toBeNull();
  });

  test("keeps other rows from a reset that started before an item was removed", async () => {
    const initial = deferred<unknown>();
    const staleReset = deferred<unknown>();
    const loadPage = vi
      .fn()
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(staleReset.promise);
    let page: ReturnType<typeof useCursorPage> | undefined;
    const Harness = () => {
      page = useCursorPage({ resetKey: "stable", loadPage });
      return null;
    };

    await act(async () => {
      render(h(Harness, {}), host);
    });
    await act(async () => {
      initial.resolve({ items: [{ id: "keep" }, { id: "delete" }], nextCursor: null });
      await initial.promise;
    });

    await act(async () => {
      void page?.reload();
    });
    await act(async () => {
      page?.removeItem("delete");
    });

    await act(async () => {
      staleReset.resolve({ items: [{ id: "keep" }, { id: "delete" }], nextCursor: null });
      await staleReset.promise;
    });

    expect(page?.items).toEqual([{ id: "keep" }]);
    expect(page?.loaded).toBe(true);
    expect(page?.loading).toBe(false);
  });

  test("restores a removed item locally after a failed mutation", async () => {
    const initial = deferred<unknown>();
    const loadPage = vi.fn().mockReturnValueOnce(initial.promise);
    let page: ReturnType<typeof useCursorPage> | undefined;
    const Harness = () => {
      page = useCursorPage({ resetKey: "stable", loadPage });
      return null;
    };

    await act(async () => {
      render(h(Harness, {}), host);
    });
    await act(async () => {
      initial.resolve({ items: [{ id: "keep" }, { id: "restore" }], nextCursor: null });
      await initial.promise;
    });
    await act(async () => {
      page?.removeItem("restore");
    });
    expect(page?.items).toEqual([{ id: "keep" }]);

    await act(async () => {
      page?.restoreItem("restore", { id: "restore" }, 1);
    });

    expect(page?.items).toEqual([{ id: "keep" }, { id: "restore" }]);
    expect(loadPage).toHaveBeenCalledOnce();
  });

  test("coalesces duplicate mounted load-more requests", async () => {
    const initial = deferred<unknown>();
    const more = deferred<unknown>();
    const loadPage = vi
      .fn()
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(more.promise);
    let page: ReturnType<typeof useCursorPage> | undefined;
    const Harness = () => {
      page = useCursorPage({ resetKey: "stable", loadPage });
      return null;
    };

    await act(async () => {
      render(h(Harness, {}), host);
    });
    await act(async () => {
      initial.resolve({ items: [{ id: "first" }], nextCursor: "page-2" });
      await initial.promise;
    });
    expect(page?.hasMore).toBe(true);

    await act(async () => {
      void page?.loadMore();
      void page?.loadMore();
    });
    expect(loadPage).toHaveBeenCalledTimes(2);

    await act(async () => {
      more.resolve({ items: [{ id: "second" }], nextCursor: null });
      await more.promise;
    });
    expect(page?.items).toEqual([{ id: "first" }, { id: "second" }]);
    expect(page?.isPartial).toBe(false);
  });

  test("stops a repeated cursor without presenting the loaded count as exact", async () => {
    const initial = deferred<unknown>();
    const more = deferred<unknown>();
    const loadPage = vi
      .fn()
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(more.promise);
    let page: ReturnType<typeof useCursorPage> | undefined;
    const Harness = () => {
      page = useCursorPage({ resetKey: "stable", loadPage });
      return null;
    };

    await act(async () => {
      render(h(Harness, {}), host);
    });
    await act(async () => {
      initial.resolve({ items: [{ id: "first" }], nextCursor: "page-2" });
      await initial.promise;
    });
    await act(async () => {
      const request = page?.loadMore();
      more.resolve({ items: [{ id: "second" }], nextCursor: "page-2" });
      await request;
    });

    expect(page?.items).toEqual([{ id: "first" }, { id: "second" }]);
    expect(page?.hasMore).toBe(false);
    expect(page?.cursorStalled).toBe(true);
    expect(page?.isPartial).toBe(true);
  });

  test("stops a duplicate-only page without presenting the loaded count as exact", async () => {
    const initial = deferred<unknown>();
    const more = deferred<unknown>();
    const loadPage = vi
      .fn()
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(more.promise);
    let page: ReturnType<typeof useCursorPage> | undefined;
    const Harness = () => {
      page = useCursorPage({ resetKey: "stable", loadPage });
      return null;
    };

    await act(async () => {
      render(h(Harness, {}), host);
    });
    await act(async () => {
      initial.resolve({ items: [{ id: "first" }], nextCursor: "page-2" });
      await initial.promise;
    });
    await act(async () => {
      const request = page?.loadMore();
      more.resolve({ items: [{ id: "first" }], nextCursor: "page-3" });
      await request;
    });

    expect(page?.items).toEqual([{ id: "first" }]);
    expect(page?.hasMore).toBe(false);
    expect(page?.cursorStalled).toBe(true);
    expect(page?.isPartial).toBe(true);
  });

  test("keeps loaded rows and the cursor retryable after a next-page error", async () => {
    const timedOut = new Error("request timed out");
    const initial = deferred<unknown>();
    const loadPage = vi
      .fn()
      .mockReturnValueOnce(initial.promise)
      .mockRejectedValueOnce(timedOut)
      .mockResolvedValueOnce({
        items: [{ id: "second" }],
        nextCursor: null,
      });
    let page: ReturnType<typeof useCursorPage> | undefined;
    const Harness = () => {
      page = useCursorPage({ resetKey: "person-documents:person-1", loadPage });
      return null;
    };

    await act(async () => {
      render(h(Harness, {}), host);
    });
    await act(async () => {
      initial.resolve({
        items: [{ id: "first" }],
        nextCursor: "page-2",
      });
      await initial.promise;
    });
    await act(async () => {
      await page?.loadMore();
    });

    expect(page?.items).toEqual([{ id: "first" }]);
    expect(page?.nextCursor).toBe("page-2");
    expect(page?.loadMoreError).toBe(timedOut);
    expect(page?.hasMore).toBe(true);

    await act(async () => {
      await page?.loadMore();
    });

    expect(loadPage.mock.calls[1][0]).toEqual({ limit: 50, cursor: "page-2" });
    expect(loadPage.mock.calls[2][0]).toEqual({ limit: 50, cursor: "page-2" });
    expect(page?.items).toEqual([{ id: "first" }, { id: "second" }]);
    expect(page?.loadMoreError).toBeNull();
  });

  test("restarts from page one when a mutable-order cursor becomes stale", async () => {
    const stale = Object.assign(new Error("stale"), { code: "STALE_PAGE_CURSOR" });
    const initial = deferred<unknown>();
    const refreshed = deferred<unknown>();
    const loadPage = vi
      .fn()
      .mockReturnValueOnce(initial.promise)
      .mockRejectedValueOnce(stale)
      .mockReturnValueOnce(refreshed.promise);
    let page: ReturnType<typeof useCursorPage> | undefined;
    const Harness = () => {
      page = useCursorPage({ resetKey: "stable", loadPage });
      return null;
    };

    await act(async () => {
      render(h(Harness, {}), host);
    });
    await act(async () => {
      initial.resolve({ items: [{ id: "old-first" }], nextCursor: "page-2" });
      await initial.promise;
    });
    expect(page?.items).toEqual([{ id: "old-first" }]);

    await act(async () => {
      await page?.loadMore();
    });
    await act(async () => {
      refreshed.resolve({ items: [{ id: "new-first" }], nextCursor: null });
      await refreshed.promise;
    });

    expect(loadPage).toHaveBeenCalledTimes(3);
    expect(loadPage.mock.calls[1][0]).toEqual({ limit: 50, cursor: "page-2" });
    expect(loadPage.mock.calls[2][0]).toEqual({ limit: 50 });
    expect(page?.items).toEqual([{ id: "new-first" }]);
    expect(page?.loadMoreError).toBeNull();
  });
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
