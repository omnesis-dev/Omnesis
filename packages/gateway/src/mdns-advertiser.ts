// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * mDNS / Bonjour advertiser for the gateway (#49).
 *
 * Publishes an `_omnesis._tcp` service record on the LAN carrying the
 * gateway's port, scheme, and TLS fingerprint, plus the mDNS hostname
 * (`omnesis.local` by default) so the host is resolvable without DNS.
 * A same-LAN collector with `OMNESIS_GATEWAY_URL` unset finds the gateway
 * through this advertisement (see `@omnesis/core`'s `discoverGatewayViaMdns`),
 * and browsers can reach the portal at `https://<hostname>:<port>`.
 *
 * Two ways to publish, chosen per platform:
 *
 * - **macOS** already runs the system mDNS responder (mDNSResponder) on UDP
 *   5353. A second responder in this process cannot share that socket reliably
 *   — the bind can be refused, or succeed without ever receiving a query — so
 *   the gateway registers its records with the system responder through
 *   `dns-sd -P` and keeps that registration alive for the process lifetime.
 * - **Everywhere else** the gateway runs its own responder on the low-level
 *   `multicast-dns`. `bonjour-service` would blindly advertise an A record for
 *   EVERY non-internal address (a Docker / VM / VPN address no off-host client
 *   can reach) with no way to filter; here A records cover ONLY the host's real
 *   LAN IPv4(s) (`realLanIpv4s()` excludes Docker/VM/VPN/overlay interfaces),
 *   and the responder binds to that interface.
 *
 * This is gateway infrastructure, not a data source. A publishing failure (a
 * container netns with no multicast, a host that blocks or already holds UDP
 * 5353, a responder that exits) must never crash the gateway: it is logged as
 * a warning and the advertiser goes inert.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import makeMdns from "multicast-dns";
import { createLogger, networkInterfacesUsable, realLanIpv4s } from "@omnesis/core";

const log = createLogger("gateway").child("mdns");

export const DEFAULT_MDNS_ENABLED = true;
export const DEFAULT_MDNS_HOSTNAME = "omnesis.local";

/** `_omnesis._tcp.local` — the DNS-SD service type the gateway advertises. */
const SERVICE_TYPE = "_omnesis._tcp.local";

/** The macOS Bonjour command-line client. */
const DNS_SD = "/usr/bin/dns-sd";

export interface MdnsAdvertiseOptions {
  /** TCP port the gateway is listening on. */
  port: number;
  /** mDNS hostname to publish (e.g. "omnesis.local"). */
  hostname: string;
  /** mDNS service instance name (typically the OS hostname). */
  serviceName: string;
  /** Hex SHA-256 of the gateway's TLS cert (DER) — published in TXT for pin pre-seeding. */
  fingerprintSha256: string;
}

/** The part of a spawned `dns-sd` process the advertiser uses. */
export interface BonjourRegistration {
  on(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface MdnsAdvertiserDeps {
  /** Platform to publish for; defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Whether the Bonjour client is installed; defaults to checking `/usr/bin/dns-sd`. */
  bonjourAvailable?: () => boolean;
  /** Starts a `dns-sd` registration with the given arguments. */
  spawnRegistration?: (args: string[]) => BonjourRegistration;
}

type Record = import("multicast-dns").ResourceRecord;

function txtEntries(fingerprintSha256: string): string[] {
  return ["v=1", "scheme=https", `fp=${fingerprintSha256}`];
}

/**
 * Advertises the gateway as an `_omnesis._tcp` mDNS service, through the
 * system responder on macOS and a `multicast-dns` responder elsewhere.
 * `stop()` withdraws the records and releases the socket or registration.
 */
export class MdnsAdvertiser {
  private readonly platform: NodeJS.Platform;
  private readonly bonjourAvailable: () => boolean;
  private readonly spawnRegistration: (args: string[]) => BonjourRegistration;

  private mdns: ReturnType<typeof makeMdns> | undefined;
  private answers: Record[] = [];
  /** The record names we own — a query touching any of these triggers a response. */
  private names = new Set<string>();

  private registration: BonjourRegistration | undefined;
  private registrationArgs: ((fingerprintSha256: string) => string[]) | undefined;

  /** The `.local` name published with the host's real LAN address(es); unset without one. */
  private addressedHost: string | undefined;

  constructor(deps: MdnsAdvertiserDeps = {}) {
    this.platform = deps.platform ?? process.platform;
    this.bonjourAvailable = deps.bonjourAvailable ?? (() => existsSync(DNS_SD));
    this.spawnRegistration =
      deps.spawnRegistration ?? ((args) => spawn(DNS_SD, args, { stdio: "ignore" }));
  }

  /**
   * Begin advertising. Best-effort: a publishing failure logs a warning and
   * leaves the advertiser inert rather than throwing.
   */
  start(opts: MdnsAdvertiseOptions): void {
    // `multicast-dns` calls `os.networkInterfaces()` inside its dgram socket
    // callback (to join the multicast group). On hosts where that syscall
    // throws (EAFNOSUPPORT / "Unknown system error 97") the throw lands in an
    // async context our try/catch can't reach, crashing the whole process. mDNS
    // can't work without interface enumeration anyway, so skip it entirely here
    // rather than let the responder start and take the gateway down with it.
    if (!networkInterfacesUsable()) {
      log.warn(
        "mDNS disabled: this host cannot enumerate network interfaces (os.networkInterfaces() fails) — continuing without LAN discovery",
      );
      return;
    }
    try {
      // See #2765 — planned: re-read the LAN addresses when they change.
      const lanIps = realLanIpv4s();
      const host = opts.hostname.endsWith(".local") ? opts.hostname : `${opts.hostname}.local`;
      if (this.platform === "darwin" && this.bonjourAvailable()) {
        this.startBonjour(opts, host, lanIps);
      } else {
        this.startMulticast(opts, host, lanIps);
      }
      this.addressedHost = lanIps.length > 0 ? host : undefined;

      if (lanIps.length === 0) {
        log.warn(
          `No real LAN IPv4 found — advertising _omnesis._tcp without a host A record (${host} won't resolve for LAN clients)`,
        );
      }
      log.info(
        `Advertising _omnesis._tcp as "${opts.serviceName}" at ${host}:${opts.port}` +
          (lanIps.length > 0 ? ` (${lanIps.join(", ")})` : ""),
      );
    } catch (err) {
      this.mdns = undefined;
      this.registration = undefined;
      log.warn(
        `mDNS advertise failed (continuing without LAN discovery): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Register with the system responder. `dns-sd -P` publishes the service
   * (PTR/SRV/TXT) together with an address record for `host`; it carries one
   * address, the first real LAN IPv4. Without a LAN address, `dns-sd -R`
   * publishes the service on the Mac's own local hostname instead.
   */
  private startBonjour(opts: MdnsAdvertiseOptions, host: string, lanIps: string[]): void {
    const type = "_omnesis._tcp";
    const port = String(opts.port);
    const lanIp = lanIps[0];
    this.registrationArgs = (fingerprint) =>
      lanIp === undefined
        ? ["-R", opts.serviceName, type, "local", port, ...txtEntries(fingerprint)]
        : ["-P", opts.serviceName, type, "local", port, host, lanIp, ...txtEntries(fingerprint)];
    this.register(this.registrationArgs(opts.fingerprintSha256));
  }

  private register(args: string[]): void {
    const registration = this.spawnRegistration(args);
    this.registration = registration;
    registration.on("error", (err) => {
      if (this.registration !== registration) return;
      this.registration = undefined;
      log.warn(
        `mDNS disabled: could not run ${DNS_SD} (${err.message}) — continuing without LAN discovery`,
      );
    });
    registration.on("exit", (code, signal) => {
      if (this.registration !== registration) return;
      this.registration = undefined;
      log.warn(
        `mDNS disabled: the Bonjour registration ended (${signal ?? `exit ${code}`}) — continuing without LAN discovery`,
      );
    });
  }

  private startMulticast(opts: MdnsAdvertiseOptions, host: string, lanIps: string[]): void {
    const instance = `${opts.serviceName}.${SERVICE_TYPE}`;
    this.names = new Set([SERVICE_TYPE, instance, host]);

    // See #49 — advertise PTR (browse), SRV (host:port), TXT (scheme + cert
    // fingerprint for pin pre-seeding), and an A record per REAL LAN IPv4.
    this.answers = [
      { name: SERVICE_TYPE, type: "PTR", ttl: 4500, data: instance },
      {
        name: instance,
        type: "SRV",
        ttl: 120,
        data: { port: opts.port, weight: 0, priority: 0, target: host },
      },
      { name: instance, type: "TXT", ttl: 4500, data: txtEntries(opts.fingerprintSha256) },
      ...lanIps.map<Record>((ip) => ({ name: host, type: "A", ttl: 120, data: ip })),
    ];

    // Join the group and send on the real LAN interface, so announcements go
    // out on that segment (not a Docker netns or the tailnet), but bind the
    // socket to every address: multicast-dns binds to `interface` unless told
    // otherwise, and a Linux socket bound to a unicast address never receives
    // the queries sent to 224.0.0.251, so the gateway would announce once and
    // then answer nobody. When there's no real LAN IP, advertise the service
    // anyway but with no host A record — the collector can still SRV→host, and
    // the operator can use the URL.
    const mdns = makeMdns(
      lanIps.length > 0 ? { interface: lanIps[0], bind: "0.0.0.0" } : undefined,
    );
    this.mdns = mdns;
    // The socket reports bind failures (EADDRINUSE, EACCES) asynchronously as
    // `error` events; unhandled, one would take the whole process down.
    mdns.on("error", (err: Error) => this.onMulticastError(mdns, err));
    mdns.on("query", (query) => this.onQuery(query));
    this.respond(); // gratuitous announcement so peers cache the records
  }

  private onMulticastError(mdns: ReturnType<typeof makeMdns>, err: Error): void {
    if (this.mdns !== mdns) return;
    this.mdns = undefined;
    try {
      mdns.destroy();
    } catch {
      /* the socket is already unusable */
    }
    log.warn(`mDNS disabled: ${err.message} — continuing without LAN discovery`);
  }

  /**
   * The `.local` name this gateway currently answers for with only the host's
   * real LAN address(es), so a phone on the LAN reaches the gateway by it.
   * Null while nothing is published, or when there was no LAN address to
   * publish for the name.
   */
  advertisedHost(): string | null {
    if (!this.addressedHost || (!this.mdns && !this.registration)) return null;
    return this.addressedHost;
  }

  /**
   * Re-announce with a rotated certificate's fingerprint, so a collector that
   * pre-seeds its pin from the TXT record sees the certificate now served.
   */
  setFingerprint(fingerprintSha256: string): void {
    if (this.registration && this.registrationArgs) {
      const previous = this.registration;
      this.registration = undefined;
      previous.kill("SIGTERM");
      this.register(this.registrationArgs(fingerprintSha256));
      return;
    }
    if (!this.mdns) return;
    this.answers = this.answers.map((answer) =>
      answer.type === "TXT" ? { ...answer, data: txtEntries(fingerprintSha256) } : answer,
    );
    this.respond();
  }

  /** Answer any query that touches a name we own, with our full record set. */
  private onQuery(query: import("multicast-dns").QueryPacket): void {
    const relevant = (query.questions ?? []).some((q) => this.names.has(q.name));
    if (relevant) this.respond();
  }

  private respond(answers: Record[] = this.answers): void {
    try {
      this.mdns?.respond({ answers });
    } catch {
      /* a transient multicast send error is non-fatal */
    }
  }

  /**
   * Stop advertising. A Bonjour registration is withdrawn by ending its
   * `dns-sd` process (the system responder sends the goodbye). A multicast
   * responder sends a goodbye (records at TTL 0 so peers drop them promptly),
   * then destroys the socket. Each wait is bounded by ~1s so shutdown never
   * hangs on it.
   */
  async stop(): Promise<void> {
    const registration = this.registration;
    if (registration) {
      this.registration = undefined;
      await this.withTimeout(
        new Promise<void>((resolve) => {
          registration.on("exit", () => resolve());
          if (!registration.kill("SIGTERM")) resolve();
        }),
        1000,
      );
    }

    const mdns = this.mdns;
    if (!mdns) return;
    this.mdns = undefined;

    const goodbye: Record[] = this.answers.map((a) => ({ ...a, ttl: 0 }));
    await this.withTimeout(
      new Promise<void>((resolve) => {
        try {
          mdns.respond({ answers: goodbye }, () => resolve());
        } catch {
          resolve();
        }
      }),
      1000,
    );
    await this.withTimeout(
      new Promise<void>((resolve) => {
        try {
          mdns.destroy(() => resolve());
        } catch {
          resolve();
        }
      }),
      1000,
    );
  }

  private withTimeout(p: Promise<void>, ms: number): Promise<void> {
    return Promise.race([
      p,
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, ms);
        t.unref?.();
      }),
    ]);
  }
}
