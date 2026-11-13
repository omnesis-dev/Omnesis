// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash, X509Certificate } from "node:crypto";
import { isIP } from "node:net";
import { z } from "zod";
import { accountId, type IdentityProvider } from "./identity.js";

export const gatewayBindingSchema = z
  .object({
    gatewayId: z.string().uuid(),
    publicOrigin: z.string().max(2048),
    certificate: z.string().min(1).max(16_384),
    identityToken: z.string().min(1).max(16_384),
  })
  .strict();
export type GatewayBinding = z.infer<typeof gatewayBindingSchema>;

export function bindingOrigin(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    isIP(url.hostname) !== 0 ||
    !url.hostname.includes(".") ||
    !url.hostname.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  )
    throw new Error("Gateway binding requires a DNS HTTPS origin");
  return url;
}

export function certificateFingerprint(certificate: string): string {
  return createHash("sha256").update(new X509Certificate(certificate).raw).digest("hex");
}

/** Google signs this nonce during owner sign-in; a directory cannot substitute its own key. */
export function gatewayBindingNonce(binding: Omit<GatewayBinding, "identityToken">): string {
  const origin = bindingOrigin(binding.publicOrigin);
  z.string().uuid().parse(binding.gatewayId);
  const certificate = new X509Certificate(binding.certificate);
  if (certificate.toString().trim() !== binding.certificate.trim())
    throw new Error("Only a public leaf certificate may be published");
  if (!certificate.checkHost(origin.hostname))
    throw new Error("Certificate does not cover gateway host");
  return createHash("sha256")
    .update(
      JSON.stringify([
        "omnesis-gateway-tls-v2",
        binding.gatewayId,
        origin.origin,
        certificateFingerprint(binding.certificate),
      ]),
    )
    .digest("base64url");
}

export function validateCertificateDates(certificate: X509Certificate): void {
  const from = Date.parse(certificate.validFrom),
    to = Date.parse(certificate.validTo);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > Date.now() || to <= Date.now())
    throw new Error("Gateway certificate is outside its validity interval");
}

/** Run independently at the client, never trust a relay's claim that it verified Google. */
export async function verifyGatewayBinding(
  value: unknown,
  expectedAccountId: string,
  gatewayIdentity: IdentityProvider,
): Promise<GatewayBinding & { fingerprint: string }> {
  const binding = gatewayBindingSchema.parse(value);
  const owner = await gatewayIdentity.verify(binding.identityToken, gatewayBindingNonce(binding));
  if (accountId(owner) !== expectedAccountId) throw new Error("Gateway belongs to another account");
  const certificate = new X509Certificate(binding.certificate);
  validateCertificateDates(certificate);
  return {
    ...binding,
    publicOrigin: bindingOrigin(binding.publicOrigin).origin,
    fingerprint: certificateFingerprint(binding.certificate),
  };
}
