// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readPackageVersion } from "@omnesis/core";

const VERSION = readPackageVersion(import.meta.url);
const BUCKETS = [0.005, 0.025, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const ROUTES = new Map([
  ["/healthz", "health"],
  ["/_relay/v1/login", "login"],
  ["/_relay/v2/config", "configuration"],
  ["/_relay/v2/acme/challenge", "dns_challenge"],
  ["/_relay/v2/key/challenge", "key_challenge"],
  ["/_relay/v2/key/complete", "key_enrollment"],
  ["/_relay/v2/key/google-link", "google_link"],
  ["/_relay/v2/gateway", "gateway_directory"],
  ["/_relay/v2/google/browser/config", "browser_configuration"],
  ["/_relay/v2/google/browser/start", "browser_start"],
  ["/_relay/v2/google/browser/callback", "browser_callback"],
  ["/_relay/v2/google/browser/poll", "browser_poll"],
  ["/_relay/v2/google/browser/redeem", "browser_redeem"],
  ["/_relay/web", "web_discovery"],
  ["/_relay/web/start", "web_start"],
  ["/_relay/web/callback", "web_callback"],
  ["/_relay/v1/tunnel", "tunnel_upgrade"],
  ["/_relay/v1/data", "data_upgrade"],
]);
export type TunnelEvent =
  | "connected"
  | "disconnected"
  | "heartbeat_timeout"
  | "session_expired"
  | "socket_error"
  | "unexpected_message";
export type StreamEvent =
  | "requested"
  | "connected"
  | "closed"
  | "offline"
  | "capacity"
  | "aborted"
  | "timeout"
  | "gateway_disconnected"
  | "rejected";
export type DataEvent =
  | "accepted"
  | "capacity"
  | "hello_timeout"
  | "unknown_gateway"
  | "invalid_hello"
  | "connect_failed"
  | "routed"
  | "closed";
export type DnsEvent = "publish_success" | "publish_failure" | "remove_success" | "remove_failure";
export interface RelayMetricSnapshot {
  activeLogins: number;
  loginAttempts: number;
  maxConcurrentLogins: number;
  maxLoginsPerMinute: number;
  onlineGateways: number;
  activeStreams: number;
  pendingStreams: number;
  maxGateways: number;
  maxStreams: number;
  maxStreamsPerGateway: number;
  accounts: number;
  maxAccounts: number;
  gatewayBindings: number;
  googleLinks: number;
  dnsLeases: number;
  dnsQueued: number;
  dataConnections: number;
  dataIngressBytes: number;
  dataEgressBytes: number;
  recoveryExpiresAt: number;
  recoveryEpoch: number;
}
const GAUGES: readonly (readonly [string, keyof RelayMetricSnapshot])[] = [
  ["active_logins", "activeLogins"],
  ["login_attempts_current_minute", "loginAttempts"],
  ["max_concurrent_logins", "maxConcurrentLogins"],
  ["max_logins_per_minute", "maxLoginsPerMinute"],
  ["online_gateways", "onlineGateways"],
  ["active_streams", "activeStreams"],
  ["pending_streams", "pendingStreams"],
  ["max_gateways", "maxGateways"],
  ["max_streams", "maxStreams"],
  ["max_streams_per_gateway", "maxStreamsPerGateway"],
  ["registered_accounts", "accounts"],
  ["max_accounts", "maxAccounts"],
  ["registered_gateways", "gatewayBindings"],
  ["google_links", "googleLinks"],
  ["dns_leases", "dnsLeases"],
  ["dns_queued", "dnsQueued"],
  ["data_connections", "dataConnections"],
  ["recovery_policy_expiry_timestamp_seconds", "recoveryExpiresAt"],
  ["recovery_policy_epoch", "recoveryEpoch"],
];
interface Histogram {
  buckets: number[];
  count: number;
  sum: number;
}

/** Bounded operation labels only: never record URLs, SNI, accounts, tokens or gateway identities. */
export class CloudRelayMetrics {
  private readonly requests = new Map<string, number>();
  private readonly durations = new Map<string, Histogram>();
  private readonly events = new Map<string, number>();
  private readonly started = Date.now() / 1000;

  http(
    method: string | undefined,
    url: string | undefined,
    status: number,
    durationSeconds: number,
  ): void {
    const route = ROUTES.get(url?.split("?")[0] ?? "") ?? "other";
    const verb = ["GET", "POST", "DELETE"].includes(method ?? "") ? method! : "other";
    const code =
      Number.isInteger(status) && status >= 100 && status < 600 ? String(status) : "other";
    const statusClass = code === "other" ? "other" : `${Math.floor(status / 100)}xx`;
    const key = `route="${route}",method="${verb}"`;
    this.increment(this.requests, `${key},status="${code}",status_class="${statusClass}"`);
    const observations = this.durations.get(key) ?? {
      buckets: BUCKETS.map(() => 0),
      count: 0,
      sum: 0,
    };
    const duration = Number.isFinite(durationSeconds) ? Math.max(0, durationSeconds) : 0;
    BUCKETS.forEach((boundary, index) => {
      if (duration <= boundary) observations.buckets[index]!++;
    });
    observations.count++;
    observations.sum += duration;
    this.durations.set(key, observations);
  }
  tunnel(event: TunnelEvent): void {
    this.increment(this.events, `tunnel_events_total{event="${event}"}`);
  }
  stream(event: StreamEvent): void {
    this.increment(this.events, `stream_events_total{event="${event}"}`);
  }
  data(event: DataEvent): void {
    this.increment(this.events, `data_events_total{event="${event}"}`);
  }
  dns(event: DnsEvent): void {
    this.increment(this.events, `dns_operations_total{event="${event}"}`);
  }

  render(snapshot: RelayMetricSnapshot): string {
    const memory = process.memoryUsage();
    const cpu = process.cpuUsage();
    const lines = [
      "# TYPE cloud_relay_build_info gauge",
      `cloud_relay_build_info{version=${JSON.stringify(VERSION)}} 1`,
    ];
    for (const [name, field] of GAUGES)
      lines.push(`# TYPE cloud_relay_${name} gauge`, `cloud_relay_${name} ${snapshot[field]}`);
    for (const [name, value] of [
      ["data_ingress_bytes_total", snapshot.dataIngressBytes],
      ["data_egress_bytes_total", snapshot.dataEgressBytes],
      ["process_cpu_user_seconds_total", cpu.user / 1e6],
      ["process_cpu_system_seconds_total", cpu.system / 1e6],
    ] as const)
      lines.push(`# TYPE cloud_relay_${name} counter`, `cloud_relay_${name} ${value}`);
    for (const [name, value] of [
      ["process_start_time_seconds", this.started],
      ["process_uptime_seconds", process.uptime()],
      ["process_resident_memory_bytes", memory.rss],
      ["process_heap_used_bytes", memory.heapUsed],
      ["process_heap_total_bytes", memory.heapTotal],
      ["process_external_memory_bytes", memory.external],
    ] as const)
      lines.push(`# TYPE cloud_relay_${name} gauge`, `cloud_relay_${name} ${value}`);
    lines.push("# TYPE cloud_relay_http_requests_total counter");
    for (const [key, value] of this.requests)
      lines.push(`cloud_relay_http_requests_total{${key}} ${value}`);
    lines.push("# TYPE cloud_relay_http_request_duration_seconds histogram");
    for (const [key, value] of this.durations) {
      BUCKETS.forEach((boundary, index) =>
        lines.push(
          `cloud_relay_http_request_duration_seconds_bucket{${key},le="${boundary}"} ${value.buckets[index]}`,
        ),
      );
      lines.push(
        `cloud_relay_http_request_duration_seconds_bucket{${key},le="+Inf"} ${value.count}`,
        `cloud_relay_http_request_duration_seconds_count{${key}} ${value.count}`,
        `cloud_relay_http_request_duration_seconds_sum{${key}} ${value.sum}`,
      );
    }
    for (const name of [
      "tunnel_events_total",
      "stream_events_total",
      "data_events_total",
      "dns_operations_total",
    ]) {
      lines.push(`# TYPE cloud_relay_${name} counter`);
      for (const [key, value] of this.events)
        if (key.startsWith(name + "{")) lines.push(`cloud_relay_${key} ${value}`);
    }
    return lines.join("\n") + "\n";
  }
  private increment(values: Map<string, number>, key: string): void {
    values.set(key, (values.get(key) ?? 0) + 1);
  }
}
