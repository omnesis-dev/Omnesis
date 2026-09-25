// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Visibility-aware polling hook. Six views (sources, devices, models,
// triggers, debug × 3) used to spin their own `setInterval` loops that
// kept ticking while the tab was hidden — wasting cycles, hammering the
// gateway, and keeping the writer worker warm for nothing.
//
// Centralising the pattern here also gives us one place to add backoff,
// jitter, error-pause behaviour later (currently none — caller logs).
import { useEffect, useRef } from "preact/hooks";

/**
 * Run `fn` on an interval, paused while the document is hidden
 * (`visibilitychange`). On resume, fires `fn` immediately so the user
 * sees fresh data on tab focus rather than waiting for the next tick.
 *
 * Pass `enabled: false` to suspend without unmounting (e.g. only poll
 * while a model download is in flight).
 *
 * The latest `fn` is captured via a ref so callers don't have to memoise
 * — the effect re-binds only on `intervalMs` / `enabled` changes.
 */
export function useVisiblePoll(fn, intervalMs, { enabled = true } = {}) {
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    if (!enabled || intervalMs <= 0) return undefined;
    let timer = null;
    let alive = true;

    const tick = () => {
      if (!alive) return;
      try {
        fnRef.current();
      } catch {
        // Swallow — the caller's fn already owns its error reporting
        // (typically setError(...)). Letting it throw would tear down
        // the whole interval.
      }
    };

    const start = () => {
      if (timer != null) return;
      timer = setInterval(tick, intervalMs);
    };
    const stop = () => {
      if (timer == null) return;
      clearInterval(timer);
      timer = null;
    };

    const onVisibility = () => {
      if (document.hidden) {
        stop();
      } else {
        // Fire once immediately on resume so the user doesn't stare at
        // a stale snapshot for up to `intervalMs`.
        tick();
        start();
      }
    };

    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      alive = false;
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [intervalMs, enabled]);
}
