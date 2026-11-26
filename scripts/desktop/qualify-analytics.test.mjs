// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Script } from "node:vm";
import { afterEach, expect, test, vi } from "vitest";
import { qualifyDesktopAnalytics } from "./qualify-analytics.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "omnesis-analytics-qualification-")));
  roots.push(scratch);
  return {
    input: join(scratch, "upstream"),
    target: join(scratch, "desktop"),
    node: process.execPath,
    architecture: "arm64",
    scratch,
    env: { OMNESIS_TOKEN: "invented-inherited-token" },
  };
}
function stageExtensions({ target }) {
  const assets = join(target, "packages/gateway/duckdb-extensions");
  mkdirSync(assets, { recursive: true });
  writeFileSync(join(assets, "manifest.json"), JSON.stringify({ duckdbVersion: "v1.5.6" }));
}

test("compatibility probes carry their fresh fixture key only on bounded private stdin", () => {
  const run = vi.fn().mockReturnValue({ status: 0, stdout: "qualified\n" });
  const f = fixture();
  qualifyDesktopAnalytics(f, { run, stageExtensions });
  expect(run).toHaveBeenCalledTimes(3);
  const inputs = run.mock.calls.map(([, , options]) => JSON.parse(options.input));
  expect(inputs.map(({ step }) => step)).toEqual([1, 2, 3]);
  expect(inputs.map(({ engineVersion }) => engineVersion)).toEqual(["v1.5.6", "v1.5.6", "v1.5.6"]);
  expect(new Set(inputs.map(({ key }) => key)).size).toBe(1);
  expect(inputs[0].key).toMatch(/^[a-f0-9]{64}$/u);
  expect(inputs[0].extension).toContain("osx_arm64/httpfs.duckdb_extension");
  expect(inputs[1].extension).toBeUndefined();
  expect(inputs[2].extension).toBe(inputs[0].extension);
  for (const [, args, options] of run.mock.calls) {
    expect(() => new Script(args[1])).not.toThrow();
    expect(JSON.stringify([args, options.env])).not.toContain(inputs[0].key);
    expect(options.env.OMNESIS_TOKEN).toBeUndefined();
    expect(options.timeout).toBe(60_000);
    expect(options.killSignal).toBe("SIGKILL");
  }
});

test("a failed native probe stops qualification and never includes its diagnostics in the build error", () => {
  const run = vi.fn().mockImplementation((_node, _args, options) => ({
    status: 1,
    stdout: options.input,
    stderr: options.input,
    error: new Error(options.input),
  }));
  expect(() => qualifyDesktopAnalytics(fixture(), { run, stageExtensions })).toThrow(
    /^The packaged analytics engine failed upstream encrypted-file interoperability$/u,
  );
  expect(run).toHaveBeenCalledTimes(1);
});
