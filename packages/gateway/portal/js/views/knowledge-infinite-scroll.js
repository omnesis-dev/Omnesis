// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { html } from "htm/preact";
import { useEffect, useRef } from "preact/hooks";

/** A visible boundary must leave and re-enter before another admission. */
export function observeKnowledgeBoundary({ target, root, current, Observer = globalThis.IntersectionObserver }) {
  if (typeof Observer !== "function") return () => {};
  let active = true, visible = false;
  const observer = new Observer((entries) => {
    if (!active) return;
    const entry = entries.at(-1);
    if (!entry) return;
    const entered = entry.isIntersecting && !visible;
    visible = entry.isIntersecting;
    const page = current();
    if (entered && page.hasMore && !page.loading && !page.loadingMore && !page.error && !page.loadMoreError) void page.loadMore();
  }, { root, rootMargin: "0px 0px 100px 0px" });
  observer.observe(target);
  return () => { active = false; observer.disconnect(); };
}

export function KnowledgeInfiniteScroll({ page, listRef, resetKey }) {
  const targetRef = useRef(null), currentRef = useRef(page);
  currentRef.current = page;
  useEffect(() => {
    if (!page.loaded || !targetRef.current) return undefined;
    let cleanup = () => {};
    const connect = () => {
      cleanup();
      const list = listRef.current;
      const root = list && getComputedStyle(list).overflowY === "auto" ? list : null;
      cleanup = observeKnowledgeBoundary({ target: targetRef.current, root, current: () => currentRef.current });
    };
    connect();
    window.addEventListener("resize", connect);
    return () => { cleanup(); window.removeEventListener("resize", connect); };
  }, [page.loaded, resetKey]);
  return html`<div ref=${targetRef} class="kn-page-boundary">
    ${page.loadingMore && html`<p role="status">Loading more pages…</p>`}
    ${page.loadMoreError && (page.loadMoreError.code === "STALE_PAGE_CURSOR"
      ? html`<p role="status">Library changed. Refresh to continue browsing.</p><button class="kn-button" onClick=${page.reload}>Refresh library</button>`
      : html`<p role="alert">More pages could not be loaded.</p><button class="kn-button" onClick=${page.loadMore}>Retry loading pages</button>`)}
    ${page.cursorStalled && html`<p role="status">Additional pages could not be advanced. Refresh to try again.</p>`}
  </div>`;
}
