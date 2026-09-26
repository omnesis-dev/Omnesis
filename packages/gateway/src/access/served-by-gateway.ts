// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { connect, rootCertificates } from "node:tls";

/** The certificate a TLS client meets at a resource. */
export interface PresentedCertificate {
  /** SHA-256 fingerprint, lowercase hex. */
  fingerprint: string;
  /**
   * It verifies for the resource's name against the public certificate
   * authorities an agent trusts out of the box, as a Let's Encrypt
   * certificate does and a self-signed one does not.
   */
  publiclyTrusted: boolean;
}

/** What a TLS client meets at `resource`, or null when it cannot be reached in time. */
export type CertificateProbe = (resource: URL) => Promise<PresentedCertificate | null>;

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
      // Judged against the bundled public roots only, so a certificate this
      // process was told to trust does not pass for a public one.
      ca: [...rootCertificates],
      ...(isIP(host) === 0 ? { servername: host } : {}),
    });
    const finish = (presented: PresentedCertificate | null) => {
      socket.destroy();
      resolve(presented);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS, () => finish(null));
    socket.once("error", () => finish(null));
    socket.once("secureConnect", () => {
      const raw = socket.getPeerCertificate().raw;
      finish(
        raw
          ? {
              fingerprint: createHash("sha256").update(raw).digest("hex"),
              publiclyTrusted: socket.authorized,
            }
          : null,
      );
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
  /**
   * Its certificate is one agents trust without being told to. An agent that
   * cannot be given another certificate to trust, such as Claude Code with a
   * self-signed one, cannot connect where this is false.
   */
  publiclyTrusted: boolean;
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
  type Answer = { servedByGateway: boolean; publiclyTrusted: boolean };
  const cache = new Map<string, Answer & { fingerprint: string; at: number }>();
  const served = async (resource: string, own: string): Promise<Answer> => {
    const cached = cache.get(resource);
    if (cached && cached.fingerprint === own && now() - cached.at < CACHE_TTL_MS) {
      return cached;
    }
    const presented = await probe(new URL(resource)).catch(() => null);
    const answer = {
      servedByGateway: presented?.fingerprint.toLowerCase() === own,
      publiclyTrusted: presented?.publiclyTrusted ?? false,
    };
    cache.set(resource, { ...answer, fingerprint: own, at: now() });
    return answer;
  };
  return async (resources) => {
    const own = options.fingerprint()?.toLowerCase();
    const results = new Map<string, ServedResource>();
    await Promise.all(
      resources.map(async (resource) => {
        const { servedByGateway, publiclyTrusted } = own
          ? await served(resource, own)
          : { servedByGateway: false, publiclyTrusted: false };
        const direct =
          servedByGateway &&
          (options.listenPort === undefined || resourcePort(resource) === options.listenPort);
        results.set(resource, { servedByGateway, direct, publiclyTrusted });
      }),
    );
    return results;
  };
}
