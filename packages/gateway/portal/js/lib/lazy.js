// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { useState, useEffect } from "preact/hooks";

/**
 * Lazy view loader. Returns a component that renders a placeholder until its
 * module + named export resolves, then renders the real component with the
 * provided props. A failed import shows a reload action: browsers can retain
 * a failed module in the current document, so retrying its URL may fail again.
 *
 * Module + resolution are cached in the closure and shared across mounts, so
 * re-navigating to the same view doesn't re-fetch.
 *
 * Manual implementation rather than `preact/compat`'s `lazy()` to avoid
 * pulling compat (~5KB) for ~20 lines the portal can own itself.
 *
 * `loader` is `() => import("…")` then `.then((m) => m.NamedExport)`.
 */
export function lazy(loader) {
  let cached = null;
  let pending = null;
  let failed = false;
  return function LazyView(props) {
    const [Comp, setComp] = useState(() => cached);
    const [failure, setFailure] = useState(() => failed);
    useEffect(() => {
      if (cached || failed) return;
      if (!pending) {
        try { pending = loader(); }
        catch (error) { pending = Promise.reject(error); }
      }
      let cancelled = false;
      pending.then((c) => {
        cached = c;
        if (!cancelled) setComp(() => c);
      }).catch(() => {
        failed = true;
        if (!cancelled) setFailure(true);
      });
      return () => { cancelled = true; };
    }, []);
    if (failure) {
      return html`<div class="error-card" role="alert">
        <h2>Couldn't load this page</h2>
        <p>Check your connection and reload the page to try again.</p>
        <button type="button" class="btn-secondary" onClick=${() => location.reload()}>Reload</button>
      </div>`;
    }
    if (!Comp) {
      return html`<div class="lazy-view-loading">Loading…</div>`;
    }
    return html`<${Comp} ...${props} />`;
  };
}
