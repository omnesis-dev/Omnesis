// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Process-level registry of the web hosts owned by *every known source
 * type* — the union of each loaded source definition's `ownedWebDomains`.
 *
 * A source declares `ownedWebDomains` for the public hostnames of the web
 * app whose data it already ingests (`mail.google.com` for Gmail,
 * `web.whatsapp.com` for WhatsApp, …). The browser capture policy serves this
 * union as `ownedDomains`, and a browser skips any visited host already owned
 * by another source, so it doesn't double-ingest a page a dedicated source
 * covers.
 *
 * Pushed by the collector at startup via `POST /admin/owned-web-domains`,
 * derived from every loaded source definition (the collector loads every
 * provider definition regardless of whether the user added it). Re-posting
 * fully replaces the previous list. Same shape and plumbing as
 * `known-url-patterns.ts`.
 *
 * In-memory only — it's data the collector knows authoritatively and
 * re-pushes every boot, so there's nothing to persist. Before the collector
 * pushes, the set is empty and browsers skip nothing extra.
 *
 * No source-specific logic lives here — the gateway treats domains as opaque
 * lowercase host strings. Per-source domain ownership lives in each source
 * package's `ownedWebDomains` on `defineSource(...)`.
 */

import { createLogger } from "@omnesis/core";

const log = createLogger("gateway").child("owned-web-domains");

let domains: ReadonlySet<string> = new Set();

/**
 * Replace the registry with a fresh list of owned web hosts. Entries are
 * trimmed, lowercased, and de-duplicated; empty entries are dropped.
 */
export function setOwnedWebDomains(next: readonly string[]): void {
  const set = new Set<string>();
  for (const raw of next) {
    const d = raw.trim().toLowerCase();
    if (d) set.add(d);
  }
  domains = set;
  log.info(`registered ${set.size} owned web domain(s)`);
}

/** Read the aggregated owned-domain set, sorted for a stable response. */
export function getOwnedWebDomains(): string[] {
  return [...domains].sort();
}

/** Test-only: reset the registry to empty. */
export function resetOwnedWebDomains(): void {
  domains = new Set();
}
