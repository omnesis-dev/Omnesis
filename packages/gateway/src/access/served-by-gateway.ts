// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { connect } from "node:tls";

/**
 * SHA-256 fingerprint (lowercase hex) of the certificate a TLS client meets at
 * `resource`, or null when it cannot be reached in time.
 */
export type CertificateProbe = (resource: URL) => Promise<string | null>;

const PROBE_TIMEOUT_MS = 2_000;
const CACHE_TTL_MS = 60_000;

/** Connect to the resource's host and port and fingerprint the certificate it presents. */
export const probeServedCertificate: CertificateProbe = (resource) =>
  new Promise((resolve) => {
    const host = resource.hostname.replace(/^\[(.*)\]$/u, "$1");
    // Fingerprints whichever certificate answers; sends no data and trusts nothing.
    // nosemgrep: problem-based-packs.insecure-transport.js-node.bypass-tls-verification.bypass-tls-verification
    const socket = connect({
      host,
      port: Number(resource.port || 443),
      // The point is to see whichever certificate answers, trusted or not.
      rejectUnauthorized: false,
      ...(isIP(host) === 0 ? { servername: host } : {}),
    });
    const finish = (fingerprint: string | null) => {
      socket.destroy();
      resolve(fingerprint);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS, () => finish(null));
    socket.once("error", () => finish(null));
    socket.once("secureConnect", () => {
      const raw = socket.getPeerCertificate().raw;
      finish(raw ? createHash("sha256").update(raw).digest("hex") : null);
    });
  });

/** What a client meets at one of the gateway's MCP resources. */
export interface ServedResource {
  /**
   * It presents the gateway's own certificate, so a client there can check
   * the gateway's fingerprint.
   */
  servedByGateway: boolean;
  /**
   * It is the gateway's own listener: its certificate, on the port the
   * gateway listens on. A proxy that serves the same certificate — Tailscale
   * Funnel or Serve in front of a gateway that uses its Tailscale
   * certificate — answers on another port, so it is served by the gateway's
   * certificate without being direct.
   */
  direct: boolean;
}

/** The port a resource URL is dialled on, spelled out or implied by its scheme. */
function resourcePort(resource: string): number {
  const url = new URL(resource);
  return Number(url.port || (url.protocol === "http:" ? 80 : 443));
}

/**
 * Which of the gateway's MCP resources reach the gateway itself, judged by the
 * certificate a client meets there and the port it dials: only where the
 * certificate is the gateway's own can a client pin the gateway's
 * fingerprint, and only on the gateway's own port is nothing between them.
 * A proxy in front usually presents its own certificate; one that presents
 * the gateway's shows by its port. Certificate answers are cached briefly and
 * never trusted across a change of the gateway's certificate. Without a
 * listening port to compare, a resource that presents the gateway's
 * certificate counts as direct.
 */
export function createServedByGatewayCheck(options: {
  fingerprint: () => string | undefined;
  listenPort?: number;
  probe?: CertificateProbe;
  now?: () => number;
}): (resources: readonly string[]) => Promise<Map<string, ServedResource>> {
  const probe = options.probe ?? probeServedCertificate;
  const now = options.now ?? Date.now;
  const cache = new Map<string, { fingerprint: string; servedByGateway: boolean; at: number }>();
  const served = async (resource: string, own: string): Promise<boolean> => {
    const cached = cache.get(resource);
    if (cached && cached.fingerprint === own && now() - cached.at < CACHE_TTL_MS) {
      return cached.servedByGateway;
    }
    const presented = await probe(new URL(resource)).catch(() => null);
    const servedByGateway = presented?.toLowerCase() === own;
    cache.set(resource, { fingerprint: own, servedByGateway, at: now() });
    return servedByGateway;
  };
  return async (resources) => {
    const own = options.fingerprint()?.toLowerCase();
    const results = new Map<string, ServedResource>();
    await Promise.all(
      resources.map(async (resource) => {
        const servedByGateway = own ? await served(resource, own) : false;
        const direct =
          servedByGateway &&
          (options.listenPort === undefined || resourcePort(resource) === options.listenPort);
        results.set(resource, { servedByGateway, direct });
      }),
    );
    return results;
  };
}
