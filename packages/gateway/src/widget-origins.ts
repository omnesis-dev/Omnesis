// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Process-level registry of the external widget-vendor origins declared by
 * *every known source type* — the union of each loaded source descriptor's
 * `widgetOrigins`.
 *
 * A `link-widget` source (Plaid Link, SnapTrade Connect, Yodlee FastLink, …)
 * loads its vendor's SDK from the vendor's CDN and opens a vendor-hosted
 * iframe; neither can be self-hosted/vendored the way the portal's own assets
 * are. The portal serves a deliberately strict, zero-external-load Content-
 * Security-Policy, so without an explicit allow-list the SDK and iframe are
 * blocked and the widget can never open in the browser. This registry is that
 * allow-list: `buildPortalCsp` reads the aggregated origins and adds them to
 * the portal CSP's `script-src` / `frame-src` / `connect-src`.
 *
 * Pushed by the collector at startup via `POST /admin/widget-origins`, derived
 * from every loaded source descriptor (the collector loads every provider
 * definition regardless of whether the user added it). Re-posting fully
 * replaces the previous set. Same shape and plumbing as `owned-web-domains.ts`.
 *
 * In-memory only — it's data the collector knows authoritatively and re-pushes
 * every boot, so there's nothing to persist. Before the collector pushes, the
 * set is empty and the portal CSP stays strictly self-hosted.
 *
 * No source-specific logic lives here — the gateway treats every entry as an
 * opaque CSP source expression. Per-source widget-origin knowledge lives in
 * each source package's `widgetOrigins` on `defineSource`/`defineProvider`.
 */

import { createLogger } from "@omnesis/core";

const log = createLogger("gateway").child("widget-origins");

/** Aggregated origins per CSP fetch directive. */
export interface AggregatedWidgetOrigins {
  /** Origins to add to `script-src`. */
  script: string[];
  /** Origins to add to `frame-src`. */
  frame: string[];
  /** Origins to add to `connect-src`. */
  connect: string[];
}

const EMPTY: AggregatedWidgetOrigins = Object.freeze({
  script: Object.freeze([]) as unknown as string[],
  frame: Object.freeze([]) as unknown as string[],
  connect: Object.freeze([]) as unknown as string[],
});

let origins: AggregatedWidgetOrigins = EMPTY;

function dedupeSorted(values: readonly string[]): string[] {
  const set = new Set<string>();
  for (const raw of values) {
    const v = raw.trim();
    if (v) set.add(v);
  }
  return [...set].sort();
}

/**
 * Replace the registry with a fresh aggregate. Entries are trimmed,
 * de-duplicated, and sorted per directive; empty entries are dropped. The
 * collector POSTs the full union every boot, so a missing entry means "no
 * loaded source declares that origin".
 */
export function setWidgetOrigins(next: Partial<AggregatedWidgetOrigins>): void {
  origins = {
    script: dedupeSorted(next.script ?? []),
    frame: dedupeSorted(next.frame ?? []),
    connect: dedupeSorted(next.connect ?? []),
  };
  log.info(
    `registered widget origins: ${origins.script.length} script, ${origins.frame.length} frame, ${origins.connect.length} connect`,
  );
}

/** Read the aggregated widget-origin allow-list. */
export function getWidgetOrigins(): AggregatedWidgetOrigins {
  return origins;
}

/** Test-only: reset the registry to empty. */
export function resetWidgetOrigins(): void {
  origins = EMPTY;
}
