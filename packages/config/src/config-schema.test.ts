// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import {
  CONFIG_SCHEMA_VERSION,
  DEFAULT_PUSH_RELAY_URL,
  validateConfig,
  applyMergePatch,
  changedPathsFromPatch,
  toJsonPointer,
  resolveSourceSettings,
  type OmnesisConfig,
} from "./config-schema.js";

describe("validateConfig — backupRetention", () => {
  test.each([0, 1, 2, 100])("accepts a nonnegative pre-update count: %s", (preUpdateCount) => {
    const result = validateConfig({ backupRetention: { preUpdateCount } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.backupRetention?.preUpdateCount).toBe(preUpdateCount);
    }
  });

  test.each([-1, 1.5, "2"])("rejects an invalid pre-update count: %s", (preUpdateCount) => {
    expect(validateConfig({ backupRetention: { preUpdateCount } }).ok).toBe(false);
  });
});

describe("validateConfig — releaseCheck", () => {
  test.each([true, false])("accepts the live release-check switch: %s", (releaseCheck) => {
    const result = validateConfig({ releaseCheck });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.releaseCheck).toBe(releaseCheck);
  });

  test.each([0, "false", null])(
    "rejects a non-boolean release-check switch: %s",
    (releaseCheck) => {
      expect(validateConfig({ releaseCheck }).ok).toBe(false);
    },
  );
});

describe("validateConfig — gateway.pushRelay", () => {
  test("defaults an explicit relay block to disabled and the published endpoint", () => {
    const res = validateConfig({ gateway: { pushRelay: {} } });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.gateway?.pushRelay).toEqual({
        enabled: false,
        url: DEFAULT_PUSH_RELAY_URL,
      });
    }
  });

  test("accepts an enabled HTTPS origin override", () => {
    const res = validateConfig({
      gateway: { pushRelay: { enabled: true, url: "https://relay.example.com" } },
    });
    expect(res.ok).toBe(true);
  });

  test.each([
    "x",
    "http://relay.example.com",
    "https://user@relay.example.com",
    "https://relay.example.com/path",
    "https://relay.example.com?region=test",
    "https://relay.example.com/#fragment",
  ])("rejects unsafe or non-origin relay URL %s", (url) => {
    expect(validateConfig({ gateway: { pushRelay: { url } } }).ok).toBe(false);
  });
});

describe("validateConfig — gateway.pushWakeRetry", () => {
  test("applies the durable wake retry defaults", () => {
    const result = validateConfig({ gateway: { pushWakeRetry: {} } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.gateway?.pushWakeRetry).toEqual({
        initialBackoffMs: 5_000,
        maxBackoffMs: 300_000,
        maxAttempts: 18,
        leaseMs: 60_000,
        batchSize: 50,
        intervalMs: 5_000,
        idleIntervalMs: 30_000,
      });
    }
  });

  test("rejects inverted backoff and scheduler intervals", () => {
    expect(
      validateConfig({
        gateway: { pushWakeRetry: { initialBackoffMs: 20, maxBackoffMs: 10 } },
      }).ok,
    ).toBe(false);
    expect(
      validateConfig({
        gateway: { pushWakeRetry: { intervalMs: 20, idleIntervalMs: 10 } },
      }).ok,
    ).toBe(false);
    expect(
      validateConfig({
        gateway: { pushWakeRetry: { leaseMs: Number.MAX_SAFE_INTEGER } },
      }).ok,
    ).toBe(false);
    expect(
      validateConfig({
        gateway: { pushWakeRetry: { leaseMs: 59_999 } },
      }).ok,
    ).toBe(false);
    for (const pushWakeRetry of [
      { maxAttempts: 101 },
      { batchSize: 1_001 },
      { intervalMs: 24 * 60 * 60 * 1_000 + 1 },
      { idleIntervalMs: 24 * 60 * 60 * 1_000 + 1 },
    ]) {
      expect(validateConfig({ gateway: { pushWakeRetry } }).ok).toBe(false);
    }
  });
});

describe("validateConfig — gateway.watch judge budget", () => {
  test("accepts disabled or two-call-capable judge budgets", () => {
    expect(
      validateConfig({
        gateway: { watch: { judge: { dailyCap: 0, perWatchDailyCap: 2 } } },
      }).ok,
    ).toBe(true);
  });

  test("rejects a one-call cap that can never complete a body review", () => {
    expect(
      validateConfig({
        gateway: { watch: { judge: { dailyCap: 1, perWatchDailyCap: 2 } } },
      }).ok,
    ).toBe(false);
    expect(
      validateConfig({
        gateway: { watch: { judge: { dailyCap: 2, perWatchDailyCap: 1 } } },
      }).ok,
    ).toBe(false);
  });
});

describe("validateConfig — happy paths", () => {
  test("empty object is valid (all sections optional)", () => {
    const res = validateConfig({});
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.config).toEqual({});
  });

  test("decodes the pre-rename sweep prime key into canonical terminology", () => {
    const res = validateConfig({
      brain: {
        sweeps: {
          horizon: {
            timeIndexPrimeDays: 14,
          },
        },
      },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.brain?.sweeps?.horizon).toEqual({
        temporalAnnotationPrimeDays: 14,
      });
    }
  });

  test("minimal real config passes", () => {
    const input = {
      dataRetention: { maxAge: "1y" },
      activityRetention: { maxAge: "90d" },
      indexer: { cycleInterval: "5m" },
      inference: {
        assignments: { embedder: "nomic-embed-text-v1.5.Q8_0" },
      },
      sources: {
        default: { syncInterval: "5m" },
        "gmail:jamesbond@gmail.com": { syncInterval: "2m", extractAttachments: true },
      },
    };
    const res = validateConfig(input);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.config.activityRetention?.maxAge).toBe("90d");
  });

  test("all duration formats accepted", () => {
    for (const d of ["30s", "5m", "1h", "30d", "6M", "1y", "500ms", "1000"]) {
      const res = validateConfig({ sources: { default: { syncInterval: d } } });
      expect(res.ok).toBe(true);
    }
  });

  test("accepts a transcriber inference assignment", () => {
    const res = validateConfig({
      inference: { assignments: { transcriber: "local/whisper-small" } },
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.config.inference?.assignments?.transcriber).toBe("local/whisper-small");
  });

  test("accepts an independent privacy reviewer inference assignment", () => {
    const res = validateConfig({
      inference: {
        assignments: {
          agent: "anthropic/claude-haiku-4-5-20251001",
          "privacy-reviewer": "codex/gpt-5.4",
        },
      },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.inference?.assignments?.agent).toBe("anthropic/claude-haiku-4-5-20251001");
      expect(res.config.inference?.assignments?.["privacy-reviewer"]).toBe("codex/gpt-5.4");
    }
  });

  test("accepts an independent Watch judge inference assignment", () => {
    const res = validateConfig({
      inference: {
        assignments: {
          "background-agent": "codex/gpt-5.6-luna",
          "watch-judge": "fireworks/accounts/fireworks/models/deepseek-v4-flash",
        },
      },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.inference?.assignments?.["background-agent"]).toBe("codex/gpt-5.6-luna");
      expect(res.config.inference?.assignments?.["watch-judge"]).toBe(
        "fireworks/accounts/fireworks/models/deepseek-v4-flash",
      );
    }
  });

  test("keeps reasoning choices bound to their exact capability assignment", () => {
    const res = validateConfig({
      inference: {
        assignments: { agent: "openai/gpt-example", "watch-judge": "openrouter/judge-example" },
        modelSettings: {
          agent: { assignment: "openai/gpt-example", values: { reasoningEffort: "high" } },
          "watch-judge": {
            assignment: "openrouter/judge-example",
            values: { reasoningEnabled: false },
          },
        },
      },
    });
    expect(res.ok).toBe(true);
    if (res.ok)
      expect(res.config.inference?.modelSettings?.agent?.values).toEqual({
        reasoningEffort: "high",
      });
    expect(
      validateConfig({
        inference: {
          modelSettings: {
            agent: {
              assignment: "openai/gpt-example",
              values: { reasoningBudgetTokens: 1.5 },
            },
          },
        },
      }).ok,
    ).toBe(false);
    expect(
      validateConfig({
        inference: {
          modelSettings: {
            agent: {
              assignment: "nvidia/omni-example",
              values: { reasoningBudgetTokens: -1 },
            },
          },
        },
      }).ok,
    ).toBe(true);
    expect(
      validateConfig({
        inference: {
          modelSettings: {
            agent: {
              assignment: "nvidia/omni-example",
              values: { reasoningBudgetTokens: -2 },
            },
          },
        },
      }).ok,
    ).toBe(false);
    expect(
      validateConfig({
        inference: {
          modelSettings: {
            agent: {
              assignment: "openai/gpt-example",
              values: { providerSpecificBody: "unsafe" },
            },
          },
        },
      }).ok,
    ).toBe(false);
  });

  test("accepts FCM HTTP v1 service-account configuration", () => {
    const res = validateConfig({
      gateway: {
        fcm: {
          serviceAccountPath: "/var/lib/omnesis/fcm-service-account.json",
          projectId: "example-project",
          appId: "dev.example.android",
        },
      },
    });
    expect(res.ok).toBe(true);
  });

  test("accepts explicit remote HTTP inference opt-in", () => {
    const res = validateConfig({
      inference: {
        allowRemoteInference: true,
        backends: {
          cloud: { type: "http", url: "https://api.example.com" },
        },
      },
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.config.inference?.allowRemoteInference).toBe(true);
  });

  test("accepts HTTP backend API keys as plaintext or config-secret references", () => {
    expect(
      validateConfig({
        inference: {
          backends: {
            legacy: { type: "http", url: "https://api.example.com", apiKey: "sk-example" },
            wrapped: {
              type: "http",
              url: "https://api.example.org",
              apiKeySecret: "config-secret:inference.backend.wrapped.apiKey",
            },
          },
        },
      }).ok,
    ).toBe(true);
  });

  test("accepts per-model token ceilings on an HTTP backend", () => {
    const res = validateConfig({
      inference: {
        backends: {
          cloud: {
            type: "http",
            url: "https://api.example.com",
            modelLimits: {
              "reasoning-model": {
                maxInputTokens: 120_000,
                contextWindowTokens: 128_000,
                maxOutputTokens: 8_000,
              },
            },
            agentTimeoutMs: 345_000,
          },
        },
      },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.inference?.backends?.cloud?.modelLimits?.["reasoning-model"]).toEqual({
        maxInputTokens: 120_000,
        contextWindowTokens: 128_000,
        maxOutputTokens: 8_000,
      });
      expect(res.config.inference?.backends?.cloud?.agentTimeoutMs).toBe(345_000);
    }
  });

  test.each([
    ["zero agent timeout", { agentTimeoutMs: 0 }],
    ["fractional agent timeout", { agentTimeoutMs: 1.5 }],
  ])("rejects %s", (_label, invalid) => {
    const res = validateConfig({
      inference: {
        backends: {
          cloud: { type: "http", url: "https://api.example.com", ...invalid },
        },
      },
    });
    expect(res.ok).toBe(false);
  });

  test("does not accept operator-maintained reasoning model lists", () => {
    const res = validateConfig({
      inference: {
        backends: {
          cloud: {
            type: "http",
            url: "https://api.example.com",
            reasoningModels: ["reasoning-model"],
          },
        },
      },
    });
    expect(res.ok).toBe(false);
  });

  test("rejects malformed HTTP backend config-secret references", () => {
    const res = validateConfig({
      inference: {
        backends: {
          wrapped: {
            type: "http",
            url: "https://api.example.org",
            apiKeySecret: "config-secret:../bad",
          },
        },
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors[0].path).toBe("/inference/backends/wrapped/apiKeySecret");
    }
  });

  test("accepts nullable known roles and rejects unknown assignment roles", () => {
    expect(validateConfig({ inference: { assignments: { transcriber: null } } }).ok).toBe(true);
    expect(validateConfig({ inference: { assignments: { "watch-judge": null } } }).ok).toBe(true);
    expect(validateConfig({ inference: { assignments: { nonsense: "x" } as never } }).ok).toBe(
      false,
    );
  });

  test("per-source maxAge accepted on default and per-source keys", () => {
    const res = validateConfig({
      dataRetention: { maxAge: "1y" },
      sources: {
        default: { maxAge: "6M" },
        "gmail:user@example.com": { maxAge: "30d" },
      },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.sources?.default?.maxAge).toBe("6M");
      expect(res.config.sources?.["gmail:user@example.com"]?.maxAge).toBe("30d");
    }
  });

  test("invalid per-source maxAge rejected with JSON-pointer path", () => {
    const res = validateConfig({
      sources: { "gmail:user@example.com": { maxAge: "tomorrow" } },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors[0]?.path).toBe("/sources/gmail:user@example.com/maxAge");
    }
  });

  test("activity retention is optional and rejects malformed durations", () => {
    expect(validateConfig({}).ok).toBe(true);
    const res = validateConfig({ activityRetention: { maxAge: "forever" } });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors[0]?.path).toBe("/activityRetention/maxAge");
    }
  });
});

describe("validateConfig — rejections", () => {
  test.each([
    ["zero", { maxInputTokens: 0 }],
    ["fractional", { contextWindowTokens: 4_096.5 }],
    ["unknown field", { outputLimit: 1_000 }],
  ])("rejects %s HTTP model token limits", (_label, limits) => {
    const res = validateConfig({
      inference: {
        backends: {
          cloud: {
            type: "http",
            url: "https://api.example.com",
            modelLimits: { model: limits },
          },
        },
      },
    });
    expect(res.ok).toBe(false);
  });

  test("invalid duration rejected with JSON-pointer path", () => {
    const res = validateConfig({
      sources: { "gmail:user@example.com": { syncInterval: "banana" } },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors).toHaveLength(1);
      expect(res.errors[0].path).toBe("/sources/gmail:user@example.com/syncInterval");
      expect(res.errors[0].message).toContain("duration");
    }
  });

  test("unknown top-level key rejected (strict mode)", () => {
    const res = validateConfig({ typo: true });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.some((e) => e.message.match(/unrecognized|unknown/i))).toBe(true);
    }
  });

  test("non-object payload rejected", () => {
    const res = validateConfig("hello");
    expect(res.ok).toBe(false);
  });

  test("enabled field on source rejected (existence is DB-authoritative)", () => {
    // Confirms the inline-review decision: config holds *settings*, not enablement.
    const res = validateConfig({
      sources: { "gmail:u@x.com": { enabled: true } as object },
    });
    expect(res.ok).toBe(false);
  });

  test("brain.notesMaxBytes accepts its 32768 ceiling and rejects above it", () => {
    // The bound keeps the 2x overflow ceiling within the notes tools'
    // 65536-char argument schemas, so the zod ceiling can never bind first.
    expect(validateConfig({ brain: { notesMaxBytes: 32768 } }).ok).toBe(true);
    expect(validateConfig({ brain: { notesMaxBytes: 32769 } }).ok).toBe(false);
  });
});

describe("validateConfig — gateway.cors wildcard+credentials rejection", () => {
  test("rejects a wildcard origin combined with credentials", () => {
    const res = validateConfig({
      gateway: { cors: { allowedOrigins: ["*"], allowCredentials: true } },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.some((e) => /wildcard|allowCredentials/i.test(e.message))).toBe(true);
    }
  });

  test("allows a wildcard origin without credentials", () => {
    expect(
      validateConfig({ gateway: { cors: { allowedOrigins: ["*"], allowCredentials: false } } }).ok,
    ).toBe(true);
    expect(validateConfig({ gateway: { cors: { allowedOrigins: ["*"] } } }).ok).toBe(true);
  });

  test("allows credentials with exact origins", () => {
    expect(
      validateConfig({
        gateway: {
          cors: { allowedOrigins: ["https://app.example.com"], allowCredentials: true },
        },
      }).ok,
    ).toBe(true);
  });
});

describe("validateConfig — nearDuplicates", () => {
  test("empty nearDuplicates block is valid (all defaults)", () => {
    const res = validateConfig({ nearDuplicates: {} });
    expect(res.ok).toBe(true);
  });

  test("accepts every documented tunable", () => {
    const res = validateConfig({
      nearDuplicates: {
        enabled: true,
        eligibleDocTypes: ["email", "attachment", "file"],
        minContentLength: 200,
        maxContentLength: 200000,
        algorithm: {
          shingleSize: 5,
          numHashes: 128,
          bands: 16,
          rows: 8,
          hashSeed: 0xc0ffee,
          stripQuotes: true,
          maxIdfWeight: 8.0,
          recordThreshold: 0.5,
        },
        gate: {
          emailJaccardMin: 0.85,
          emailPairUniqueDf2Min: 5,
          fileLikeJaccardMin: 0.75,
          fileLikePairUniqueDf2Min: 1,
          fileLikeContainmentMin: 0.95,
          automatedSenderPrefixes: ["noreply", "mailer-daemon"],
        },
        scheduler: {
          computePeriodMs: 2000,
          computeIdlePeriodMs: 30000,
          computeBatchSize: 25,
          maxCandidatesPerDoc: 200,
          dfRefreshPeriodMs: 21600000,
          dfRefreshIdlePeriodMs: 3600000,
          sweepPeriodMs: 600000,
          sweepIdlePeriodMs: 3600000,
          sweepChunkSize: 2000,
          algoSweepChunkSize: 5000,
        },
      },
    });
    expect(res.ok).toBe(true);
  });

  test("rejects unknown nearDuplicates keys (strict)", () => {
    const res = validateConfig({ nearDuplicates: { mystery: 1 } });
    expect(res.ok).toBe(false);
  });

  test("rejects out-of-range jaccard threshold", () => {
    const res = validateConfig({
      nearDuplicates: { gate: { emailJaccardMin: 1.5 } },
    });
    expect(res.ok).toBe(false);
  });

  test("rejects non-positive periodMs", () => {
    const res = validateConfig({
      nearDuplicates: { scheduler: { computePeriodMs: 0 } },
    });
    expect(res.ok).toBe(false);
  });
});

describe("validateConfig — gateway.timings", () => {
  test("each timing field accepts a duration string", () => {
    const res = validateConfig({
      gateway: {
        timings: {
          slowRequest: "500ms",
          wsHeartbeatInterval: "30s",
          wsAuthTimeout: "5s",
          wsCommandTimeout: "30s",
          authFlowTtl: "15m",
          pairingTtl: "10m",
          sessionTtl: "30d",
          sessionRefreshThrottle: "1h",
        },
      },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.gateway?.timings?.pairingTtl).toBe("10m");
      expect(res.config.gateway?.timings?.sessionTtl).toBe("30d");
      expect(res.config.gateway?.timings?.sessionRefreshThrottle).toBe("1h");
    }
  });

  test("partial timings block accepted (each field optional)", () => {
    const res = validateConfig({ gateway: { timings: { slowRequest: "1s" } } });
    expect(res.ok).toBe(true);
  });

  test("invalid duration rejected with JSON-pointer path", () => {
    const res = validateConfig({
      gateway: { timings: { sessionTtl: "forever" } },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors[0].path).toBe("/gateway/timings/sessionTtl");
    }
  });

  test("unknown timings key rejected (strict)", () => {
    const res = validateConfig({
      gateway: { timings: { mysteryKnob: "1m" } as object },
    });
    expect(res.ok).toBe(false);
  });

  test("timings coexists with journalMode", () => {
    const res = validateConfig({
      gateway: { journalMode: "WAL", timings: { slowRequest: "750ms" } },
    });
    expect(res.ok).toBe(true);
  });
});

describe("validateConfig — gateway.backfill", () => {
  test("empty backfill block is valid", () => {
    const res = validateConfig({ gateway: { backfill: {} } });
    expect(res.ok).toBe(true);
  });

  test("full backfill block with every sub-task accepted", () => {
    const res = validateConfig({
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
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.gateway?.backfill?.linkReconcile?.batchSize).toBe(5000);
      expect(res.config.gateway?.backfill?.people?.batchSize).toBe(1000);
      expect(res.config.gateway?.backfill?.mergeCandidates?.idleDelay).toBe("1h");
    }
  });

  test("each sub-task accepts partial configuration", () => {
    for (const subblock of [
      { links: { interval: "2s" } },
      { links: { idleDelay: "1m" } },
      { linkReconcile: { batchSize: 1000 } },
      { linkReconcile: { interval: "1m" } },
      { people: { batchSize: 250 } },
      { mergePass: {} },
      { autoDetect: {} },
      { mergeCandidates: { idleDelay: "10m" } },
    ]) {
      const res = validateConfig({ gateway: { backfill: subblock } });
      expect(res.ok).toBe(true);
    }
  });

  test("invalid duration on interval rejected with JSON-pointer path", () => {
    const res = validateConfig({
      gateway: { backfill: { linkReconcile: { interval: "forever" } } },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors[0].path).toBe("/gateway/backfill/linkReconcile/interval");
    }
  });

  test("invalid duration on idleDelay rejected with JSON-pointer path", () => {
    const res = validateConfig({
      gateway: { backfill: { links: { idleDelay: "soon" } } },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors[0].path).toBe("/gateway/backfill/links/idleDelay");
    }
  });

  test("non-positive linkReconcile.batchSize rejected", () => {
    const negative = validateConfig({
      gateway: { backfill: { linkReconcile: { batchSize: -1 } } },
    });
    expect(negative.ok).toBe(false);
    const zero = validateConfig({
      gateway: { backfill: { linkReconcile: { batchSize: 0 } } },
    });
    expect(zero.ok).toBe(false);
  });

  test("non-positive people.batchSize rejected", () => {
    const res = validateConfig({
      gateway: { backfill: { people: { batchSize: 0 } } },
    });
    expect(res.ok).toBe(false);
  });

  test("non-integer batchSize rejected", () => {
    const res = validateConfig({
      gateway: { backfill: { linkReconcile: { batchSize: 100.5 } } },
    });
    expect(res.ok).toBe(false);
  });

  test("unknown sub-task rejected (strict)", () => {
    const res = validateConfig({
      gateway: { backfill: { mysteryTask: {} } as object },
    });
    expect(res.ok).toBe(false);
  });

  test("unknown field inside a sub-task rejected (strict)", () => {
    const res = validateConfig({
      gateway: { backfill: { linkReconcile: { mysteryKnob: "1m" } as object } },
    });
    expect(res.ok).toBe(false);
  });

  test("gateway.linkReconcile (legacy top-level) rejected — moved under backfill", () => {
    const res = validateConfig({
      gateway: { linkReconcile: { batchSize: 1000 } as object },
    });
    expect(res.ok).toBe(false);
  });

  test("backfill coexists with timings and journalMode and apns-free gateway", () => {
    const res = validateConfig({
      gateway: {
        journalMode: "WAL",
        timings: { slowRequest: "750ms" },
        backfill: { linkReconcile: { batchSize: 2000 } },
      },
    });
    expect(res.ok).toBe(true);
  });
});

describe("validateConfig — indexer.chunker / indexer.embedder", () => {
  test("accepts indexer.chunker.{chunkSize,overlap}", () => {
    const res = validateConfig({
      indexer: { chunker: { chunkSize: 4096, overlap: 1024 } },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.indexer?.chunker?.chunkSize).toBe(4096);
      expect(res.config.indexer?.chunker?.overlap).toBe(1024);
    }
  });

  test("accepts indexer.embedder.{contextSize,timeoutMs,maxInputChars}", () => {
    const res = validateConfig({
      indexer: {
        embedder: { contextSize: 4096, timeoutMs: 60_000, maxInputChars: 12_000 },
      },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.indexer?.embedder?.contextSize).toBe(4096);
      expect(res.config.indexer?.embedder?.timeoutMs).toBe(60_000);
      expect(res.config.indexer?.embedder?.maxInputChars).toBe(12_000);
    }
  });

  test("rejects negative chunker.chunkSize", () => {
    const res = validateConfig({ indexer: { chunker: { chunkSize: -1 } } });
    expect(res.ok).toBe(false);
  });

  test("rejects zero chunker.chunkSize (positive int required)", () => {
    const res = validateConfig({ indexer: { chunker: { chunkSize: 0 } } });
    expect(res.ok).toBe(false);
  });

  test("accepts zero chunker.overlap (non-negative int)", () => {
    const res = validateConfig({ indexer: { chunker: { overlap: 0 } } });
    expect(res.ok).toBe(true);
  });

  test("strict mode rejects unknown keys under indexer.chunker", () => {
    const res = validateConfig({
      indexer: { chunker: { chunkSize: 1024, junk: 1 } as never },
    });
    expect(res.ok).toBe(false);
  });

  test("strict mode rejects unknown keys under indexer.embedder", () => {
    const res = validateConfig({
      indexer: { embedder: { contextSize: 2048, junk: 1 } as never },
    });
    expect(res.ok).toBe(false);
  });
});

describe("validateConfig — gateway.snapshotAbsence", () => {
  test("accepts a smaller writer-safe mark ceiling", () => {
    expect(validateConfig({ gateway: { snapshotAbsence: { maxMarksPerSnapshot: 50 } } }).ok).toBe(
      true,
    );
  });

  test("rejects a mark ceiling above the writer-safe maximum", () => {
    expect(validateConfig({ gateway: { snapshotAbsence: { maxMarksPerSnapshot: 201 } } }).ok).toBe(
      false,
    );
  });

  test("accepts an explicit startup deletion grace", () => {
    expect(validateConfig({ gateway: { snapshotAbsence: { deletionGrace: "30s" } } }).ok).toBe(
      true,
    );
  });
});

describe("toJsonPointer", () => {
  test("empty path is root", () => {
    expect(toJsonPointer([])).toBe("");
  });

  test("escapes ~ and /", () => {
    expect(toJsonPointer(["foo/bar", "a~b"])).toBe("/foo~1bar/a~0b");
  });

  test("preserves source-id colons (no special meaning in JSON pointer)", () => {
    expect(toJsonPointer(["sources", "gmail:user@x.com", "syncInterval"])).toBe(
      "/sources/gmail:user@x.com/syncInterval",
    );
  });
});

describe("applyMergePatch (RFC 7396)", () => {
  test("null values delete keys", () => {
    const out = applyMergePatch({ a: 1, b: 2 }, { b: null });
    expect(out).toEqual({ a: 1 });
  });

  test("plain objects merge recursively", () => {
    const out = applyMergePatch(
      { sources: { default: { syncInterval: "5m" }, gmail: { syncInterval: "2m" } } },
      { sources: { default: { extractAttachments: true } } },
    );
    expect(out).toEqual({
      sources: {
        default: { syncInterval: "5m", extractAttachments: true },
        gmail: { syncInterval: "2m" },
      },
    });
  });

  test("arrays replace wholesale (not merge)", () => {
    const out = applyMergePatch(
      { gateway: { cors: { allowedOrigins: ["https://one.example"] } } },
      { gateway: { cors: { allowedOrigins: ["https://two.example"] } } },
    );
    expect(out).toEqual({
      gateway: { cors: { allowedOrigins: ["https://two.example"] } },
    });
  });

  test("does not mutate input", () => {
    const target = { a: { b: 1 } };
    applyMergePatch(target, { a: { c: 2 } });
    expect(target).toEqual({ a: { b: 1 } });
  });

  test("scalar replacement at any depth", () => {
    const out = applyMergePatch(
      { indexer: { model: "old.gguf" } },
      { indexer: { model: "new.gguf" } },
    );
    expect(out).toEqual({ indexer: { model: "new.gguf" } });
  });

  test("keeps a literal __proto__ record key as data, not a prototype", () => {
    // Record keys are operator-controlled (source ids); JSON.parse keeps a
    // literal __proto__ key as an own data property, and the merge must too.
    const patch = JSON.parse('{"sources":{"__proto__":{"syncInterval":"5m"}}}');
    const out = applyMergePatch({ sources: {} }, patch) as {
      sources: Record<string, unknown>;
    };
    expect(Object.getPrototypeOf(out.sources)).toBe(Object.prototype);
    expect(Object.hasOwn(out.sources, "__proto__")).toBe(true);
    expect(out.sources["__proto__"]).toEqual({ syncInterval: "5m" });
  });
});

describe("changedPathsFromPatch", () => {
  test("flat scalar change", () => {
    expect(changedPathsFromPatch({ indexer: { model: "x.gguf" } })).toEqual(["/indexer/model"]);
  });

  test("null leaves report the deleted path", () => {
    expect(changedPathsFromPatch({ sources: { gmail: null } })).toEqual(["/sources/gmail"]);
  });

  test("nested multiple changes", () => {
    const paths = changedPathsFromPatch({
      indexer: { enabled: false, cycleInterval: "10m" },
    });
    expect(paths.sort()).toEqual(["/indexer/cycleInterval", "/indexer/enabled"]);
  });

  test("source-id keys escape correctly", () => {
    const paths = changedPathsFromPatch({
      sources: { "gmail:user@x.com": { syncInterval: "2m" } },
    });
    expect(paths).toEqual(["/sources/gmail:user@x.com/syncInterval"]);
  });
});

describe("resolveSourceSettings", () => {
  test("a descriptor-id block applies to an account-qualified instance", () => {
    const cfg: OmnesisConfig = {
      sources: { "google-drive": { syncInterval: "30m", extractAttachments: false } },
    };
    expect(resolveSourceSettings(cfg, "google-drive:maya@example.com")).toEqual({
      syncInterval: "30m",
      extractAttachments: false,
    });
  });

  test("instance beats descriptor beats default, per field", () => {
    const cfg: OmnesisConfig = {
      sources: {
        default: { syncInterval: "15m", attachmentMaxTextLength: 1000, extractAttachments: false },
        "google-drive": { syncInterval: "30m", extractAttachments: true },
        "google-drive:maya@example.com": { syncInterval: "2m" },
      },
    };
    expect(resolveSourceSettings(cfg, "google-drive:maya@example.com")).toEqual({
      syncInterval: "2m",
      attachmentMaxTextLength: 1000,
      extractAttachments: true,
    });
    expect(resolveSourceSettings(cfg, "google-drive:jamie@example.org")).toEqual({
      syncInterval: "30m",
      attachmentMaxTextLength: 1000,
      extractAttachments: true,
    });
  });

  test("returns defaults when no override exists", () => {
    const cfg: OmnesisConfig = {
      sources: { default: { syncInterval: "5m", extractAttachments: false } },
    };
    expect(resolveSourceSettings(cfg, "gmail:unknown@x.com")).toEqual({
      syncInterval: "5m",
      extractAttachments: false,
    });
  });

  test("per-source settings override default per-field", () => {
    const cfg: OmnesisConfig = {
      sources: {
        default: { syncInterval: "5m", attachmentMaxTextLength: 1000, extractAttachments: false },
        "gmail:jamesbond@x.com": { syncInterval: "2m", extractAttachments: true },
      },
    };
    expect(resolveSourceSettings(cfg, "gmail:jamesbond@x.com")).toEqual({
      syncInterval: "2m",
      attachmentMaxTextLength: 1000,
      extractAttachments: true,
    });
  });

  test("empty when neither exists", () => {
    expect(resolveSourceSettings({}, "whatever")).toEqual({});
  });
});

describe("validateConfig — agent", () => {
  test("accepts every documented tunable", () => {
    const res = validateConfig({
      agent: {
        maxToolIterations: 8,
        replay: { fixture: "/tmp/fixture.jsonl", placeholders: "/tmp/placeholders.json" },
      },
    });
    expect(res.ok).toBe(true);
  });

  test("rejects unknown agent keys (strict)", () => {
    const res = validateConfig({ agent: { backend: "anthropic" } });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.errors.some((e) => /unrecognized|unknown/i.test(e.message))).toBe(true);
    }
  });

  test("rejects unknown agent.replay keys (strict)", () => {
    const res = validateConfig({ agent: { replay: { fixutre: "/tmp/x.jsonl" } } });
    expect(res.ok).toBe(false);
  });

  test("rejects out-of-range maxToolIterations", () => {
    expect(validateConfig({ agent: { maxToolIterations: 0 } }).ok).toBe(false);
    expect(validateConfig({ agent: { maxToolIterations: 200 } }).ok).toBe(false);
  });
});

describe("validateConfig — stripUnknownKeys (lenient load)", () => {
  test("records and strips the retired host-process configuration", () => {
    expect(CONFIG_SCHEMA_VERSION).toBe(8);
    // An install that once permitted the gateway to spawn processes still has
    // this block on disk. It must load — refusing the file would lock the
    // operator out of their gateway over a key that no longer does anything —
    // and it must be reported, so "my setting stopped working" has an answer
    // rather than being a silent no-op.
    const res = validateConfig(
      {
        gateway: {
          triggers: {
            exec: { enabled: false },
            runner: { enabled: true, deviceId: "dev_runner" },
          },
        },
      },
      { stripUnknownKeys: true },
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.strippedKeys).toEqual(["/gateway/triggers"]);
      expect(res.config.gateway).not.toHaveProperty("triggers");
    }
  });

  test("strips the retired operator-maintained reasoning model list", () => {
    const res = validateConfig(
      {
        inference: {
          backends: {
            cloud: {
              type: "http",
              url: "https://api.example.com",
              reasoningModels: ["reasoning-model"],
              agentTimeoutMs: 300_000,
            },
          },
        },
      },
      { stripUnknownKeys: true },
    );

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.strippedKeys).toEqual(["/inference/backends/cloud/reasoningModels"]);
      expect(res.config.inference?.backends?.cloud).toEqual({
        type: "http",
        url: "https://api.example.com",
        agentTimeoutMs: 300_000,
      });
    }
  });

  test("strips the pre-v6 named-search-configuration keys, keeping the flat search knobs", () => {
    // Schema v6 moved the search tunables out of a named-configuration map and
    // onto flat `search.params` / `search.boosts` / `search.defaultFilters`.
    // An install written before the bump still carries the old keys; loading it
    // must succeed, report them as stripped, and leave everything else intact.
    const res = validateConfig(
      {
        search: {
          defaultRecipe: "balanced",
          recipes: {
            balanced: { params: { rrfK: 60 } },
            precise: { params: { rrfK: 20 }, boosts: { typeBoosts: { email: 1.2 } } },
          },
          params: { candidateLimit: 80, topRankBonus: 0.1 },
          boosts: { relevanceBoostWeight: 0.5 },
          defaultFilters: { documentTypes: ["email"] },
        },
        indexer: { cycleInterval: "5m" },
      },
      { stripUnknownKeys: true },
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.strippedKeys.sort()).toEqual(["/search/defaultRecipe", "/search/recipes"]);
      expect(res.config.search?.params).toEqual({ candidateLimit: 80, topRankBonus: 0.1 });
      expect(res.config.search?.boosts).toEqual({ relevanceBoostWeight: 0.5 });
      expect(res.config.search?.defaultFilters).toEqual({ documentTypes: ["email"] });
      expect(res.config.indexer?.cycleInterval).toBe("5m");
    }
  });

  test("strips pre-v4 root and device settings while preserving current config", () => {
    const res = validateConfig(
      {
        urlCrawler: { enabled: true },
        urlCrawl: { maxDepth: 2 },
        devices: { laptop: { sources: { default: { syncInterval: "30m" } } } },
        indexer: { cycleInterval: "5m" },
      },
      { stripUnknownKeys: true },
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.strippedKeys.sort()).toEqual(["/devices", "/urlCrawl", "/urlCrawler"]);
      expect(res.config.indexer?.cycleInterval).toBe("5m");
    }
  });

  test("strips an unknown nested key and reports it, preserving the rest", () => {
    const res = validateConfig(
      {
        indexer: { cycleInterval: "5m" },
        sources: { web: { removedSetting: true, syncInterval: "10m" } },
      },
      { stripUnknownKeys: true },
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.strippedKeys).toEqual(["/sources/web/removedSetting"]);
      expect(res.config.indexer?.cycleInterval).toBe("5m");
      expect(res.config.sources?.web?.syncInterval).toBe("10m");
      expect((res.config.sources?.web as Record<string, unknown>).removedSetting).toBeUndefined();
    }
  });

  test("strips unknown keys at multiple depths in one call", () => {
    const res = validateConfig(
      {
        bogusTopLevel: 1,
        indexer: { cycleInterval: "5m", goneKnob: true },
      },
      { stripUnknownKeys: true },
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.strippedKeys.sort()).toEqual(["/bogusTopLevel", "/indexer/goneKnob"]);
      expect(res.config.indexer?.cycleInterval).toBe("5m");
    }
  });

  test("does NOT strip real validation errors — they still fail", () => {
    // A bad value (not an unknown key) must surface as an error, never be
    // silently removed.
    const res = validateConfig(
      { sources: { default: { syncInterval: "invalid" } } },
      { stripUnknownKeys: true },
    );
    expect(res.ok).toBe(false);
  });

  test("a valid config is unchanged and reports nothing stripped", () => {
    const res = validateConfig({ indexer: { cycleInterval: "5m" } }, { stripUnknownKeys: true });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.strippedKeys).toEqual([]);
      expect(res.config.indexer?.cycleInterval).toBe("5m");
    }
  });

  test("default (strict) mode rejects unknown keys", () => {
    const res = validateConfig({ sources: { web: { removedSetting: true } } });
    expect(res.ok).toBe(false);
  });
});

describe("Codex inference capacity", () => {
  test("accepts bounded independent capacity and disabled interactive pooling", () => {
    const result = validateConfig({
      inference: { codex: { interactivePoolSize: 0, inferencePoolSize: 3 } },
    });
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.config.inference?.codex).toEqual({
        interactivePoolSize: 0,
        inferencePoolSize: 3,
      });
  });
  test.each([
    { inferencePoolSize: 0 },
    { inferencePoolSize: -1 },
    { inferencePoolSize: 1.5 },
    { interactivePoolSize: -1 },
    { interactivePoolSize: 1.5 },
  ])("rejects invalid capacity %j", (codex) => {
    expect(validateConfig({ inference: { codex } }).ok).toBe(false);
  });
});
