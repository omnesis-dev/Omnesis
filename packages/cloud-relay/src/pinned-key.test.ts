// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFileSync } from "node:fs";
import { X509Certificate } from "node:crypto";
import { expect, test } from "vitest";
import { malformedDateCertificate } from "../test/support.js";
import { tlsSpkiFingerprint, verifyPinnedGatewayKey } from "./pinned-key.js";
import type { PeerCertificate } from "node:tls";
const fixture = JSON.parse(
  readFileSync(new URL("../test/identity-vectors.json", import.meta.url), "utf8"),
);
const certificate = new X509Certificate(fixture.gateway.certificate);
const hostname = new URL(fixture.gateway.publicOrigin).hostname;
const peer = certificate.toLegacyObject() as PeerCertificate;

test("a pin names the actual leaf SPKI, never its DER hash or an unrelated chain certificate", () => {
  const pin = tlsSpkiFingerprint(certificate.raw);
  expect(pin).toMatch(/^[a-f0-9]{64}$/);
  expect(pin).not.toBe(fixture.fingerprint);
  expect(() => verifyPinnedGatewayKey(hostname, peer, pin, fixture.clock * 1000)).not.toThrow();
  expect(() =>
    verifyPinnedGatewayKey(hostname, peer, "a".repeat(64), fixture.clock * 1000),
  ).toThrow("key pin mismatch");
  expect(() => verifyPinnedGatewayKey(hostname, peer, "invalid", fixture.clock * 1000)).toThrow(
    "Invalid",
  );
  expect(() =>
    verifyPinnedGatewayKey("attacker.example.test", peer, pin, fixture.clock * 1000),
  ).toThrow();
});

test("stable key pins still reject expired future and malformed certificate dates", () => {
  const pin = tlsSpkiFingerprint(certificate.raw);
  for (const now of [NaN, Date.parse(certificate.validFrom) - 1, Date.parse(certificate.validTo)])
    expect(() => verifyPinnedGatewayKey(hostname, peer, pin, now)).toThrow("validity");
  for (const field of ["from", "to"] as const) {
    const malformed = new X509Certificate(
      malformedDateCertificate(fixture.gateway.certificate, field),
    );
    expect(() =>
      verifyPinnedGatewayKey(hostname, { ...peer, raw: malformed.raw }, pin, fixture.clock * 1000),
    ).toThrow("validity");
  }
});

test("RSA EC and Ed25519 shared vectors use the same full-SPKI digest and canonical hostname contract", () => {
  for (const vector of fixture.spkiVectors) {
    const cert = new X509Certificate(vector.certificate);
    expect(tlsSpkiFingerprint(cert.raw)).toBe(vector.spkiFingerprint);
    const expectedHostname = vector.algorithm === "RSA-2048" ? hostname : "gateway.example.test";
    expect(() =>
      verifyPinnedGatewayKey(
        expectedHostname,
        cert.toLegacyObject(),
        vector.spkiFingerprint,
        Math.floor((Date.parse(cert.validFrom) + Date.parse(cert.validTo)) / 2),
      ),
    ).not.toThrow();
  }
});
