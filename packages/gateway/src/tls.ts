// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * TLS bundle resolution for the gateway.
 *
 * Resolves a self-signed cert + key pair the gateway will serve HTTPS with.
 * iOS pins the SHA-256 fingerprint we bake into the QR pairing payload (TOFU).
 *
 * Why we shell out to `openssl` for cert generation
 * ─────────────────────────────────────────────────
 * The user resolution was emphatic: NO third-party cert lib
 * (rules out `selfsigned`, `node-forge`, etc.). Pure `node:crypto` does
 * everything we need to load + parse + fingerprint X.509 certs (the
 * `crypto.X509Certificate` class and `createPrivateKey()` are stdlib),
 * but it does NOT expose a sign-cert primitive. Hand-rolling a TBSCertificate
 * in DER ASN.1 is several hundred lines of error-prone boilerplate.
 *
 * The pragmatic answer: spawn the OS `openssl` binary, which is present on
 * every supported gateway host (macOS ships LibreSSL at /usr/bin/openssl;
 * Linux distros all have openssl). One-shot at first boot, output goes to
 * disk under <configDir>/tls/, subsequent boots load from disk. ~80 LOC
 * total, no supply chain surface, no manual ASN.1.
 */

import { execFileSync } from "node:child_process";
import { X509Certificate, createHash, createPrivateKey } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isIP } from "node:net";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import {
  createLogger,
  isCertificateIpAddress,
  localMdnsHostname,
  safeNetworkInterfaces,
} from "@omnesis/core";

const log = createLogger("gateway").child("tls");

export interface TlsBundle {
  /** PEM-encoded X.509 certificate. */
  cert: string;
  /** PEM-encoded private key (PKCS#8). */
  key: string;
  /**
   * Hex-encoded (lowercase, no colons) SHA-256 of the certificate's DER bytes.
   * iOS pins this. Matches the value you'd get from
   * `openssl x509 -fingerprint -sha256 -noout` after stripping `:`.
   */
  fingerprintSha256: string;
  source: "user-provided" | "auto-generated";
}

export interface ResolveTlsBundleOpts {
  configDir: string;
  envCertPath?: string;
  envKeyPath?: string;
  /**
   * OMNESIS_TLS_EXTRA_NAMES: further names a newly minted self-signed
   * certificate covers. An existing certificate is never re-minted for them.
   */
  envExtraNames?: string;
}

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u;

/**
 * The SAN entries named by OMNESIS_TLS_EXTRA_NAMES: a comma-separated list of
 * DNS names and IP literals. The Docker installer passes the host's own names
 * here, because the gateway inside a container cannot see them. Anything that
 * is not a plain RFC 1123 hostname or a routable IP is dropped with a warning.
 */
export function parseTlsExtraNames(raw: string | undefined): string[] {
  const entries: string[] = [];
  for (const item of (raw ?? "").split(",")) {
    const value = item.trim();
    if (value.length === 0) continue;
    if (isIP(value) !== 0) {
      if (isCertificateIpAddress(value)) entries.push(`IP:${value}`);
      else log.warn(`Ignoring OMNESIS_TLS_EXTRA_NAMES entry ${value}: not a routable address`);
      continue;
    }
    const host = value.toLowerCase().replace(/\.$/u, "");
    const labels = host.split(".");
    if (
      host.length <= 253 &&
      labels.every((label) => label.length <= 63 && DNS_LABEL.test(label))
    ) {
      entries.push(`DNS:${host}`);
    } else {
      log.warn(
        `Ignoring OMNESIS_TLS_EXTRA_NAMES entry ${JSON.stringify(value)}: not a hostname or IP address`,
      );
    }
  }
  return entries;
}

/**
 * Resolve the TLS bundle for boot:
 *   1. If both env paths are set, load from disk (source=user-provided).
 *   2. Otherwise, ensure <configDir>/tls/{cert,key}.pem exists — load if
 *      present, generate-and-persist otherwise — and return that
 *      (source=auto-generated).
 */
export function resolveTlsBundle(opts: ResolveTlsBundleOpts): TlsBundle {
  const { configDir, envCertPath, envKeyPath, envExtraNames } = opts;

  // The installer (scripts/install.sh) auto-provisions a real cert here when
  // it can — Tailscale `tailscale cert`, or mkcert on opt-in — and points
  // these env vars at it via the config dir's .env, so the portal loads
  // without the self-signed-cert browser warning.
  if (envCertPath && envKeyPath) {
    const cert = readFileSync(envCertPath, "utf8");
    const key = readFileSync(envKeyPath, "utf8");
    assertPairBelongsTogether(cert, key, envCertPath, envKeyPath);
    return {
      cert,
      key,
      fingerprintSha256: fingerprintFromCertPem(cert),
      source: "user-provided",
    };
  }

  const tlsDir = join(configDir, "tls");
  const certPath = join(tlsDir, "cert.pem");
  const keyPath = join(tlsDir, "key.pem");

  if (existsSync(certPath) && existsSync(keyPath)) {
    const cert = readFileSync(certPath, "utf8");
    const key = readFileSync(keyPath, "utf8");
    if (pairBelongsTogether(cert, key)) {
      // Kept even when it misses a name OMNESIS_TLS_EXTRA_NAMES now asks for:
      // phones and collectors pin its fingerprint, and a new one would break
      // them. `omnesis tls renew --force` mints one on request.
      return {
        cert,
        key,
        fingerprintSha256: fingerprintFromCertPem(cert),
        source: "auto-generated",
      };
    }
    // The gateway's own pair, and it does not belong together: a write that
    // stopped halfway. Nothing can serve it, so it is minted again; clients
    // that pinned the old certificate need a repair either way.
    log.warn(
      `The self-signed pair at ${tlsDir} does not belong together (the key does not match the certificate); minting a new one`,
    );
  }

  // Generate a fresh bundle and persist it.
  mkdirSync(tlsDir, { recursive: true, mode: 0o700 });
  const generated = generateSelfSigned({ extraNames: envExtraNames });
  writeFileSync(certPath, generated.cert, { mode: 0o600 });
  writeFileSync(keyPath, generated.key, { mode: 0o600 });
  // mkdirSync's mode is masked by umask on some platforms; force it.
  try {
    chmodSync(tlsDir, 0o700);
    chmodSync(certPath, 0o600);
    chmodSync(keyPath, 0o600);
  } catch {
    /* best-effort; non-POSIX hosts will fall back to filesystem defaults */
  }

  log.info(`Auto-generated TLS bundle at ${tlsDir} (fingerprint=${generated.fingerprintSha256})`);
  return { ...generated, source: "auto-generated" };
}

/** Does the key sign for the certificate? False for anything that does not parse. */
function pairBelongsTogether(certPem: string, keyPem: string): boolean {
  try {
    return new X509Certificate(certPem).checkPrivateKey(createPrivateKey(keyPem));
  } catch {
    return false;
  }
}

function assertPairBelongsTogether(
  certPem: string,
  keyPem: string,
  certPath: string,
  keyPath: string,
): void {
  if (pairBelongsTogether(certPem, keyPem)) return;
  throw new Error(
    `The TLS material at ${certPath} and ${keyPath} does not belong together (the key does not match the certificate, or one of them did not parse). Point OMNESIS_TLS_CERT and OMNESIS_TLS_KEY at a matching pair.`,
  );
}

/** Pure helper: SHA-256 fingerprint of a PEM-encoded cert (DER bytes). */
export function fingerprintFromCertPem(certPem: string): string {
  const cert = new X509Certificate(certPem);
  return createHash("sha256").update(cert.raw).digest("hex");
}

/**
 * Generate a fresh RSA-2048 keypair + a self-signed X.509 cert valid for 10
 * years, with SAN entries for localhost / 127.0.0.1 / ::1 / <hostname>.local /
 * omnesis.local (the stable mDNS name the gateway advertises), plus
 * whatever `extraNames` (OMNESIS_TLS_EXTRA_NAMES) validly names.
 *
 * Subject CN: "Omnesis Gateway (auto-generated)".
 * notBefore: now - 1 day (clock-skew tolerance).
 * notAfter:  now + 10 years.
 */
export function generateSelfSigned(opts: { extraNames?: string } = {}): {
  cert: string;
  key: string;
  fingerprintSha256: string;
} {
  const tmpDir = mkdtempSync(join(tmpdir(), "omnesis-tls-"));
  const keyPath = join(tmpDir, "key.pem");
  const certPath = join(tmpDir, "cert.pem");
  const cnfPath = join(tmpDir, "openssl.cnf");

  try {
    const hostLocal = localMdnsHostname(hostname());

    // Enumerate every non-internal network address the host currently
    // owns and bake them all into the SAN list. iOS App Transport
    // Security pre-flight-rejects HTTPS-to-IP-literal connections when
    // the cert's SAN doesn't list the literal — and this rejection
    // happens BEFORE the URLSessionDelegate trust-challenge fires, so
    // the pin can't rescue it. Without these SAN entries, an iPhone
    // pairing over LAN / VPN overlay / mDNS-magic-DNS to the gateway
    // gets `NSURLErrorSecureConnectionFailed` and aborts the TCP
    // socket before the gateway sees a SYN. (Pin is still the
    // load-bearing security; SAN matching is iOS pre-flight only.)
    const extraIps = new Set<string>();
    for (const list of Object.values(safeNetworkInterfaces())) {
      if (!list) continue;
      for (const addr of list) {
        if (addr.internal) continue;
        if (!isCertificateIpAddress(addr.address)) continue;
        extraIps.add(addr.address);
      }
    }
    const sanList = [
      ...new Set([
        "DNS:localhost",
        `DNS:${hostLocal}`,
        // Stable mDNS name the gateway advertises — keeps
        // https://omnesis.local:7600 free of a cert-name mismatch.
        "DNS:omnesis.local",
        // The compose service name the installer's Docker role gives the gateway,
        // so a collector container reaches https://gateway:7600 without a
        // hostname mismatch on the self-signed cert.
        "DNS:gateway",
        "IP:127.0.0.1",
        "IP:::1",
        ...[...extraIps].sort().map((ip) => `IP:${ip}`),
        // Names only the operator's environment knows, such as the host a
        // Docker gateway is published on.
        ...parseTlsExtraNames(opts.extraNames),
      ]),
    ].join(", ");

    // Minimal OpenSSL config with subjectAltName + the bits a modern
    // self-signed server cert needs (basicConstraints, keyUsage, extKeyUsage).
    const cnf = `
[req]
distinguished_name = dn
prompt = no
x509_extensions = v3_ext

[dn]
CN = Omnesis Gateway (auto-generated)

[v3_ext]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = ${sanList}
`.trim();
    writeFileSync(cnfPath, cnf);

    // -days 3650 ≈ 10 years. -newkey rsa:2048 generates the keypair.
    // -nodes leaves the key unencrypted (we set 0600 on disk anyway).
    // -x509 emits a self-signed cert directly. -keyout/-out write PEMs.
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-keyout",
        keyPath,
        "-out",
        certPath,
        "-days",
        "3650",
        "-nodes",
        "-config",
        cnfPath,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );

    let keyPem = readFileSync(keyPath, "utf8");
    const certPem = readFileSync(certPath, "utf8");

    // Normalize the key to PKCS#8 PEM. Older openssl emits "BEGIN PRIVATE
    // KEY" (PKCS#8) by default with rsa:2048, but LibreSSL on macOS may emit
    // "BEGIN RSA PRIVATE KEY" (PKCS#1). Normalize via createPrivateKey().
    if (keyPem.includes("BEGIN RSA PRIVATE KEY")) {
      keyPem = createPrivateKey(keyPem).export({ type: "pkcs8", format: "pem" }).toString();
    }

    return {
      cert: certPem,
      key: keyPem,
      fingerprintSha256: fingerprintFromCertPem(certPem),
    };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}
