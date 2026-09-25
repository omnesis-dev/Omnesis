// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Minimal ambient types for `multicast-dns` (the lib ships none, and there is
 * no maintained `@types/multicast-dns` for v7). Only the surface the mDNS
 * advertiser uses is declared.
 */
declare module "multicast-dns" {
  interface SrvData {
    port: number;
    weight: number;
    priority: number;
    target: string;
  }

  interface ResourceRecord {
    name: string;
    type: "A" | "AAAA" | "PTR" | "SRV" | "TXT";
    ttl?: number;
    /** string for A/PTR; string[] for TXT (key=value entries); SrvData for SRV. */
    data?: string | string[] | SrvData;
  }

  interface QueryPacket {
    questions?: Array<{ name: string; type: string }>;
  }

  interface MulticastDns {
    on(event: "query", handler: (query: QueryPacket) => void): void;
    /** Socket failures, including a refused bind (EADDRINUSE / EACCES), arrive asynchronously. */
    on(event: "error", handler: (err: Error) => void): void;
    respond(res: { answers: ResourceRecord[] }, cb?: () => void): void;
    destroy(cb?: () => void): void;
  }

  interface MulticastDnsOptions {
    /**
     * Interface (an IP address string) to join the multicast group and send on.
     * Also the socket's bind address unless `bind` says otherwise.
     */
    interface?: string;
    /**
     * Address to bind the socket to. On Linux a socket bound to a unicast
     * address never receives datagrams sent to the group, so a responder that
     * must hear queries binds `0.0.0.0` and names its LAN address in `interface`.
     */
    bind?: string | false;
    loopback?: boolean;
    reuseAddr?: boolean;
  }

  export default function makeMdns(opts?: MulticastDnsOptions): MulticastDns;
}
