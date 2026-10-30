// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Downloading a message's media across a stale file reference.
 *
 * A Telegram file id carries a file reference that expires (hours to days
 * after the message was fetched). The server then answers
 * `FILE_REFERENCE_EXPIRED`, and the only fix is to fetch the message again,
 * whose media carries a fresh reference, and retry. This module holds that
 * rule free of any client library, so the mtcute adapter and the simulated
 * one share it and it is tested without the network
 * (`docs/telegram-source.md` §10).
 */

import { TelegramError, type TgDownloaded, type TgMediaDownload, type TgMessage } from "./types.js";

export interface ReferenceRefreshDeps {
  /** Download by file id; a stale reference throws `file-reference-expired`. */
  download(fileId: string): Promise<Uint8Array>;
  /** The message as Telegram has it now, or `null` when it is gone. */
  refetch(chatId: number, msgId: number): Promise<TgMessage | null>;
}

/** The file is larger than the caller allows. */
function tooLarge(): TelegramError {
  return new TelegramError("forbidden", "The file is larger than allowed");
}

/**
 * Download `target`, refreshing a stale reference once: a second stale
 * answer, a message that is gone, or one that no longer carries a file is
 * final. The size limit is checked against what is known before any byte is
 * fetched, and against the bytes after.
 */
export async function downloadWithReferenceRefresh(
  target: TgMediaDownload,
  maxBytes: number,
  deps: ReferenceRefreshDeps,
): Promise<TgDownloaded> {
  if (target.size !== undefined && target.size > maxBytes) throw tooLarge();
  const fetchBounded = async (fileId: string): Promise<Uint8Array> => {
    const data = await deps.download(fileId);
    if (data.byteLength > maxBytes) throw tooLarge();
    return data;
  };
  try {
    return { data: await fetchBounded(target.fileId) };
  } catch (err) {
    if (!(err instanceof TelegramError) || err.code !== "file-reference-expired") throw err;
  }
  const fresh = await deps.refetch(target.chatId, target.msgId);
  const media = fresh?.media;
  if (!media?.fileId) {
    throw new TelegramError("not-found", "The message no longer carries this file");
  }
  if (media.size !== undefined && media.size > maxBytes) throw tooLarge();
  return { data: await fetchBounded(media.fileId), refreshed: media };
}
