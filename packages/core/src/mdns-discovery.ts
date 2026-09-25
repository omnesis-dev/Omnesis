// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Collector-side mDNS / Bonjour discovery of the gateway (#49).
 *
 * Counterpart to the gateway's `MdnsAdvertiser`: browses for an
 * `_omnesis._tcp` service on the LAN and, on the first hit, reconstructs
 * the gateway's base URL (scheme from the TXT `scheme` field, an IPv4 from
 * the advertised addresses when available, else the advertised mDNS host)
 * and returns the TLS fingerprint published in TXT.
 *
 * This is best-effort: a timeout, no advertiser on the LAN, or any error
 * resolves to `null` so the caller falls back to its configured default.
 * Multicast doesn't cross subnets or Tailscale, so this only ever finds a
 * gateway on the same broadcast domain.
 */

// bonjour-service is CommonJS (`export = Bonjour`); the class is the default
// export — a named `{ Bonjour }` import is not resolvable under Node ESM.
import Bonjour from "bonjour-service";
import { createLogger } from "./logger.js";
import { networkInterfacesUsable } from "./network-discovery.js";

const log = createLogger("core").child("mdns-discovery");

export interface DiscoveredGateway {
  /** Base URL the gateway is reachable at, e.g. "https://192.168.1.20:7600". */
  url: string;
  /** Hex SHA-256 of the gateway's TLS cert, from the TXT `fp` field, if present. */
  fingerprint?: string;
  /**
   * The service instance name the gateway published — its own hostname. What
   * an operator is shown when asked to confirm the gateway that answered.
   */
  name?: string;
}

/**
 * Browse the LAN for an `_omnesis._tcp` gateway. Resolves with the first
 * advertisement seen, or `null` after `timeoutMs` (default 3000) with no
 * hit / on any error. The `Bonjour` instance is always destroyed before
 * resolving so no multicast socket leaks.
 */
export function discoverGatewayViaMdns(opts?: {
  timeoutMs?: number;
}): Promise<DiscoveredGateway | null> {
  const timeoutMs = opts?.timeoutMs ?? 3000;

  // Same host-quirk guard as the gateway's MdnsAdvertiser: bonjour-service
  // wraps multicast-dns, which calls os.networkInterfaces() inside a dgram
  // socket callback. On hosts where that syscall throws (EAFNOSUPPORT /
  // "Unknown system error 97") the throw is uncatchable and crashes the
  // process, so skip discovery entirely there — a null result already means
  // "fall back to the configured gateway URL" to every caller.
  if (!networkInterfacesUsable()) {
    log.debug(
      "mDNS discovery skipped: this host cannot enumerate network interfaces (os.networkInterfaces() fails)",
    );
    return Promise.resolve(null);
  }

  return new Promise<DiscoveredGateway | null>((resolve) => {
    let bonjour: InstanceType<typeof Bonjour> | undefined;
    let settled = false;

    const finish = (result: DiscoveredGateway | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        bonjour?.destroy();
      } catch {
        /* best effort — socket teardown failures are not actionable */
      }
      resolve(result);
    };

    // `findOne` does NOT call back on a no-match timeout, so own the deadline.
    // Declared before the browse so the (always-async) `finish` can clear it;
    // a synchronous init failure below still finds it assigned.
    const timer = setTimeout(() => finish(null), timeoutMs + 250);
    timer.unref?.();

    try {
      bonjour = new Bonjour();
      // `findOne` fires the callback on the first matching service.
      bonjour.findOne({ type: "omnesis", protocol: "tcp" }, timeoutMs, (service: unknown) => {
        const discovered = service ? buildDiscovered(service) : null;
        if (discovered) {
          log.info(`Discovered gateway via mDNS at ${discovered.url}`);
        }
        finish(discovered);
      });
    } catch (err) {
      log.debug(`mDNS discovery init failed: ${err instanceof Error ? err.message : String(err)}`);
      finish(null);
    }
  });
}

interface MdnsServiceShape {
  addresses?: string[];
  host?: string;
  name?: string;
  port?: number;
  txt?: Record<string, unknown>;
}

/** Hostnames and IP literals only — no room for a URL to be smuggled in. */
const SAFE_HOST = /^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/;
/** Only the two schemes the gateway ever serves. */
const SAFE_SCHEMES = new Set(["https", "http"]);
/** A hex SHA-256, which is the only shape the TXT `fp` field ever carries. */
const SAFE_FINGERPRINT = /^[0-9a-f]{64}$/i;

/**
 * Reconstruct a `DiscoveredGateway` from a Bonjour service record.
 * Prefers an IPv4 address (most broadly routable on a LAN, and what the
 * cert's SAN list carries) over the advertised mDNS host. Returns null if
 * the record lacks both a usable host and a port.
 *
 * Every field here was published by whoever happens to be on the LAN, so each
 * is validated to the shape it is supposed to have rather than interpolated on
 * trust: the result is rendered in a terminal, offered to an operator to
 * confirm, and turned into a URL a collector dials.
 */
function buildDiscovered(service: unknown): DiscoveredGateway | null {
  const s = service as MdnsServiceShape;
  const port = typeof s.port === "number" ? s.port : undefined;
  if (!port || !Number.isInteger(port) || port < 1 || port > 65_535) return null;

  const ipv4 = (s.addresses ?? []).find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a));
  const host = ipv4 ?? s.host;
  if (!host || !SAFE_HOST.test(host)) return null;

  const scheme = txtString(s.txt, "scheme") ?? "https";
  if (!SAFE_SCHEMES.has(scheme)) return null;

  const fingerprint = txtString(s.txt, "fp");
  const name = typeof s.name === "string" ? s.name.replace(/[\p{Cc}\p{Cf}]/gu, "").trim() : "";

  return {
    url: `${scheme}://${host}:${port}`,
    ...(fingerprint && SAFE_FINGERPRINT.test(fingerprint)
      ? { fingerprint: fingerprint.toLowerCase() }
      : {}),
    ...(name ? { name: name.slice(0, 64) } : {}),
  };
}

/**
 * Read a TXT value as a string. multicast-dns hands TXT values back as
 * Buffers (or strings); normalize both to a string, treating empty as
 * absent.
 */
function txtString(txt: Record<string, unknown> | undefined, key: string): string | undefined {
  const raw = txt?.[key];
  if (raw == null) return undefined;
  const str = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
  return str.length > 0 ? str : undefined;
}
