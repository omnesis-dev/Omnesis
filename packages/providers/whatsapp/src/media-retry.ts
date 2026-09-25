// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { WASocket, WAMessage } from "@whiskeysockets/baileys";
import type { Logger } from "pino";

/**
 * The re-upload retry context passed as `downloadMediaMessage`'s 4th argument.
 * Mirrors Baileys' `DownloadMediaMessageContext`.
 */
export interface MediaRetryContext {
  reuploadRequest: (message: WAMessage) => Promise<WAMessage>;
  logger: Logger;
}

/**
 * Build the media re-upload retry context for `downloadMediaMessage`.
 *
 * When WhatsApp's CDN returns 404/410 for a media payload — common for a voice
 * note the user sent from another device (their phone) or media whose location
 * the companion learned across a reconnect — Baileys, given this context,
 * re-requests the upload via `sock.updateMediaMessage` and retries the download.
 * Without it the download throws on 404/410 and the voice note is silently
 * dropped (no transcript, not even a placeholder).
 *
 * Returns `undefined` when the socket can't re-request uploads — a not-yet-
 * connected socket or a test stub without `updateMediaMessage` — so callers pass
 * the result straight through as the optional 4th arg and the download behaves
 * exactly as before.
 */
export function buildMediaRetryContext(
  sock: Partial<WASocket> | null | undefined,
  logger: Logger,
): MediaRetryContext | undefined {
  const reupload = sock?.updateMediaMessage;
  if (typeof reupload !== "function") return undefined;
  return {
    reuploadRequest: reupload.bind(sock) as MediaRetryContext["reuploadRequest"],
    logger,
  };
}

/**
 * HTTP-ish status codes that mean a media download will never succeed on retry:
 * `404`/`410` (the blob is gone from the CDN and the phone reported it gone via
 * a `NOT_FOUND` media-retry — whatsmeow calls this "media no longer available on
 * phone") and `412` (`DECRYPTION_ERROR` — the key can't decrypt the re-uploaded
 * blob, which won't change). Baileys derives these from
 * `getStatusCodeForMediaRetry` and surfaces them as the thrown error's status.
 */
const TERMINAL_MEDIA_STATUS = new Set([404, 410, 412]);

function mediaErrorStatus(err: unknown): number | undefined {
  if (err && typeof err === "object") {
    const e = err as { output?: { statusCode?: number }; statusCode?: number };
    return e.output?.statusCode ?? e.statusCode;
  }
  return undefined;
}

/**
 * Classify a failed media download as `terminal` (the media is gone /
 * undecryptable — stop retrying) or `transient` (CDN momentarily evicted, phone
 * offline so no device has re-uploaded yet, a reconnect, or a timeout — retry on
 * a backoff). Defaults to `transient`: a misclassified transient just retries a
 * few more times, whereas a misclassified terminal would hammer a dead blob.
 * `GENERAL_ERROR` (418) is treated as transient for the same reason.
 */
export function classifyMediaDownloadError(err: unknown): "transient" | "terminal" {
  const status = mediaErrorStatus(err);
  if (status !== undefined && TERMINAL_MEDIA_STATUS.has(status)) return "terminal";
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (
    msg.includes("not_found") ||
    msg.includes("no longer available") ||
    msg.includes("decryption_error")
  ) {
    return "terminal";
  }
  return "transient";
}
