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

/**
 * The certificate an installation pinned when it was connected.
 *
 * Deliberately carries no `mode` key: plugins already in the field read this
 * shape strictly and rewrite the whole file on every OAuth rotation, so a
 * pinned file must stay byte-compatible with what they expect.
 */
export const pinnedTlsTrustSchema = z
  .object({
    caPem: z.string().min(1),
    leafFingerprintSha256: fingerprintSchema,
  })
  .strict();

/**
 * Ordinary system-root and hostname verification, for a gateway addressed by a
 * DNS name whose certificate a public CA issued. A renewal changes nothing.
 */
export const systemTlsTrustSchema = z.object({ mode: z.literal("system") }).strict();

export const tlsTrustSchema = z.union([systemTlsTrustSchema, pinnedTlsTrustSchema]);

export type TlsTrust = z.input<typeof tlsTrustSchema>;
export type PinnedTlsTrust = z.input<typeof pinnedTlsTrustSchema>;

/**
 * How a client verifies the gateway, as it reports it in its hello: by name
 * under public roots, or pinned to a certificate that either cannot issue
 * others (`pinned-leaf`) or could (`pinned-ca`).
 */
export type TlsTrustMode = "system" | "pinned-leaf" | "pinned-ca";

export function isSystemTrust(trust: TlsTrust): trust is { mode: "system" } {
  return "mode" in trust;
}

/** The pinned certificate, or null for system trust. */
export function pinnedTrust(trust: TlsTrust): PinnedTlsTrust | null {
  return "mode" in trust ? null : trust;
}

export class TlsPinError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TlsPinError";
  }
}

/**
 * Node's certificate verification codes, each with the cause it is described
 * by. `null` describes the code in terms of the trust this installation holds.
 */
const TLS_FAILURE_CAUSES: Readonly<Record<string, string | null>> = {
  DEPTH_ZERO_SELF_SIGNED_CERT: null,
  SELF_SIGNED_CERT_IN_CHAIN: null,
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: null,
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: null,
  INVALID_CA: null,
  INVALID_PURPOSE: null,
  KEYUSAGE_NO_CERTSIGN: null,
  CERT_UNTRUSTED: null,
  CERT_REJECTED: null,
  CERT_HAS_EXPIRED: "its certificate has expired",
  CERT_NOT_YET_VALID: "its certificate is not yet valid on this machine's clock",
  ERR_TLS_CERT_ALTNAME_INVALID: "its certificate does not cover the name this installation uses",
};

export interface TlsFailureContext {
  gatewayUrl: string;
  harness: string;
}

/**
 * The gateway's certificate could not be verified with the trust this
 * installation holds. The message is written for the operator who will read
 * it in an agent's reply or a log line: what went wrong, and the one command
 * on this machine that repairs it.
 */
export class GatewayTlsError extends Error {
  constructor(
    message: string,
    /** Node's verification code, when the failure carried one. */
    readonly code?: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "GatewayTlsError";
  }
}

function describeTlsFailure(
  context: TlsFailureContext,
  cause: string,
  code: string | undefined,
): string {
  const gateway = `the Omnesis gateway at ${context.gatewayUrl}`;
  if (code === "CERT_HAS_EXPIRED" || code === "CERT_NOT_YET_VALID") {
    return (
      `Omnesis is unreachable over TLS: ${gateway} was refused because ${cause}. ` +
      "Renew it on the gateway host (`omnesis tls status` there says how)."
    );
  }
  return (
    `Omnesis is unreachable over TLS: ${gateway} was refused because ${cause}. ` +
    `Run \`omnesis connect ${context.harness} --refresh\` on this machine to trust its current ` +
    `certificate, adding \`--trust-fingerprint sha256:<fingerprint>\` with the fingerprint ` +
    "`omnesis tls status` prints on the gateway host to run it unattended."
  );
}

/**
 * Turn a certificate failure into a {@link GatewayTlsError}, walking the
 * error's causes; null for anything that is not a certificate failure.
 */
export function classifyTlsFailure(
  error: unknown,
  context: TlsFailureContext,
): GatewayTlsError | null {
  let current: unknown = error;
  for (let depth = 0; depth < 10 && current && typeof current === "object"; depth += 1) {
    if (current instanceof GatewayTlsError) return current;
    if (current instanceof TlsPinError) {
      return new GatewayTlsError(
        describeTlsFailure(
          context,
          "it presents a certificate other than the one this installation pinned",
          undefined,
        ),
        undefined,
        { cause: error },
      );
    }
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && Object.hasOwn(TLS_FAILURE_CAUSES, code)) {
      const cause =
        TLS_FAILURE_CAUSES[code] ?? "its certificate is not one this installation trusts";
      return new GatewayTlsError(describeTlsFailure(context, cause, code), code, {
        cause: error,
      });
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
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
 * Node TLS options that trust exactly one pinned certificate. Normal
 * hostname validation runs first, then the exact leaf pin.
 */
export function pinnedTlsOptions(hostname: string, trust: PinnedTlsTrust): ConnectionOptions {
  const parsed = pinnedTlsTrustSchema.parse(trust);
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
