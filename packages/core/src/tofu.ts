// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { connect as tlsConnect, getCACertificates, setDefaultCACertificates } from "node:tls";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import { createLogger } from "./logger.js";
import { atomicWriteFileSync } from "./atomic-write.js";

const log = createLogger("tofu");

export type TofuResult =
  | { action: "already-trusted" }
  /**
   * `certPem` is present only when the call carried an `expectedFingerprint`:
   * it is the certificate that was verified against it, so the caller can
   * make the request that follows trust THAT certificate exclusively rather
   * than the process CA store plus it.
   */
  | { action: "trusted-in-process"; certPem?: string }
  | { action: "insecure-mode" }
  | { action: "skipped" };

const TLS_CERT_ERROR_CODES = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  // Hostname not in the cert's SAN — triggers the TOFU flow so the user gets
  // a clear diagnostic (or auto-trust picks up) instead of a silent loop.
  "ERR_TLS_CERT_ALTNAME_INVALID",
  // A saved copy of a self-signed certificate that has since expired, or a
  // freshly minted one ahead of this host's clock, fails the same way a
  // rotated one does: the trust on file no longer describes what is served.
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
]);

/**
 * The gateway presents a certificate other than the one saved for it, and
 * nothing on this host says the new one is expected. Carries both
 * fingerprints so the operator can compare them against the gateway's own
 * report before re-trusting.
 */
export class GatewayCertificateChangedError extends Error {
  constructor(
    readonly gatewayUrl: string,
    readonly savedFingerprint: string | null,
    readonly servedFingerprint: string,
    readonly certPath: string,
  ) {
    super(
      `The gateway at ${gatewayUrl} presents a certificate other than the one saved at ${certPath}.\n` +
        `  Saved:  ${savedFingerprint ? `sha256:${savedFingerprint}` : "(unreadable)"}\n` +
        `  Served: sha256:${servedFingerprint}\n` +
        `If the gateway's certificate was renewed or rotated (\`omnesis tls status\` on the gateway host says when), ` +
        `re-trust it here with \`omnesis tls trust --fingerprint ${servedFingerprint}\` (or OMNESIS_TRUST_FINGERPRINT=${servedFingerprint} before the collector starts) after checking the fingerprint against the gateway's report. ` +
        `If it was not, do not: something else is answering at that address.`,
    );
    this.name = "GatewayCertificateChangedError";
  }
}

/** The TLS verification code behind an error, walking its causes; null when there is none. */
export function tlsErrorCode(err: unknown, depth = 0): string | null {
  if (depth > 10 || !err || typeof err !== "object") return null;
  const code = (err as { code?: string }).code;
  if (code && TLS_CERT_ERROR_CODES.has(code)) return code;
  const cause = (err as { cause?: unknown }).cause;
  return cause ? tlsErrorCode(cause, depth + 1) : null;
}

export function isTlsCertError(err: unknown, depth = 0): boolean {
  if (depth > 10 || !err || typeof err !== "object") return false;
  const code = (err as { code?: string }).code;
  if (code && TLS_CERT_ERROR_CODES.has(code)) return true;
  const cause = (err as { cause?: unknown }).cause;
  if (cause) return isTlsCertError(cause, depth + 1);
  return false;
}

export function fetchPeerCert(
  host: string,
  port: number,
  timeoutMs = 10_000,
): Promise<{ pem: string; fingerprint: string }> {
  return new Promise((resolve, reject) => {
    // TOFU must read the untrusted peer certificate before the operator accepts its fingerprint.
    const socket = tlsConnect(
      // nosemgrep: problem-based-packs.insecure-transport.js-node.bypass-tls-verification.bypass-tls-verification
      {
        host,
        port,
        rejectUnauthorized: false,
        timeout: timeoutMs,
        // Name the host (SNI) as any TLS client does: a front that serves
        // several names, such as Tailscale's serve and Funnel, refuses a
        // handshake without one. An IP address is never sent as a name.
        ...(isIP(host.replace(/^\[(.*)\]$/u, "$1")) === 0 ? { servername: host } : {}),
      },
      () => {
        const cert = socket.getPeerCertificate();
        socket.destroy();
        if (!cert || !cert.raw || cert.raw.length === 0) {
          reject(new Error("No certificate returned by gateway"));
          return;
        }
        const der = cert.raw;
        const b64 = der.toString("base64");
        const pem =
          "-----BEGIN CERTIFICATE-----\n" +
          b64.match(/.{1,64}/g)!.join("\n") +
          "\n-----END CERTIFICATE-----\n";
        const fingerprint = createHash("sha256").update(der).digest("hex");
        resolve({ pem, fingerprint });
      },
    );
    socket.on("error", reject);
    socket.on("timeout", () => {
      socket.destroy();
      // ETIMEDOUT, as the kernel would have said: a dropped SYN (a cloud
      // security group, a DROP-target firewall) or a relay whose upstream
      // never answers ends here, and without a connection code the join's
      // "cannot reach the gateway" branch missed it — the operator got a stack
      // trace and was sent to mint a fresh code for a port that was shut.
      reject(
        Object.assign(new Error(`TLS probe timed out connecting to ${host}:${port}`), {
          code: "ETIMEDOUT",
        }),
      );
    });
  });
}

/**
 * Normalize a certificate fingerprint an operator typed or pasted into the
 * bare lowercase hex the SHA-256 of a DER certificate is compared as.
 *
 * Accepts the three shapes a fingerprint travels in: the `sha256:` prefix the
 * installer and the gateway banner print, the colon-separated pairs `openssl`
 * emits, and bare hex. Returns null for anything that is not 32 bytes of hex,
 * so a truncated or mistyped pin is refused up front rather than silently
 * failing to match later.
 */
export function normalizeCertFingerprint(value: string | undefined | null): string | null {
  if (!value) return null;
  const stripped = value
    .trim()
    .replace(/^sha-?256[:=]/i, "")
    .replace(/[\s:]/g, "")
    .toLowerCase();
  return /^[0-9a-f]{64}$/.test(stripped) ? stripped : null;
}

function promptTrust(
  fingerprint: string,
  gatewayUrl: string,
  previousFingerprint: string | null = null,
): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    process.stderr.write(
      previousFingerprint
        ? `\nThe gateway at ${gatewayUrl} presents a certificate other than the one saved for it.\n\n` +
            `  Saved:  ${previousFingerprint}\n` +
            `  Served: ${fingerprint}\n\n` +
            `Verify the served fingerprint matches \`omnesis tls status\` on the gateway host.\n`
        : `\nThe gateway at ${gatewayUrl} presents a self-signed certificate.\n\n` +
            `  SHA-256 fingerprint: ${fingerprint}\n\n` +
            `Verify this matches the fingerprint shown in the gateway's boot log.\n`,
    );
    rl.question("Trust this certificate? [y/N] ", (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes");
    });
  });
}

const PEM_CERT_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;

/** Content hash last merged for each cert path in the process CA store. */
const appliedCaPaths = new Map<string, string>();

/**
 * Make the current process trust the certificate(s) in `certPath` by
 * appending them to Node's default CA store via
 * `tls.setDefaultCACertificates()`. The new trust applies to every
 * subsequent TLS connection opened by this process — `fetch` (undici),
 * the `WebSocket` global, and raw `node:tls` — with no restart and no
 * `NODE_EXTRA_CA_CERTS`. Multi-cert PEM bundles are split and each
 * certificate is added individually.
 *
 * Idempotent per path and file content. A safely rotated certificate written
 * atomically at the same path is applied on the next call.
 */
export function applyCaTrustInProcess(certPath: string): void {
  const pem = readFileSync(certPath, "utf8");
  const contentHash = createHash("sha256").update(pem).digest("hex");
  if (appliedCaPaths.get(certPath) === contentHash) return;
  const certs = pem.match(PEM_CERT_BLOCK);
  if (!certs || certs.length === 0) {
    throw new Error(`No PEM certificates found in ${certPath}`);
  }
  setDefaultCACertificates([...getCACertificates("default"), ...certs]);
  appliedCaPaths.set(certPath, contentHash);
  log.debug(`Added ${certs.length} certificate(s) from ${certPath} to the process CA store`);
}

/**
 * Ensure the process trusts the gateway's TLS certificate before any
 * network calls. On first remote connect this fetches the cert, prompts
 * the user to verify the SHA-256 fingerprint (like SSH's TOFU), saves
 * it to `<configDir>/tls/cert.pem`, and adds it to the in-process CA
 * store (`applyCaTrustInProcess`) so the very same process can connect
 * immediately.
 *
 * Subsequent runs find the saved cert, skip the prompt, and re-apply the
 * in-process trust — unless `NODE_EXTRA_CA_CERTS` already points at the
 * saved cert, in which case Node trusted it at startup.
 */
export async function ensureGatewayTrust(opts: {
  gatewayUrl: string;
  configDir: string;
  /**
   * A fingerprint the caller was told to expect, in any of the shapes
   * `normalizeCertFingerprint` accepts. Unlike `OMNESIS_TRUST_FINGERPRINT`,
   * which is a shortcut past the interactive prompt on first sight, this is a
   * pin: it is verified against the certificate the gateway actually presents
   * on every call, and a mismatch throws instead of connecting.
   */
  expectedFingerprint?: string | undefined;
  /**
   * A fingerprint learned from the network for first sight only — the
   * collector reads it off the gateway's mDNS record. It stands in for
   * `OMNESIS_TRUST_FINGERPRINT` when no certificate is saved yet, and for
   * nothing else: a record anyone on the LAN can publish must not be able to
   * move trust that is already established.
   */
  discoveredFingerprint?: string | undefined;
  /**
   * Check that the saved certificate still describes what the gateway serves.
   * A rotated gateway certificate is followed only when the operator's own
   * `OMNESIS_TRUST_FINGERPRINT` names the new one; otherwise the change is
   * refused with both fingerprints and the repair command. Off by default:
   * the saved copy is applied without a probe, and callers that hit a
   * certificate error afterwards ask again with this set.
   */
  verifyServed?: boolean | undefined;
}): Promise<TofuResult> {
  const { gatewayUrl, configDir } = opts;

  // A pin outranks every shortcut below it, including the two that would
  // otherwise let it pass unchecked: a `http://` URL (there is no certificate
  // to verify, so the pin is a promise the transport cannot keep) and
  // OMNESIS_INSECURE_TLS.
  if (opts.expectedFingerprint !== undefined) {
    if (!gatewayUrl.startsWith("https://")) {
      throw new Error(
        `Refusing to verify a certificate fingerprint over ${gatewayUrl}.\n` +
          `A pinned gateway must be addressed over https://.`,
      );
    }
    return pinGatewayCertificate(gatewayUrl, configDir, opts.expectedFingerprint);
  }

  if (!gatewayUrl.startsWith("https://")) return { action: "skipped" };
  if (process.env.OMNESIS_INSECURE_TLS) return { action: "insecure-mode" };

  const certPath = join(configDir, "tls", "cert.pem");

  if (existsSync(certPath)) {
    const viaNodeExtra = process.env.NODE_EXTRA_CA_CERTS === certPath;
    if (!viaNodeExtra) applyCaTrustInProcess(certPath);
    if (!opts.verifyServed)
      return { action: viaNodeExtra ? "already-trusted" : "trusted-in-process" };
    let failure: unknown;
    try {
      await fetch(`${gatewayUrl}/health`);
      return { action: viaNodeExtra ? "already-trusted" : "trusted-in-process" };
    } catch (err) {
      if (!isTlsCertError(err)) {
        return { action: viaNodeExtra ? "already-trusted" : "trusted-in-process" };
      }
      failure = err;
    }
    return followRotation(gatewayUrl, certPath, tlsErrorCode(failure));
  }

  // Probe the gateway — if TLS succeeds, we're already trusted (e.g.
  // same-machine setup where NODE_EXTRA_CA_CERTS was set by npm script).
  try {
    await fetch(`${gatewayUrl}/health`);
    return { action: "already-trusted" };
  } catch (err) {
    if (!isTlsCertError(err)) {
      return { action: "skipped" };
    }
    const code = tlsErrorCode(err);
    if (code === "CERT_HAS_EXPIRED" || code === "CERT_NOT_YET_VALID") {
      // Trusting it would change nothing: the next connection fails the same way.
      throw new Error(
        `The certificate the gateway at ${gatewayUrl} serves ${code === "CERT_HAS_EXPIRED" ? "has expired" : "is not yet valid on this host's clock"}. ` +
          `Renew it on the gateway host (\`omnesis tls status\` there says how), then retry.`,
        { cause: err },
      );
    }
  }

  // TLS cert error — enter TOFU flow.
  const url = new URL(gatewayUrl);
  const host = url.hostname;
  const port = Number(url.port) || 443;

  log.info(`Fetching certificate from ${host}:${port}...`);
  const { pem, fingerprint } = await fetchPeerCert(host, port);

  const trustFingerprint = process.env.OMNESIS_TRUST_FINGERPRINT;
  const source = trustFingerprint
    ? { label: "OMNESIS_TRUST_FINGERPRINT", value: trustFingerprint }
    : opts.discoveredFingerprint
      ? { label: "the gateway's advertised fingerprint", value: opts.discoveredFingerprint }
      : null;
  if (source) {
    const expected = normalizeCertFingerprint(source.value);
    if (expected === null) {
      throw new Error(
        `${source.label} is not a SHA-256 certificate fingerprint: ${source.value}\n` +
          `Expected 64 hex characters, optionally prefixed with "sha256:".`,
      );
    }
    if (expected === fingerprint) {
      log.info(`Fingerprint matches ${source.label}, trusting automatically`);
    } else {
      throw new Error(
        `Certificate fingerprint mismatch.\n` +
          `  Expected (${source.label}): ${source.value}\n` +
          `  Got: ${fingerprint}`,
      );
    }
  } else if (process.stdin.isTTY) {
    const accepted = await promptTrust(fingerprint, gatewayUrl);
    if (!accepted) {
      throw new Error("Certificate rejected by user. Cannot connect securely.");
    }
  } else {
    throw new Error(
      `Cannot trust the gateway's self-signed certificate in non-interactive mode.\n` +
        `Either:\n` +
        `  1. Copy the cert: scp <gateway-host>:~/.config/omnesis/tls/cert.pem ${certPath}\n` +
        `  2. Set OMNESIS_TRUST_FINGERPRINT=${fingerprint} to auto-accept`,
    );
  }

  mkdirSync(join(configDir, "tls"), { recursive: true });
  atomicWriteFileSync(certPath, pem, { mode: 0o600 });
  log.info(`Certificate saved to ${certPath}`);
  applyCaTrustInProcess(certPath);
  return { action: "trusted-in-process" };
}

/**
 * The saved certificate no longer verifies what the gateway serves. Follow
 * the change only when the operator's own `OMNESIS_TRUST_FINGERPRINT` names
 * the served certificate, and refuse it otherwise: trust that exists is moved
 * by the operator, never by what the network says.
 */
async function followRotation(
  gatewayUrl: string,
  certPath: string,
  code: string | null,
): Promise<TofuResult> {
  const url = new URL(gatewayUrl);
  const { pem, fingerprint } = await fetchPeerCert(url.hostname, Number(url.port) || 443);
  const saved = savedFingerprint(certPath);
  if (saved === fingerprint) {
    // The same certificate fails verification, so re-trusting cannot help;
    // say why, by the code the handshake gave.
    if (code === "ERR_TLS_CERT_ALTNAME_INVALID") {
      throw new Error(
        `The certificate the gateway at ${gatewayUrl} serves (sha256:${fingerprint}) does not cover the name ${url.hostname}. ` +
          `Address the gateway by a name the certificate covers, or re-provision it for this one on the gateway host (\`omnesis tls status\` there lists its names).`,
      );
    }
    throw new Error(
      `The certificate saved for ${gatewayUrl} is the one it serves (sha256:${fingerprint}), but it no longer verifies — ` +
        `it has expired or is not yet valid on this host's clock. Renew it on the gateway host (\`omnesis tls status\` there says how), then retry.`,
    );
  }
  const configured = process.env.OMNESIS_TRUST_FINGERPRINT;
  const expected = normalizeCertFingerprint(configured);
  if (configured && expected !== null && expected !== fingerprint && expected !== saved) {
    log.warn(
      `OMNESIS_TRUST_FINGERPRINT names neither the saved nor the served certificate of ${gatewayUrl}; it is stale`,
    );
  }
  if (expected !== null && expected === fingerprint) {
    atomicWriteFileSync(certPath, pem, { mode: 0o600 });
    applyCaTrustInProcess(certPath);
    log.info(
      `Gateway certificate rotated (sha256:${saved ?? "?"} -> sha256:${fingerprint}); the saved copy at ${certPath} was replaced`,
    );
    return { action: "trusted-in-process", certPem: pem };
  }
  throw new GatewayCertificateChangedError(gatewayUrl, saved, fingerprint, certPath);
}

function savedFingerprint(certPath: string): string | null {
  try {
    const block = readFileSync(certPath, "utf8").match(PEM_CERT_BLOCK)?.[0];
    if (!block) return null;
    const der = Buffer.from(
      block.replace(/-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----|\s/g, ""),
      "base64",
    );
    return createHash("sha256").update(der).digest("hex");
  } catch {
    return null;
  }
}

/**
 * Replace the trust saved for a gateway whose certificate changed: with a
 * fingerprint, the served certificate is verified against it and saved;
 * without one, the operator is shown the saved and served fingerprints and
 * asked, as on first sight. Non-interactive runs need the fingerprint.
 */
export async function retrustGateway(opts: {
  gatewayUrl: string;
  configDir: string;
  expectedFingerprint?: string | undefined;
}): Promise<{ fingerprint: string; previousFingerprint: string | null; certPath: string }> {
  const certPath = join(opts.configDir, "tls", "cert.pem");
  const previousFingerprint = existsSync(certPath) ? savedFingerprint(certPath) : null;
  if (opts.expectedFingerprint !== undefined) {
    await pinGatewayCertificate(opts.gatewayUrl, opts.configDir, opts.expectedFingerprint);
    return {
      fingerprint: normalizeCertFingerprint(opts.expectedFingerprint)!,
      previousFingerprint,
      certPath,
    };
  }
  const url = new URL(opts.gatewayUrl);
  const { pem, fingerprint } = await fetchPeerCert(url.hostname, Number(url.port) || 443);
  if (!process.stdin.isTTY) {
    throw new Error(
      `Cannot re-trust the gateway's certificate in non-interactive mode.\n` +
        `Check the fingerprint against \`omnesis tls status\` on the gateway host, then run\n` +
        `  omnesis tls trust --fingerprint ${fingerprint}`,
    );
  }
  const accepted = await promptTrust(fingerprint, opts.gatewayUrl, previousFingerprint);
  if (!accepted) throw new Error("Certificate rejected by user. The saved trust is unchanged.");
  mkdirSync(join(opts.configDir, "tls"), { recursive: true });
  atomicWriteFileSync(certPath, pem, { mode: 0o600 });
  applyCaTrustInProcess(certPath);
  return { fingerprint, previousFingerprint, certPath };
}

/**
 * Verify the gateway's certificate against a caller-supplied pin, then save
 * and trust it, and hand the verified certificate back.
 *
 * Deliberately unconditional: it runs before the saved-certificate and
 * successful-handshake shortcuts. A pin is a claim about *which* gateway is on
 * the other end, so the run that carries one either proves that claim or stops
 * — a cached certificate from an earlier install is not evidence about the
 * host being dialled now.
 *
 * The verification here binds one probe connection. Adding the certificate to
 * the process CA store makes the pin *sufficient* for later requests but not
 * *necessary*, so a caller that needs the pin to be the only thing its request
 * will accept takes `certPem` from the result and pins the request itself.
 */
async function pinGatewayCertificate(
  gatewayUrl: string,
  configDir: string,
  expected: string,
): Promise<TofuResult> {
  const pin = normalizeCertFingerprint(expected);
  if (!pin) {
    throw new Error(
      `Not a SHA-256 certificate fingerprint: ${expected}\n` +
        `Expected 64 hex characters, optionally prefixed with "sha256:".`,
    );
  }

  const url = new URL(gatewayUrl);
  const { pem, fingerprint } = await fetchPeerCert(url.hostname, Number(url.port) || 443);
  if (fingerprint !== pin) {
    throw new Error(
      `Certificate fingerprint mismatch for ${gatewayUrl}.\n` +
        `  Expected: sha256:${pin}\n` +
        `  Got:      sha256:${fingerprint}\n` +
        `Refusing to connect. Check the fingerprint the gateway printed, and that ` +
        `the URL names the machine you meant.`,
    );
  }

  const certPath = join(configDir, "tls", "cert.pem");
  // One certificate per config directory, so pinning a different gateway from
  // this directory replaces the trust the previous one left. Said out loud:
  // the symptom otherwise is every later command against the old gateway
  // failing its handshake with nothing to connect it to.
  const replacing = existsSync(certPath) && readFileSync(certPath, "utf8") !== pem;
  mkdirSync(join(configDir, "tls"), { recursive: true });
  atomicWriteFileSync(certPath, pem, { mode: 0o600 });
  applyCaTrustInProcess(certPath);
  log.info(
    replacing
      ? `Certificate pinned (sha256:${fingerprint}) — replaced the certificate previously saved at ${certPath}`
      : `Certificate pinned (sha256:${fingerprint}) and saved to ${certPath}`,
  );
  return { action: "trusted-in-process", certPem: pem };
}
