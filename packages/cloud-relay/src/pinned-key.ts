// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash, X509Certificate } from "node:crypto";
import { checkServerIdentity, type PeerCertificate } from "node:tls";

/** A TLS peer failed the saved identity, before any application bytes were sent. */
export class GatewayTlsIdentityRefused extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

export function tlsSpkiFingerprint(certificate: string | Buffer): string {
  return createHash("sha256")
    .update(new X509Certificate(certificate).publicKey.export({ type: "spki", format: "der" }))
    .digest("hex");
}

/** A gateway must prove its pinned leaf key in TLS, name the canonical hostname, and be current. */
export function verifyPinnedGatewayKey(
  hostname: string,
  peer: PeerCertificate,
  pin: string,
  now = Date.now(),
): void {
  if (!/^[a-f0-9]{64}$/.test(pin)) throw new Error("Invalid gateway public key pin");
  const identityError = checkServerIdentity(hostname, peer);
  if (identityError) throw new GatewayTlsIdentityRefused("Gateway certificate hostname mismatch");
  const certificate = new X509Certificate(peer.raw);
  const from = Date.parse(certificate.validFrom),
    until = Date.parse(certificate.validTo);
  if (
    !Number.isFinite(now) ||
    !Number.isFinite(from) ||
    !Number.isFinite(until) ||
    from > now ||
    until <= now
  )
    throw new GatewayTlsIdentityRefused("Gateway certificate validity check failed");
  if (tlsSpkiFingerprint(peer.raw) !== pin)
    throw new GatewayTlsIdentityRefused("Gateway public key pin mismatch");
}
