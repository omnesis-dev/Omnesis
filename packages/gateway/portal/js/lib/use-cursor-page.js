// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { useCallback, useEffect, useRef, useState } from "preact/hooks";

const defaultItems = (payload) => payload?.items ?? [];
const defaultCursor = (payload) =>
  payload?.pageInfo?.nextCursor ?? payload?.nextCursor ?? null;

/**
 * Merge one page without duplicating rows already present in the view.
 * Exported so the state transition can be covered without a DOM harness.
 */
export function mergeCursorPageItems(current, incoming, { itemKey, merge = "append" } = {}) {
  const next = Array.isArray(incoming) ? incoming : [];
  if (typeof itemKey !== "function") {
    return merge === "prepend" ? [...next, ...current] : [...current, ...next];
  }
  const seen = new Set(current.map(itemKey));
  const unique = next.filter((item) => {
    const key = itemKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return merge === "prepend" ? [...unique, ...current] : [...current, ...unique];
}

/** Normalise canonical Page<T> and the older root-cursor response shapes. */
export function cursorPageResult(payload, selectItems = defaultItems, selectCursor = defaultCursor) {
  const items = selectItems(payload);
  const nextCursor = selectCursor(payload);
  return {
    items: Array.isArray(items) ? items : [],
    nextCursor:
      typeof nextCursor === "string" && nextCursor.length > 0 ? nextCursor : null,
  };
}

/**
 * Small cursor-page state owner shared by portal list views.
 *
 * `resetKey` must include every server-side filter and ordering input. A
 * generation guard discards an older response when navigation/filter changes
 * while that response is still in flight.
 */
export function useCursorPage({
  resetKey,
  enabled = true,
  pageSize = 50,
  loadPage,
  selectItems = defaultItems,
  selectCursor = defaultCursor,
  selectMeta = () => null,
  mergeMeta = (_previous, next) => next,
  itemKey = (item) => item?.id,
  merge = "append",
}) {
  const [state, setState] = useState({
    items: [],
    meta: null,
    loaded: false,
    loading: false,
    loadingMore: false,
    error: null,
    loadMoreError: null,
    nextCursor: null,
    cursorStalled: false,
  });
  const stateRef = useRef(state);
  stateRef.current = state;
  const generationRef = useRef(0);
  const inFlightRef = useRef(null);
  const removedKeysRef = useRef(new Set());
  // Effects clean up after render. Track the rendered owner separately so a
  // response that settles in that narrow window cannot commit rows belonging
  // to the previous filter/entity.
  const ownerRef = useRef({ enabled, resetKey, pageSize });
  if (
    ownerRef.current.enabled !== enabled ||
    !Object.is(ownerRef.current.resetKey, resetKey) ||
    ownerRef.current.pageSize !== pageSize
  ) {
    ownerRef.current = { enabled, resetKey, pageSize };
    removedKeysRef.current.clear();
  }

  const optionsRef = useRef(null);
  optionsRef.current = {
    loadPage,
    selectItems,
    selectCursor,
    selectMeta,
    mergeMeta,
    itemKey,
    merge,
  };

  const requestPage = useCallback(
    async (reset) => {
      const generation = reset ? ++generationRef.current : generationRef.current;
      if (!reset && inFlightRef.current?.generation === generation) return;

      const cursor = reset ? null : stateRef.current.nextCursor;
      if (!reset && !cursor) return;
      const owner = ownerRef.current;
      const options = optionsRef.current;
      const request = { generation, reset, cursor, owner };
      inFlightRef.current = request;
      setState((previous) => ({
        ...(reset
          ? {
              items: [],
              meta: null,
              loaded: false,
              nextCursor: null,
              cursorStalled: false,
            }
          : previous),
        loading: reset,
        loadingMore: !reset,
        error: reset ? null : previous.error,
        loadMoreError: null,
      }));

      try {
        const payload = await options.loadPage({
          limit: pageSize,
          ...(cursor ? { cursor } : {}),
        });
        if (generation !== generationRef.current || owner !== ownerRef.current) return;

        const page = cursorPageResult(
          payload,
          options.selectItems,
          options.selectCursor,
        );
        const visiblePageItems = page.items.filter((item) => {
          const key = typeof options.itemKey === "function" ? options.itemKey(item) : item;
          return !removedKeysRef.current.has(key);
        });
        const nextMeta = options.selectMeta(payload);
        setState((previous) => {
          const items = reset
            ? visiblePageItems
            : mergeCursorPageItems(previous.items, visiblePageItems, {
                itemKey: options.itemKey,
                merge: options.merge,
              });
          // A buggy endpoint returning the same cursor, or an append page that
          // makes no visible progress, must not create an infinite observer
          // loop. Stop requesting while retaining that the loaded count is
          // partial rather than pretending the collection is exhausted.
          const cursorStalled =
            !reset &&
            page.nextCursor !== null &&
            (page.nextCursor === cursor || items.length === previous.items.length);
          return {
            items,
            meta: reset
              ? nextMeta
              : options.mergeMeta(previous.meta, nextMeta),
            loaded: true,
            loading: false,
            loadingMore: false,
            error: null,
            loadMoreError: null,
            nextCursor: cursorStalled ? null : page.nextCursor,
            cursorStalled,
          };
        });
      } catch (error) {
        if (generation !== generationRef.current || owner !== ownerRef.current) return;
        if (!reset && error?.code === "STALE_PAGE_CURSOR") {
          // Mutable-order keysets intentionally reject an old cursor after a
          // relevant row changes. Restart transparently so a long-lived view
          // converges instead of leaving a permanent pagination error.
          void requestPage(true);
          return;
        }
        setState((previous) => ({
          ...previous,
          loaded: reset ? false : previous.loaded,
          loading: false,
          loadingMore: false,
          error: reset ? error : previous.error,
          loadMoreError: reset ? null : error,
        }));
      } finally {
        if (inFlightRef.current === request) inFlightRef.current = null;
      }
    },
    [pageSize],
  );

  useEffect(() => {
    if (!enabled) {
      generationRef.current += 1;
      inFlightRef.current = null;
      removedKeysRef.current.clear();
      setState({
        items: [],
        meta: null,
        loaded: false,
        loading: false,
        loadingMore: false,
        error: null,
        loadMoreError: null,
        nextCursor: null,
        cursorStalled: false,
      });
      return undefined;
    }
    void requestPage(true);
    return () => {
      generationRef.current += 1;
    };
  }, [enabled, resetKey, requestPage]);

  const reload = useCallback(() => requestPage(true), [requestPage]);
  const loadMore = useCallback(() => requestPage(false), [requestPage]);
  const setItems = useCallback((updater) => {
    setState((previous) => ({
      ...previous,
      items:
        typeof updater === "function" ? updater(previous.items) : updater,
    }));
  }, []);
  const removeItem = useCallback((key) => {
    // A committed local deletion outranks every collection snapshot for this
    // page owner. Keep a tombstone so a late response can still contribute its
    // other rows without restoring the removed one.
    removedKeysRef.current.add(key);
    setState((previous) => ({
      ...previous,
      items: previous.items.filter((item) =>
        typeof optionsRef.current.itemKey === "function"
          ? optionsRef.current.itemKey(item) !== key
          : item !== key,
      ),
    }));
  }, []);
  const restoreItem = useCallback((key, item, index = 0) => {
    removedKeysRef.current.delete(key);
    setState((previous) => {
      const itemKey = optionsRef.current.itemKey;
      const alreadyPresent = previous.items.some((candidate) =>
        typeof itemKey === "function" ? itemKey(candidate) === key : candidate === key,
      );
      if (alreadyPresent) return previous;
      const items = [...previous.items];
      items.splice(Math.max(0, Math.min(index, items.length)), 0, item);
      return { ...previous, items };
    });
  }, []);
  const replaceItem = useCallback(
    (key, replacement) =>
      setItems((items) =>
        items.map((item) =>
          typeof optionsRef.current.itemKey === "function" &&
          optionsRef.current.itemKey(item) === key
            ? typeof replacement === "function"
              ? replacement(item)
              : replacement
            : item,
        ),
      ),
    [setItems],
  );

  return {
    ...state,
    hasMore: state.nextCursor !== null,
    isPartial: state.nextCursor !== null || state.cursorStalled,
    reload,
    loadMore,
    setItems,
    removeItem,
    restoreItem,
    replaceItem,
  };
}
