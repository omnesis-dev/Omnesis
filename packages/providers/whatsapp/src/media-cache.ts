// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A bounded, in-memory, consume-once cache of media bytes — the bytes the
 * provider eagerly downloads the instant a message arrives, so the later drain
 * can read them instead of re-fetching a possibly-evicted CDN blob. Bounded by
 * entry count, total bytes, and a TTL so it can never grow unbounded or serve
 * stale bytes; bytes live only in RAM (audio is never persisted to disk).
 *
 * Eviction is oldest-first (insertion order), which is a good proxy for the
 * access pattern here: media is consumed by the very next drain, so anything
 * lingering is almost certainly never going to be consumed.
 */
export interface MediaByteCacheOptions {
  maxEntries: number;
  maxBytes: number;
  ttlMs: number;
}

export class MediaByteCache {
  private readonly map = new Map<string, { data: Uint8Array; at: number }>();
  private bytes = 0;

  /** @param now Injectable clock (ms) so TTL behavior is unit-testable. */
  constructor(
    private readonly opts: MediaByteCacheOptions,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Insert/replace bytes for `key`, then enforce the bounds. Note: eviction is
   * by *first* insertion order, so re-`put`ting an existing key refreshes its
   * TTL but does NOT move it to the back of the eviction queue.
   */
  put(key: string, data: Uint8Array): void {
    const existing = this.map.get(key);
    if (existing) this.bytes -= existing.data.byteLength;
    this.map.set(key, { data, at: this.now() });
    this.bytes += data.byteLength;
    this.evict();
  }

  /**
   * Remove and return the bytes for `key` (consume-once), or undefined if absent
   * or expired. Expired entries are dropped rather than returned.
   */
  take(key: string): Uint8Array | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    this.map.delete(key);
    this.bytes -= entry.data.byteLength;
    if (this.now() - entry.at > this.opts.ttlMs) return undefined;
    return entry.data;
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  get size(): number {
    return this.map.size;
  }

  /** Current total cached bytes — exposed for assertions / observability. */
  get byteSize(): number {
    return this.bytes;
  }

  /** Drop expired entries, then evict oldest until within entry + byte bounds. */
  private evict(): void {
    const cutoff = this.now() - this.opts.ttlMs;
    for (const [k, v] of this.map) {
      if (v.at < cutoff) this.drop(k, v.data.byteLength);
    }
    while (this.map.size > this.opts.maxEntries || this.bytes > this.opts.maxBytes) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.drop(oldest, this.map.get(oldest)!.data.byteLength);
    }
  }

  private drop(key: string, size: number): void {
    this.map.delete(key);
    this.bytes -= size;
  }
}
