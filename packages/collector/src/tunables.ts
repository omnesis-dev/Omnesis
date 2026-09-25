// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Collector tunables — every magic number that lives in the sync pipeline.
 *
 * These were scattered across `sync-engine.ts` and `file-watcher-manager.ts`,
 * several of them picked empirically with no instrumentation and no
 * migration path if a value turned out to be wrong. Centralising them
 * gives a single place to:
 *
 * - read what each knob does and why it's set where it is;
 * - override at construction time (each constructor accepts an
 *   `opts.<name>` mirroring the constant here);
 * - reason about cross-knob interactions (e.g. the 3s file-watch
 *   debounce + 3s mtime poll fallback are deliberately the same).
 *
 * Treat values here as *defaults*, not hard limits. The matching
 * constructor option always wins; the global config-store could later
 * surface them as user-tunable settings without re-architecting.
 */

/** Debounce window between an FS event and the triggered sync. */
export const DEFAULT_WATCH_DEBOUNCE_MS = 3000;

/** Debounce window between a push-source notification and the triggered sync. */
export const DEFAULT_PUSH_DEBOUNCE_MS = 3000;

/**
 * Mtime polling fallback for SQLite WAL files where macOS `fs.watch`
 * misses memory-mapped writes. Same cadence as the watch debounce so the
 * two paths line up — a missed `fs.watch` event is picked up on the
 * next poll, with the debounce smoothing out duplicate triggers.
 */
export const DEFAULT_FILE_POLL_INTERVAL_MS = 3000;

/**
 * Cap on how many sources the engine will sync in parallel. 4 is a
 * compromise between Mac-laptop CPU pressure and provider RTT bound:
 * push higher and a single bootstrap can swamp the gateway's writer
 * queue; push lower and a long Apple Notes scan blocks Drive cycles.
 */
export const DEFAULT_SYNC_CONCURRENCY = 4;

/**
 * Stagger between initial-sync starts. Spreads provider connect bursts
 * (Baileys QR, Notion search) across N seconds so the gateway sees one
 * new sync at a time instead of all at once.
 */
export const DEFAULT_STAGGER_MS = 3000;

/**
 * Wall-clock cap on a single `syncSource` invocation. A source whose
 * `instance.sync()` never resolves (provider SDK hangs on a
 * never-completing fetch, an mtime poll on a stuck network mount) used
 * to leave `status.state = "syncing"` forever — every subsequent
 * tick / file-watch / push event short-circuits on the flag, the only
 * escape is a collector restart. With this cap the engine surfaces a
 * timeout error after 1h, logs loudly, and clears the flag so the
 * next tick re-attempts. Override via the engine constructor for
 * tests or per-source policy.
 */
export const DEFAULT_SYNC_TIMEOUT_MS = 60 * 60 * 1000;
