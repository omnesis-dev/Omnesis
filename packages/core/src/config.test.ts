// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  parseDuration,
  getSyncIntervalMs,
  getDataCutoffDate,
  getSourceCutoffDate,
  resolveSourceMaxAge,
  readTokenFile,
  resolveToken,
  parseSourceKey,
  readCollectorTokenFile,
  writeCollectorTokenFile,
} from "./config.js";
import { ensureInstallRootKey } from "./secret-store.js";
import { clearSecretFileKeyCacheForTests, isEncryptedSecretFile } from "./secret-file.js";
import type { DataRetentionConfig, SourceConfig, SearchConfig, IndexerConfig } from "./config.js";

// Local alias mirroring the legacy union shape `loadConfig`/`watchConfig`
// accept. Lives here (not in `@omnesis/core`'s public surface) so the
// public API stays narrow.
type LegacyConfigShape = {
  defaultSyncInterval?: string;
  obsidian?: { vaults?: string[]; exclude?: string[] };
  dataRetention?: DataRetentionConfig;
  sources?: Record<string, SourceConfig>;
  search?: SearchConfig;
  indexer?: IndexerConfig;
};

describe("parseDuration", () => {
  test("parses milliseconds", () => {
    expect(parseDuration("500ms")).toBe(500);
  });

  test("parses seconds", () => {
    expect(parseDuration("30s")).toBe(30_000);
  });

  test("parses minutes", () => {
    expect(parseDuration("5m")).toBe(300_000);
  });

  test("parses hours", () => {
    expect(parseDuration("1h")).toBe(3_600_000);
  });

  test("parses plain number as milliseconds", () => {
    expect(parseDuration("300000")).toBe(300_000);
  });

  test("parses fractional values", () => {
    expect(parseDuration("1.5h")).toBe(5_400_000);
    expect(parseDuration("2.5m")).toBe(150_000);
  });

  test("parses days", () => {
    expect(parseDuration("30d")).toBe(30 * 24 * 3_600_000);
  });

  test("parses months", () => {
    expect(parseDuration("6M")).toBe(6 * 30 * 24 * 3_600_000);
  });

  test("parses years", () => {
    expect(parseDuration("1y")).toBe(365 * 24 * 3_600_000);
  });

  test("throws on invalid format", () => {
    expect(() => parseDuration("abc")).toThrow("Invalid duration");
    expect(() => parseDuration("5x")).toThrow("Invalid duration");
    expect(() => parseDuration("")).toThrow("Invalid duration");
  });

  test("rejects bare numbers below 1000ms (unit-confusion guard)", () => {
    // `"5"` almost certainly meant `"5m"`, not 5ms. Refusing this catches
    // the case where a user types a number meaning a different unit and
    // ends up pegging the sync engine on a 5ms loop.
    expect(() => parseDuration("5")).toThrow(/below 1000ms/);
    expect(() => parseDuration("999")).toThrow(/below 1000ms/);
    // 1000 is the boundary — accepted.
    expect(parseDuration("1000")).toBe(1000);
  });

  test("rejects durations exceeding 100 years (Date overflow guard)", () => {
    expect(() => parseDuration("9999y")).toThrow(/exceeds maximum/);
    expect(() => parseDuration("101y")).toThrow(/exceeds maximum/);
    // 100y is the cap — accepted.
    expect(parseDuration("100y")).toBe(100 * 365 * 24 * 3_600_000);
  });
});

describe("parseSourceKey", () => {
  test("delegates to parseSourceId — splits on the first colon", () => {
    const r = parseSourceKey("gmail:user@gmail.com");
    expect(String(r.sourceType)).toBe("gmail");
    expect(String(r.accountId)).toBe("user@gmail.com");
  });

  test("returns 'local' accountId when no colon", () => {
    const r = parseSourceKey("things");
    expect(String(r.sourceType)).toBe("things");
    expect(String(r.accountId)).toBe("local");
  });

  test("rejects multi-colon keys (matches parseSourceId)", () => {
    expect(() => parseSourceKey("apple-reminders:uuid:1234")).toThrow();
  });
});

describe("getDataCutoffDate", () => {
  test("returns null when no maxAge configured", () => {
    expect(getDataCutoffDate({})).toBeNull();
    expect(getDataCutoffDate({ dataRetention: {} })).toBeNull();
  });

  test("returns ISO date string for maxAge", () => {
    const now = Date.now();
    const cutoff = getDataCutoffDate({ dataRetention: { maxAge: "1y" } });
    expect(cutoff).not.toBeNull();
    // Should be approximately 1 year ago (within 1 second tolerance)
    const cutoffMs = new Date(cutoff!).getTime();
    const expectedMs = now - 365 * 24 * 3_600_000;
    expect(Math.abs(cutoffMs - expectedMs)).toBeLessThan(1000);
  });
});

describe("resolveSourceMaxAge", () => {
  test("falls through global > sources.default > sources.<id>", () => {
    expect(resolveSourceMaxAge({}, "gmail:a@b.com")).toBeUndefined();
    expect(resolveSourceMaxAge({ dataRetention: { maxAge: "1y" } }, "gmail:a@b.com")).toBe("1y");
    expect(
      resolveSourceMaxAge(
        {
          dataRetention: { maxAge: "1y" },
          sources: { default: { maxAge: "6M" } },
        },
        "gmail:a@b.com",
      ),
    ).toBe("6M");
    expect(
      resolveSourceMaxAge(
        {
          dataRetention: { maxAge: "1y" },
          sources: {
            default: { maxAge: "6M" },
            "gmail:a@b.com": { maxAge: "30d" },
          },
        },
        "gmail:a@b.com",
      ),
    ).toBe("30d");
  });

  test("a descriptor-id block applies to every account-qualified instance", () => {
    // Real sources are registered as `<type>:<account>`, so a block keyed on
    // the bare descriptor id is only reachable through the specificity walk.
    const config = {
      dataRetention: { maxAge: "1y" },
      sources: { "google-drive": { maxAge: "7d" } },
    };
    expect(resolveSourceMaxAge(config, "google-drive:maya@example.com")).toBe("7d");
    expect(resolveSourceMaxAge(config, "google-drive:jamie@example.org")).toBe("7d");
    expect(resolveSourceMaxAge(config, "gmail:maya@example.com")).toBe("1y");
  });

  test("the more specific key wins over the less specific one", () => {
    const config = {
      dataRetention: { maxAge: "1y" },
      sources: {
        default: { maxAge: "6M" },
        "google-drive": { maxAge: "7d" },
        "google-drive:maya@example.com": { maxAge: "30d" },
      },
    };
    expect(resolveSourceMaxAge(config, "google-drive:maya@example.com")).toBe("30d");
    expect(resolveSourceMaxAge(config, "google-drive:jamie@example.org")).toBe("7d");
    expect(resolveSourceMaxAge(config, "things:local")).toBe("6M");
  });

  test("per-source override does not leak across sources", () => {
    const config = {
      dataRetention: { maxAge: "1y" },
      sources: {
        "gmail:a@b.com": { maxAge: "30d" },
      },
    };
    expect(resolveSourceMaxAge(config, "gmail:a@b.com")).toBe("30d");
    expect(resolveSourceMaxAge(config, "calendar:a@b.com")).toBe("1y");
  });
});

describe("getSourceCutoffDate", () => {
  test("returns null when nothing is configured", () => {
    expect(getSourceCutoffDate({}, "gmail:a@b.com")).toBeNull();
  });

  test("uses per-source override over global", () => {
    const now = Date.now();
    const cutoff = getSourceCutoffDate(
      {
        dataRetention: { maxAge: "1y" },
        sources: { "gmail:a@b.com": { maxAge: "30d" } },
      },
      "gmail:a@b.com",
    );
    expect(cutoff).not.toBeNull();
    const cutoffMs = new Date(cutoff!).getTime();
    expect(Math.abs(cutoffMs - (now - 30 * 24 * 3_600_000))).toBeLessThan(1000);
  });

  test("falls back to global for sources without per-source override", () => {
    const now = Date.now();
    const cutoff = getSourceCutoffDate(
      {
        dataRetention: { maxAge: "1y" },
        sources: { "gmail:a@b.com": { maxAge: "30d" } },
      },
      "calendar:a@b.com",
    );
    expect(cutoff).not.toBeNull();
    const cutoffMs = new Date(cutoff!).getTime();
    expect(Math.abs(cutoffMs - (now - 365 * 24 * 3_600_000))).toBeLessThan(1000);
  });
});

describe("getSyncIntervalMs", () => {
  const originalEnv = process.env.OMNESIS_SYNC_INTERVAL;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.OMNESIS_SYNC_INTERVAL;
    } else {
      process.env.OMNESIS_SYNC_INTERVAL = originalEnv;
    }
  });

  test("exact source ID match via source config", () => {
    const config: LegacyConfigShape = {
      sources: {
        "gmail:user@gmail.com": { enabled: true, syncInterval: "2m" },
      },
    };
    expect(getSyncIntervalMs("gmail:user@gmail.com", config)).toBe(120_000);
  });

  test("base source type match via source config", () => {
    const config: LegacyConfigShape = {
      sources: {
        "gmail:other@gmail.com": { enabled: true, syncInterval: "3m" },
      },
    };
    expect(getSyncIntervalMs("gmail:user@gmail.com", config)).toBe(180_000);
  });

  test("exact match takes priority over base match", () => {
    const config: LegacyConfigShape = {
      sources: {
        "gmail:other@gmail.com": { enabled: true, syncInterval: "3m" },
        "gmail:user@gmail.com": { enabled: true, syncInterval: "1m" },
      },
    };
    expect(getSyncIntervalMs("gmail:user@gmail.com", config)).toBe(60_000);
  });

  test("falls back to defaultSyncInterval", () => {
    const config: LegacyConfigShape = {
      defaultSyncInterval: "10m",
    };
    delete process.env.OMNESIS_SYNC_INTERVAL;
    expect(getSyncIntervalMs("gmail:user@gmail.com", config)).toBe(600_000);
  });

  test("falls back to env var", () => {
    process.env.OMNESIS_SYNC_INTERVAL = "120000";
    const config: LegacyConfigShape = {};
    expect(getSyncIntervalMs("gmail:user@gmail.com", config)).toBe(120_000);
  });

  test("falls back to hardcoded default (5 minutes)", () => {
    delete process.env.OMNESIS_SYNC_INTERVAL;
    const config: LegacyConfigShape = {};
    expect(getSyncIntervalMs("gmail:user@gmail.com", config)).toBe(300_000);
  });

  test("works with no sources in config", () => {
    const config: LegacyConfigShape = {
      defaultSyncInterval: "15m",
    };
    expect(getSyncIntervalMs("gmail:user@gmail.com", config)).toBe(900_000);
  });
});

describe("readTokenFile", () => {
  let tmpDir: string;
  const originalSecretStore = process.env.OMNESIS_SECRET_STORE;

  beforeEach(() => {
    clearSecretFileKeyCacheForTests();
    tmpDir = mkdtempSync(join(tmpdir(), "omnesis-token-test-"));
  });

  afterEach(() => {
    clearSecretFileKeyCacheForTests();
    rmSync(tmpDir, { recursive: true, force: true });
    if (originalSecretStore === undefined) {
      delete process.env.OMNESIS_SECRET_STORE;
    } else {
      process.env.OMNESIS_SECRET_STORE = originalSecretStore;
    }
  });

  test("returns token from file", () => {
    writeFileSync(join(tmpDir, "token"), "omn_abc123\n");
    expect(readTokenFile(tmpDir)).toBe("omn_abc123");
  });

  test("returns null when file does not exist", () => {
    expect(readTokenFile(tmpDir)).toBeNull();
  });

  test("returns null for empty file", () => {
    writeFileSync(join(tmpDir, "token"), "");
    expect(readTokenFile(tmpDir)).toBeNull();
  });

  test("trims whitespace", () => {
    writeFileSync(join(tmpDir, "token"), "  omn_abc123  \n");
    expect(readTokenFile(tmpDir)).toBe("omn_abc123");
  });

  test("reads encrypted token files after a root key exists", async () => {
    process.env.OMNESIS_SECRET_STORE = "file";
    await ensureInstallRootKey({ backend: "file", configDir: tmpDir });

    writeCollectorTokenFile("collector-secret", tmpDir);

    const raw = readFileSync(join(tmpDir, "collector-token"), "utf8");
    expect(isEncryptedSecretFile(raw)).toBe(true);
    expect(raw).not.toContain("collector-secret");
    expect(readCollectorTokenFile(tmpDir)).toBe("collector-secret");
  });
});

describe("resolveToken", () => {
  let tmpDir: string;
  const originalToken = process.env.OMNESIS_TOKEN;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "omnesis-resolve-test-"));
    delete process.env.OMNESIS_TOKEN;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    if (originalToken === undefined) {
      delete process.env.OMNESIS_TOKEN;
    } else {
      process.env.OMNESIS_TOKEN = originalToken;
    }
  });

  test("prefers env var over file", () => {
    process.env.OMNESIS_TOKEN = "env-token";
    writeFileSync(join(tmpDir, "token"), "file-token\n");
    expect(resolveToken(tmpDir)).toBe("env-token");
  });

  test("falls back to file when env var not set", () => {
    writeFileSync(join(tmpDir, "token"), "file-token\n");
    expect(resolveToken(tmpDir)).toBe("file-token");
  });

  test("returns null when neither env var nor file exist", () => {
    expect(resolveToken(tmpDir)).toBeNull();
  });
});
