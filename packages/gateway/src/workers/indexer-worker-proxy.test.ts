// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import { buildIndexerCutoffMap } from "./indexer-worker-proxy.js";
import { resolveIndexerCutoffMaxAge } from "./protocol.js";

describe("buildIndexerCutoffMap", () => {
  test("empty config produces empty map", () => {
    const map = buildIndexerCutoffMap({});
    expect(map).toEqual({ default: null, perSource: {} });
  });

  test("global dataRetention.maxAge becomes the default", () => {
    const map = buildIndexerCutoffMap({ dataRetention: { maxAge: "1y" } });
    expect(map.default).toBe("1y");
    expect(map.perSource).toEqual({});
  });

  test("sources.default.maxAge wins over dataRetention.maxAge for default", () => {
    const map = buildIndexerCutoffMap({
      dataRetention: { maxAge: "1y" },
      sources: { default: { maxAge: "6M" } },
    });
    expect(map.default).toBe("6M");
  });

  test("per-source overrides land in perSource keyed by sourceId", () => {
    const map = buildIndexerCutoffMap({
      dataRetention: { maxAge: "1y" },
      sources: {
        default: { maxAge: "6M" },
        "gmail:a@b.com": { maxAge: "30d" },
        "google-calendar:a@b.com": { maxAge: "90d" },
      },
    });
    expect(map.default).toBe("6M");
    expect(map.perSource).toEqual({
      "gmail:a@b.com": "30d",
      "google-calendar:a@b.com": "90d",
    });
    // The reserved `default` key is not duplicated into perSource.
    expect(map.perSource).not.toHaveProperty("default");
  });

  test("sources without maxAge are not included in perSource", () => {
    const map = buildIndexerCutoffMap({
      sources: {
        "gmail:a@b.com": { syncInterval: "5m" },
        "calendar:a@b.com": { maxAge: "30d" },
      },
    });
    expect(map.perSource).toEqual({ "calendar:a@b.com": "30d" });
  });
});

describe("resolveIndexerCutoffMaxAge", () => {
  test("a descriptor-keyed override applies to every account of that type", () => {
    const map = buildIndexerCutoffMap({
      dataRetention: { maxAge: "1y" },
      sources: { "google-drive": { maxAge: "7d" } },
    });
    expect(resolveIndexerCutoffMaxAge(map, "google-drive:maya@example.com")).toBe("7d");
    expect(resolveIndexerCutoffMaxAge(map, "google-drive:jamie@example.org")).toBe("7d");
    expect(resolveIndexerCutoffMaxAge(map, "gmail:maya@example.com")).toBe("1y");
  });

  test("the instance key wins over the descriptor key", () => {
    const map = buildIndexerCutoffMap({
      dataRetention: { maxAge: "1y" },
      sources: {
        default: { maxAge: "6M" },
        "google-drive": { maxAge: "7d" },
        "google-drive:maya@example.com": { maxAge: "30d" },
      },
    });
    expect(resolveIndexerCutoffMaxAge(map, "google-drive:maya@example.com")).toBe("30d");
    expect(resolveIndexerCutoffMaxAge(map, "google-drive:jamie@example.org")).toBe("7d");
    expect(resolveIndexerCutoffMaxAge(map, "things:local")).toBe("6M");
  });

  test("falls back to the map default when nothing addresses the source", () => {
    expect(
      resolveIndexerCutoffMaxAge({ default: null, perSource: {} }, "gmail:a@b.com"),
    ).toBeNull();
  });
});
