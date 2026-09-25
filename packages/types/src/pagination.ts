// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Canonical pagination envelope used by every gateway list endpoint.
 * Lives in `@omnesis/types` (re-exported by `@omnesis/core`) so the CLI,
 * the iOS transport, and the portal can all share the same `Page<T>` shape.
 *
 *   {
 *     items: T[],
 *     pageInfo: {
 *       nextCursor?: string,   // present iff hasMore
 *       hasMore: boolean,
 *       limit: number,         // the actual page size used
 *     }
 *   }
 *
 * The cursor is opaque to clients — its shape is endpoint-specific.
 * For SQLite-backed lists we typically use the last-seen `id` as the
 * cursor (keyset). For DuckDB / analytics activity we use a stringified
 * offset. Either way the client just rounds-trips it as `?cursor=<value>`
 * and never parses it.
 *
 * For genuinely small admin lists (devices, sources — typically &lt;100
 * rows) the gateway still returns `Page<T>` for shape consistency, but
 * `hasMore` is always `false` and `nextCursor` is omitted.
 */

export interface PageInfo {
  /** Opaque cursor a client passes back as `?cursor=...` to fetch the
   *  next page. Present iff `hasMore` is true. */
  nextCursor?: string;
  /** True iff a subsequent fetch with `nextCursor` would return more
   *  items. False on the last page or for fully-served small lists. */
  hasMore: boolean;
  /** The actual page size used to build this response — equal to the
   *  caller's requested `limit` clamped to the endpoint's max, or the
   *  endpoint default if the caller didn't request one. */
  limit: number;
}

export interface Page<T> {
  items: T[];
  pageInfo: PageInfo;
}

/** Build a `Page<T>` from an items slice + cursor metadata. */
export function buildPage<T>(
  items: T[],
  args: { hasMore: boolean; limit: number; nextCursor?: string },
): Page<T> {
  const pageInfo: PageInfo = {
    hasMore: args.hasMore,
    limit: args.limit,
  };
  if (args.hasMore && args.nextCursor !== undefined) {
    pageInfo.nextCursor = args.nextCursor;
  }
  return { items, pageInfo };
}

/** Parse + clamp a `limit` query-string value. */
export function clampLimit(
  raw: string | null | undefined,
  opts: { default: number; max: number },
): number {
  const parsed = raw == null ? NaN : parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return opts.default;
  return Math.min(opts.max, parsed);
}
