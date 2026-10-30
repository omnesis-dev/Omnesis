// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The media lifecycle: what a download or processing attempt's outcome means
 * for the next one (`docs/telegram-source.md` §10). Mirrors WhatsApp's
 * (`packages/providers/whatsapp/src/message-store.ts`, `recordMediaOutcome`),
 * with Telegram's own failure classes.
 *
 * Pure: the archive applies these decisions, the media pass makes them.
 */

import { TelegramError } from "./client/types.js";
import { MEDIA_MAX_ATTEMPTS, MEDIA_RETRY_BACKOFF_SEC } from "./limits.js";
import type { TgMediaKind } from "./client/types.js";

/**
 * Where a message's media stands.
 *
 * - `pending`     — not processed yet, or backing off after a failed attempt.
 * - `done`        — transcribed or extracted; the result is in the archive.
 * - `empty`       — processed, and there was nothing to read (no speech, no text).
 * - `unavailable` — Telegram no longer has the file, or every download failed.
 * - `skipped`     — the attachment settings exclude it (type, size); a resync
 *                   looks at it again.
 */
export type MediaState = "pending" | "done" | "empty" | "unavailable" | "skipped";

/** The media kinds Omnesis downloads; everything else stays a placeholder. */
const PROCESSABLE_KINDS: ReadonlySet<TgMediaKind> = new Set(["voice", "photo", "document"]);

export function isProcessableKind(kind: TgMediaKind): boolean {
  return PROCESSABLE_KINDS.has(kind);
}

/**
 * The result of one attempt.
 *
 * - `transcribed`    — a voice note's text (`""` is no speech → `empty`).
 * - `extracted`      — an attachment's extraction, kept so every later render
 *                      re-emits it without a download. `complete: false` keeps
 *                      it enrolled (a PDF whose scanned pages await OCR).
 * - `empty`          — an attachment with no text in it.
 * - `transient`      — the download failed and may succeed later; counts toward
 *                      giving up. `retryAfterSec` is Telegram's own wait.
 * - `process-failed` — bytes in hand, but no transcriber or extractor could
 *                      run; retried at the capped backoff, never given up.
 * - `terminal`       — Telegram no longer has the file.
 * - `skipped`        — the attachment settings exclude it.
 */
export type MediaOutcome =
  | { kind: "transcribed"; text: string }
  | { kind: "extracted"; extraction: string; complete: boolean }
  | { kind: "empty" }
  | { kind: "transient"; error: string; retryAfterSec?: number }
  | { kind: "process-failed"; error: string }
  | { kind: "terminal"; error: string }
  | { kind: "skipped"; reason: string };

/**
 * Seconds until the next attempt after `attempts` failed ones, or `null`
 * once a download has failed too often to keep trying.
 */
export function downloadRetryDelaySec(attempts: number): number | null {
  if (attempts >= MEDIA_MAX_ATTEMPTS) return null;
  return backoffStep(attempts);
}

/** The backoff step for `attempts`, never giving up (processing failures). */
export function backoffStep(attempts: number): number {
  const i = Math.min(Math.max(attempts - 1, 0), MEDIA_RETRY_BACKOFF_SEC.length - 1);
  return MEDIA_RETRY_BACKOFF_SEC[i]!;
}

/**
 * What a failed download means.
 *
 * - `cancelled` — the sync was stopped; nothing is recorded.
 * - `halt`      — the session is gone; nothing is recorded, and the sync's own
 *                 authorization check reports it.
 * - `flood`     — Telegram asked to wait; no more downloads until then.
 * - `terminal`  — the file or message is gone, or refused.
 * - `transient` — anything else: retried on the backoff.
 */
export type DownloadFailure =
  | { kind: "cancelled" }
  | { kind: "halt" }
  | { kind: "flood"; seconds: number; error: string }
  | { kind: "terminal"; error: string }
  | { kind: "transient"; error: string };

export function classifyDownloadFailure(err: unknown, signal?: AbortSignal): DownloadFailure {
  if (signal?.aborted) return { kind: "cancelled" };
  if (!(err instanceof TelegramError)) {
    return { kind: "transient", error: err instanceof Error ? err.message : String(err) };
  }
  switch (err.code) {
    case "revoked":
      return { kind: "halt" };
    case "flood-wait":
      return { kind: "flood", seconds: Math.max(1, err.detail?.seconds ?? 0), error: err.message };
    case "not-found":
    case "forbidden":
      return { kind: "terminal", error: err.message };
    // A second stale reference right after a refresh, or a client-side
    // timeout: neither says the file is gone.
    // Downloads never go through a takeout session; treated as any oddity.
    case "file-reference-expired":
    case "takeout":
    case "cancelled":
    case "network":
    case "unknown":
      return { kind: "transient", error: err.message };
  }
}
