// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { resolveEffectiveMimeType } from "@omnesis/core";
import type { RawIMessageAttachment } from "./imessage-types.js";

/**
 * One `attachment` row as chat.db stores it. Messages records every
 * attachment's Uniform Type Identifier but fills `mime_type` only for some
 * transfers: an audio message recorded in Messages is stored as
 * `com.apple.coreaudio-format` with no MIME type at all, so the UTI is the
 * only type signal the row carries for it.
 */
export interface IMessageAttachmentRow {
  attachmentRowId: number;
  guid: string | null;
  messageRowId: number;
  filename: string | null;
  mimeType: string | null;
  uti: string | null;
  transferName: string | null;
  totalBytes: number;
}

/** UTI → MIME type for the attachment kinds Messages stores without a MIME type. */
const UTI_MIME_TYPES: Record<string, string> = {
  "com.apple.coreaudio-format": "audio/x-caf",
  "com.apple.m4a-audio": "audio/x-m4a",
  "public.mpeg-4-audio": "audio/mp4",
  "public.mp3": "audio/mpeg",
  "public.aac-audio": "audio/aac",
  "com.microsoft.waveform-audio": "audio/wav",
  "public.jpeg": "image/jpeg",
  "public.png": "image/png",
  "public.heic": "image/heic",
  "public.heif": "image/heif",
  "com.compuserve.gif": "image/gif",
  "com.adobe.pdf": "application/pdf",
};

/** The name an attachment is shown under: its transfer name, else its file's basename. */
export function imessageAttachmentFilename(row: {
  filename: string | null;
  transferName: string | null;
}): string {
  return row.transferName ?? row.filename?.split("/").pop() ?? "attachment";
}

/**
 * The MIME type an attachment row effectively has: chat.db's `mime_type` when
 * it is set, else the type its UTI names, else the type its filename extension
 * names; `""` when none of them is known to the pipeline.
 */
export function imessageAttachmentMimeType(row: IMessageAttachmentRow): string {
  const reported = row.mimeType?.trim() ?? "";
  const fromUti = row.uti && Object.hasOwn(UTI_MIME_TYPES, row.uti) ? UTI_MIME_TYPES[row.uti] : "";
  return resolveEffectiveMimeType(imessageAttachmentFilename(row), reported || fromUti);
}

/** The row with its MIME type resolved, which is what every later pass reads. */
export function resolveIMessageAttachment(row: IMessageAttachmentRow): RawIMessageAttachment {
  return {
    attachmentRowId: row.attachmentRowId,
    guid: row.guid,
    messageRowId: row.messageRowId,
    filename: row.filename,
    mimeType: imessageAttachmentMimeType(row),
    transferName: row.transferName,
    totalBytes: row.totalBytes,
  };
}
