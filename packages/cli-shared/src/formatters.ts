// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatDateShort(iso: string): string {
  const d = new Date(iso);
  const isUS = Intl.DateTimeFormat().resolvedOptions().locale.startsWith("en-US");
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yy = String(d.getFullYear() % 100).padStart(2, "0");
  return isUS ? `${mm}/${dd}/${yy}` : `${dd}/${mm}/${yy}`;
}

export function formatInterval(ms: number): string {
  if (ms >= 3_600_000) return `${ms / 3_600_000}h`;
  if (ms >= 60_000) return `${ms / 60_000}m`;
  return `${ms / 1000}s`;
}

export function formatTimeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export interface FormatTimeAgoMsOptions {
  /** Returned when `ms` is null / undefined / 0. Default: `"never"`. */
  neverLabel?: string;
  /**
   * What to render when the value is older than 24h.
   * - `"days"` → `Xd ago` (matches the ISO-input `formatTimeAgo` behaviour). Default.
   * - `"iso-date"` → ISO-8601 date (`YYYY-MM-DD`). Useful for tabular listings
   *   where a 30d-old timestamp shouldn't render as `30d ago` and confuse the eye.
   */
  longFormat?: "days" | "iso-date";
}

/**
 * Epoch-millisecond variant of `formatTimeAgo`. Most CLI consumers carry
 * `Date.now()`-shaped numbers (DB rows, JSON payloads with `lastFiredAt: 17…ms`),
 * not ISO strings — calling `.toISOString()` just to round-trip through
 * `formatTimeAgo` is silly. This helper consumes the ms directly and
 * renders the same `Xs/m/h ago` ladder, with two knobs for the two
 * pre-existing dialects: `neverLabel` for the null branch and
 * `longFormat` for the >24h branch.
 */
export function formatTimeAgoMs(
  ms: number | null | undefined,
  opts: FormatTimeAgoMsOptions = {},
): string {
  if (ms === null || ms === undefined || ms === 0) return opts.neverLabel ?? "never";
  const diff = Date.now() - ms;
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (opts.longFormat === "iso-date") return new Date(ms).toISOString().slice(0, 10);
  return `${Math.floor(diff / 86_400_000)}d ago`;
}
