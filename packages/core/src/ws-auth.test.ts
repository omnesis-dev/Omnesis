// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import {
  parseWebSocketAuthProtocolHeader,
  websocketAuthProtocol,
  WS_AUTH_PROTOCOL_PREFIX,
} from "./ws-auth.js";

describe("WebSocket auth subprotocol", () => {
  test("encodes and parses an Omnesis token", () => {
    const protocol = websocketAuthProtocol("omn_abcdef123456");
    expect(protocol).toBe(`${WS_AUTH_PROTOCOL_PREFIX}omn_abcdef123456`);
    expect(parseWebSocketAuthProtocolHeader(protocol)).toBe("omn_abcdef123456");
  });

  test("finds the auth protocol among multiple requested protocols", () => {
    expect(parseWebSocketAuthProtocolHeader("chat, omnesis-token.omn_abc, v2")).toBe("omn_abc");
  });

  test("rejects characters that are invalid in Sec-WebSocket-Protocol tokens", () => {
    expect(() => websocketAuthProtocol("omn token")).toThrow(/invalid in a subprotocol/);
    expect(parseWebSocketAuthProtocolHeader("omnesis-token.omn token")).toBeNull();
  });
});
