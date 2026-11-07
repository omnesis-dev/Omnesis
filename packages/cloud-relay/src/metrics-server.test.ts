// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test, vi } from "vitest";
import { startRelayMetricsServer } from "./metrics-server.js";

test("serves only exact GET /metrics on loopback, suppresses renderer failures, and closes its listener", async () => {
  const render = vi.fn(() => "fixture_metric 1\n");
  const server = await startRelayMetricsServer(0, render);
  const url = `http://127.0.0.1:${server.port}`;
  try {
    const response = await fetch(url + "/metrics");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("version=0.0.4");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("fixture_metric 1\n");
    for (const path of ["/", "/metrics/", "/metrics?token=fixture"])
      expect((await fetch(url + path)).status).toBe(404);
    expect((await fetch(url + "/metrics", { method: "POST" })).status).toBe(404);
    render.mockImplementation(() => {
      throw new Error("private-render-error-fixture");
    });
    const failed = await fetch(url + "/metrics");
    expect(failed.status).toBe(503);
    expect(await failed.text()).toBe("");
    await expect(startRelayMetricsServer(server.port, () => "")).rejects.toMatchObject({
      code: "EADDRINUSE",
    });
  } finally {
    await server.close();
  }
  await expect(server.close()).rejects.toMatchObject({ code: "ERR_SERVER_NOT_RUNNING" });
});
