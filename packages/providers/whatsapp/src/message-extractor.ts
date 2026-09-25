// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { proto } from "@whiskeysockets/baileys";
import type { StoredMessage } from "./types.js";

/**
 * Extract a StoredMessage from a Baileys WAMessage.
 * Handles all common message types and normalizes into our internal format.
 */
export function extractMessage(msg: proto.IWebMessageInfo): StoredMessage | null {
  if (!msg.key?.id || !msg.key.remoteJid) return null;

  const chatJid = msg.key.remoteJid;
  const isGroup = chatJid.endsWith("@g.us");
  const senderJid = isGroup ? (msg.key.participant ?? msg.key.remoteJid) : msg.key.remoteJid;
  const fromMe = msg.key.fromMe ?? false;
  const timestamp =
    typeof msg.messageTimestamp === "number"
      ? msg.messageTimestamp
      : typeof msg.messageTimestamp === "object" &&
          msg.messageTimestamp !== null &&
          "low" in msg.messageTimestamp
        ? (msg.messageTimestamp as { low: number }).low
        : Math.floor(Date.now() / 1000);

  const base: Omit<StoredMessage, "type" | "text"> = {
    id: msg.key.id,
    chatJid,
    senderJid,
    senderName: msg.pushName ?? "",
    fromMe,
    timestamp,
  };

  const message = msg.message;
  if (!message) {
    // Protocol/system message with no content
    return {
      ...base,
      type: "system",
      text: "",
    };
  }

  // Extract context info (quotes/replies) from any message type
  const contextInfo = getContextInfo(message);
  const quoteInfo = contextInfo
    ? {
        quotedText:
          contextInfo.quotedMessage?.conversation ??
          contextInfo.quotedMessage?.extendedTextMessage?.text ??
          undefined,
        quotedSender: contextInfo.participant ?? undefined,
      }
    : {};

  // Plain text
  if (message.conversation) {
    return {
      ...base,
      ...quoteInfo,
      type: "text",
      text: message.conversation,
    };
  }

  // Extended text (with link previews, formatting, quotes)
  if (message.extendedTextMessage) {
    return {
      ...base,
      ...quoteInfo,
      type: "text",
      text: message.extendedTextMessage.text ?? "",
    };
  }

  // Image. Preserve the CDN download descriptors so the image can be fetched
  // and OCR'd into a child attachment doc. Like all WhatsApp media they expire
  // after ~30 days on the CDN, so OCR only works for recently-synced (or
  // backup-imported) images.
  if (message.imageMessage) {
    return {
      ...base,
      ...quoteInfo,
      type: "image",
      text: message.imageMessage.caption ?? "",
      media: {
        mimetype: message.imageMessage.mimetype ?? undefined,
        fileLength: toNumber(message.imageMessage.fileLength),
        width: message.imageMessage.width ?? undefined,
        height: message.imageMessage.height ?? undefined,
        url: message.imageMessage.url ?? undefined,
        directPath: message.imageMessage.directPath ?? undefined,
        mediaKey: message.imageMessage.mediaKey
          ? uint8ToBase64(message.imageMessage.mediaKey)
          : undefined,
        mediaKeyTimestamp: toNumber(message.imageMessage.mediaKeyTimestamp),
      },
    };
  }

  // Video
  if (message.videoMessage) {
    return {
      ...base,
      ...quoteInfo,
      type: "video",
      text: message.videoMessage.caption ?? "",
      media: {
        mimetype: message.videoMessage.mimetype ?? undefined,
        fileLength: toNumber(message.videoMessage.fileLength),
        seconds: message.videoMessage.seconds ?? undefined,
        width: message.videoMessage.width ?? undefined,
        height: message.videoMessage.height ?? undefined,
      },
    };
  }

  // Audio / Voice note. Preserve the CDN download descriptors so voice notes
  // can be fetched and transcribed (speech-to-text). They expire after ~30
  // days on WhatsApp's CDN, so transcription only works for recently-synced
  // (or backup-imported) audio.
  if (message.audioMessage) {
    return {
      ...base,
      ...quoteInfo,
      type: "audio",
      text: "",
      media: {
        mimetype: message.audioMessage.mimetype ?? undefined,
        fileLength: toNumber(message.audioMessage.fileLength),
        seconds: message.audioMessage.seconds ?? undefined,
        isVoiceNote: message.audioMessage.ptt ?? false,
        url: message.audioMessage.url ?? undefined,
        directPath: message.audioMessage.directPath ?? undefined,
        mediaKey: message.audioMessage.mediaKey
          ? uint8ToBase64(message.audioMessage.mediaKey)
          : undefined,
        mediaKeyTimestamp: toNumber(message.audioMessage.mediaKeyTimestamp),
      },
    };
  }

  // Document
  if (message.documentMessage) {
    return {
      ...base,
      ...quoteInfo,
      type: "document",
      text: message.documentMessage.caption ?? "",
      media: {
        mimetype: message.documentMessage.mimetype ?? undefined,
        filename: message.documentMessage.fileName ?? undefined,
        fileLength: toNumber(message.documentMessage.fileLength),
        url: message.documentMessage.url ?? undefined,
        directPath: message.documentMessage.directPath ?? undefined,
        mediaKey: message.documentMessage.mediaKey
          ? uint8ToBase64(message.documentMessage.mediaKey)
          : undefined,
        mediaKeyTimestamp: toNumber(message.documentMessage.mediaKeyTimestamp),
      },
    };
  }

  // Sticker
  if (message.stickerMessage) {
    return {
      ...base,
      type: "sticker",
      text: "",
      media: {
        mimetype: message.stickerMessage.mimetype ?? undefined,
      },
    };
  }

  // Location
  if (message.locationMessage) {
    const lat = message.locationMessage.degreesLatitude ?? 0;
    const lon = message.locationMessage.degreesLongitude ?? 0;
    const name = message.locationMessage.name ?? "";
    const addr = message.locationMessage.address ?? "";
    const label = [name, addr].filter(Boolean).join(", ") || `${lat}, ${lon}`;
    return {
      ...base,
      ...quoteInfo,
      type: "location",
      text: label,
    };
  }

  // Contact
  if (message.contactMessage) {
    return {
      ...base,
      type: "contact",
      text: message.contactMessage.displayName ?? "",
    };
  }

  // Contact array
  if (message.contactsArrayMessage) {
    const names = (message.contactsArrayMessage.contacts ?? [])
      .map((c) => c.displayName ?? "")
      .filter(Boolean)
      .join(", ");
    return {
      ...base,
      type: "contact",
      text: names,
    };
  }

  // Reaction
  if (message.reactionMessage) {
    return {
      ...base,
      type: "reaction",
      text: message.reactionMessage.text ?? "",
      reactionEmoji: message.reactionMessage.text ?? undefined,
      reactionTargetId: message.reactionMessage.key?.id ?? undefined,
    };
  }

  // Protocol message (deletion, ephemeral settings, etc.)
  if (message.protocolMessage) {
    const pm = message.protocolMessage;
    // Message deletion
    if (pm.type === 0 && pm.key?.id) {
      return {
        ...base,
        type: "system",
        text: "Message deleted",
      };
    }
    return null; // Skip other protocol messages
  }

  // Ephemeral / view-once wrappers — unwrap the inner message
  const innerMessage =
    message.ephemeralMessage?.message ??
    message.viewOnceMessage?.message ??
    message.viewOnceMessageV2?.message;
  if (innerMessage) {
    const unwrapped: proto.IWebMessageInfo = {
      ...msg,
      message: innerMessage,
    };
    return extractMessage(unwrapped);
  }

  // Fallback for unknown message types
  return {
    ...base,
    type: "unknown",
    text: "",
  };
}

/**
 * Get contextInfo from any message type (for quote/reply detection).
 */
function getContextInfo(message: proto.IMessage): proto.IContextInfo | null {
  return (
    message.extendedTextMessage?.contextInfo ??
    message.imageMessage?.contextInfo ??
    message.videoMessage?.contextInfo ??
    message.audioMessage?.contextInfo ??
    message.documentMessage?.contextInfo ??
    message.locationMessage?.contextInfo ??
    null
  );
}

/**
 * Convert Long-like values to number.
 *
 * Baileys / protobuf-js represents int64 as `{ low, high, unsigned }`.
 * The previous implementation returned `low` only, so any value that
 * needed the high 32 bits silently wrapped:
 *
 * - `fileLength` > 4 GiB on a video / large document attachment.
 * - `mediaKeyTimestamp` past 2038-01-19 (the int32 epoch, `2^31` seconds
 *   after 1970) — already plausible for messages with backdated mtimes
 *   from imports.
 *
 * `Number.MAX_SAFE_INTEGER` is `2^53 − 1`, so the combined
 * `high * 2^32 + low` fits losslessly until we hit ~9.0 EB / year ~285616.
 * The unsigned-vs-signed reading matters for `high < 0` (the int64 is
 * negative); we only round-trip through `>>> 0` for the unsigned case
 * because Baileys' fileLength / timestamps are never negative in
 * practice.
 */
function toNumber(val: number | Long | null | undefined): number | undefined {
  if (val === null || val === undefined) return undefined;
  if (typeof val === "number") return val;
  if (typeof val === "object" && "low" in val) {
    const lo = (val as Long).low;
    const hi = (val as Long).high;
    const unsigned = (val as Long).unsigned;
    // Treat each half as unsigned 32 bits; combine to an integer that
    // fits in a JS number up to Number.MAX_SAFE_INTEGER.
    const loU = lo >>> 0;
    const hiU = hi >>> 0;
    if (unsigned || hi >= 0) {
      return hiU * 0x1_0000_0000 + loU;
    }
    // Signed negative — recover via two's-complement.
    return hi * 0x1_0000_0000 + loU;
  }
  return Number(val);
}

type Long = { low: number; high: number; unsigned: boolean };

/** Convert a Uint8Array or Buffer to base64 string */
function uint8ToBase64(data: Uint8Array | Buffer): string {
  return Buffer.from(data).toString("base64");
}
