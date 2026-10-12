// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";

import {
  certificateFingerprint,
  classifyTlsFailure,
  GatewayTlsError,
  mcpEndpointUrl,
  normalizeFingerprint,
  TlsPinError,
  isSystemTrust,
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

  test("tells system trust from a pin", () => {
    expect(isSystemTrust({ mode: "system" })).toBe(true);
    expect(isSystemTrust({ caPem: "pem", leafFingerprintSha256: "a".repeat(64) })).toBe(false);
  });
});

describe("certificate failures, in the operator's words", () => {
  const context = { gatewayUrl: "https://gateway.example.test:7600", harness: "hermes" };

  test("a pin mismatch names the refresh command and the unattended form", () => {
    const failure = classifyTlsFailure(new TlsPinError("mismatch"), context);
    expect(failure).toBeInstanceOf(GatewayTlsError);
    expect(failure?.message).toContain("https://gateway.example.test:7600");
    expect(failure?.message).toContain("pinned");
    expect(failure?.message).toContain("`omnesis connect hermes --refresh`");
    expect(failure?.message).toContain("--trust-fingerprint sha256:");
    expect(failure?.message).toContain("omnesis tls status");
  });

  test("reads Node's verification code through wrapping errors", () => {
    const wrapped = new Error("fetch failed", {
      cause: Object.assign(new Error("self-signed certificate"), {
        code: "DEPTH_ZERO_SELF_SIGNED_CERT",
      }),
    });
    const failure = classifyTlsFailure(wrapped, context);
    expect(failure?.code).toBe("DEPTH_ZERO_SELF_SIGNED_CERT");
    expect(failure?.message).toContain("omnesis connect hermes --refresh");
    expect(failure?.cause).toBe(wrapped);
  });

  test("an expired certificate is renewed on the gateway, not re-trusted here", () => {
    const failure = classifyTlsFailure(
      Object.assign(new Error("certificate has expired"), { code: "CERT_HAS_EXPIRED" }),
      context,
    );
    expect(failure?.message).toContain("has expired");
    expect(failure?.message).toContain("Renew it on the gateway host");
  });

  test("leaves anything else alone, and an already classified failure as it is", () => {
    expect(classifyTlsFailure(new Error("connect ECONNREFUSED"), context)).toBeNull();
    expect(
      classifyTlsFailure(Object.assign(new Error("refused"), { code: "ECONNREFUSED" }), context),
    ).toBeNull();
    const classified = new GatewayTlsError("already said");
    expect(classifyTlsFailure(classified, context)).toBe(classified);
  });
});
