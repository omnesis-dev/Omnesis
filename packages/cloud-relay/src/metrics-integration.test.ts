// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test } from "vitest";
import { fixture, echoGateway, listen, until } from "../test/support.js";
import { CloudRelayMetrics } from "./metrics.js";

test("real encrypted streams change aggregate tunnel, registration and traffic observations", async () => {
  const metrics = new CloudRelayMetrics();
  const f = await fixture({ metrics });
  const gateway = await echoGateway();
  const proxy = f.proxy(gateway);
  const origin = await listen(proxy.server);
  try {
    expect(f.relay.metrics()).toContain("cloud_relay_registered_accounts 1\n");
    expect(f.relay.metrics()).toContain("cloud_relay_online_gateways 0\n");
    await f.tunnel(gateway.url);
    const response = await fetch(origin + "/metrics-private-path-fixture", {
      headers: { authorization: "Bearer fixture-token" },
    });
    expect(response.status).toBe(200);
    await response.text();
    await until(() =>
      Promise.resolve(f.relay.metrics().includes('cloud_relay_data_events_total{event="routed"}')),
    );
    const body = f.relay.metrics();
    expect(body).toContain("cloud_relay_online_gateways 1\n");
    expect(body).toContain("cloud_relay_registered_gateways 1\n");
    expect(body).toMatch(/cloud_relay_data_ingress_bytes_total [1-9][0-9]*/);
    expect(body).toMatch(/cloud_relay_data_egress_bytes_total [1-9][0-9]*/);
    expect(body).toContain('cloud_relay_tunnel_events_total{event="connected"} 1');
    expect(body).toContain('route="tunnel_upgrade"');
    expect(body).not.toContain("metrics-private-path-fixture");
    expect(body).not.toContain(f.session.token);
    expect(body).not.toContain(f.session.accountId);
    expect((await fetch(f.url + "/metrics")).status).toBe(404);
  } finally {
    await proxy.close();
    await f.close();
    await gateway.close();
  }
});

test("DNS lease and queue gauges reflect a slow publication and return to zero after cleanup", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { AcmeDnsChallenges } = await import("./acme-dns.js");
  const dir = await mkdtemp(join(tmpdir(), "cloud-metrics-dns-"));
  let release!: () => void;
  let entered = false;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const dns = await AcmeDnsChallenges.open({
    file: join(dir, "journal.json"),
    suffix: "example.test",
    provider: {
      create: async () => {
        entered = true;
        await pending;
      },
      remove: async () => {},
    },
  });
  const f = await fixture({ acmeDns: dns });
  try {
    const work = dns.create("a".repeat(64), "gateway.example.test", "b".repeat(43));
    await until(() => Promise.resolve(entered));
    expect(f.relay.metrics()).toContain("cloud_relay_dns_leases 1\n");
    expect(f.relay.metrics()).toContain("cloud_relay_dns_queued 1\n");
    release();
    const lease = await work;
    await dns.remove("a".repeat(64), lease.id);
    expect(f.relay.metrics()).toContain("cloud_relay_dns_leases 0\n");
    expect(f.relay.metrics()).toContain("cloud_relay_dns_queued 0\n");
  } finally {
    release();
    await f.close();
    await rm(dir, { recursive: true, force: true });
  }
});
