// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { connect, rootCertificates } from "node:tls";
import { bindingOrigin, certificateFingerprint, type GatewayBinding } from "./gateway-binding.js";

// DER encoding of OID 1.3.6.1.4.1.11129.2.4.2, the embedded SCT list.
const SCT_EXTENSION = Buffer.from("060a2b06010401d679020402", "hex");

/** The extension's presence is enough: a browser-trusted CA only embeds SCTs it obtained from logs. */
export function hasEmbeddedSct(certificate: Buffer): boolean {
  return certificate.includes(SCT_EXTENSION);
}

/**
 * First contact only: is this exact certificate one the public web would trust,
 * and therefore visible in public logs? A false answer never fails pairing; it
 * makes the device ask for the human comparison instead.
 */
export async function certificateIsPubliclyLogged(
  candidate: Pick<GatewayBinding, "publicOrigin" | "certificate">,
  signal: AbortSignal,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const origin = bindingOrigin(candidate.publicOrigin);
  const fingerprint = certificateFingerprint(candidate.certificate);
  const extra = env.OMNESIS_CLOUD_RELAY_GATEWAY_CA_FILE;
  const socket = connect({
    host: origin.hostname,
    port: Number(origin.port) || 443,
    servername: origin.hostname,
    // Verified as the public web would: an untrusted chain or name fails the
    // handshake, which reads as "not publicly logged" below.
    ...(extra ? { ca: [...rootCertificates, await readFile(extra, "utf8")] } : {}),
  });
  try {
    await once(socket, "secureConnect", {
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    });
    const peer = socket.getPeerCertificate();
    return (
      socket.authorized &&
      peer.fingerprint256?.replaceAll(":", "").toLowerCase() === fingerprint &&
      hasEmbeddedSct(peer.raw)
    );
  } catch {
    return false;
  } finally {
    socket.destroy();
  }
}
