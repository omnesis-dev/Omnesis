// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { useEffect, useRef } from "preact/hooks";

function message(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Normalize the shared `useCursorPage` contract for a paging boundary.
 *
 * Initial loads and initial failures have no cursor yet, but a section which
 * owns either still needs to stay mounted. Initial failures retry the whole
 * page; append failures retain their cursor and retry only that append.
 */
export function cursorPageBoundaryState(page) {
  const initialError = page?.error ?? null;
  const error = page?.loadMoreError ?? initialError;
  const loading = Boolean(page?.loading || page?.loadingMore);
  return {
    visible: Boolean(page?.hasMore || loading || error),
    hasMore: Boolean(page?.hasMore || loading || error),
    loading,
    error,
    onLoadMore: initialError ? page?.reload : page?.loadMore,
  };
}

/**
 * Viewport-triggered pagination sentinel shared by growing portal collections.
 *
 * Each observer owns at most one request. Loading or an error tears it down;
 * a successful page with another cursor renders a fresh observer. Browsers
 * without IntersectionObserver retain an explicit fallback instead of trying
 * to poll or eagerly drain an unbounded collection.
 */
export function LoadMore({
  hasMore,
  loading = false,
  error = null,
  onLoadMore,
  label = "Load more",
  loadingLabel = "Loading…",
  className = "",
}) {
  if (!hasMore && !error) return null;
  const footerClass = `cursor-page-footer${className ? ` ${className}` : ""}`;
  if (error) {
    return html`
      <div class=${footerClass}>
        <div class="cursor-page-error" role="alert">${message(error)}</div>
        ${hasMore
          ? html`
              <button
                type="button"
                class="btn-secondary cursor-page-button"
                aria-label=${`Retry ${label.toLowerCase()}`}
                onClick=${onLoadMore}
              >Retry</button>
            `
          : null}
      </div>
    `;
  }
  if (loading) {
    return html`
      <div class=${footerClass}>
        <div class="cursor-page-loading" role="status" aria-live="polite">
          ${loadingLabel}
        </div>
      </div>
    `;
  }
  if (typeof globalThis.IntersectionObserver !== "function") {
    return html`
      <div class=${footerClass}>
        <button
          type="button"
          class="btn-secondary cursor-page-button"
          aria-label=${label}
          onClick=${onLoadMore}
        >Show more</button>
      </div>
    `;
  }
  return html`
    <${ViewportSentinel}
      onLoadMore=${onLoadMore}
      className=${className}
    />
  `;
}

function ViewportSentinel({ onLoadMore, className }) {
  const sentinelRef = useRef(null);

  useEffect(() => {
    if (!sentinelRef.current) return undefined;
    let active = true;
    let requested = false;
    const observer = new globalThis.IntersectionObserver(
      (entries) => {
        if (!active || requested || !entries.some((entry) => entry.isIntersecting)) return;
        requested = true;
        observer.disconnect();
        onLoadMore?.();
      },
      { rootMargin: "0px 0px 160px 0px" },
    );
    observer.observe(sentinelRef.current);
    return () => {
      active = false;
      observer.takeRecords?.();
      observer.disconnect();
    };
  }, [onLoadMore]);

  return html`
    <div
      ref=${sentinelRef}
      class=${`cursor-page-footer${className ? ` ${className}` : ""}`}
      aria-hidden="true"
    ></div>
  `;
}
