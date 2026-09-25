// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { isCompiledModule, resolveWorkerEntry, resolveSubprocessEntry } from "./worker-entry.js";

const SRC_URL = "file:///repo/packages/gateway/src/index.ts";
const DIST_URL = "file:///repo/packages/gateway/dist/index.js";

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
    expect(entry.url.href).toBe("file:///repo/packages/gateway/src/workers/writer-worker.ts");
    expect(entry.execArgv).toEqual([
      "--import",
      "file:///repo/packages/gateway/src/workers/reg.mjs",
    ]);
  });

  test("compiled mode points at the emitted .js sibling with no loader", () => {
    const entry = resolveWorkerEntry("./workers/writer-worker.ts", DIST_URL, "./workers/reg.mjs");
    expect(entry.url.href).toBe("file:///repo/packages/gateway/dist/workers/writer-worker.js");
    expect(entry.execArgv).toEqual([]);
  });

  test("rejects non-.ts entry paths", () => {
    expect(() => resolveWorkerEntry("./worker.js", SRC_URL, "./reg.mjs")).toThrow(/\.ts path/);
  });
});

describe("resolveSubprocessEntry", () => {
  test("source mode spawns npx tsx on the .ts entry", () => {
    const entry = resolveSubprocessEntry("./auth-subprocess.ts", SRC_URL);
    expect(entry.command).toBe("npx");
    expect(entry.args).toEqual(["tsx", "/repo/packages/gateway/src/auth-subprocess.ts"]);
  });

  test("compiled mode spawns node on the emitted .js entry", () => {
    const entry = resolveSubprocessEntry("./auth-subprocess.ts", DIST_URL);
    expect(entry.command).toBe(process.execPath);
    expect(entry.args).toEqual(["/repo/packages/gateway/dist/auth-subprocess.js"]);
  });
});
