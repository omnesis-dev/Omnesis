// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";

import {
  certificateFingerprint,
  mcpEndpointUrl,
  normalizeFingerprint,
  TlsPinError,
  validateGatewayUrl,
  verifyPeerFingerprint,
  websocketUrl,
} from "./tls.js";

describe("TLS identity validation", () => {
  test("accepts an exact SHA-256 leaf pin", () => {
    const raw = Buffer.from("fictional gateway certificate DER");
    expect(() => verifyPeerFingerprint(raw, certificateFingerprint(raw))).not.toThrow();
  });

  test("fails closed for a missing or changed leaf", () => {
    const expected = certificateFingerprint(Buffer.from("expected leaf"));
    expect(() => verifyPeerFingerprint(undefined, expected)).toThrow(TlsPinError);
    expect(() => verifyPeerFingerprint(Buffer.from("rotated leaf"), expected)).toThrow(
      /fingerprint mismatch/,
    );
  });

  test("normalizes the display form but rejects malformed pins", () => {
    const compact = "ab".repeat(32);
    expect(normalizeFingerprint(compact.match(/.{2}/g)!.join(":").toUpperCase())).toBe(compact);
    expect(() => normalizeFingerprint("not-a-pin")).toThrow();
  });

  test("requires TLS remotely and permits plaintext only on loopback", () => {
    expect(validateGatewayUrl("https://gateway.example.org:7600").protocol).toBe("https:");
    expect(validateGatewayUrl("http://127.0.0.2:7600").protocol).toBe("http:");
    expect(() => validateGatewayUrl("http://gateway.example.org:7600")).toThrow(/require HTTPS/);
    expect(websocketUrl("https://gateway.example.org:7600").toString()).toBe(
      "wss://gateway.example.org:7600/device/ws",
    );
    expect(websocketUrl("https://gateway.example.org/omnesis").toString()).toBe(
      "wss://gateway.example.org/omnesis/device/ws",
    );
    expect(mcpEndpointUrl("https://gateway.example.org/omnesis").toString()).toBe(
      "https://gateway.example.org/omnesis/mcp",
    );
  });
});
