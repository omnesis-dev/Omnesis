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

/**
 * Which of the gateway's MCP resources reach the gateway itself, judged by the
 * certificate a client meets there: only where it is the gateway's own can a
 * client pin the gateway's fingerprint. A proxy in front (Tailscale Funnel, a
 * reverse proxy) presents its own certificate; a plain port-forward presents
 * the gateway's. Answers are cached briefly and never trusted across a change
 * of the gateway's certificate.
 */
export function createServedByGatewayCheck(options: {
  fingerprint: () => string | undefined;
  probe?: CertificateProbe;
  now?: () => number;
}): (resources: readonly string[]) => Promise<Map<string, boolean>> {
  const probe = options.probe ?? probeServedCertificate;
  const now = options.now ?? Date.now;
  const cache = new Map<string, { fingerprint: string; servedByGateway: boolean; at: number }>();
  return async (resources) => {
    const own = options.fingerprint()?.toLowerCase();
    const results = new Map<string, boolean>();
    await Promise.all(
      resources.map(async (resource) => {
        if (!own) {
          results.set(resource, false);
          return;
        }
        const cached = cache.get(resource);
        if (cached && cached.fingerprint === own && now() - cached.at < CACHE_TTL_MS) {
          results.set(resource, cached.servedByGateway);
          return;
        }
        const presented = await probe(new URL(resource)).catch(() => null);
        const servedByGateway = presented?.toLowerCase() === own;
        cache.set(resource, { fingerprint: own, servedByGateway, at: now() });
        results.set(resource, servedByGateway);
      }),
    );
    return results;
  };
}
