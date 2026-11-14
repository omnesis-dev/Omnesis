// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import { isCompiledModule, resolveWorkerEntry, resolveSubprocessEntry } from "./worker-entry.js";

const fixtureRoot = join(tmpdir(), "worker entry paths");
const SRC_URL = pathToFileURL(join(fixtureRoot, "packages/gateway/src/index.ts")).href;
const DIST_URL = pathToFileURL(join(fixtureRoot, "packages/gateway/dist/index.js")).href;

describe("isCompiledModule", () => {
  test("ts source is not compiled", () => {
    expect(isCompiledModule(SRC_URL)).toBe(false);
  });

  test("js/mjs output is compiled", () => {
    expect(isCompiledModule(DIST_URL)).toBe(true);
    expect(isCompiledModule("file:///x/dist/worker.mjs")).toBe(true);
  });
});

describe("resolveWorkerEntry", () => {
  test("source mode points at the .ts entry with the tsx preload", () => {
    const entry = resolveWorkerEntry("./workers/writer-worker.ts", SRC_URL, "./workers/reg.mjs");
    expect(entry.url.href).toBe(new URL("./workers/writer-worker.ts", SRC_URL).href);
    expect(entry.execArgv).toEqual(["--import", new URL("./workers/reg.mjs", SRC_URL).href]);
  });

  test("compiled mode points at the emitted .js sibling with no loader", () => {
    const entry = resolveWorkerEntry("./workers/writer-worker.ts", DIST_URL, "./workers/reg.mjs");
    expect(entry.url.href).toBe(new URL("./workers/writer-worker.js", DIST_URL).href);
    expect(entry.execArgv).toEqual([]);
  });

  test("rejects non-.ts entry paths", () => {
    expect(() => resolveWorkerEntry("./worker.js", SRC_URL, "./reg.mjs")).toThrow(/\.ts path/);
  });
});

describe("resolveSubprocessEntry", () => {
  test("source mode spawns this node with the tsx loader on the .ts entry", () => {
    const entry = resolveSubprocessEntry("./auth-subprocess.ts", SRC_URL);
    expect(entry.command).toBe(process.execPath);
    expect(entry.args).toEqual([
      "--import",
      expect.stringMatching(/^file:.*\/tsx\/.*\.mjs$/),
      fileURLToPath(new URL("./auth-subprocess.ts", SRC_URL)),
    ]);
  });

  test("a source-mode entry runs TypeScript from outside the workspace", () => {
    const dir = mkdtempSync(join(tmpdir(), "subprocess-entry-"));
    try {
      const script = join(dir, "entry.ts");
      writeFileSync(script, "const answer: number = 42;\nprocess.stdout.write(String(answer));\n");
      const entry = resolveSubprocessEntry(
        "./entry.ts",
        pathToFileURL(join(dir, "caller.ts")).href,
      );

      const result = spawnSync(entry.command, entry.args, {
        cwd: dir,
        encoding: "utf8",
        // Machine-readable fixture output must not inherit the runner's forced colors.
        env: { ...process.env, FORCE_COLOR: "0" },
      });

      expect(result.stderr).toBe("");
      expect(result.stdout).toBe("42");
      expect(result.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("compiled mode spawns node on the emitted .js entry", () => {
    const entry = resolveSubprocessEntry("./auth-subprocess.ts", DIST_URL);
    expect(entry.command).toBe(process.execPath);
    expect(entry.args).toEqual([fileURLToPath(new URL("./auth-subprocess.js", DIST_URL))]);
  });
});
