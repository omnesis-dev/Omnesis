// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import {
  clearSecretFileKeyCacheForTests,
  ensureInstallRootKey,
  readSecretJsonFileSync,
} from "@omnesis/core";
import {
  createConfigRefreshQueue,
  fetchAndApplyFreshConfig,
  fetchConfigWithBackoff,
  toLegacyConfig,
} from "./gateway-config.js";
import type { HttpGatewayClient } from "@omnesis/gateway-client";
import type { OmnesisConfig } from "@omnesis/config";

let configDir: string;

beforeEach(() => {
  vi.stubEnv("OMNESIS_SECRET_STORE", "file");
  clearSecretFileKeyCacheForTests();
  configDir = mkdtempSync(join(tmpdir(), "omnesis-collector-cfg-"));
});

afterEach(() => {
  clearSecretFileKeyCacheForTests();
  vi.unstubAllEnvs();
  rmSync(configDir, { recursive: true, force: true });
});

function mockGateway(
  answers: Array<{ config: OmnesisConfig; version: number } | Error>,
): HttpGatewayClient {
  let i = 0;
  const reply = async () => {
    const next = answers[Math.min(i, answers.length - 1)];
    i++;
    if (next instanceof Error) throw next;
    return next;
  };
  return {
    getConfig: reply,
    getAdminConfig: reply,
  } as unknown as HttpGatewayClient;
}

describe("toLegacyConfig adapter", () => {
  test("maps sources.default.syncInterval → defaultSyncInterval", () => {
    const out = toLegacyConfig({
      sources: { default: { syncInterval: "3m" } },
    });
    expect(out.defaultSyncInterval).toBe("3m");
  });

  test("per-source settings override sources.default per-field", () => {
    const out = toLegacyConfig({
      sources: {
        default: { syncInterval: "5m", extractAttachments: false },
        "gmail:x@y.com": { syncInterval: "1m" },
      },
    });
    expect(out.sources?.["gmail:x@y.com"]).toEqual({
      enabled: true,
      syncInterval: "1m",
      extractAttachments: false,
    });
  });

  test("passes through dataRetention, search, and indexer unchanged", () => {
    const out = toLegacyConfig({
      dataRetention: { maxAge: "1y" },
      indexer: { model: "foo.gguf" },
      search: { params: { rrfK: 42 } },
    });
    expect(out.dataRetention?.maxAge).toBe("1y");
    expect(out.indexer?.model).toBe("foo.gguf");
    expect(out.search?.params?.rrfK).toBe(42);
  });

  test("sources become a Record keyed by source ID with enabled=true", () => {
    const out = toLegacyConfig({
      sources: {
        "gmail:a@x.com": { syncInterval: "5m" },
        "notion-pages:ws-1": {},
      },
    });
    expect(out.sources).toBeDefined();
    expect(out.sources?.["gmail:a@x.com"].enabled).toBe(true);
    expect(out.sources?.["notion-pages:ws-1"].enabled).toBe(true);
  });

  test("default alone produces no per-source entries", () => {
    const out = toLegacyConfig({ sources: { default: { syncInterval: "5m" } } });
    expect(out.sources).toBeUndefined();
    expect(out.defaultSyncInterval).toBe("5m");
  });
});

describe("fetchConfigWithBackoff — success path", () => {
  test("first-try success returns config and writes cache", async () => {
    const gateway = mockGateway([
      {
        config: { indexer: { model: "live.gguf" } },
        version: 1,
      },
    ]);
    const config = await fetchConfigWithBackoff({ gateway, configDir });
    expect(config.indexer?.model).toBe("live.gguf");
    // Cache written
    const cachePath = join(configDir, "cache", "omnesis.cache.json");
    expect(existsSync(cachePath)).toBe(true);
    const cached = JSON.parse(readFileSync(cachePath, "utf-8"));
    expect(cached.config.indexer.model).toBe("live.gguf");
    expect(cached.writtenAt).toBeGreaterThan(0);
  });

  test("reports the loaded gateway config revision", async () => {
    const onLoaded = vi.fn();
    const gateway = mockGateway([{ config: {}, version: 42 }]);

    await fetchConfigWithBackoff({ gateway, configDir, onLoaded });

    expect(onLoaded).toHaveBeenCalledWith(42);
  });
});

describe("fetchConfigWithBackoff — offline fallback", () => {
  test("uses fresh cached config when gateway is down on first attempt", async () => {
    // Seed a recent cache.
    const cachePath = join(configDir, "cache", "omnesis.cache.json");
    mkdirSync(join(configDir, "cache"), { recursive: true });
    writeFileSync(
      cachePath,
      JSON.stringify({
        writtenAt: Date.now() - 60_000,
        config: { indexer: { model: "cached.gguf" } },
      }),
    );

    const gateway = mockGateway([new Error("ECONNREFUSED")]);
    const onLoadError = vi.fn();
    const config = await fetchConfigWithBackoff({ gateway, configDir, onLoadError });
    expect(config.indexer?.model).toBe("cached.gguf");
    expect(onLoadError).toHaveBeenCalledWith(expect.objectContaining({ message: "ECONNREFUSED" }));
  });

  test("ignores stale cache (>24h) and retries until success", async () => {
    const cachePath = join(configDir, "cache", "omnesis.cache.json");
    mkdirSync(join(configDir, "cache"), { recursive: true });
    // 48h old.
    writeFileSync(
      cachePath,
      JSON.stringify({
        writtenAt: Date.now() - 48 * 60 * 60 * 1000,
        config: { indexer: { model: "stale.gguf" } },
      }),
    );
    // First attempt fails, second succeeds — simulates the gateway coming up.
    const gateway = mockGateway([
      new Error("ECONNREFUSED"),
      { config: { indexer: { model: "live.gguf" } }, version: 1 },
    ]);
    const config = await fetchConfigWithBackoff({ gateway, configDir });
    // Stale cache was ignored; we waited for the live response.
    expect(config.indexer?.model).toBe("live.gguf");
  });
});

describe("fetchAndApplyFreshConfig", () => {
  test("reports a revision only after the live config is applied", async () => {
    const onLoaded = vi.fn();
    const apply = vi.fn(async () => {});
    const gateway = mockGateway([{ config: { search: {} }, version: 17 }]);

    await fetchAndApplyFreshConfig({ gateway, configDir, onLoaded }, apply);

    expect(apply).toHaveBeenCalledWith({ search: {} });
    expect(onLoaded).toHaveBeenCalledWith(17);
    expect(apply.mock.invocationCallOrder[0]).toBeLessThan(onLoaded.mock.invocationCallOrder[0]!);
  });

  test.each([
    ["fetch", new Error("gateway unavailable"), undefined],
    ["application", undefined, new Error("config rejected")],
  ])(
    "records a %s failure without reporting the revision loaded",
    async (_kind, fetchError, applyError) => {
      const onLoaded = vi.fn();
      const onLoadError = vi.fn();
      const gateway = mockGateway([fetchError ?? { config: { search: {} }, version: 18 }]);

      await expect(
        fetchAndApplyFreshConfig({ gateway, configDir, onLoaded, onLoadError }, async () => {
          if (applyError) throw applyError;
        }),
      ).rejects.toThrow(fetchError?.message ?? applyError?.message);

      expect(onLoaded).not.toHaveBeenCalled();
      expect(onLoadError).toHaveBeenCalledWith(fetchError ?? applyError);
    },
  );

  test("serializes overlapping refreshes so revisions cannot apply out of order", async () => {
    const first = Promise.withResolvers<{ config: OmnesisConfig; version: number }>();
    const second = Promise.withResolvers<{ config: OmnesisConfig; version: number }>();
    const getConfig = vi
      .fn<() => Promise<{ config: OmnesisConfig; version: number }>>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const gateway = { getConfig } as unknown as HttpGatewayClient;
    const applied: string[] = [];
    const loaded: number[] = [];
    const refresh = createConfigRefreshQueue(
      { gateway, configDir, onLoaded: (version) => loaded.push(version) },
      async (config) => {
        applied.push(config.indexer?.model ?? "none");
      },
    );

    const older = refresh();
    const newer = refresh();
    await Promise.resolve();
    expect(getConfig).toHaveBeenCalledTimes(1);

    first.resolve({ config: { indexer: { model: "revision-11.gguf" } }, version: 11 });
    await older;
    await vi.waitFor(() => expect(getConfig).toHaveBeenCalledTimes(2));
    second.resolve({ config: { indexer: { model: "revision-12.gguf" } }, version: 12 });
    await newer;

    expect(applied).toEqual(["revision-11.gguf", "revision-12.gguf"]);
    expect(loaded).toEqual([11, 12]);
  });
});

describe("configuration cache encryption", () => {
  test("encrypts and reopens personal configuration for offline startup", async () => {
    await ensureInstallRootKey({ backend: "file", configDir });
    const config: OmnesisConfig = { sources: { "gmail:maya@example.com": {} } };
    await fetchConfigWithBackoff({ configDir, gateway: mockGateway([{ config, version: 1 }]) });
    const path = join(configDir, "cache", "omnesis.cache.json");
    expect(readFileSync(path, "utf8")).not.toContain("maya@example.com");
    expect(readSecretJsonFileSync<{ config: OmnesisConfig }>(path, { configDir })?.config).toEqual(
      config,
    );
    clearSecretFileKeyCacheForTests();
    await expect(
      fetchConfigWithBackoff({ configDir, gateway: mockGateway([new Error("offline")]) }),
    ).resolves.toEqual(config);
  });

  test("migrates legacy cached settings before using an offline copy", async () => {
    const path = join(configDir, "cache", "omnesis.cache.json");
    mkdirSync(join(configDir, "cache"));
    const config: OmnesisConfig = { sources: { "gmail:jamie@example.org": {} } };
    writeFileSync(path, JSON.stringify({ writtenAt: Date.now(), config }));
    await ensureInstallRootKey({ backend: "file", configDir });
    await expect(
      fetchConfigWithBackoff({ configDir, gateway: mockGateway([new Error("offline")]) }),
    ).resolves.toEqual(config);
    expect(readFileSync(path, "utf8")).not.toContain("jamie@example.org");
    expect(readSecretJsonFileSync<{ config: OmnesisConfig }>(path, { configDir })?.config).toEqual(
      config,
    );
  });

  test("unavailable keys preserve the encrypted cache while live config stays usable", async () => {
    await ensureInstallRootKey({ backend: "file", configDir });
    await fetchConfigWithBackoff({ configDir, gateway: mockGateway([{ config: {}, version: 1 }]) });
    const path = join(configDir, "cache", "omnesis.cache.json");
    const original = readFileSync(path, "utf8");
    rmSync(join(configDir, "keyring"), { recursive: true, force: true });
    clearSecretFileKeyCacheForTests();
    const config: OmnesisConfig = { sources: { "gmail:alex@example.com": {} } };
    await expect(
      fetchConfigWithBackoff({ configDir, gateway: mockGateway([{ config, version: 2 }]) }),
    ).resolves.toEqual(config);
    expect(readFileSync(path, "utf8")).toBe(original);
  });
});
