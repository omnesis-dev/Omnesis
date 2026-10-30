// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * RPC error → {@link TelegramError}.
 *
 * Pure, and deliberately free of mtcute: the adapter recognises an RPC error
 * and hands over its three plain fields, so this table can be tested without
 * the library and reused by any other client implementation.
 *
 * mtcute normalises a parameterised error text before it reaches here:
 * `FLOOD_WAIT_37` arrives as text `FLOOD_WAIT_%d` with `seconds: 37`. The raw
 * spelling is accepted too, because a flood wait the library synthesises from
 * a stored wait can come either way.
 */

import { TelegramError, isRevocationReason } from "./types.js";

/** The fields of an RPC error this mapping reads. */
export interface RpcErrorFields {
  code: number;
  text: string;
  seconds?: number;
}

const FLOOD_TEXTS =
  /^(FLOOD_WAIT|FLOOD_PREMIUM_WAIT|SLOWMODE_WAIT|FLOOD_TEST_PHONE_WAIT)_(%d|\d+)$/u;
const FILE_REFERENCE_TEXTS = /^FILE_REFERENCE_(?:(?:%d|\d+)_)?(EXPIRED|INVALID|EMPTY)$/u;

const NOT_FOUND_TEXTS = new Set([
  "MSG_ID_INVALID",
  "MESSAGE_ID_INVALID",
  "MESSAGE_IDS_EMPTY",
  "PEER_ID_INVALID",
  "CHANNEL_INVALID",
  "CHAT_ID_INVALID",
  "USER_ID_INVALID",
  "FILE_ID_INVALID",
  "MEDIA_EMPTY",
  "TOPIC_ID_INVALID",
]);

const FORBIDDEN_TEXTS = new Set([
  "CHANNEL_PRIVATE",
  "CHANNEL_PUBLIC_GROUP_NA",
  "CHAT_FORBIDDEN",
  "CHAT_ADMIN_REQUIRED",
  "USER_BANNED_IN_CHANNEL",
  "API_ID_INVALID",
  "API_ID_PUBLISHED_FLOOD",
]);

/** Takeout errors: an export not approved yet, or a session that is no longer valid. */
const TAKEOUT_DELAY = /^TAKEOUT_INIT_DELAY_(%d|\d+)$/u;
const TAKEOUT_ENDED = new Set(["TAKEOUT_INVALID", "TAKEOUT_REQUIRED"]);

/** Whether an RPC error says the operator's app credential itself is refused. */
export function isAppCredentialRejected(rpc: string | undefined): boolean {
  return rpc === "API_ID_INVALID" || rpc === "API_ID_PUBLISHED_FLOOD";
}

export function mapRpcError(err: RpcErrorFields): TelegramError {
  const { code, text } = err;
  if (isRevocationReason(text)) {
    return new TelegramError("revoked", `Telegram ended this session (${text})`, {
      reason: text,
      rpc: text,
    });
  }
  // Before the flood check: Telegram sends the export delay with code 420.
  const delay = TAKEOUT_DELAY.exec(text);
  if (delay) {
    const seconds = err.seconds ?? (delay[1] !== "%d" ? Number(delay[1]) : 0);
    return new TelegramError(
      "takeout",
      `Telegram holds the data export for ${seconds}s (${text})`,
      {
        seconds,
        rpc: text,
      },
    );
  }
  if (TAKEOUT_ENDED.has(text)) {
    return new TelegramError("takeout", `The Telegram data export session ended (${text})`, {
      rpc: text,
    });
  }
  const flood = FLOOD_TEXTS.exec(text);
  if (code === 420 || flood) {
    const parsed = flood && flood[2] !== "%d" ? Number(flood[2]) : undefined;
    const seconds = err.seconds ?? parsed ?? 0;
    return new TelegramError("flood-wait", `Telegram asked to wait ${seconds}s (${text})`, {
      seconds,
      rpc: text,
    });
  }
  if (FILE_REFERENCE_TEXTS.test(text)) {
    return new TelegramError("file-reference-expired", `File reference is stale (${text})`, {
      rpc: text,
    });
  }
  if (NOT_FOUND_TEXTS.has(text)) {
    return new TelegramError("not-found", `Telegram has no such item (${text})`, { rpc: text });
  }
  if (code === 403 || FORBIDDEN_TEXTS.has(text)) {
    return new TelegramError("forbidden", `Telegram refused the request (${text})`, { rpc: text });
  }
  if (code >= 500 || code === -503) {
    return new TelegramError("network", `Telegram had a server error (${code} ${text})`, {
      rpc: text,
    });
  }
  return new TelegramError("unknown", `Telegram error ${code} ${text}`, { rpc: text });
}
