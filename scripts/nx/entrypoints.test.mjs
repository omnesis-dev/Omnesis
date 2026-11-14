// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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
  test("checks resolves Nx only when an Nx invocation is requested", () => {
    const { root } = entryTree();
    const preload = join(root, "without-nx.cjs");
    writeFileSync(
      preload,
      `const Module=require('node:module');
const resolve=Module._resolveFilename;
Module._resolveFilename=function(specifier,...args){
  if(specifier==='nx/bin/nx.js') throw Object.assign(new Error('Invented absent Nx dependency'),{code:'MODULE_NOT_FOUND'});
  return resolve.call(this,specifier,...args);
};
`,
    );
    const checks = pathToFileURL(join(repoRoot, "scripts/nx/checks.mjs")).href;
    const script = `const checks=await import(${JSON.stringify(checks)});
process.stdout.write('planner-imported\\n');
try { checks.nxInvocation(['show','projects','--json']);process.exitCode=2; }
catch(error) { if(error.code!=='MODULE_NOT_FOUND')throw error;process.stdout.write('nx-required-at-invocation\\n'); }
`;
    const result = spawnSync(
      process.execPath,
      ["--require", preload, "--input-type=module", "-e", script],
      { cwd: root, encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("planner-imported\nnx-required-at-invocation\n");
  });

  test.each([
    ["push", "all", false],
    ["schedule", "all", true],
    ["workflow_dispatch", "all", true],
    ["workflow_dispatch", "linux", false],
  ])("ci-scope %s/%s runs without Nx or any installed dependencies", (event, lanes, macos) => {
    const root = mkdtempSync(join(tmpdir(), "omnesis-scope-no-deps-"));
    roots.push(root);
    const entry = join(root, "ci scope # without dependencies.mjs");
    copyFileSync(join(repoRoot, "scripts/nx/ci-scope.mjs"), entry);
    const output = join(root, "outputs");
    const result = spawnSync(process.execPath, [entry], {
      cwd: root,
      env: {
        ...process.env,
        EVENT: event,
        LANES: lanes,
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: "",
      },
      encoding: "utf8",
    });
    expect(existsSync(join(root, "node_modules"))).toBe(false);
    expect(result.status, result.stderr).toBe(0);
    const scope = Object.fromEntries(
      result.stdout
        .trim()
        .split(/\r?\n/u)
        .map((line) => {
          const equals = line.indexOf("=");
          return [line.slice(0, equals), line.slice(equals + 1)];
        }),
    );
    expect(scope.scope).toBe("full");
    expect(scope.unit).toBe("true");
    expect(scope.security_static).toBe("true");
    expect(scope.node_macos).toBe(String(macos));
    expect(scope.reason).toBe(
      macos
        ? `${event} event runs every lane`
        : `${event} event runs every Linux lane; macOS runs twice daily or on full dispatch`,
    );
    expect(JSON.parse(scope.e2e_matrix).length).toBeGreaterThan(0);
    expect(readFileSync(output, "utf8")).toBe(result.stdout);
  });

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
          pathToFileURL(preload).href,
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
