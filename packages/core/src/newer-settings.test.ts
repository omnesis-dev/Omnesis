// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { newerSettingsPath, restoreNewerSettings, saveNewerSettings } from "./newer-settings.js";

let dir: string;
let configPath: string;
let copyPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omnesis-newer-settings-"));
  configPath = join(dir, "omnesis.json");
  copyPath = newerSettingsPath(configPath);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const writeJson = (path: string, value: unknown): void =>
  writeFileSync(path, JSON.stringify(value), { mode: 0o644 });
const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));
const mode = (path: string): number => statSync(path).mode & 0o777;

describe("saveNewerSettings", () => {
  test("saves the config beside it, owner-only, stamped with the newest release", () => {
    const config = { agent: { noteAgent: false }, indexer: { cycleInterval: "5m" } };
    writeJson(configPath, config);

    expect(saveNewerSettings(configPath, ["v0.7.0", "0.6.0", "origin/main"])).toBe(true);

    expect(readJson(copyPath)).toEqual({ release: "0.7.0", config });
    expect(mode(copyPath)).toBe(0o600);
  });

  test("folds in a copy not yet restored: its settings the config lacks, and its newer stamp", () => {
    writeJson(copyPath, {
      release: "0.8.0",
      config: { agent: { noteAgent: false, futureKnob: 3 }, indexer: { cycleInterval: "5m" } },
    });
    writeJson(configPath, { indexer: { cycleInterval: "15m" } });

    saveNewerSettings(configPath, ["0.7.0"]);

    expect(readJson(copyPath)).toEqual({
      release: "0.8.0",
      config: { indexer: { cycleInterval: "15m" }, agent: { noteAgent: false, futureKnob: 3 } },
    });
  });

  test("replaces a copy it cannot read", () => {
    writeFileSync(copyPath, "{ truncated");
    writeJson(configPath, { indexer: { cycleInterval: "15m" } });

    saveNewerSettings(configPath, ["0.7.0"]);

    expect(readJson(copyPath)).toEqual({
      release: "0.7.0",
      config: { indexer: { cycleInterval: "15m" } },
    });
  });

  test("saves nothing when there is no config", () => {
    expect(saveNewerSettings(configPath, ["0.7.0"])).toBe(false);
    expect(existsSync(copyPath)).toBe(false);
  });

  test("refuses a config that is not JSON", () => {
    writeFileSync(configPath, "{ not json");
    expect(() => saveNewerSettings(configPath, ["0.7.0"])).toThrow(SyntaxError);
    expect(existsSync(copyPath)).toBe(false);
  });
});

describe("restoreNewerSettings", () => {
  test("puts back what the config lacks, keeps what it holds, and retires the copy", () => {
    writeJson(copyPath, {
      release: "0.7.0",
      config: {
        agent: { noteAgent: false, maxDepth: 2 },
        inference: { allowRemoteInference: false, transcriptionVocabulary: { enabled: false } },
        indexer: { cycleInterval: "5m" },
      },
    });
    // Rewritten by an older release: the operator changed two settings it
    // knows; the ones it does not know are gone.
    writeJson(configPath, {
      agent: { maxDepth: 4 },
      inference: { allowRemoteInference: true },
      indexer: { cycleInterval: "15m" },
    });

    const outcome = restoreNewerSettings(configPath, "0.7.0");

    expect(outcome).toEqual({
      kind: "restored",
      restored: ["/agent/noteAgent", "/inference/transcriptionVocabulary"],
      kept: false,
    });
    expect(readJson(configPath)).toEqual({
      agent: { maxDepth: 4, noteAgent: false },
      inference: { allowRemoteInference: true, transcriptionVocabulary: { enabled: false } },
      indexer: { cycleInterval: "15m" },
    });
    expect(mode(configPath)).toBe(0o600);
    expect(existsSync(copyPath)).toBe(false);
  });

  test("treats an array as one value: one the config holds is not merged with the saved one", () => {
    writeJson(copyPath, {
      release: "0.7.0",
      config: { brain: { excludedSources: ["codex", "github:someone"] } },
    });
    writeJson(configPath, { brain: { excludedSources: ["codex"] } });

    expect(restoreNewerSettings(configPath, "0.7.0")).toMatchObject({ restored: [] });
    expect(readJson(configPath)).toEqual({ brain: { excludedSources: ["codex"] } });
  });

  test("is applied once", () => {
    writeJson(copyPath, { release: "0.7.0", config: { agent: { noteAgent: false } } });
    writeJson(configPath, {});
    restoreNewerSettings(configPath, "0.7.0");
    // Removed on the release that knows it: stays removed.
    writeJson(configPath, {});

    expect(restoreNewerSettings(configPath, "0.7.0")).toEqual({ kind: "none" });
    expect(readJson(configPath)).toEqual({});
  });

  test("leaves the config untouched when there is nothing to put back", () => {
    writeJson(copyPath, { release: "0.7.0", config: { indexer: { cycleInterval: "5m" } } });
    writeFileSync(configPath, '{"indexer":{"cycleInterval":"15m"}}', { mode: 0o644 });

    expect(restoreNewerSettings(configPath, "0.7.0")).toEqual({
      kind: "restored",
      restored: [],
      kept: false,
    });
    expect(readFileSync(configPath, "utf8")).toBe('{"indexer":{"cycleInterval":"15m"}}');
    expect(existsSync(copyPath)).toBe(false);
  });

  test("keeps what this release does not know for the newer release that saved it", () => {
    writeJson(copyPath, {
      release: "0.8.0",
      config: {
        agent: { noteAgent: false, futureKnob: 3 },
        futureSection: { enabled: true },
        laterSection: { mode: "fast" },
      },
    });
    // Not yet rewritten by this release: one key it does not know is still in the file.
    writeJson(configPath, { laterSection: { mode: "slow" } });

    const outcome = restoreNewerSettings(configPath, "0.7.0");

    expect(outcome).toEqual({ kind: "restored", restored: ["/agent"], kept: true });
    expect(readJson(configPath)).toEqual({
      laterSection: { mode: "slow" },
      agent: { noteAgent: false },
    });
    expect(readJson(copyPath)).toEqual({
      release: "0.8.0",
      config: {
        laterSection: { mode: "slow" },
        agent: { futureKnob: 3 },
        futureSection: { enabled: true },
      },
    });
    expect(mode(copyPath)).toBe(0o600);
  });

  test("drops what this release does not know once it is at least as new as the copy", () => {
    writeJson(copyPath, { release: "0.7.0", config: { retiredSection: { enabled: true } } });
    writeJson(configPath, {});

    expect(restoreNewerSettings(configPath, "0.8.0")).toEqual({
      kind: "restored",
      restored: [],
      kept: false,
    });
    expect(readJson(configPath)).toEqual({});
    expect(existsSync(copyPath)).toBe(false);
  });

  test("does not put back a value this release's schema rejects", () => {
    writeJson(copyPath, {
      release: "0.7.0",
      config: { agent: { noteAgent: "sometimes" }, indexer: { cycleInterval: "5m" } },
    });
    writeJson(configPath, {});

    expect(restoreNewerSettings(configPath, "0.7.0")).toMatchObject({ restored: ["/indexer"] });
    expect(readJson(configPath)).toEqual({ indexer: { cycleInterval: "5m" } });
  });

  test("leaves a copy it cannot read in place", () => {
    writeFileSync(copyPath, "{ truncated");
    writeJson(configPath, {});

    expect(restoreNewerSettings(configPath, "0.7.0")).toMatchObject({
      kind: "unusable",
      reason: expect.stringContaining("not valid JSON"),
    });
    expect(readFileSync(copyPath, "utf8")).toBe("{ truncated");
    expect(readJson(configPath)).toEqual({});
  });

  test("leaves a copy that is not a release and a config in place", () => {
    writeJson(copyPath, { agent: { noteAgent: false } });
    writeJson(configPath, {});

    expect(restoreNewerSettings(configPath, "0.7.0")).toMatchObject({ kind: "unusable" });
    expect(existsSync(copyPath)).toBe(true);
  });

  test("waits for a config the store can read", () => {
    writeJson(copyPath, { release: "0.7.0", config: { agent: { noteAgent: false } } });
    writeFileSync(configPath, "{ not json");

    expect(restoreNewerSettings(configPath, "0.7.0")).toEqual({ kind: "none" });
    expect(existsSync(copyPath)).toBe(true);
  });

  test("retires the copy without restoring when the config was removed", () => {
    writeJson(copyPath, { release: "0.7.0", config: { agent: { noteAgent: false } } });

    expect(restoreNewerSettings(configPath, "0.7.0")).toMatchObject({ restored: [] });
    expect(existsSync(configPath)).toBe(false);
    expect(existsSync(copyPath)).toBe(false);
  });
});
