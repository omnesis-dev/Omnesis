// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// A waiting item stops waiting when its time runs out, and the gateway does
// not signal that: a list of waiting items re-reads itself at the moment its
// first item expires.

import { useEffect, useRef } from "preact/hooks";

/** Past an expiry, so the gateway has stopped listing the item when it is read again. */
const EXPIRY_SLACK_MS = 500;
/** The longest delay `setTimeout` keeps; a later expiry is caught by a fallback read anyway. */
const MAX_TIMER_MS = 2 ** 31 - 1;

const toMs = (value) => (typeof value === "number" ? value : new Date(value).getTime());

/**
 * The soonest `expiresAt` after `now` among `items` (epoch ms or ISO string), in epoch ms, or
 * null. One already past by this browser's clock is left to the fallback read, so a clock ahead
 * of the gateway's cannot spin.
 */
export function earliestExpiry(items, now = Date.now()) {
  let soonest = null;
  for (const item of items ?? []) {
    const at = toMs(item?.expiresAt);
    if (Number.isFinite(at) && at > now && (soonest === null || at < soonest)) soonest = at;
  }
  return soonest;
}

/** Whether `item` still waits by its `expiresAt` (epoch ms or ISO string). */
export function notExpired(item, now = Date.now()) {
  return toMs(item?.expiresAt) > now;
}

/** Calls `refresh()` just after `at` (epoch ms); nothing while `at` is null. */
export function useRefreshAt(at, refresh) {
  const callback = useRef(refresh);
  callback.current = refresh;
  useEffect(() => {
    if (at === null || at === undefined) return undefined;
    const delay = Math.min(MAX_TIMER_MS, Math.max(0, at - Date.now()) + EXPIRY_SLACK_MS);
    const timer = setTimeout(() => callback.current(), delay);
    return () => clearTimeout(timer);
  }, [at]);
}
