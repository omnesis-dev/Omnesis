// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// The developer-annotation open channel. One composer is mounted in the app
// shell (`DevAnnotationComposer`); every trigger — the global floating ⚑ FAB
// and the per-item ⚑ buttons on the cognition debug page — asks it to open by
// dispatching this event with an explicit target. Decoupling the triggers from
// the composer this way keeps a single composer while letting any view attach
// an annotate affordance to a specific entity. A `route` / `agent_notes`
// target may carry a null `targetId`.

const OPEN_EVENT = "omnesis:dev-annotate";

/**
 * Open the developer-annotation composer for `target`
 * (`{ targetType, targetId, label, deepLink }`).
 */
export function openDevAnnotation(target) {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: { target } }));
}

/**
 * Subscribe the composer to open requests. Returns an unsubscribe fn.
 * `handler` receives the requested target.
 */
export function onDevAnnotateRequest(handler) {
  const listener = (e) => handler(e.detail?.target);
  window.addEventListener(OPEN_EVENT, listener);
  return () => window.removeEventListener(OPEN_EVENT, listener);
}

/**
 * Build the `context` snapshot for a developer annotation filed from the
 * portal. Besides the human label it carries the filing platform and the
 * browser's user-agent string — the portal ships as static files with no app
 * version of its own, so the user agent is the identifying metadata the
 * engineer gets (mirroring the mobile clients' `platform` +
 * `appVersion`/`appBuild`). Kept pure (the `navigator` read is guarded) so it
 * is unit testable outside a browser.
 */
export function devAnnotationContext(label) {
  const context = { platform: "portal" };
  if (label) context.label = label;
  const userAgent =
    typeof navigator !== "undefined" && typeof navigator.userAgent === "string"
      ? navigator.userAgent
      : null;
  if (userAgent) context.userAgent = userAgent;
  return context;
}
