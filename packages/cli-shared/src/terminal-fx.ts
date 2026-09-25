// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  imagesSupported,
  hyperlinksSupported,
  inlineImage,
  hyperlink,
  parseSourceKey,
} from "@omnesis/core";
import type { SourceMeta as CanonicalSourceMeta, SourceMetaEntry } from "@omnesis/source-sdk";

/**
 * Re-export of the canonical {@link CanonicalSourceMeta} type defined
 * in `@omnesis/core/source-meta.ts`. The CLI side previously declared
 * its own loose union (`{ icon?, label? } | string | undefined`) for
 * back-compat with a long-gone shape; the gateway has emitted the
 * strict object form for releases. Tightening it here means a future
 * server-side change to `getSourceMeta` propagates as a compile error
 * instead of a silent shape drift.
 */
export type SourceMeta = CanonicalSourceMeta;

export interface CliFx {
  images: boolean;
  hyperlinks: boolean;
  meta: SourceMeta;
}

export type FetchSourceMeta = () => Promise<SourceMeta>;

/**
 * A reusable, caller-owned cache for the gateway's per-source metadata.
 * Module-level singletons looked clean but were a testing hazard — there
 * was no way to reset between gateways or between unit tests. Each CLI
 * (production or test) instantiates one cache via `makeSourceMetaCache()`
 * and threads it through the calls that need it.
 */
export interface SourceMetaCache {
  /** Drop the cached value. The next `get()` re-fetches. */
  clear(): void;
  /**
   * Return the cached metadata, or fetch + cache it on first call.
   * Never throws — on fetch error the cache settles to `{}` so the
   * CLI degrades to no-icon mode rather than crashing.
   */
  get(fetcher: () => Promise<Response>): Promise<SourceMeta>;
}

export function makeSourceMetaCache(): SourceMetaCache {
  let cache: SourceMeta | null = null;
  return {
    clear() {
      cache = null;
    },
    async get(fetcher) {
      if (cache) return cache;
      try {
        const res = await fetcher();
        cache = res.ok ? ((await res.json()) as SourceMeta) : {};
      } catch {
        cache = {};
      }
      return cache;
    },
  };
}

export async function buildCliFx(opts: {
  fetchMeta: FetchSourceMeta;
  disabled?: boolean;
}): Promise<CliFx> {
  if (opts.disabled) return { images: false, hyperlinks: false, meta: {} };
  const images = imagesSupported();
  const hyperlinks = hyperlinksSupported();
  const meta = images ? await opts.fetchMeta() : {};
  return { images, hyperlinks, meta };
}

function normalizeMetaEntry(entry: SourceMetaEntry | undefined): SourceMetaEntry {
  return entry ?? {};
}

export function iconFor(sourceId: string, fx: CliFx): string {
  if (!fx.images) return "";
  const type = sourceId ? parseSourceKey(sourceId).sourceType : "";
  const icon = normalizeMetaEntry(fx.meta[sourceId]).icon ?? normalizeMetaEntry(fx.meta[type]).icon;
  if (!icon) return "  ";
  // Post-rasterization the gateway ships every icon as a `data:image/...;base64,…`
  // URI. iTerm2's OSC 1337 inline-image sequence wants the raw base64 only —
  // it can't follow URLs and it can't handle the `data:` prefix. Strip the
  // header here. Hosted URLs (rare — should only appear if rasterization
  // failed gracefully) get a blank slot to avoid emitting garbage bytes.
  const base64 = extractBase64(icon);
  if (!base64) return "  ";
  return inlineImage(base64, {
    enabled: true,
    widthCells: 2,
    heightCells: 1,
  });
}

function extractBase64(icon: string): string | null {
  if (icon.startsWith("data:")) {
    const comma = icon.indexOf(",");
    if (comma < 0) return null;
    if (!icon.slice(0, comma).includes(";base64")) return null;
    return icon.slice(comma + 1);
  }
  if (icon.startsWith("http://") || icon.startsWith("https://")) return null;
  // Legacy bare-base64 — pass through unchanged.
  return icon;
}

export function linkify(text: string, url: string, fx: CliFx): string {
  return hyperlink(text, url, { enabled: fx.hyperlinks });
}
