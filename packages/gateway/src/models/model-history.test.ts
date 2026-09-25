// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ModelHistoryStore } from "./model-history.js";
import type { OmnesisConfig } from "@omnesis/config";

function cfg(
  assignments: NonNullable<NonNullable<OmnesisConfig["inference"]>["assignments"]>,
): OmnesisConfig {
  return { inference: { assignments, entailment: { promptStyle: "judge" } } };
}

describe("ModelHistoryStore", () => {
  let dir: string;
  let store: ModelHistoryStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omnesis-model-history-"));
    store = new ModelHistoryStore({ filePath: join(dir, "model-history.json") });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("starts empty when no file exists", () => {
    store.load();
    expect(store.snapshot()).toEqual({});
  });

  test("record persists and reloads across instances", () => {
    store.load();
    expect(store.record("agent", undefined, "openai/gpt-4o")).toBe(true);
    expect(store.record("agent", "openai/gpt-4o", "codex/gpt-5.4")).toBe(true);

    const reloaded = new ModelHistoryStore({ filePath: join(dir, "model-history.json") });
    reloaded.load();
    expect(reloaded.snapshot()).toEqual({ agent: ["codex/gpt-5.4", "openai/gpt-4o"] });
  });

  test("record is a no-op for unchanged assignments", () => {
    store.load();
    store.record("agent", undefined, "openai/gpt-4o");
    expect(store.record("agent", "openai/gpt-4o", "openai/gpt-4o")).toBe(false);
  });

  test("recordChanges diffs config snapshots across roles", () => {
    store.load();
    store.recordChanges(cfg({ agent: "a", ocr: "b" }), cfg({ agent: "c", ocr: "b" }));
    expect(store.snapshot()).toEqual({ agent: ["c", "a"] });
  });

  test("a cleared assignment preserves the replaced value and reloads", () => {
    store.load();
    store.recordChanges(cfg({ agent: "openai/gpt-4o" }), cfg({ agent: null }));
    expect(store.snapshot()).toEqual({ agent: ["openai/gpt-4o"] });

    const reloaded = new ModelHistoryStore({ filePath: join(dir, "model-history.json") });
    reloaded.load();
    expect(reloaded.snapshot()).toEqual({ agent: ["openai/gpt-4o"] });
  });

  test("a semantic no-op change does not rewrite the file", () => {
    store.load();
    store.record("agent", "x", "y");
    const path = join(dir, "model-history.json");
    const before = readFileSync(path, "utf8");
    // Clearing the current value recomputes the stored list identically —
    // the history already leads with the replaced value.
    store.recordChanges(cfg({ agent: "y" }), cfg({}));
    expect(store.snapshot()).toEqual({ agent: ["y", "x"] });
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("a persist failure warns instead of throwing", () => {
    // A regular file where the sidecar directory should be makes the atomic
    // write fail deterministically.
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "x");
    const stuck = new ModelHistoryStore({ filePath: join(blocker, "model-history.json") });
    stuck.load();
    expect(() => stuck.record("agent", undefined, "a")).not.toThrow();
    expect(stuck.snapshot()).toEqual({ agent: ["a"] });
  });

  test("corrupt file starts empty instead of throwing", () => {
    writeFileSync(join(dir, "model-history.json"), "{ not json");
    expect(() => store.load()).not.toThrow();
    expect(store.snapshot()).toEqual({});
  });

  test("unknown roles and non-string values are dropped on load", () => {
    writeFileSync(
      join(dir, "model-history.json"),
      JSON.stringify({ version: 1, roles: { agent: ["a", 42, ""], nonsense: ["x"] } }),
    );
    store.load();
    expect(store.snapshot()).toEqual({ agent: ["a"] });
  });

  test("non-object JSON and a future version start empty", () => {
    for (const body of [
      `[1,2]`,
      `"42"`,
      `null`,
      JSON.stringify({ version: 2, roles: { agent: ["a"] } }),
    ]) {
      writeFileSync(join(dir, "model-history.json"), body);
      store.load();
      expect(store.snapshot()).toEqual({});
    }
  });
});
