// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawn, execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  completeNodeHeaders,
  droppedOptionalPackages,
  npmCi,
  npmJavaScriptEntry,
} from "./npm-ci.mjs";
import { npmCiFixture } from "../test-fixtures/npm-ci-fixture.mjs";
import { childGroupIsAlive } from "../lib/check-process-runtime.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function temporary() {
  const root = mkdtempSync(join(tmpdir(), "npm portable ' spaces "));
  roots.push(root);
  return root;
}

function fixture(actions, options) {
  return npmCiFixture(temporary(), actions, options);
}

function records(path) {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

describe("portable Node CI bootstrap", () => {
  test("prepares exact-version/architecture headers before literal npm invocation in a clean checkout", async () => {
    const f = fixture(["ok"], { clean: true });
    const { result } = f.start(["--no-audit", "one argument & literal"]);
    const outcome = await result;
    expect(outcome.code, outcome.stderr).toBe(0);
    const [headers, ci] = records(f.events);
    expect(headers).toMatchObject({
      stage: "headers",
      version: process.versions.node,
      arch: process.arch,
    });
    expect(ci).toMatchObject({
      stage: "ci",
      headers: headers.root,
      legacy: null,
      target: process.versions.node,
      arch: process.arch,
    });
    expect(ci.args).toEqual([
      "ci",
      "--logs-dir",
      expect.any(String),
      "--no-audit",
      "one argument & literal",
    ]);
    expect(existsSync(dirname(dirname(headers.root)))).toBe(false);
    expect(existsSync(join(f.checkout, "node_modules"))).toBe(false);
  }, 60_000);

  test("Windows explicit nodedir stages the matching import library for Release and Debug", async () => {
    const f = fixture();
    let observed = false;
    const code = await npmCi([], {
      platform: "win32",
      arch: "x64",
      nodePath: f.nodePath,
      cwd: f.root,
      env: {
        ...process.env,
        npm_execpath: f.npmCli,
        npm_config_arch: "ia32",
        NPM_PACKAGE_CONFIG_NODE_GYP_TARGET: "1.2.3",
        NPM_PACKAGE_CONFIG_NODE_GYP_NODEDIR: "wrong headers",
      },
      run: (args, options) => {
        if (args[0] === f.npmCli) {
          observed = true;
          const headers = options.env.npm_package_config_node_gyp_nodedir;
          expect(readFileSync(join(headers, "Release", "node.lib"), "utf8")).toBe(
            "synthetic import library",
          );
          expect(readFileSync(join(headers, "Debug", "node.lib"), "utf8")).toBe(
            "synthetic import library",
          );
          expect(options.env.npm_package_config_node_gyp_arch).toBe("x64");
          expect(options.env.npm_package_config_node_gyp_target).toBe(process.versions.node);
          expect(options.env).not.toHaveProperty("NPM_PACKAGE_CONFIG_NODE_GYP_NODEDIR");
        }
        return new Promise((resolve, reject) =>
          execFile(process.execPath, args, { env: options.env, cwd: options.cwd }, (error) =>
            error ? reject(error) : resolve(0),
          ),
        );
      },
    });
    expect(code).toBe(0);
    expect(observed).toBe(true);
    expect(records(f.events)[0]).toMatchObject({
      stage: "headers",
      arch: "x64",
      version: process.versions.node,
    });
  });

  test.each([
    [["drop", "ok"], {}, 0, 2, "retrying"],
    [["drop", "drop", "drop"], {}, 0, 3, "::warning::"],
    [["drop", "drop", "drop"], { NPM_CI_REQUIRE_OPTIONAL: "1" }, 1, 3, "requires them"],
    [["whisper"], {}, 0, 1, "::notice::"],
    [["fail", "fail", "fail"], {}, 1, 3, "failed after 3 attempts"],
  ])(
    "retains optional-package and retry policy: %j",
    async (actions, env, code, count, message) => {
      const f = fixture(actions);
      const outcome = await f.start([], env).result;
      expect(outcome.code, outcome.stderr).toBe(code);
      expect(outcome.stderr).toContain(message);
      const events = records(f.events);
      expect(events.filter((row) => row.stage === "headers")).toHaveLength(1);
      expect(events.filter((row) => row.stage === "ci")).toHaveLength(count);
    },
    60_000,
  );

  test("platform source loads without workspace aliases and removes the sibling resolver afterward", async () => {
    const f = fixture(["ok"], { clean: true });
    const root = join(f.checkout, "packages/platform/src");
    writeFileSync(join(root, "after-bootstrap.ts"), "export default 1");
    const script = `import {bootstrapWindowsPlatform} from ${JSON.stringify(pathToFileURL(join(f.checkout, "scripts/lib/bootstrap-platform.mjs")).href)};
      const mod=await bootstrapWindowsPlatform();if(typeof mod.runWindowsJob!=='function')process.exit(2);
      try{await import(${JSON.stringify(pathToFileURL(join(root, "after-bootstrap.js")).href)});process.exit(3)}catch(e){if(e.code!=='ERR_MODULE_NOT_FOUND')throw e}`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      cwd: f.root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (bytes) => {
      stderr += bytes;
    });
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    expect(code, stderr).toBe(0);
    expect(existsSync(join(f.checkout, "node_modules"))).toBe(false);
  });

  test.each(["shutdown", "disconnect"])(
    "%s joins descendants before deleting isolated headers",
    async (mode) => {
      const f = fixture(["hang"]);
      const { child, result } = f.start();
      let descendant;
      try {
        await vi.waitFor(() => expect(existsSync(f.marker)).toBe(true), { timeout: 30_000 });
        const ready = JSON.parse(readFileSync(f.marker, "utf8"));
        descendant = ready.pid;
        expect(existsSync(ready.headers)).toBe(true);
        if (mode === "disconnect") child.disconnect();
        else child.send({ type: "omnesis.parent-shutdown", version: 1 });
        const outcome = await result;
        expect(outcome.code, outcome.stderr).not.toBe(0);
        expect(childGroupIsAlive({ spawnfile: process.execPath, pid: descendant })).toBe(false);
        // The descendant shares its npm parent's group, so also inspect its PID.
        if (process.platform !== "win32") {
          const { execFileSync } = await import("node:child_process");
          const states = execFileSync("ps", ["-axo", "pid=,stat="], { encoding: "utf8" });
          expect(
            states.split("\n").some((line) => {
              const [p, state] = line.trim().split(/\s+/);
              return Number(p) === descendant && !state.startsWith("Z");
            }),
          ).toBe(false);
        } else expect(() => process.kill(descendant, 0)).toThrow();
        expect(existsSync(dirname(dirname(ready.headers)))).toBe(false);
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          if (child.connected) child.send({ type: "omnesis.parent-shutdown", version: 1 });
          else child.kill("SIGTERM");
        }
        await result;
      }
    },
    60_000,
  );
});

test("optional diagnostics understand Windows separators and never print checkout paths", () => {
  expect(
    droppedOptionalPackages(
      "2 verbose reify failed optional dependency C:\\private\\project\\node_modules\\@scope\\binding\n3 verbose reify failed optional dependency C:\\private\\node_modules\\smart-whisper\\node_modules\\node-addon-api",
    ),
  ).toEqual({ dropped: ["@scope/binding"], lacking: ["smart-whisper"] });
});

test("partial and wrong-version headers are rejected", async () => {
  const root = temporary();
  mkdirSync(join(root, "include/node"), { recursive: true });
  for (const name of ["node.h", "node_api.h", "common.gypi", "config.gypi"])
    writeFileSync(join(root, "include/node", name), name.endsWith(".gypi") ? "{}" : "header");
  writeFileSync(
    join(root, "include/node/node_version.h"),
    "#define NODE_MAJOR_VERSION 1\n#define NODE_MINOR_VERSION 2\n#define NODE_PATCH_VERSION 3",
  );
  expect(await completeNodeHeaders(root, "24.0.0", "linux", "arm64")).toBe(false);
  expect(await completeNodeHeaders(root, "1.2.3", "win32", "x64")).toBe(false);
  writeFileSync(join(root, "include/node/common.gypi"), "{");
  expect(await completeNodeHeaders(root, "1.2.3", "linux", "arm64")).toBe(false);
});

test("npm CLI resolution never depends on the node_modules tree npm ci will remove", async () => {
  const root = temporary();
  const unstable = join(root, "node_modules/npm/bin/npm-cli.js");
  const stable = join(root, "runtime/node_modules/npm/bin/npm-cli.js");
  for (const entry of [unstable, stable]) {
    mkdirSync(dirname(entry), { recursive: true });
    writeFileSync(entry, "// synthetic CLI");
  }
  expect(
    await npmJavaScriptEntry({ npm_execpath: unstable }, join(root, "runtime/node.exe"), root),
  ).toBe(stable);
});
