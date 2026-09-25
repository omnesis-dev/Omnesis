// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * WebSocket authentication helpers.
 *
 * Browsers and Node's built-in WebSocket cannot portably attach arbitrary
 * HTTP headers to the upgrade request. `Sec-WebSocket-Protocol` is available
 * everywhere and is part of the upgrade boundary, so devices present their
 * Omnesis token as a dedicated subprotocol instead of inside the first frame.
 */

export const WS_AUTH_PROTOCOL_PREFIX = "omnesis-token." as const;

const TOKEN_PROTOCOL_ALLOWED = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export function websocketAuthProtocol(token: string): string {
  if (!TOKEN_PROTOCOL_ALLOWED.test(token)) {
    throw new Error("WebSocket auth token contains characters that are invalid in a subprotocol");
  }
  return `${WS_AUTH_PROTOCOL_PREFIX}${token}`;
}

export function parseWebSocketAuthProtocolHeader(header: string | null | undefined): string | null {
  if (!header) return null;
  for (const part of header.split(",")) {
    const protocol = part.trim();
    if (!protocol.startsWith(WS_AUTH_PROTOCOL_PREFIX)) continue;
    const token = protocol.slice(WS_AUTH_PROTOCOL_PREFIX.length);
    if (token.length === 0) return null;
    if (!TOKEN_PROTOCOL_ALLOWED.test(token)) return null;
    return token;
  }
  return null;
}
