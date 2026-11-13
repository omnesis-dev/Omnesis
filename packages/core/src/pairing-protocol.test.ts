// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import {
  PAIRING_PROTOCOL_VERSION,
  buildPairingPayloadV2,
  buildPairingPayloadV3,
  buildPairingPayloadV4,
  decodePairingPayload,
} from "./pairing-protocol.js";

/** A well-formed leaf-cert fingerprint: 64 lowercase hex chars. */
const FINGERPRINT = "ab12cd34".repeat(8);

/**
 * Pairing payload contract is now declared in this
 * module instead of being duplicated between the CLI builder and
 * the iOS Codable struct. Pin the producer + consumer surfaces
 * here so a future bump (TLS fingerprint field, different exchange
 * code) lands in one place and the test suite catches drift.
 */
describe("pairing-protocol", () => {
  describe("buildPairingPayloadV2", () => {
    it("produces a V2 envelope for legacy back-compat", () => {
      const p = buildPairingPayloadV2({
        gatewayUrl: "http://mac.local:7600",
        pairingCode: "1A2B-3C4D-5E",
      });
      expect(p.v).toBe(2);
      expect(p.gatewayUrl).toBe("http://mac.local:7600");
      expect(p.pairingCode).toBe("1A2B-3C4D-5E");
      // Sanity: the accepted protocol head advances independently of this builder.
      expect(PAIRING_PROTOCOL_VERSION).toBe(4);
    });

    it("JSON.stringify round-trips through decodePairingPayload", () => {
      const built = buildPairingPayloadV2({
        gatewayUrl: "https://10.0.0.5:7600",
        pairingCode: "AAAA-BBBB-CCCC",
      });
      const result = decodePairingPayload(JSON.stringify(built));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.payload).toEqual(built);
      }
    });
  });

  describe("buildPairingPayloadV4 + decode — explicit TLS trust", () => {
    it("round-trips system WebPKI over HTTPS", () => {
      const built = buildPairingPayloadV4({
        gatewayUrl: "https://public-gateway.example.com",
        pairingCode: "AAAA-BBBB-CCCC",
        tls: { mode: "system" },
      });
      expect(decodePairingPayload(JSON.stringify(built))).toEqual({ ok: true, payload: built });
    });

    it("separately binds a strict public key and never treats a leaf hash as a key hash", () => {
      const payload = buildPairingPayloadV4({
        gatewayUrl: "https://gateway.example.test",
        pairingCode: "fictional-pairing-code",
        tls: { mode: "pinned-key-strict", spkiFingerprint: FINGERPRINT },
      });
      expect(decodePairingPayload(JSON.stringify(payload))).toEqual({ ok: true, payload });
      for (const tls of [
        { mode: "pinned-key-strict", fingerprint: FINGERPRINT },
        { mode: "pinned-key-strict", spkiFingerprint: 2 },
        { mode: "pinned-key-strict", spkiFingerprint: "bad" },
      ]) {
        expect(decodePairingPayload(JSON.stringify({ ...payload, tls })).ok).toBe(false);
      }
    });

    it("round-trips pinned-leaf trust", () => {
      const built = buildPairingPayloadV4({
        gatewayUrl: "https://gateway.example.com",
        pairingCode: "AAAA-BBBB-CCCC",
        tls: { mode: "pinned-leaf", fingerprint: FINGERPRINT },
      });
      expect(decodePairingPayload(JSON.stringify(built))).toEqual({ ok: true, payload: built });
    });

    it("preserves strict relay pins and refuses missing pins or plaintext downgrade", () => {
      const payload = buildPairingPayloadV4({
        gatewayUrl: "https://gateway.example.com",
        pairingCode: "AAAA-BBBB-CCCC",
        tls: { mode: "pinned-leaf-strict", fingerprint: FINGERPRINT },
      });
      expect(decodePairingPayload(JSON.stringify(payload))).toEqual({ ok: true, payload });
      for (const candidate of [
        { ...payload, tls: { mode: "pinned-leaf-strict" } },
        { ...payload, tls: { mode: "pinned-leaf-strict", fingerprint: "invalid" } },
        { ...payload, gatewayUrl: "http://gateway.example.com" },
      ])
        expect(decodePairingPayload(JSON.stringify(candidate)).ok).toBe(false);
    });

    it("rejects system trust over plaintext HTTP", () => {
      const result = decodePairingPayload(
        JSON.stringify({
          v: 4,
          gatewayUrl: "http://public-gateway.example.com",
          pairingCode: "AAAA-BBBB-CCCC",
          tls: { mode: "system" },
        }),
      );
      expect(result).toEqual({ ok: false, error: { kind: "invalid-scheme", scheme: "http" } });
    });

    it("rejects pinned-leaf trust over plaintext HTTP", () => {
      const result = decodePairingPayload(
        JSON.stringify({
          v: 4,
          gatewayUrl: "http://gateway.example.com",
          pairingCode: "AAAA-BBBB-CCCC",
          tls: { mode: "pinned-leaf", fingerprint: FINGERPRINT },
        }),
      );
      expect(result).toEqual({ ok: false, error: { kind: "invalid-scheme", scheme: "http" } });
    });

    it("rejects an unknown trust mode and a missing pinned fingerprint", () => {
      const base = {
        v: 4,
        gatewayUrl: "https://public-gateway.example.com",
        pairingCode: "AAAA-BBBB-CCCC",
      };
      expect(decodePairingPayload(JSON.stringify({ ...base, tls: { mode: "other" } }))).toEqual({
        ok: false,
        error: { kind: "invalid-shape", detail: "unknown TLS trust mode" },
      });
      expect(
        decodePairingPayload(JSON.stringify({ ...base, tls: { mode: "pinned-leaf" } })),
      ).toEqual({ ok: false, error: { kind: "missing-field", field: "tls.fingerprint" } });
    });
  });

  describe("decodePairingPayload — V2", () => {
    it("accepts a well-formed V2 payload", () => {
      const result = decodePairingPayload(
        JSON.stringify({ v: 2, gatewayUrl: "http://localhost:7600", pairingCode: "code123" }),
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.payload.v).toBe(2);
      }
    });

    it("trims surrounding whitespace before parsing", () => {
      const result = decodePairingPayload(
        '   {"v":2,"gatewayUrl":"http://localhost:7600","pairingCode":"x"}\n',
      );
      expect(result.ok).toBe(true);
    });

    it("rejects an unparseable JSON body", () => {
      const result = decodePairingPayload("not json {{{");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("invalid-json");
    });

    it("rejects a non-object top-level value", () => {
      const result = decodePairingPayload("[]");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("invalid-shape");
    });

    it("rejects a missing version field", () => {
      const result = decodePairingPayload(
        JSON.stringify({ gatewayUrl: "http://localhost:7600", pairingCode: "x" }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("invalid-shape");
    });

    it("rejects an unsupported version", () => {
      const result = decodePairingPayload(JSON.stringify({ v: 99 }));
      expect(result.ok).toBe(false);
      if (!result.ok && result.error.kind === "unsupported-version") {
        expect(result.error.version).toBe(99);
      } else {
        throw new Error("expected unsupported-version error");
      }
    });

    it("rejects V2 with missing gatewayUrl", () => {
      const result = decodePairingPayload(JSON.stringify({ v: 2, pairingCode: "x" }));
      expect(result.ok).toBe(false);
      if (!result.ok && result.error.kind === "missing-field") {
        expect(result.error.field).toBe("gatewayUrl");
      } else {
        throw new Error("expected missing-field gatewayUrl");
      }
    });

    it("rejects V2 with empty pairingCode", () => {
      const result = decodePairingPayload(
        JSON.stringify({ v: 2, gatewayUrl: "http://localhost", pairingCode: "" }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok && result.error.kind === "missing-field") {
        expect(result.error.field).toBe("pairingCode");
      } else {
        throw new Error("expected missing-field pairingCode");
      }
    });

    it("rejects V2 with an unparseable gatewayUrl", () => {
      const result = decodePairingPayload(
        JSON.stringify({ v: 2, gatewayUrl: "not a url", pairingCode: "x" }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("invalid-url");
    });
  });

  describe("buildPairingPayloadV3 + decode — V3 (canonical, TLS-pinned)", () => {
    it("produces a V3 envelope carrying the leaf-cert fingerprint", () => {
      const p = buildPairingPayloadV3({
        gatewayUrl: "https://mac.local:7600",
        pairingCode: "1A2B-3C4D-5E",
        fingerprint: FINGERPRINT,
      });
      expect(p.v).toBe(3);
      expect(p.gatewayUrl).toBe("https://mac.local:7600");
      expect(p.pairingCode).toBe("1A2B-3C4D-5E");
      expect(p.fingerprint).toBe(FINGERPRINT);
    });

    it("JSON.stringify round-trips through decodePairingPayload", () => {
      const built = buildPairingPayloadV3({
        gatewayUrl: "https://10.0.0.5:7600",
        pairingCode: "AAAA-BBBB-CCCC",
        fingerprint: FINGERPRINT,
      });
      const result = decodePairingPayload(JSON.stringify(built));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.payload).toEqual(built);
      }
    });

    it("rejects V3 with a missing fingerprint", () => {
      const result = decodePairingPayload(
        JSON.stringify({ v: 3, gatewayUrl: "https://localhost:7600", pairingCode: "x" }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok && result.error.kind === "missing-field") {
        expect(result.error.field).toBe("fingerprint");
      } else {
        throw new Error("expected missing-field fingerprint");
      }
    });

    it("rejects V3 with a malformed fingerprint (wrong length / non-hex)", () => {
      const result = decodePairingPayload(
        JSON.stringify({
          v: 3,
          gatewayUrl: "https://localhost:7600",
          pairingCode: "x",
          fingerprint: "NOTHEX",
        }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("invalid-fingerprint");
    });

    it("rejects V3 with a disallowed gatewayUrl scheme", () => {
      const result = decodePairingPayload(
        JSON.stringify({
          v: 3,
          gatewayUrl: "ftp://localhost:7600",
          pairingCode: "x",
          fingerprint: FINGERPRINT,
        }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok && result.error.kind === "invalid-scheme") {
        expect(result.error.scheme).toBe("ftp");
      } else {
        throw new Error("expected invalid-scheme error");
      }
    });
  });

  describe("decodePairingPayload — V1 (legacy)", () => {
    it("accepts a well-formed V1 payload", () => {
      const result = decodePairingPayload(
        JSON.stringify({
          v: 1,
          url: "http://mac.local:7600",
          token: "tok_abc",
          accountId: "user@example.com",
          name: "iPhone Perso",
        }),
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.payload.v).toBe(1);
      }
    });

    it("rejects V1 missing token", () => {
      const result = decodePairingPayload(
        JSON.stringify({ v: 1, url: "http://x", accountId: "y", name: "z" }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok && result.error.kind === "missing-field") {
        expect(result.error.field).toBe("token");
      } else {
        throw new Error("expected missing-field token");
      }
    });
  });
});

describe("malformed pairing envelopes across retained versions", () => {
  it("refuses primitive envelopes, absent TLS policies, incomplete exchanges and unsafe schemes", () => {
    for (const value of [null, true, 42, "text"]) {
      expect(decodePairingPayload(JSON.stringify(value))).toMatchObject({
        ok: false,
        error: { kind: "invalid-shape" },
      });
    }
    const valid = {
      v: 4,
      gatewayUrl: "https://gateway.example.test",
      pairingCode: "fictional",
      tls: { mode: "system" },
    };
    for (const tls of [undefined, null, "system", {}]) {
      expect(decodePairingPayload(JSON.stringify({ ...valid, tls }))).toEqual({
        ok: false,
        error: { kind: "missing-field", field: "tls" },
      });
    }
    for (const field of ["gatewayUrl", "pairingCode"] as const) {
      for (const invalid of [undefined, ""]) {
        expect(decodePairingPayload(JSON.stringify({ ...valid, [field]: invalid }))).toEqual({
          ok: false,
          error: { kind: "missing-field", field },
        });
      }
    }
    expect(decodePairingPayload(JSON.stringify({ ...valid, gatewayUrl: "bad" }))).toMatchObject({
      ok: false,
      error: { kind: "invalid-url" },
    });
    expect(
      decodePairingPayload(JSON.stringify({ ...valid, gatewayUrl: "ftp://gateway.example.test" })),
    ).toMatchObject({ ok: false, error: { kind: "invalid-scheme", scheme: "ftp" } });
  });
  it("validates every retained legacy envelope before exposing credentials", () => {
    for (const v of [2, 3]) {
      const valid = {
        v,
        gatewayUrl: "https://gateway.example.test",
        pairingCode: "fictional",
        fingerprint: FINGERPRINT,
      };
      for (const field of ["gatewayUrl", "pairingCode"] as const) {
        for (const invalid of [undefined, ""]) {
          expect(decodePairingPayload(JSON.stringify({ ...valid, [field]: invalid }))).toEqual({
            ok: false,
            error: { kind: "missing-field", field },
          });
        }
      }
      expect(decodePairingPayload(JSON.stringify({ ...valid, gatewayUrl: "bad" }))).toMatchObject({
        ok: false,
        error: { kind: "invalid-url" },
      });
      expect(
        decodePairingPayload(
          JSON.stringify({ ...valid, gatewayUrl: "ftp://gateway.example.test" }),
        ),
      ).toMatchObject({ ok: false, error: { kind: "invalid-scheme", scheme: "ftp" } });
    }
    const valid = {
      v: 1,
      url: "https://gateway.example.test",
      token: "fictional-token",
      accountId: "fictional-account",
      name: "Fictional phone",
    };
    for (const field of ["url", "accountId", "name"] as const) {
      expect(decodePairingPayload(JSON.stringify({ ...valid, [field]: undefined }))).toEqual({
        ok: false,
        error: { kind: "missing-field", field },
      });
    }
    expect(decodePairingPayload(JSON.stringify({ ...valid, url: "bad" }))).toMatchObject({
      ok: false,
      error: { kind: "invalid-url" },
    });
    expect(
      decodePairingPayload(JSON.stringify({ ...valid, url: "ftp://gateway.example.test" })),
    ).toMatchObject({ ok: false, error: { kind: "invalid-scheme", scheme: "ftp" } });
  });
});
