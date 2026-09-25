// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What the gateway's TLS material is, and what state it is in.
 *
 * Pure over PEM text and a clock: the gateway inspects what it serves, the
 * doctor reports it, and the CLI prints it, all from the same answer. Nothing
 * here reads the network or writes a file.
 *
 * Ownership is read off the material's path. The gateway mints its own
 * self-signed pair at `<configDir>/tls/{cert,key}.pem`; the installer and
 * `omnesis tls provision` mint the two browser-trusted tiers at
 * `tls/tailscale.{crt,key}` and `tls/mkcert.{crt,key}`. Anything else is an
 * operator's own material: inspected and reported, never renewed or replaced
 * by Omnesis.
 */

import { X509Certificate, createHash, createPrivateKey } from "node:crypto";
import { isIP } from "node:net";
import { join, resolve } from "node:path";

/** Who minted the served certificate, and therefore who may renew it. */
export type TlsOwnership = "self-signed" | "tailscale" | "mkcert" | "external";

export type TlsMaterialState =
  | "valid"
  | "expiring"
  | "expired"
  | "not-yet-valid"
  | "key-mismatch"
  | "unreadable";

export interface TlsMaterialInspection {
  state: TlsMaterialState;
  /** What made the material unreadable or its key mismatched; absent otherwise. */
  error?: string;
  /** Hex SHA-256 of the certificate's DER bytes; null when it did not parse. */
  fingerprintSha256: string | null;
  subject: string | null;
  issuer: string | null;
  /** Issued by its own key: nothing but a pin or a saved copy can trust it. */
  selfSigned: boolean;
  notBefore: string | null;
  notAfter: string | null;
  /** Whole days until `notAfter`; negative once expired; null when unreadable. */
  daysRemaining: number | null;
  /** DNS names and IP addresses the certificate covers, as written in it. */
  names: string[];
  /** Hosts the gateway is addressed by that the certificate does not cover. */
  uncoveredHosts: string[];
}

export interface InspectTlsMaterialInput {
  certPem: string;
  /** The private key that should belong to the certificate, when known. */
  keyPem?: string | null;
  /** The clock, in epoch milliseconds. */
  now: number;
  /** A certificate within this many days of `notAfter` is `expiring`. */
  renewBeforeDays: number;
  /** Hostnames and IP literals the gateway is reached at. */
  requiredHosts?: readonly string[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Hex SHA-256 fingerprint of a parsed certificate's DER bytes. */
export function certificateFingerprintSha256(cert: X509Certificate): string {
  return createHash("sha256").update(cert.raw).digest("hex");
}

/** The DNS and IP entries of a certificate's subjectAltName, without their tags. */
export function certificateNames(cert: X509Certificate): string[] {
  const san = cert.subjectAltName;
  if (!san) return [];
  const names: string[] = [];
  for (const entry of san.split(",")) {
    const trimmed = entry.trim();
    const dns = /^DNS:(.+)$/u.exec(trimmed);
    if (dns) {
      names.push(dns[1]!);
      continue;
    }
    const ip = /^IP Address:(.+)$/u.exec(trimmed);
    if (ip) names.push(ip[1]!);
  }
  return names;
}

/** Normalize a host for coverage checks: lowercase, no brackets, no trailing dot. */
export function normalizeRequiredHost(host: string): string {
  let value = host.trim().toLowerCase();
  if (value.startsWith("[") && value.endsWith("]")) value = value.slice(1, -1);
  if (value.endsWith(".")) value = value.slice(0, -1);
  return value;
}

/** Does the certificate cover this host, by DNS name (wildcards included) or IP literal? */
export function certificateCoversHost(cert: X509Certificate, host: string): boolean {
  const value = normalizeRequiredHost(host);
  if (!value) return true;
  if (isIP(value)) return cert.checkIP(value) !== undefined;
  return cert.checkHost(value, { subject: "default" }) !== undefined;
}

/**
 * Signed with its own key. `checkIssued` is not the test: it also demands a
 * CA-shaped issuer, which a leaf that signed itself never is.
 */
function signedByOwnKey(cert: X509Certificate): boolean {
  try {
    return cert.verify(cert.publicKey);
  } catch {
    return false;
  }
}

export function inspectTlsMaterial(input: InspectTlsMaterialInput): TlsMaterialInspection {
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(input.certPem);
  } catch (err) {
    return {
      state: "unreadable",
      error: `The certificate did not parse: ${err instanceof Error ? err.message : String(err)}`,
      fingerprintSha256: null,
      subject: null,
      issuer: null,
      selfSigned: false,
      notBefore: null,
      notAfter: null,
      daysRemaining: null,
      names: [],
      uncoveredHosts: [],
    };
  }

  const notBeforeMs = Date.parse(cert.validFrom);
  const notAfterMs = Date.parse(cert.validTo);
  const names = certificateNames(cert);
  const required = [...new Set((input.requiredHosts ?? []).map(normalizeRequiredHost))].filter(
    (host) => host.length > 0,
  );
  const uncoveredHosts = required.filter((host) => !certificateCoversHost(cert, host));
  const base: Omit<TlsMaterialInspection, "state" | "error"> = {
    fingerprintSha256: certificateFingerprintSha256(cert),
    subject: cert.subject,
    issuer: cert.issuer,
    selfSigned: signedByOwnKey(cert),
    notBefore: Number.isFinite(notBeforeMs) ? new Date(notBeforeMs).toISOString() : null,
    notAfter: Number.isFinite(notAfterMs) ? new Date(notAfterMs).toISOString() : null,
    daysRemaining: Number.isFinite(notAfterMs)
      ? Math.floor((notAfterMs - input.now) / DAY_MS)
      : null,
    names,
    uncoveredHosts,
  };

  if (input.keyPem) {
    try {
      if (!cert.checkPrivateKey(createPrivateKey(input.keyPem))) {
        return {
          ...base,
          state: "key-mismatch",
          error: "The private key does not belong to the certificate.",
        };
      }
    } catch (err) {
      return {
        ...base,
        state: "key-mismatch",
        error: `The private key did not parse: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  if (!Number.isFinite(notBeforeMs) || !Number.isFinite(notAfterMs)) {
    return {
      ...base,
      state: "unreadable",
      error: "The certificate carries no readable validity period.",
    };
  }
  if (input.now < notBeforeMs) return { ...base, state: "not-yet-valid" };
  if (input.now >= notAfterMs) return { ...base, state: "expired" };
  if (notAfterMs - input.now <= input.renewBeforeDays * DAY_MS)
    return { ...base, state: "expiring" };
  return { ...base, state: "valid" };
}

export interface TlsMaterialPaths {
  configDir: string;
  /** `OMNESIS_TLS_CERT`, when set. */
  certPath?: string | null;
  /** `OMNESIS_TLS_KEY`, when set. */
  keyPath?: string | null;
}

export interface ResolvedTlsMaterial {
  ownership: TlsOwnership;
  certPath: string;
  keyPath: string;
}

/**
 * Where the served material lives and who owns it. Without the env override
 * the gateway serves its own self-signed pair; the two installer tiers are
 * recognised by their fixed paths under the config directory's `tls/`; any
 * other pair is the operator's.
 */
export function resolveTlsMaterial(paths: TlsMaterialPaths): ResolvedTlsMaterial {
  const tlsDir = join(paths.configDir, "tls");
  if (!paths.certPath || !paths.keyPath) {
    return {
      ownership: "self-signed",
      certPath: join(tlsDir, "cert.pem"),
      keyPath: join(tlsDir, "key.pem"),
    };
  }
  const certPath = resolve(paths.certPath);
  const keyPath = resolve(paths.keyPath);
  const tier = (cert: string, key: string): boolean =>
    certPath === resolve(join(tlsDir, cert)) && keyPath === resolve(join(tlsDir, key));
  if (tier("cert.pem", "key.pem")) return { ownership: "self-signed", certPath, keyPath };
  if (tier("tailscale.crt", "tailscale.key")) return { ownership: "tailscale", certPath, keyPath };
  if (tier("mkcert.crt", "mkcert.key")) return { ownership: "mkcert", certPath, keyPath };
  return { ownership: "external", certPath, keyPath };
}

/** How the served material gets renewed. */
export type TlsRenewalMode =
  /** This gateway re-mints it in-process before it expires. */
  | "automatic"
  /** Renewed on the host outside this container; the gateway activates what appears on disk. */
  | "host"
  /** Operator-managed: inspected and reported, never renewed by Omnesis. */
  | "external"
  /** Omnesis-managed, but automatic renewal is switched off in the config. */
  | "disabled";

/** What `GET /status` and the doctor carry about the served certificate. */
export interface TlsLifecycleSnapshot {
  checkedAt: string;
  ownership: TlsOwnership;
  certPath: string;
  keyPath: string;
  served: TlsMaterialInspection;
  /**
   * Material on disk that differs from what is served and could not be
   * activated, with the reason; null when disk and process agree.
   */
  pendingReplacement: { fingerprintSha256: string | null; error: string } | null;
  renewal: {
    mode: TlsRenewalMode;
    renewBeforeDays: number;
    lastAttemptAt: string | null;
    lastError: string | null;
    lastRenewedAt: string | null;
  };
  /** The last time the served fingerprint changed, for clients that pinned the old one. */
  rotation: { previousFingerprintSha256: string; rotatedAt: string } | null;
  /**
   * Hosts the gateway is addressed by that a trusted reverse proxy serves
   * with its own certificate, so this certificate need not cover them.
   * Optional on the wire; readers treat absence as an empty list.
   */
  proxiedHosts?: string[];
}
