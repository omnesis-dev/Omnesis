// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { useState, useEffect } from "preact/hooks";

/**
 * Lazy view loader. Returns a component that renders a placeholder until its
 * module + named export resolves, then renders the real component with the
 * provided props. A loader that rejects logs and leaves the placeholder up.
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
  return function LazyView(props) {
    const [Comp, setComp] = useState(() => cached);
    useEffect(() => {
      if (cached) return;
      if (!pending) pending = loader();
      let cancelled = false;
      pending.then((c) => {
        cached = c;
        if (!cancelled) setComp(() => c);
      }).catch((err) => {
        if (!cancelled) {
          console.error("portal: failed to load view module", err);
        }
      });
      return () => { cancelled = true; };
    }, []);
    if (!Comp) {
      return html`<div class="lazy-view-loading">Loading…</div>`;
    }
    return html`<${Comp} ...${props} />`;
  };
}
