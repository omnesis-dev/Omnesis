// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * How this installation verifies the gateway, held once per process.
 *
 * Every client of one gateway — ingestion, delivery, MCP, OAuth, management —
 * reads its TLS options from the same instance, per connection. That is what
 * lets a pinned installation follow a renewal of a publicly trusted
 * certificate: the first connection that sees the renewed certificate moves
 * the whole process to system trust and records it once, and every later
 * connection, on any client, is made with the new options.
 *
 * The move is allowed only where a fresh `omnesis connect` would have chosen
 * system trust itself: a gateway addressed by a DNS name, whose pinned
 * certificate explicitly cannot issue others (`CA:FALSE`), and whose new
 * certificate verifies under the bundled public roots for that exact name. An
 * IP address, a loopback name, or a pin that could act as an issuer stay
 * strictly pinned — there is no public trust to fall back on, and a rotation
 * there needs the operator.
 */

import { X509Certificate } from "node:crypto";
import { Agent as HttpsAgent } from "node:https";
import { isIP } from "node:net";
import {
  checkServerIdentity,
  createSecureContext,
  getCACertificates,
  type ConnectionOptions,
  type DetailedPeerCertificate,
  type PeerCertificate,
} from "node:tls";

import { certificateCannotIssue } from "./certificate-authority.js";
import { silentIntegrationLogger, type IntegrationLogger } from "./logger.js";
import {
  certificateFingerprint,
  classifyTlsFailure,
  pinnedTlsOptions,
  pinnedTlsTrustSchema,
  TlsPinError,
  tlsTrustSchema,
  validateGatewayUrl,
  type GatewayTlsError,
  type TlsTrust,
  type TlsTrustMode,
} from "./tls.js";

/**
 * The roots `@omnesis/core`'s `DISTRUSTED_ROOT_SHA256` names — removed from
 * NSS, still bundled by Node — restated because this package imports nothing
 * of Omnesis at runtime. A test in `@omnesis/core`'s `tls-distrust.test.ts`
 * holds the two to the same set.
 */
const DISTRUSTED_ROOT_SHA256: ReadonlySet<string> = new Set([
  "86a1ecba089c4a8d3bbe2734c612ba341d813e043cf9e8a862cd5c57a36bbe6b", // emSign ECC Root CA - G3
  "125609aa301da0a249b97a8239cb6a34216f44dcac9f3954b14292f2e8c8608f", // emSign Root CA - C1
  "bc4d809b15189d78db3e1d8cf4f9726a795da1643ca5f1358e1ddb0edc0d7eb3", // emSign ECC Root CA - C3
]);

/** Node's bundled public roots (or `bundled`) without the distrusted ones. */
export function publicRoots(bundled = getCACertificates("bundled")): string[] {
  return bundled.filter(
    (pem) =>
      !DISTRUSTED_ROOT_SHA256.has(
        new X509Certificate(pem).fingerprint256.replaceAll(":", "").toLowerCase(),
      ),
  );
}

export interface GatewayTrustOptions {
  gatewayUrl: string;
  /** Required for an `https:` gateway; ignored for plaintext loopback. */
  trust: TlsTrust | undefined;
  /**
   * Named in the repair command a certificate failure prints. Without it —
   * a client that is no agent harness — failures are left as Node reports
   * them, since there is no `omnesis connect` to point at.
   */
  harness?: string;
  /** The public roots system trust verifies against. Defaults to `publicRoots()`. */
  systemRoots?: () => readonly string[];
  /**
   * Called once, after this process has moved from a pinned leaf to system
   * trust, with the fingerprint of the pin it moved from, so the caller can
   * replace exactly that pin with `{ mode: "system" }`. A throw is logged and
   * does not undo the move for this process.
   */
  onUpgraded?: (previousFingerprint: string) => void;
  logger?: IntegrationLogger;
}

interface PinnedState {
  kind: "pinned";
  pin: { caPem: string; leafFingerprintSha256: string };
  /** The pin could act as an issuer: never trusted beside the public roots. */
  canIssue: boolean;
  strict: boolean;
}

type TrustState = { kind: "plaintext" } | { kind: "system" } | PinnedState;

const PLAINTEXT_OPTIONS: ConnectionOptions = Object.freeze({});

/** Whether a certificate for this host could have come from a public CA at all. */
export function publicNameCandidate(hostname: string): boolean {
  const host = hostname
    .replace(/^\[|\]$/gu, "")
    .replace(/\.$/u, "")
    .toLowerCase();
  if (host === "" || isIP(host) !== 0) return false;
  return host !== "localhost" && !host.endsWith(".localhost");
}

/**
 * Whether a certificate in the served chain was issued by the pin — signed by
 * its key, or the pin itself standing as an issuer. Such a chain was anchored
 * by the pin, not by a public root, and must never be read as a renewal.
 */
export function anchoredByPin(
  cert: DetailedPeerCertificate,
  pinPem: string,
  pinFingerprint: string,
): boolean {
  const pinKey = new X509Certificate(pinPem).publicKey;
  let link: DetailedPeerCertificate | undefined = cert;
  for (let depth = 0; link && depth < 16; depth += 1) {
    if (link !== cert && link.raw && certificateFingerprint(link.raw) === pinFingerprint) {
      return true;
    }
    if (link.raw) {
      try {
        if (new X509Certificate(link.raw).verify(pinKey)) return true;
      } catch {
        // A key of another type cannot have signed it.
      }
    }
    const next: DetailedPeerCertificate | undefined = link.issuerCertificate;
    if (!next || next === link) break;
    link = next;
  }
  return false;
}

export class GatewayTrust {
  /** The trust a client was handed, as one shared instance. */
  static resolve(
    value: GatewayTrust | TlsTrust | undefined,
    gatewayUrl: string,
    harness?: string,
  ): GatewayTrust {
    return value instanceof GatewayTrust
      ? value
      : new GatewayTrust({ gatewayUrl, trust: value, ...(harness ? { harness } : {}) });
  }

  private readonly hostname: string;
  private readonly https: boolean;
  private readonly systemRoots: () => readonly string[];
  private readonly log: IntegrationLogger;
  private resolved: TrustState | null = null;
  private cached: ConnectionOptions | null = null;
  private pool: HttpsAgent | null = null;

  constructor(private readonly options: GatewayTrustOptions) {
    const url = validateGatewayUrl(options.gatewayUrl);
    this.hostname = url.hostname;
    this.https = url.protocol === "https:";
    this.systemRoots = options.systemRoots ?? publicRoots;
    this.log = options.logger ?? silentIntegrationLogger;
  }

  /**
   * Parsed on first use rather than in the constructor, so a client can be
   * built before anything is dialled; missing or malformed trust still fails
   * before the first socket opens.
   */
  private state(): TrustState {
    if (this.resolved) return this.resolved;
    if (!this.https) {
      this.resolved = { kind: "plaintext" };
      return this.resolved;
    }
    if (!this.options.trust) {
      throw new Error("HTTPS integration requires pinned TLS trust material");
    }
    const trust = tlsTrustSchema.parse(this.options.trust);
    if ("mode" in trust) {
      this.resolved = { kind: "system" };
      return this.resolved;
    }
    const pin = pinnedTlsTrustSchema.parse(trust);
    const canIssue = !certificateCannotIssue(new X509Certificate(pin.caPem).raw);
    this.resolved = {
      kind: "pinned",
      pin,
      canIssue,
      strict: canIssue || !publicNameCandidate(this.hostname),
    };
    return this.resolved;
  }

  /** The trust in force now; `null` for a plaintext loopback gateway. */
  mode(): TlsTrustMode | null {
    const state = this.state();
    switch (state.kind) {
      case "plaintext":
        return null;
      case "system":
        return "system";
      case "pinned":
        return state.canIssue ? "pinned-ca" : "pinned-leaf";
    }
  }

  /**
   * What the device reports in its hello, so the gateway can say who is
   * pinned. A pin that gives way to public trust says so: the gateway then
   * knows a renewal of a publicly trusted certificate leaves it connected.
   */
  helloCapability(): { mode: TlsTrustMode; followsPublicRenewal?: true } | undefined {
    const mode = this.mode();
    if (!mode) return undefined;
    const state = this.state();
    return state.kind === "pinned" && !state.strict
      ? { mode, followsPublicRenewal: true }
      : { mode };
  }

  /**
   * TLS options for the next connection. Read per connection, never held by
   * a client: a move to system trust must reach every client's next socket.
   */
  connectionOptions(): ConnectionOptions {
    if (this.cached) return this.cached;
    const state = this.state();
    let options: ConnectionOptions;
    if (state.kind === "plaintext") {
      options = PLAINTEXT_OPTIONS;
    } else if (state.kind === "system") {
      options = {
        // Built once per state: a context over the whole root set is not free.
        secureContext: createSecureContext({ ca: [...this.systemRoots()] }),
        rejectUnauthorized: true,
      };
    } else if (state.strict) {
      options = pinnedTlsOptions(this.hostname, state.pin);
    } else {
      options = this.upgradableOptions(state);
    }
    this.cached = options;
    return options;
  }

  /**
   * The connection pool HTTPS requests to this gateway use, owned by this
   * trust and replaced when the trust changes. Node's shared agent keys its
   * pooled sockets and resumable TLS sessions by host and a few options that
   * a secure context does not appear in, so a socket or session another
   * client set up under other trust could be reused — and a resumed session
   * skips `checkServerIdentity`, the check the pin lives in.
   */
  agent(): HttpsAgent {
    this.pool ??= new HttpsAgent({ keepAlive: true, timeout: 5_000 });
    return this.pool;
  }

  /** A certificate failure as a {@link GatewayTlsError}; anything else unchanged. */
  classify<T>(error: T): T | GatewayTlsError {
    const harness = this.options.harness;
    if (!harness) return error;
    return classifyTlsFailure(error, { gatewayUrl: this.options.gatewayUrl, harness }) ?? error;
  }

  /**
   * A pin that cannot issue, on a public name: the pin is trusted, and so are
   * the public roots, and the pin decides which of the two vouched for the
   * connection.
   *
   * Node calls `checkServerIdentity` only after the chain has verified, and
   * OpenSSL refuses a `CA:FALSE` certificate as an issuer — so a certificate
   * that reaches it without matching the pin was anchored by a public root.
   * The served chain is still checked for the pin's signature before that is
   * believed, so the conclusion never rests on OpenSSL's issuer rules alone.
   */
  private upgradableOptions(state: PinnedState): ConnectionOptions {
    const expected = state.pin.leafFingerprintSha256;
    return {
      secureContext: createSecureContext({
        ca: [state.pin.caPem, ...this.systemRoots()],
        allowPartialTrustChain: true,
      }),
      rejectUnauthorized: true,
      checkServerIdentity: (host, cert) => {
        const hostnameError = checkServerIdentity(host || this.hostname, cert);
        if (hostnameError) return hostnameError;
        const raw = (cert as PeerCertificate).raw;
        if (!raw || raw.byteLength === 0) {
          return new TlsPinError("gateway did not present a leaf certificate");
        }
        const served = certificateFingerprint(raw);
        if (served === expected) return undefined;
        if (anchoredByPin(cert as DetailedPeerCertificate, state.pin.caPem, expected)) {
          return new TlsPinError(
            "gateway certificate was issued under the pinned certificate, not a public CA",
          );
        }
        this.adoptSystemTrust(expected, served);
        return undefined;
      },
    };
  }

  private adoptSystemTrust(previous: string, served: string): void {
    if (this.resolved?.kind !== "pinned") return;
    this.resolved = { kind: "system" };
    this.cached = null;
    // New requests get a pool of their own. Idle sockets of the old one are
    // closed now; the one carrying this handshake finishes its request and
    // then times out with the pool.
    const retired = this.pool;
    this.pool = null;
    for (const sockets of Object.values(retired?.freeSockets ?? {})) {
      for (const socket of sockets ?? []) socket.destroy();
    }
    const message =
      `Omnesis gateway certificate renewed (sha256:${previous} -> sha256:${served}) and ` +
      `verified by a public CA for ${this.hostname}; using system trust from now on`;
    if (this.log.info) this.log.info(message);
    else this.log.warn(message);
    try {
      this.options.onUpgraded?.(previous);
    } catch (error) {
      this.log.warn(
        `could not record system trust for the Omnesis gateway: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
