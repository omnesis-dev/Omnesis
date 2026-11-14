// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { execute, nxInvocation } from "./checks.mjs";

const repoRoot = join(import.meta.dirname, "../..");
const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function entryTree() {
  const root = mkdtempSync(join(tmpdir(), "omnesis-entrypoint-"));
  roots.push(root);
  const link = join(root, "source tree # with spaces");
  // Junctions need no symlink privilege on Windows. The tests only read the checkout.
  symlinkSync(repoRoot, link, "junction");
  return { root, link };
}

const cases = [
  ["scripts/nx/checks.mjs", ["invented-invalid-mode"], 1, /Expected checks mode/u],
  ["scripts/nx/run-project-task.mjs", ["unit", "invented-absent-project"], 1, /no unit tests/u],
  ["scripts/nx/ci-scope.mjs", [], 0, /reason=workflow_dispatch event runs every lane/u],
];

describe("real Node entrypoints through a URL-escaped source path", () => {
  test("the resolved Nx JavaScript CLI supports capture and streaming without a batch shim", async () => {
    const invocation = nxInvocation(["--version"]);
    const env = { ...process.env, NX_DAEMON: "false" };
    const captured = spawnSync(invocation.command, invocation.args, { env, encoding: "utf8" });
    expect(captured.error).toBeUndefined();
    expect(captured.status, captured.stderr).toBe(0);
    expect(captured.stdout).toMatch(/\d+\.\d+\.\d+/u);
    await expect(execute(invocation.command, invocation.args, env)).resolves.toBe(0);
  });

  test.each(cases)(
    "%s executes its command and preserves its exit status",
    (script, args, code, message) => {
      const { link } = entryTree();
      const result = spawnSync(
        process.execPath,
        ["--preserve-symlinks-main", join(link, script), ...args],
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            EVENT: "workflow_dispatch",
            LANES: "all",
            GITHUB_OUTPUT: "",
            GITHUB_STEP_SUMMARY: "",
          },
          encoding: "utf8",
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(code);
      expect(`${result.stdout}${result.stderr}`).toMatch(message);
    },
  );

  test.each(["arch-substrate", "sweep-examples", "watch-examples"])(
    "the %s renderer really checks drift and refuses it",
    (name) => {
      const { root, link } = entryTree();
      const preload = join(root, "invented-drift.mjs");
      // Supply stale public markup at the filesystem boundary without editing the checkout.
      writeFileSync(
        preload,
        `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const read = fs.readFileSync;
fs.readFileSync = function(path, ...args) {
  const value = read.call(this, path, ...args);
  if (typeof value !== 'string' || !String(path).endsWith('.html')) return value;
  return value.replace(/(<!-- (arch-substrate:start[^>]*|sweep-examples:start|watch-examples:start) -->)[\\s\\S]*?(<!-- (arch-substrate:end|sweep-examples:end|watch-examples:end) -->)/g,
    '$1\\n<p>Invented stale renderer fixture.</p>\\n$3');
};
syncBuiltinESMExports();
`,
      );
      const result = spawnSync(
        process.execPath,
        [
          "--preserve-symlinks-main",
          "--import",
          preload,
          join(link, `scripts/render-${name}.mjs`),
          "--check",
        ],
        {
          cwd: repoRoot,
          encoding: "utf8",
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toMatch(/Stale (?:arch-substrate|sweep|watch)/u);
    },
  );
});
