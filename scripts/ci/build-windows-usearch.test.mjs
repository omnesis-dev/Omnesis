// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { buildWindowsUsearch } from "./build-windows-usearch.mjs";

function fixture({
  headerCode = 0,
  buildCode = 0,
  mappingBuildCode = 0,
  probeCode = 0,
  whole = true,
} = {}) {
  const calls = [];
  let headers;
  const env = {
    PATH: "/fixture/tools",
    npm_config_nodedir: "/wrong/headers",
    NPM_CONFIG_TARGET: "wrong-version",
    npm_package_config_node_gyp_arch: "wrong-arch",
  };
  const options = {
    platform: "win32",
    arch: "x64",
    version: "24.0.0",
    cwd: process.cwd(),
    env,
    npmEntry: async () => "/fixture/npm-cli.js",
    gypEntry: () => "/fixture/node-gyp.js",
    locate: () => ({
      root: "/fixture/dependency",
      entry: "/fixture/dependency/javascript/dist/esm/usearch.js",
    }),
    headersComplete: async (root, ...args) => {
      expect(args).toEqual(["24.0.0", "win32", "x64"]);
      expect(root).toBe(headers);
      return whole;
    },
    run: async (args, opts) => {
      calls.push({ args, ...opts, env: { ...opts.env } });
      if (args[1] === "install") {
        headers = join(args.find((arg) => arg.startsWith("--devdir=")).slice(9), "24.0.0");
        mkdirSync(join(headers, "x64"), { recursive: true });
        writeFileSync(join(headers, "x64/node.lib"), "invented import library");
        return headerCode;
      }
      if (args[1] === "rebuild") {
        expect(readFileSync(join(headers, "Release/node.lib"), "utf8")).toBe(
          "invented import library",
        );
        expect(readFileSync(join(headers, "Debug/node.lib"), "utf8")).toBe(
          "invented import library",
        );
        if (opts.cwd === "/fixture/dependency") return buildCode;
        const targets = JSON.parse(readFileSync(join(opts.cwd, "binding.gyp"), "utf8")).targets;
        expect(targets.map(({ target_name }) => target_name)).toEqual([
          "usearch-mapping-proof",
          "usearch_abort_proof",
        ]);
        expect(targets[1].sources[0]).toMatch(/usearch-windows-abort-proof\.cc$/u);
        expect(targets[1].msvs_settings).toEqual(targets[0].msvs_settings);
        return mappingBuildCode;
      }
      return probeCode;
    },
  };
  return { calls, options, env, headers: () => headers };
}

test("builds against running Node headers and proves the exact installed Windows binary", async () => {
  const f = fixture();
  await expect(buildWindowsUsearch(f.options)).resolves.toMatchObject({
    root: "/fixture/dependency",
  });
  expect(f.calls).toHaveLength(4);
  expect(f.calls.every((call) => call.completion === "root")).toBe(true);
  const build = f.calls[1];
  expect(build.cwd).toBe("/fixture/dependency");
  expect(build.args).toEqual([
    "/fixture/node-gyp.js",
    "rebuild",
    `--nodedir=${f.headers()}`,
    "--arch=x64",
    "--jobs=2",
  ]);
  expect(build.env.npm_config_nodedir).toBeUndefined();
  expect(build.env.NPM_CONFIG_TARGET).toBeUndefined();
  expect(build.env.npm_package_config_node_gyp_arch).toBe("x64");
  expect(build.env.npm_package_config_node_gyp_target).toBe("24.0.0");
  expect(build.env.npm_package_config_node_gyp_nodedir).toBe(f.headers());
  expect(f.calls[3].args.slice(1, 3)).toEqual([
    "/fixture/dependency/javascript/dist/esm/usearch.js",
    "/fixture/dependency",
  ]);
  expect(f.calls[2].cwd).toBe(join(dirname(dirname(f.headers())), "mapping-proof"));
  expect(f.calls[3].args[0]).toMatch(/probe-windows-usearch\.mjs$/u);
  expect(f.calls[3].args[3]).toMatch(/usearch-mapping-proof\.exe$/u);
  expect(f.calls[3].args[4]).toMatch(/usearch_abort_proof\.node$/u);
  expect(existsSync(dirname(f.headers()))).toBe(false);
  expect(f.env.npm_config_nodedir).toBe("/wrong/headers");
});

test.each([
  [{ headerCode: 1 }, "complete headers", 1],
  [{ whole: false }, "complete headers", 1],
  [{ buildCode: 1 }, "compile the patched", 2],
  [{ mappingBuildCode: 1 }, "64-bit mapping proof", 3],
  [{ probeCode: 1 }, "native publication proof", 4],
])("fails closed and cleans its headers on %j", async (failure, message, calls) => {
  const f = fixture(failure);
  await expect(buildWindowsUsearch(f.options)).rejects.toThrow(message);
  expect(f.calls).toHaveLength(calls);
  expect(existsSync(dirname(f.headers()))).toBe(false);
});

test("rejects an unneeded rebuild on platforms using their existing prebuilt", async () => {
  await expect(buildWindowsUsearch({ platform: "linux" })).rejects.toThrow("requires Windows");
});
