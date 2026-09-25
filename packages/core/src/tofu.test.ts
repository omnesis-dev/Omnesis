// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { isTlsCertError, normalizeCertFingerprint, tlsErrorCode } from "./tofu.js";

describe("isTlsCertError", () => {
  test("returns true for DEPTH_ZERO_SELF_SIGNED_CERT", () => {
    expect(isTlsCertError({ code: "DEPTH_ZERO_SELF_SIGNED_CERT" })).toBe(true);
  });

  test("returns true for SELF_SIGNED_CERT_IN_CHAIN", () => {
    expect(isTlsCertError({ code: "SELF_SIGNED_CERT_IN_CHAIN" })).toBe(true);
  });

  test("returns true for UNABLE_TO_GET_ISSUER_CERT_LOCALLY", () => {
    expect(isTlsCertError({ code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY" })).toBe(true);
  });

  test("returns true for UNABLE_TO_VERIFY_LEAF_SIGNATURE", () => {
    expect(isTlsCertError({ code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" })).toBe(true);
  });

  test("returns false for network errors", () => {
    expect(isTlsCertError({ code: "ECONNREFUSED" })).toBe(false);
    expect(isTlsCertError({ code: "ENOTFOUND" })).toBe(false);
    expect(isTlsCertError({ code: "ETIMEDOUT" })).toBe(false);
  });

  test("returns false for null/undefined/non-objects", () => {
    expect(isTlsCertError(null)).toBe(false);
    expect(isTlsCertError(undefined)).toBe(false);
    expect(isTlsCertError("string")).toBe(false);
    expect(isTlsCertError(42)).toBe(false);
  });

  test("recurses into cause", () => {
    const wrapped = {
      code: "ECONNRESET",
      cause: { code: "DEPTH_ZERO_SELF_SIGNED_CERT" },
    };
    expect(isTlsCertError(wrapped)).toBe(true);
  });

  test("returns false for deeply nested non-TLS cause", () => {
    const wrapped = {
      code: "ERR_FETCH",
      cause: { code: "ECONNREFUSED" },
    };
    expect(isTlsCertError(wrapped)).toBe(false);
  });

  test("finds a TLS code nested within the 10-hop depth budget", () => {
    // 9 wrapping hops above the leaf — within the depth>10 cutoff, so it is
    // discovered. (depth starts at 0; hop 9 carries the TLS code.)
    let err: unknown = { code: "DEPTH_ZERO_SELF_SIGNED_CERT" };
    for (let i = 0; i < 9; i++) {
      err = { code: "ERR_WRAP", cause: err };
    }
    expect(isTlsCertError(err)).toBe(true);
  });

  test("stops recursing past depth 10 even if a TLS code lies deeper", () => {
    // Bury the TLS code beneath a chain long enough that the depth guard
    // bails before reaching it — proving the cutoff terminates a pathological
    // (or maliciously deep) cause chain instead of recursing unbounded.
    let err: unknown = { code: "DEPTH_ZERO_SELF_SIGNED_CERT" };
    for (let i = 0; i < 20; i++) {
      err = { code: "ERR_WRAP", cause: err };
    }
    expect(isTlsCertError(err)).toBe(false);
  });
});

describe("tlsErrorCode", () => {
  test("names the verification code behind an error, including expiry and clock codes", () => {
    expect(tlsErrorCode({ code: "CERT_HAS_EXPIRED" })).toBe("CERT_HAS_EXPIRED");
    expect(tlsErrorCode(new Error("fetch failed", { cause: { code: "CERT_NOT_YET_VALID" } }))).toBe(
      "CERT_NOT_YET_VALID",
    );
    expect(isTlsCertError({ code: "CERT_HAS_EXPIRED" })).toBe(true);
    expect(tlsErrorCode({ code: "ECONNREFUSED" })).toBeNull();
  });
});

describe("normalizeCertFingerprint", () => {
  const hex = "9ce7bc3e9ef09c45bdcdb3ed30fccd57e536c29538ad8ea9e4fb5f9de65d1e05";

  test("accepts the three shapes a fingerprint is pasted in", () => {
    // Bare hex, the `sha256:` form the installer and the banner print, and
    // the colon-separated pairs `openssl x509 -fingerprint` emits.
    expect(normalizeCertFingerprint(hex)).toBe(hex);
    expect(normalizeCertFingerprint(`sha256:${hex}`)).toBe(hex);
    expect(normalizeCertFingerprint(`SHA-256:${hex.toUpperCase()}`)).toBe(hex);
    const pairs = (hex.match(/../g) ?? []).join(":").toUpperCase();
    expect(normalizeCertFingerprint(`  sha256:${pairs}  `)).toBe(hex);
  });

  test("rejects anything that is not 32 bytes of hex", () => {
    // A truncated or mistyped pin has to fail loudly here, because further
    // down it would only fail to match — which reads as the wrong gateway.
    expect(normalizeCertFingerprint(undefined)).toBeNull();
    expect(normalizeCertFingerprint("")).toBeNull();
    expect(normalizeCertFingerprint("sha256:beef")).toBeNull();
    expect(normalizeCertFingerprint(hex.slice(0, 63))).toBeNull();
    expect(normalizeCertFingerprint(`${hex}00`)).toBeNull();
    expect(normalizeCertFingerprint(`sha1:${hex}`)).toBeNull();
    expect(normalizeCertFingerprint(hex.replace("9", "z"))).toBeNull();
  });
});
