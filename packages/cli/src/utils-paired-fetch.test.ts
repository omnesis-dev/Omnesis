// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, expect, test, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});
async function configured(paired = true, cloudRelay = true) {
  vi.stubEnv("OMNESIS_CLOUD_RELAY_ENABLED", cloudRelay ? "1" : "");
  vi.stubEnv("OMNESIS_TOKEN", "cli-test-token");
  vi.stubEnv("OMNESIS_GATEWAY_URL", "https://gateway.example.test");
  if (paired) vi.stubEnv("OMNESIS_GATEWAY_REQUEST_URL", "http://127.0.0.1:32100/");
  else vi.stubEnv("OMNESIS_GATEWAY_REQUEST_URL", "");
  vi.resetModules();
  return import("./utils.js");
}
test("paired relative and canonical absolute requests stay on verified adapter and forbid redirects", async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response("{}"));
  vi.stubGlobal("fetch", fetcher);
  const { gatewayFetch } = await configured();
  for (const path of ["/status?check=1", "https://gateway.example.test/status?check=1"]) {
    await gatewayFetch(path, { redirect: "follow" });
    expect(fetcher).toHaveBeenLastCalledWith(
      "http://127.0.0.1:32100/status?check=1",
      expect.objectContaining({
        redirect: "error",
        headers: expect.objectContaining({ Authorization: "Bearer cli-test-token" }),
      }),
    );
  }
});
test("paired requests never attach a credential to external origins or URL credentials", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  const { gatewayFetch } = await configured();
  for (const path of [
    "https://other.example.test/status",
    "//other.example.test/status",
    "http://gateway.example.test/status",
    "https://user:password@gateway.example.test/status",
    "data:text/plain,hello",
  ]) {
    await expect(gatewayFetch(path)).rejects.toThrow("paired gateway origin");
  }
  expect(fetcher).not.toHaveBeenCalled();
});
test("legacy direct absolute URLs and redirect options preserve their existing behavior", async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response("{}"));
  vi.stubGlobal("fetch", fetcher);
  const { gatewayFetch } = await configured(false);
  await gatewayFetch("https://direct.example.test/status", { redirect: "manual" });
  expect(fetcher).toHaveBeenCalledWith(
    "https://direct.example.test/status",
    expect.objectContaining({ redirect: "manual" }),
  );
});
test("without the cloud relay opt-in the request URL variable changes nothing", async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response("{}"));
  vi.stubGlobal("fetch", fetcher);
  const { gatewayFetch, GATEWAY_REQUEST_URL } = await configured(true, false);
  expect(GATEWAY_REQUEST_URL).toBe("https://gateway.example.test");
  await gatewayFetch("/status?check=1", { redirect: "manual" });
  expect(fetcher).toHaveBeenLastCalledWith(
    "https://gateway.example.test/status?check=1",
    expect.objectContaining({ redirect: "manual" }),
  );
  // Absolute URLs keep their plain handling too.
  await gatewayFetch("https://direct.example.test/status");
  expect(fetcher).toHaveBeenLastCalledWith("https://direct.example.test/status", expect.anything());
});
