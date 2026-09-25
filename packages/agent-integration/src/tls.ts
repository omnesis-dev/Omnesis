// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash, X509Certificate } from "node:crypto";
import { isIP } from "node:net";
import { checkServerIdentity, type ConnectionOptions, type PeerCertificate } from "node:tls";
import { z } from "zod";

const fingerprintSchema = z
  .string()
  .transform((value) => value.replaceAll(":", "").toLowerCase())
  .pipe(z.string().regex(/^[0-9a-f]{64}$/, "expected a SHA-256 certificate fingerprint"));

export const tlsTrustSchema = z
  .object({
    caPem: z.string().min(1),
    leafFingerprintSha256: fingerprintSchema,
  })
  .strict();

export type TlsTrust = z.input<typeof tlsTrustSchema>;

export class TlsPinError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TlsPinError";
  }
}

export function normalizeFingerprint(value: string): string {
  return fingerprintSchema.parse(value);
}

export function certificateFingerprint(raw: Uint8Array): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function verifyPeerFingerprint(raw: Uint8Array | undefined, expected: string): void {
  if (!raw || raw.byteLength === 0) {
    throw new TlsPinError("gateway did not present a leaf certificate");
  }
  const actual = certificateFingerprint(raw);
  const normalized = normalizeFingerprint(expected);
  if (actual !== normalized) {
    throw new TlsPinError(
      `gateway TLS leaf fingerprint mismatch (expected ${normalized}, received ${actual})`,
    );
  }
}

function isLoopback(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host === "::1") return true;
  return isIP(host) === 4 && host.startsWith("127.");
}

export function validateGatewayUrl(gatewayUrl: string): URL {
  const url = new URL(gatewayUrl);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("gateway URL must not include credentials, query parameters, or a fragment");
  }
  if (url.protocol === "http:" && isLoopback(url.hostname)) return url;
  if (url.protocol !== "https:") {
    throw new Error("remote agent integrations require HTTPS");
  }
  return url;
}

/** Resolve the MCP endpoint without discarding a reverse-proxy path prefix. */
export function mcpEndpointUrl(gatewayUrl: string | URL): URL {
  const base = validateGatewayUrl(gatewayUrl.toString());
  return new URL(`${base.href.replace(/\/+$/u, "")}/mcp`);
}

/**
 * Node TLS options shared by the HTTPS ingestion client and WSS delivery
 * socket. Normal CA/hostname validation runs first, then the exact leaf pin.
 */
export function pinnedTlsOptions(hostname: string, trust: TlsTrust): ConnectionOptions {
  const parsed = tlsTrustSchema.parse(trust);
  // Fail before opening a socket when the configured PEM is malformed.
  new X509Certificate(parsed.caPem);
  return {
    ca: parsed.caPem,
    allowPartialTrustChain: true,
    rejectUnauthorized: true,
    checkServerIdentity(host, cert) {
      const hostnameError = checkServerIdentity(host || hostname, cert);
      if (hostnameError) return hostnameError;
      try {
        verifyPeerFingerprint((cert as PeerCertificate).raw, parsed.leafFingerprintSha256);
        return undefined;
      } catch (error) {
        return error instanceof Error ? error : new TlsPinError(String(error));
      }
    },
  };
}

export function websocketUrl(gatewayUrl: string): URL {
  const url = validateGatewayUrl(gatewayUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}/device/ws`;
  return url;
}
