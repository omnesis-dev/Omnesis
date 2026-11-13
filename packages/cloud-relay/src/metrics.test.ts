// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test } from "vitest";
import { CloudRelayMetrics, type RelayMetricSnapshot } from "./metrics.js";

const snapshot: RelayMetricSnapshot = {
  identityAccounts: 2,
  identityPasskeys: 3,
  identityFederatedCredentials: 1,
  identityGatewayLinks: 2,
  identityActiveSessions: 1,
  activeLogins: 0,
  loginAttempts: 1,
  maxConcurrentLogins: 8,
  maxLoginsPerMinute: 60,
  onlineGateways: 2,
  activeStreams: 3,
  pendingStreams: 1,
  maxGateways: 100,
  maxStreams: 256,
  maxStreamsPerGateway: 16,
  accounts: 4,
  maxAccounts: 100,
  gatewayBindings: 3,
  googleLinks: 2,
  dnsLeases: 1,
  dnsQueued: 0,
  dataConnections: 3,
  dataIngressBytes: 123,
  dataEgressBytes: 456,
  recoveryExpiresAt: 1800000000,
  recoveryEpoch: 2,
};
test("exports aggregate capacity, traffic and process data with no identity-bearing labels", () => {
  const metrics = new CloudRelayMetrics();
  for (const event of [
    "connected",
    "disconnected",
    "heartbeat_timeout",
    "session_expired",
    "socket_error",
    "unexpected_message",
  ] as const)
    metrics.tunnel(event);
  for (const event of [
    "requested",
    "connected",
    "closed",
    "offline",
    "capacity",
    "aborted",
    "timeout",
    "gateway_disconnected",
    "rejected",
  ] as const)
    metrics.stream(event);
  for (const event of [
    "accepted",
    "capacity",
    "hello_timeout",
    "unknown_gateway",
    "invalid_hello",
    "connect_failed",
    "routed",
    "closed",
  ] as const)
    metrics.data(event);
  for (const event of [
    "publish_success",
    "publish_failure",
    "remove_success",
    "remove_failure",
  ] as const)
    metrics.dns(event);
  metrics.tunnel("connected");
  const body = metrics.render(snapshot);
  expect(body).toContain('cloud_relay_tunnel_events_total{event="connected"} 2');
  expect(body).toContain('cloud_relay_dns_operations_total{event="remove_failure"} 1');
  expect(body).toContain("cloud_relay_online_gateways 2\n");
  expect(body).toContain("cloud_relay_identity_passkeys 3\n");
  expect(body).toContain("cloud_relay_registered_gateways 3\n");
  expect(body).toContain("cloud_relay_data_ingress_bytes_total 123\n");
  expect(body).toContain("cloud_relay_data_egress_bytes_total 456\n");
  expect(body).toMatch(/cloud_relay_process_resident_memory_bytes [1-9][0-9]+/);
  expect(body).toContain("cloud_relay_recovery_policy_epoch 2\n");
  expect(body).not.toMatch(/account_id=|gateway_id=|hostname=|token=/);
});
test("normalizes arbitrary paths, methods, query secrets and invalid status/duration inputs", () => {
  const metrics = new CloudRelayMetrics();
  metrics.http("GET", "/healthz?token=private-query-fixture", 200, 0.1);
  metrics.http("GET", "/healthz", 200, 0.2);
  metrics.http(undefined, undefined, 0, -1);
  metrics.http("secret-method-fixture", "/private-path-fixture", 600, Number.NaN);
  metrics.http("POST", "/_relay/v1/login", 401, Number.POSITIVE_INFINITY);
  metrics.http("DELETE", "/_relay/v2/acme/challenge", 503, 20);
  metrics.http("GET", "", 99, 0);
  metrics.http("GET", "/", 100, 0);
  metrics.http("GET", "/", 599, 0);
  metrics.http("GET", "/", 199.5, 0);
  const body = metrics.render(snapshot);
  expect(body).toContain(
    'cloud_relay_http_requests_total{route="health",method="GET",status="200",status_class="2xx"} 2',
  );
  expect(body).toContain(
    'cloud_relay_http_request_duration_seconds_bucket{route="health",method="GET",le="0.1"} 1',
  );
  expect(body).toContain(
    'cloud_relay_http_request_duration_seconds_bucket{route="health",method="GET",le="0.25"} 2',
  );
  expect(body).toContain(
    'cloud_relay_http_request_duration_seconds_bucket{route="health",method="GET",le="+Inf"} 2',
  );
  expect(body).toContain(
    'cloud_relay_http_request_duration_seconds_count{route="health",method="GET"} 2',
  );
  expect(body).toContain(
    'cloud_relay_http_request_duration_seconds_sum{route="health",method="GET"} 0.30000000000000004',
  );
  expect(body).toContain('status="other",status_class="other"');
  expect(body).toContain('status="100",status_class="1xx"');
  expect(body).not.toMatch(
    /private-query-fixture|private-path-fixture|secret-method-fixture|NaN|Infinity/,
  );
});

test("account operation metrics use finite route labels and discard browser capabilities", () => {
  const metrics = new CloudRelayMetrics();
  metrics.http("POST", "/_relay/v3/desktop/redeem?ticket=secret-fixture", 403, 0.01);
  metrics.http("POST", "/_relay/account/api/passkeys/authenticate/complete", 401, 0.02);
  metrics.http("GET", "/_relay/v3/gateway?gatewayId=private-fixture", 200, 0.03);
  const body = metrics.render(snapshot);
  expect(body).toContain('route="account_desktop_redeem"');
  expect(body).toContain('route="account_passkeys_authenticate_complete"');
  expect(body).toContain('route="account_gateway_selection"');
  expect(body).not.toMatch(/secret-fixture|private-fixture|ticket=/);
});
