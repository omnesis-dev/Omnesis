// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";

import { RelayMetrics } from "./metrics.js";
import { createRelayMetricsApp } from "./metrics-server.js";
import { RelayStore } from "./store.js";

describe("relay internal metrics app", () => {
  it("serves Prometheus text only on its separate app", async () => {
    const store = new RelayStore();
    const app = createRelayMetricsApp(new RelayMetrics(), store);
    const response = await app.request("/metrics");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain; version=0.0.4");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toContain("relay_build_info");
    expect((await app.request("/health")).status).toBe(404);
    store.close();
  });
});
