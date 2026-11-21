// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { moduleLoaderOptions, type ModulePrewarmOutcome } from "./module-prewarm.js";

// The prewarm worker inherits its parent's Node options, which a Vitest worker
// does not share with a gateway, so each case runs a fresh Node with the
// gateway's TypeScript loader, as a source-mode gateway runs.
const REGISTER_TSX = new URL("../workers/register-tsx.mjs", import.meta.url).href;
const MODULE_PREWARM = new URL("./module-prewarm.ts", import.meta.url).href;
const RUNTIME = new URL("../runtime.ts", import.meta.url).href;

/** A preload that, in any worker thread, blocks every module load for good. */
const HANG_WORKER_LOADS = `data:text/javascript,${encodeURIComponent(`
  import { registerHooks } from "node:module";
  import { isMainThread } from "node:worker_threads";
  if (!isMainThread) registerHooks({ load() { for (;;) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); } });
`)}`;

const SCRIPT = `
  globalThis.evaluated = [];
  const [root, modulePrewarm, waitMs, abort] = process.argv.slice(1);
  const { startModulePrewarm } = await import(modulePrewarm);
  const controller = new AbortController();
  const prewarm = startModulePrewarm(root, controller.signal);
  if (abort === "abort") controller.abort();
  const outcome = await prewarm.finish(Number(waitMs));
  console.log(JSON.stringify({ outcome, evaluated: globalThis.evaluated }));
`;

function prewarm(
  root: string,
  options: { waitMs?: number; abort?: boolean; preload?: string } = {},
): { outcome: ModulePrewarmOutcome; evaluated: string[] } {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      REGISTER_TSX,
      ...(options.preload ? ["--import", options.preload] : []),
      "--input-type=module",
      "-e",
      SCRIPT,
      root,
      MODULE_PREWARM,
      String(options.waitMs ?? 60_000),
      options.abort ? "abort" : "",
    ],
    { encoding: "utf8", timeout: 90_000 },
  );
  expect(result.status, `prewarm process failed:\n${result.stderr}`).toBe(0);
  return JSON.parse(result.stdout.trim().split("\n").at(-1)!) as {
    outcome: ModulePrewarmOutcome;
    evaluated: string[];
  };
}

describe("startModulePrewarm", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function fixture(modules: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-module-prewarm-"));
    dirs.push(dir);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
    for (const [name, source] of Object.entries(modules)) writeFileSync(join(dir, name), source);
    return pathToFileURL(join(dir, "root.ts")).href;
  }

  it("loads the gateway runtime's whole graph", () => {
    const { outcome } = prewarm(RUNTIME);
    const reason = outcome.state === "failed" ? outcome.reason : outcome.state;
    expect(outcome.state, `the runtime's graph did not load: ${reason}`).toBe("loaded");
  }, 90_000);

  it("evaluates none of the modules it loads", () => {
    const record = (name: string): string => `globalThis.evaluated.push("${name}");\n`;
    const root = fixture({
      "root.ts": `import "./a.js";\nimport data from "./data.json" with { type: "json" };\n${record("root")}`,
      "a.ts": `import "./b.js";\nimport "./root.js";\nconst typed: number = 1;\n${record("a")}`,
      "b.ts": record("b"),
      "data.json": "{}",
    });
    expect(prewarm(root)).toEqual({ outcome: { state: "loaded" }, evaluated: [] });
  });

  it("reports a graph that cannot load", () => {
    const root = fixture({ "root.ts": `import "./missing.js";\n` });
    const { outcome } = prewarm(root);
    expect(outcome.state).toBe("failed");
    expect(outcome.state === "failed" && outcome.reason).toContain("missing");
  });

  it("stops a worker that does not finish by its deadline", () => {
    // The process could not exit while the hung worker still ran.
    const root = fixture({ "root.ts": "export {};\n" });
    expect(prewarm(root, { waitMs: 200, preload: HANG_WORKER_LOADS }).outcome).toEqual({
      state: "timed out",
    });
  });

  it("stops when startup stops", () => {
    const root = fixture({ "root.ts": "export {};\n" });
    expect(prewarm(root, { abort: true, preload: HANG_WORKER_LOADS }).outcome).toEqual({
      state: "stopped",
    });
  });
});

describe("moduleLoaderOptions", () => {
  it("keeps the options that change module loading, in order, in either form", () => {
    expect(
      moduleLoaderOptions([
        "--max-old-space-size=4096",
        "--import",
        "file:///loader.mjs",
        "--conditions=development",
        "--input-type=module",
        "-r",
        "./setup.cjs",
        "--title",
        "gateway",
        "--experimental-loader=./hooks.mjs",
      ]),
    ).toEqual([
      "--import",
      "file:///loader.mjs",
      "--conditions=development",
      "-r",
      "./setup.cjs",
      "--experimental-loader=./hooks.mjs",
    ]);
  });
});
