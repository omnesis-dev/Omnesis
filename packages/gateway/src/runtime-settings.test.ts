// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { backfillOptsFromRuntime, resolveRuntimeSettings } from "./runtime-settings.js";
import type { OmnesisConfig } from "@omnesis/config";

const TIMING_ENVS = [
  "OMNESIS_SLOW_REQUEST_MS",
  "OMNESIS_INDEX_INTERVAL",
  "OMNESIS_RECONCILE_INTERVAL",
  "OMNESIS_REINDEX_MISSING_INTERVAL",
  "OMNESIS_INDEXER_BETWEEN_PAGE_SLEEP",
  "OMNESIS_EMBED_CONCURRENCY",
  "OMNESIS_INDEXER_PAGE_SIZE",
  "OMNESIS_JOURNAL_MODE",
];

describe("resolveRuntimeSettings — gateway.timings", () => {
  // Each test owns a snapshot/restore window so a polluting env var
  // from a sibling suite can't make these flaky. Same pattern as
  // packages/cli-shared/formatters.test.ts uses for fake timers.
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of TIMING_ENVS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of TIMING_ENVS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  // The knob was renamed when the job was. An install that already sets the
  // old key must keep working, and one that sets both must get the new one.
  test("peopleCounts interval accepts the former mergePass key", () => {
    const viaOldKey = resolveRuntimeSettings({
      gateway: { backfill: { mergePass: { interval: "37m" } } },
    } as never);
    expect(viaOldKey.peopleCountsRefreshIntervalMs).toBe(37 * 60_000);

    const viaNewKey = resolveRuntimeSettings({
      gateway: { backfill: { peopleCounts: { interval: "12m" } } },
    } as never);
    expect(viaNewKey.peopleCountsRefreshIntervalMs).toBe(12 * 60_000);

    const both = resolveRuntimeSettings({
      gateway: {
        backfill: { peopleCounts: { interval: "5m" }, mergePass: { interval: "99m" } },
      },
    } as never);
    expect(both.peopleCountsRefreshIntervalMs).toBe(5 * 60_000);
  });

  test("defaults when neither config nor env supplies a value", () => {
    const r = resolveRuntimeSettings(undefined);
    expect(r.slowRequestMs).toBe(500);
    expect(r.wsHeartbeatIntervalMs).toBe(30_000);
    expect(r.wsAuthTimeoutMs).toBe(5_000);
    expect(r.wsCommandTimeoutMs).toBe(30_000);
    expect(r.authFlowTtlMs).toBe(15 * 60 * 1000);
    expect(r.pairingTtlMs).toBe(10 * 60 * 1000);
    expect(r.sessionTtlMs).toBe(30 * 24 * 60 * 60 * 1000);
    expect(r.sessionRefreshThrottleMs).toBe(60 * 60 * 1000);
    expect(r.analyticsStreamRekeyMaxRows).toBe(100_000);
  });

  test("config gateway.timings overrides defaults", () => {
    const cfg: OmnesisConfig = {
      gateway: {
        timings: {
          slowRequest: "750ms",
          wsHeartbeatInterval: "10s",
          wsAuthTimeout: "2s",
          wsCommandTimeout: "60s",
          authFlowTtl: "30m",
          pairingTtl: "5m",
          sessionTtl: "7d",
          sessionRefreshThrottle: "30m",
        },
      },
    };
    const r = resolveRuntimeSettings(cfg);
    expect(r.slowRequestMs).toBe(750);
    expect(r.wsHeartbeatIntervalMs).toBe(10_000);
    expect(r.wsAuthTimeoutMs).toBe(2_000);
    expect(r.wsCommandTimeoutMs).toBe(60_000);
    expect(r.authFlowTtlMs).toBe(30 * 60 * 1000);
    expect(r.pairingTtlMs).toBe(5 * 60 * 1000);
    expect(r.sessionTtlMs).toBe(7 * 24 * 60 * 60 * 1000);
    expect(r.sessionRefreshThrottleMs).toBe(30 * 60 * 1000);
  });

  test("OMNESIS_SLOW_REQUEST_MS env wins over config (back-compat)", () => {
    process.env.OMNESIS_SLOW_REQUEST_MS = "1234";
    const cfg: OmnesisConfig = {
      gateway: { timings: { slowRequest: "100ms" } },
    };
    const r = resolveRuntimeSettings(cfg);
    expect(r.slowRequestMs).toBe(1234);
  });

  test("OMNESIS_SLOW_REQUEST_MS=0 disables the slow-request line", () => {
    process.env.OMNESIS_SLOW_REQUEST_MS = "0";
    const r = resolveRuntimeSettings(undefined);
    expect(r.slowRequestMs).toBe(0);
  });

  test("partial timings block falls back to defaults for missing fields", () => {
    const r = resolveRuntimeSettings({
      gateway: { timings: { sessionTtl: "1d" } },
    });
    expect(r.sessionTtlMs).toBe(24 * 60 * 60 * 1000);
    // unset fields keep defaults
    expect(r.pairingTtlMs).toBe(10 * 60 * 1000);
    expect(r.wsHeartbeatIntervalMs).toBe(30_000);
  });

  test("gateway.timings coexists with gateway.journalMode", () => {
    const r = resolveRuntimeSettings({
      gateway: { journalMode: "TRUNCATE", timings: { slowRequest: "250ms" } },
    });
    expect(r.journalMode).toBe("TRUNCATE");
    expect(r.slowRequestMs).toBe(250);
  });

  test("config controls the online analytics stream-rekey admission ceiling", () => {
    expect(
      resolveRuntimeSettings({ gateway: { analyticsStreamRekeyMaxRows: 25_000 } })
        .analyticsStreamRekeyMaxRows,
    ).toBe(25_000);
  });
});

describe("resolveRuntimeSettings — indexer.chunker / indexer.embedder", () => {
  test("defaults when neither config nor env supplies a value", () => {
    const r = resolveRuntimeSettings(undefined);
    expect(r.chunkerChunkSize).toBe(2048);
    expect(r.chunkerOverlap).toBe(512);
    expect(r.embedderContextSize).toBe(2048);
    expect(r.embedderTimeoutMs).toBe(30_000);
    expect(r.embedderMaxInputChars).toBe(2048 * 3);
  });

  test("config indexer.chunker overrides defaults", () => {
    const cfg: OmnesisConfig = {
      indexer: { chunker: { chunkSize: 4096, overlap: 1024 } },
    };
    const r = resolveRuntimeSettings(cfg);
    expect(r.chunkerChunkSize).toBe(4096);
    expect(r.chunkerOverlap).toBe(1024);
    // embedder fields keep their defaults
    expect(r.embedderContextSize).toBe(2048);
  });

  test("config indexer.embedder overrides defaults", () => {
    const cfg: OmnesisConfig = {
      indexer: {
        embedder: { contextSize: 4096, timeoutMs: 60_000, maxInputChars: 12_000 },
      },
    };
    const r = resolveRuntimeSettings(cfg);
    expect(r.embedderContextSize).toBe(4096);
    expect(r.embedderTimeoutMs).toBe(60_000);
    expect(r.embedderMaxInputChars).toBe(12_000);
  });

  test("partial chunker block falls back to defaults for missing fields", () => {
    const r = resolveRuntimeSettings({
      indexer: { chunker: { chunkSize: 1024 } },
    });
    expect(r.chunkerChunkSize).toBe(1024);
    expect(r.chunkerOverlap).toBe(512);
  });
});

describe("resolveRuntimeSettings — gateway.backfill defaults", () => {
  // Pins every default. The contract is: an empty config produces the
  // same runtime values the gateway used before any of these knobs
  // were tunable, so an upgrade with no config edit is a no-op for
  // background-task cadence. Update this test if you change a default.
  test("every backfill knob defaults to its prior hardcoded value", () => {
    const r = resolveRuntimeSettings(undefined);
    // links
    expect(r.linkBackfillIntervalMs).toBe(1_000);
    expect(r.linkIdleDelayMs).toBe(30_000);
    // linkReconcile
    expect(r.linkReconcileIntervalMs).toBe(5 * 60_000);
    expect(r.linkReconcileBatchSize).toBe(500);
    // people
    expect(r.peopleBatchIntervalMs).toBe(200);
    expect(r.peopleIdleDelayMs).toBe(30_000);
    expect(r.peopleBatchSize).toBe(500);
    // people counts
    expect(r.peopleCountsRefreshIntervalMs).toBe(10 * 60_000);
    // stats
    expect(r.statsRefreshIntervalMs).toBe(30_000);
    // catalog
    expect(r.catalogRefreshIntervalMs).toBe(5 * 60_000);
    // linkStats (reconciliation cadence — reads use trigger-maintained counters)
    expect(r.linkStatsRefreshIntervalMs).toBe(3_600_000);
    expect(r.linkStatsIdleDelayMs).toBe(6 * 3_600_000);
    // interactionScores
    expect(r.interactionScoresRefreshIntervalMs).toBe(60_000);
    expect(r.interactionScoresIdleDelayMs).toBe(5 * 60_000);
    // mergeRulesEval
    expect(r.mergeRulesEvalIntervalMs).toBe(60_000);
    expect(r.mergeRulesEvalIdleDelayMs).toBe(5 * 60_000);
    // autoDetect
    expect(r.autoDetectIntervalMs).toBe(5 * 60_000);
    // mergeCandidates
    expect(r.mergeCandidatesDetectIntervalMs).toBe(5 * 60_000);
    expect(r.mergeCandidatesDetectIdleDelayMs).toBe(30 * 60_000);
  });

  test("empty backfill block yields all defaults", () => {
    const r = resolveRuntimeSettings({ gateway: { backfill: {} } });
    expect(r.linkBackfillIntervalMs).toBe(1_000);
    expect(r.linkReconcileBatchSize).toBe(500);
    expect(r.mergeCandidatesDetectIdleDelayMs).toBe(30 * 60_000);
  });
});

describe("resolveRuntimeSettings — gateway.backfill overrides", () => {
  test("full override of every sub-block", () => {
    const cfg: OmnesisConfig = {
      gateway: {
        backfill: {
          links: { interval: "2s", idleDelay: "1m" },
          linkReconcile: { interval: "30s", batchSize: 5000 },
          people: { interval: "500ms", idleDelay: "1m", batchSize: 1000 },
          mergePass: { interval: "20m" },
          sourceStats: { interval: "10s" },
          catalog: { interval: "2m" },
          linkStats: { interval: "15s", idleDelay: "1m" },
          interactionScores: { interval: "30s", idleDelay: "10m" },
          mergeRulesEval: { interval: "45s", idleDelay: "2m" },
          autoDetect: { interval: "3m" },
          mergeCandidates: { interval: "10m", idleDelay: "1h" },
        },
      },
    };
    const r = resolveRuntimeSettings(cfg);
    expect(r.linkBackfillIntervalMs).toBe(2_000);
    expect(r.linkIdleDelayMs).toBe(60_000);
    expect(r.linkReconcileIntervalMs).toBe(30_000);
    expect(r.linkReconcileBatchSize).toBe(5_000);
    expect(r.peopleBatchIntervalMs).toBe(500);
    expect(r.peopleIdleDelayMs).toBe(60_000);
    expect(r.peopleBatchSize).toBe(1_000);
    expect(r.peopleCountsRefreshIntervalMs).toBe(20 * 60_000);
    expect(r.statsRefreshIntervalMs).toBe(10_000);
    expect(r.catalogRefreshIntervalMs).toBe(2 * 60_000);
    expect(r.linkStatsRefreshIntervalMs).toBe(15_000);
    expect(r.linkStatsIdleDelayMs).toBe(60_000);
    expect(r.interactionScoresRefreshIntervalMs).toBe(30_000);
    expect(r.interactionScoresIdleDelayMs).toBe(10 * 60_000);
    expect(r.mergeRulesEvalIntervalMs).toBe(45_000);
    expect(r.mergeRulesEvalIdleDelayMs).toBe(2 * 60_000);
    expect(r.autoDetectIntervalMs).toBe(3 * 60_000);
    expect(r.mergeCandidatesDetectIntervalMs).toBe(10 * 60_000);
    expect(r.mergeCandidatesDetectIdleDelayMs).toBe(60 * 60_000);
  });

  test("partial linkReconcile block falls back to defaults for missing fields", () => {
    const r = resolveRuntimeSettings({
      gateway: { backfill: { linkReconcile: { batchSize: 1000 } } },
    });
    expect(r.linkReconcileBatchSize).toBe(1000);
    expect(r.linkReconcileIntervalMs).toBe(5 * 60_000);
  });

  test("partial people block falls back to defaults for missing fields", () => {
    const r = resolveRuntimeSettings({
      gateway: { backfill: { people: { batchSize: 250 } } },
    });
    expect(r.peopleBatchSize).toBe(250);
    expect(r.peopleBatchIntervalMs).toBe(200);
    expect(r.peopleIdleDelayMs).toBe(30_000);
  });

  test("single-field override leaves all unrelated tasks at defaults", () => {
    const r = resolveRuntimeSettings({
      gateway: { backfill: { autoDetect: { interval: "1m" } } },
    });
    expect(r.autoDetectIntervalMs).toBe(60_000);
    expect(r.peopleCountsRefreshIntervalMs).toBe(10 * 60_000);
    expect(r.linkReconcileBatchSize).toBe(500);
    expect(r.statsRefreshIntervalMs).toBe(30_000);
  });

  test("duration strings parse for every supported suffix", () => {
    const r = resolveRuntimeSettings({
      gateway: {
        backfill: {
          links: { interval: "750ms" },
          sourceStats: { interval: "45s" },
          catalog: { interval: "7m" },
          mergePass: { interval: "2h" },
          mergeCandidates: { interval: "1d" },
        },
      },
    });
    expect(r.linkBackfillIntervalMs).toBe(750);
    expect(r.statsRefreshIntervalMs).toBe(45_000);
    expect(r.catalogRefreshIntervalMs).toBe(7 * 60_000);
    expect(r.peopleCountsRefreshIntervalMs).toBe(2 * 60 * 60_000);
    expect(r.mergeCandidatesDetectIntervalMs).toBe(24 * 60 * 60_000);
  });

  // The shared `duration` zod field accepts both string ("5m") and
  // plain-integer ("1500") forms. parseDuration interprets plain
  // integers as milliseconds, but rejects values below
  // BARE_NUMBER_MIN_MS (1000) to prevent unit-confusion (a user
  // writing `"interval": 5` almost certainly meant 5 seconds, not
  // 5 ms — failing loud at boot is better than ticking 200×/sec).
  // The schema doesn't enforce this minimum because the same regex
  // is shared with elsewhere-meaningful small values; the trap is
  // here, at the resolver. This test documents both halves.
  test("bare-number duration ≥1000 passes through as ms", () => {
    const r = resolveRuntimeSettings({
      gateway: { backfill: { links: { interval: "1500" } } },
    });
    expect(r.linkBackfillIntervalMs).toBe(1_500);
  });

  test("bare-number duration <1000 passes schema but throws at resolver", () => {
    expect(() =>
      resolveRuntimeSettings({
        gateway: { backfill: { links: { interval: "5" } } },
      }),
    ).toThrow(/bare numbers below 1000ms are rejected/);
  });

  test("backfill coexists with gateway.timings and gateway.journalMode", () => {
    const r = resolveRuntimeSettings({
      gateway: {
        journalMode: "TRUNCATE",
        timings: { slowRequest: "250ms" },
        backfill: { linkReconcile: { batchSize: 2000 } },
      },
    });
    expect(r.journalMode).toBe("TRUNCATE");
    expect(r.slowRequestMs).toBe(250);
    expect(r.linkReconcileBatchSize).toBe(2000);
  });
});

describe("backfillOptsFromRuntime — field-mapping integrity", () => {
  // Guards against accidental field swaps in the wiring (e.g.
  // assigning `peopleBatchIntervalMs` to a slot expecting
  // `peopleIdleDelayMs` — both numbers, both pass typecheck, but
  // wires the wrong cadence into the wrong task). Each sub-block
  // is given a unique non-default value so a swap shows up as the
  // wrong assertion failing, not as a silent overlap with a default.
  test("each config sub-block lands on its named runtime field", () => {
    const r = resolveRuntimeSettings({
      gateway: {
        backfill: {
          links: { interval: "111ms", idleDelay: "112s" },
          linkReconcile: { interval: "121s", batchSize: 1213 },
          people: { interval: "131ms", idleDelay: "132s", batchSize: 1314 },
          mergePass: { interval: "141m" },
          sourceStats: { interval: "151s" },
          catalog: { interval: "161m" },
          linkStats: { interval: "171s", idleDelay: "172m" },
          interactionScores: { interval: "181s", idleDelay: "182m" },
          mergeRulesEval: { interval: "191s", idleDelay: "192m" },
          autoDetect: { interval: "201m" },
          mergeCandidates: { interval: "211m", idleDelay: "212m" },
        },
      },
    });
    const opts = backfillOptsFromRuntime(r);
    expect(opts).toEqual({
      linkBackfillIntervalMs: 111,
      linkIdleDelayMs: 112_000,
      linkReconcileIntervalMs: 121_000,
      linkReconcileBatchSize: 1_213,
      peopleBatchIntervalMs: 131,
      peopleIdleDelayMs: 132_000,
      peopleBatchSize: 1_314,
      peopleCountsRefreshIntervalMs: 141 * 60_000,
      statsRefreshIntervalMs: 151_000,
      catalogRefreshIntervalMs: 161 * 60_000,
      linkStatsRefreshIntervalMs: 171_000,
      linkStatsIdleDelayMs: 172 * 60_000,
      interactionScoresRefreshIntervalMs: 181_000,
      interactionScoresIdleDelayMs: 182 * 60_000,
      mergeRulesEvalIntervalMs: 191_000,
      mergeRulesEvalIdleDelayMs: 192 * 60_000,
      autoDetectIntervalMs: 201 * 60_000,
      mergeCandidatesDetectIntervalMs: 211 * 60_000,
      mergeCandidatesDetectIdleDelayMs: 212 * 60_000,
    });
  });

  test("returned shape carries every field BackfillTaskOpts consumes from runtime", () => {
    // Sanity: the helper return shape must keep parity with
    // `BackfillTaskOpts` fields that flow from runtime. If a new
    // backfill knob is added in `runtime-settings.ts` and the
    // helper isn't extended, this test catches the omission.
    const opts = backfillOptsFromRuntime(resolveRuntimeSettings(undefined));
    const expectedKeys = [
      "linkBackfillIntervalMs",
      "linkIdleDelayMs",
      "linkReconcileIntervalMs",
      "linkReconcileBatchSize",
      "peopleBatchSize",
      "peopleBatchIntervalMs",
      "peopleIdleDelayMs",
      "peopleCountsRefreshIntervalMs",
      "statsRefreshIntervalMs",
      "catalogRefreshIntervalMs",
      "linkStatsRefreshIntervalMs",
      "linkStatsIdleDelayMs",
      "interactionScoresRefreshIntervalMs",
      "interactionScoresIdleDelayMs",
      "mergeRulesEvalIntervalMs",
      "mergeRulesEvalIdleDelayMs",
      "autoDetectIntervalMs",
      "mergeCandidatesDetectIntervalMs",
      "mergeCandidatesDetectIdleDelayMs",
    ];
    expect(Object.keys(opts).sort()).toEqual(expectedKeys.sort());
  });
});

describe("resolveRuntimeSettings — gateway.publicBaseUrl", () => {
  let savedEnv: string | undefined;
  beforeEach(() => {
    savedEnv = process.env.OMNESIS_PUBLIC_BASE_URL;
    delete process.env.OMNESIS_PUBLIC_BASE_URL;
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.OMNESIS_PUBLIC_BASE_URL;
    else process.env.OMNESIS_PUBLIC_BASE_URL = savedEnv;
  });

  test("undefined when neither config nor env supplies a value", () => {
    expect(resolveRuntimeSettings(undefined).publicBaseUrl).toBeUndefined();
  });

  test("rejects MCP resource aliases when no public OAuth issuer resolves", () => {
    expect(() =>
      resolveRuntimeSettings({
        gateway: { mcpResourceUrls: ["https://private.example.net:7600/mcp"] },
      }),
    ).toThrow(/requires gateway.publicBaseUrl or OMNESIS_PUBLIC_BASE_URL/);
  });

  test("rejects MCP resource aliases when the environment issuer is invalid", () => {
    process.env.OMNESIS_PUBLIC_BASE_URL = "http://untrusted.example.org";
    expect(() =>
      resolveRuntimeSettings({
        gateway: { mcpResourceUrls: ["https://private.example.net:7600/mcp"] },
      }),
    ).toThrow(/requires gateway.publicBaseUrl or OMNESIS_PUBLIC_BASE_URL/);
  });

  test("reads gateway.publicBaseUrl from config", () => {
    const r = resolveRuntimeSettings({
      gateway: { publicBaseUrl: "https://gw.example.com:7600" },
    });
    expect(r.publicBaseUrl).toBe("https://gw.example.com:7600");
  });

  test("combines the canonical MCP resource with explicitly configured URLs", () => {
    const resolved = resolveRuntimeSettings({
      gateway: {
        publicBaseUrl: "https://gateway.example.org",
        mcpResourceUrls: [
          "https://private.example.net:7600/mcp",
          "https://proxy.example.org/omnesis/mcp",
        ],
      },
    });
    expect(resolved.mcpResourceUrls).toEqual([
      "https://gateway.example.org/mcp",
      "https://private.example.net:7600/mcp",
      "https://proxy.example.org/omnesis/mcp",
    ]);
  });

  test("OMNESIS_PUBLIC_BASE_URL env wins over config", () => {
    process.env.OMNESIS_PUBLIC_BASE_URL = "https://env.example.org:7600";
    const r = resolveRuntimeSettings({
      gateway: { publicBaseUrl: "https://config.example.com:7600" },
    });
    expect(r.publicBaseUrl).toBe("https://env.example.org:7600");
  });

  test("rejects an alias that collides with the effective environment-selected origin", () => {
    process.env.OMNESIS_PUBLIC_BASE_URL = "https://env.example.org";
    expect(() =>
      resolveRuntimeSettings({
        gateway: {
          mcpResourceUrls: [
            "https://env.example.org/alternate/mcp",
            "https://private.example.net:7600/mcp",
          ],
        },
      }),
    ).toThrow(/distinct origin/);
  });

  test("env value with a trailing slash is normalised away", () => {
    process.env.OMNESIS_PUBLIC_BASE_URL = "https://env.example.org:7600/";
    expect(resolveRuntimeSettings(undefined).publicBaseUrl).toBe("https://env.example.org:7600");
  });

  test("non-https env value is rejected and falls back to config", () => {
    process.env.OMNESIS_PUBLIC_BASE_URL = "http://insecure.example.com:7600";
    const r = resolveRuntimeSettings({
      gateway: { publicBaseUrl: "https://config.example.com:7600" },
    });
    expect(r.publicBaseUrl).toBe("https://config.example.com:7600");
  });

  test.each([
    "https://user:secret@env.example.org",
    "https://env.example.org?redirect=elsewhere",
    "https://env.example.org?",
    "https://env.example.org#fragment",
    "https://env.example.org#",
    "https://env.example.org:99999",
  ])("rejects unsafe env value %s without throwing", (publicBaseUrl) => {
    process.env.OMNESIS_PUBLIC_BASE_URL = publicBaseUrl;
    const r = resolveRuntimeSettings({
      gateway: { publicBaseUrl: "https://config.example.com:7600" },
    });
    expect(r.publicBaseUrl).toBe("https://config.example.com:7600");
  });

  test("does not echo credentials from a rejected env value into logs", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.OMNESIS_PUBLIC_BASE_URL = "https://oauth-user:oauth-secret@env.example.org";
    resolveRuntimeSettings(undefined);
    expect(warn.mock.calls.flat().join(" ")).not.toContain("oauth-secret");
    warn.mockRestore();
  });

  test("defensively rejects an invalid unparsed config value", () => {
    const r = resolveRuntimeSettings({
      gateway: { publicBaseUrl: "https://user:secret@config.example.com" },
    });
    expect(r.publicBaseUrl).toBeUndefined();
  });

  test("preserves an existing HTTPS path prefix for provider callbacks", () => {
    process.env.OMNESIS_PUBLIC_BASE_URL = "https://env.example.org/omnesis";
    expect(resolveRuntimeSettings(undefined).publicBaseUrl).toBe("https://env.example.org/omnesis");
  });
});

describe("resolveRuntimeSettings — installer-proven pairing trust", () => {
  let savedEnv: string | undefined;
  beforeEach(() => {
    savedEnv = process.env.OMNESIS_PAIRING_SYSTEM_TRUST_ORIGIN;
    delete process.env.OMNESIS_PAIRING_SYSTEM_TRUST_ORIGIN;
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.OMNESIS_PAIRING_SYSTEM_TRUST_ORIGIN;
    else process.env.OMNESIS_PAIRING_SYSTEM_TRUST_ORIGIN = savedEnv;
  });

  test("accepts the exact HTTPS origin proven by the installer", () => {
    process.env.OMNESIS_PAIRING_SYSTEM_TRUST_ORIGIN = "https://gateway.example-tailnet.ts.net:8443";
    expect(resolveRuntimeSettings(undefined).pairingSystemTrustOrigins).toEqual([
      "https://gateway.example-tailnet.ts.net:8443",
    ]);
  });

  test.each([
    "http://gateway.example.org:7600",
    "https://gateway.example.org:7600/path",
    "https://gateway.example.org:7600/",
    "https://user:secret@gateway.example.org:7600",
  ])("rejects an unsafe installer origin %s", (origin) => {
    process.env.OMNESIS_PAIRING_SYSTEM_TRUST_ORIGIN = origin;
    expect(resolveRuntimeSettings(undefined).pairingSystemTrustOrigins).toEqual([]);
  });
});
