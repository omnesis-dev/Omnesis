// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it, vi } from "vitest";

import { checkRelayHealth, type RelayHealthCheckOptions } from "./health-check.js";

const NOW = 1_700_000_000_000;

function health(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    status: "ready",
    protocols: { enrolment: [1], wake: [1] },
    carriers: {
      ios: {
        configured: true,
        status: "reachable",
        lastSuccessAt: NOW - 1_000,
        lastFailureAt: null,
      },
      android: {
        configured: true,
        status: "reachable",
        lastSuccessAt: NOW - 2_000,
        lastFailureAt: null,
      },
    },
    ...overrides,
  };
}

function options(response: Response): RelayHealthCheckOptions {
  return {
    url: new URL("https://relay.example.com"),
    maxSuccessAgeMs: 60_000,
    maxClockSkewMs: 5_000,
    timeoutMs: 1_000,
    now: () => NOW,
    fetchFn: vi.fn(() => Promise.resolve(response)),
  };
}

describe("relay health check", () => {
  it("accepts a ready relay with fresh carrier successes", async () => {
    const input = options(Response.json(health()));
    await expect(checkRelayHealth(input)).resolves.toEqual({
      kind: "healthy",
      message: "relay is ready and both carrier successes are fresh",
    });
    expect(input.fetchFn).toHaveBeenCalledWith(
      new URL("https://relay.example.com/health"),
      expect.objectContaining({ method: "GET", redirect: "error" }),
    );
  });

  it.each([
    ["unknown", 503],
    ["degraded", 503],
  ])("reports a %s relay as unhealthy", async (status, responseStatus) => {
    const response = Response.json(health({ ok: false, status }), { status: responseStatus });
    await expect(checkRelayHealth(options(response))).resolves.toEqual({
      kind: "unhealthy",
      message: `relay status is ${status}`,
    });
  });

  it("requires both configured, reachable carriers", async () => {
    const payload = health();
    const carriers = payload.carriers as Record<string, unknown>;
    carriers.ios = null;
    await expect(checkRelayHealth(options(Response.json(payload)))).resolves.toEqual({
      kind: "unhealthy",
      message: "iOS carrier is not configured",
    });

    carriers.ios = {
      configured: true,
      status: "reachable",
      lastSuccessAt: NOW,
      lastFailureAt: null,
    };
    carriers.android = {
      configured: true,
      status: "unknown",
      lastSuccessAt: null,
      lastFailureAt: null,
    };
    await expect(checkRelayHealth(options(Response.json(payload)))).resolves.toEqual({
      kind: "unhealthy",
      message: "Android carrier is not reachable",
    });
  });

  it("rejects stale, future, and superseded carrier successes", async () => {
    const payload = health();
    const ios = (payload.carriers as Record<string, Record<string, unknown>>).ios!;

    ios.lastSuccessAt = NOW - 60_001;
    await expect(checkRelayHealth(options(Response.json(payload)))).resolves.toMatchObject({
      kind: "unhealthy",
      message: "iOS carrier success is stale",
    });

    ios.lastSuccessAt = NOW + 5_001;
    await expect(checkRelayHealth(options(Response.json(payload)))).resolves.toMatchObject({
      kind: "unhealthy",
      message: "iOS carrier success timestamp is in the future",
    });

    ios.lastSuccessAt = NOW - 1_000;
    ios.lastFailureAt = NOW;
    await expect(checkRelayHealth(options(Response.json(payload)))).resolves.toMatchObject({
      kind: "unhealthy",
      message: "iOS carrier failed after its last success",
    });
  });

  it("requires the current enrolment and wake protocols", async () => {
    const payload = health({ protocols: { enrolment: [2], wake: [1] } });
    await expect(checkRelayHealth(options(Response.json(payload)))).resolves.toEqual({
      kind: "unhealthy",
      message: "relay does not accept this enrolment protocol",
    });

    payload.protocols = { enrolment: [1], wake: [2] };
    await expect(checkRelayHealth(options(Response.json(payload)))).resolves.toEqual({
      kind: "unhealthy",
      message: "relay does not accept this wake protocol",
    });
  });

  it("fails closed on network, malformed, and oversized responses", async () => {
    const network = options(Response.json(health()));
    network.fetchFn = vi.fn(() => Promise.reject(new Error("network details must not escape")));
    await expect(checkRelayHealth(network)).resolves.toEqual({
      kind: "probe_failed",
      message: "relay health request failed",
    });

    await expect(checkRelayHealth(options(new Response("not-json")))).resolves.toMatchObject({
      kind: "probe_failed",
      message: "relay health response was not valid JSON",
    });
    await expect(
      checkRelayHealth(options(Response.json({ status: "ready" }))),
    ).resolves.toMatchObject({
      kind: "probe_failed",
      message: "relay health response had an invalid shape",
    });
    await expect(
      checkRelayHealth(
        options(new Response("{}", { headers: { "content-length": String(17 * 1024) } })),
      ),
    ).resolves.toMatchObject({
      kind: "probe_failed",
      message: "relay health response exceeded the size limit",
    });

    await expect(
      checkRelayHealth(options(new Response("x".repeat(17 * 1024)))),
    ).resolves.toMatchObject({
      kind: "probe_failed",
      message: "relay health response exceeded the size limit",
    });
  });
});
