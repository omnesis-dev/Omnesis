// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { buildWindowsSqlite, resolveSqlitePackages } from "./build-windows-sqlite.mjs";

const cleanups = [];
afterEach(() => {
  for (const path of cleanups.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture({ failAt = 0, uncertainAt = 0, arch = "x64", patched = true } = {}) {
  const cwd = realpathSync.native(mkdtempSync(join(tmpdir(), "omnesis-sqlite-build-test-")));
  cleanups.push(cwd);
  const names = ["better-sqlite3", "better-sqlite3-multiple-ciphers"];
  const roots = names.map((name) => join(cwd, "node_modules", name));
  for (const [index, root] of roots.entries()) {
    mkdirSync(join(root, "deps/sqlite3"), { recursive: true });
    mkdirSync(join(root, "prebuilds"));
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: names[index], version: index === 0 ? "13.1.1" : "13.0.3" }),
    );
    writeFileSync(
      join(root, "deps/sqlite3/sqlite3.c"),
      patched
        ? "static int winZeroSharedMemory(HANDLE h){}; rc = winZeroSharedMemory(h);"
        : "unpatched fixture source",
    );
    writeFileSync(join(root, "prebuilds", `win32-${arch}.node`), `old-${index}`);
  }
  const calls = [];
  let scratch;
  const marker = Object.assign(new Error("invented unconfirmed compiler"), {
    cleanupFailure: undefined,
  });
  const failure = new Error("invented wrapper", { cause: new AggregateError([marker]) });
  const options = {
    cwd,
    platform: "win32",
    arch,
    version: "24.0.0",
    env: { PATH: "invented-tools", NPM_CONFIG_TARGET: "wrong", npm_config_nodedir: "wrong" },
    npmEntry: async () => join(cwd, "npm-cli.js"),
    gypEntry: () => join(cwd, "node-gyp.js"),
    headersComplete: async () => true,
    run: async (args, opts) => {
      calls.push({ args, ...opts, env: { ...opts.env } });
      if (args[1] === "install") {
        const devdir = args.find((arg) => arg.startsWith("--devdir=")).slice(9);
        scratch = dirname(devdir);
        cleanups.push(scratch);
        mkdirSync(join(devdir, "24.0.0", arch), { recursive: true });
        writeFileSync(join(devdir, "24.0.0", arch, "node.lib"), "invented import library");
      } else if (args[1] === "rebuild") {
        const index = roots.indexOf(opts.cwd);
        mkdirSync(join(opts.cwd, "build/Release"), { recursive: true });
        writeFileSync(join(opts.cwd, "build/Release/better_sqlite3.node"), `new-${index}`);
      } else {
        expect(
          roots.map((root) => readFileSync(join(root, "prebuilds", `win32-${arch}.node`), "utf8")),
        ).toEqual(["new-0", "new-1"]);
      }
      if (calls.length === uncertainAt) throw failure;
      return calls.length === failAt ? 1 : 0;
    },
  };
  return {
    options,
    roots,
    calls,
    failure,
    scratch: () => scratch,
    binaries: () =>
      roots.map((root) => readFileSync(join(root, "prebuilds", `win32-${arch}.node`), "utf8")),
  };
}

test.each(["x64", "arm64"])(
  "publishes and probes joined %s builds against exact Node headers",
  async (arch) => {
    const f = fixture({ arch });
    await expect(buildWindowsSqlite(f.options)).resolves.toHaveLength(2);
    expect(f.binaries()).toEqual(["new-0", "new-1"]);
    expect(f.calls).toHaveLength(4);
    expect(f.calls.every((call) => call.completion === "root")).toBe(true);
    expect(f.calls[1].args).toContain("--force_build=1");
    expect(f.calls[1].args).toContain(`--arch=${arch}`);
    expect(f.calls[1].env.NPM_CONFIG_TARGET).toBeUndefined();
    expect(f.calls[1].env.npm_config_nodedir).toBeUndefined();
    expect(f.calls[1].env.npm_package_config_node_gyp_arch).toBe(arch);
    expect(existsSync(f.scratch())).toBe(false);
    expect(f.options.env.NPM_CONFIG_TARGET).toBe("wrong");
  },
);

test.each([1, 2, 3, 4])(
  "failure at phase %i preserves previous binaries and retires known staging",
  async (failAt) => {
    const f = fixture({ failAt });
    await expect(buildWindowsSqlite(f.options)).rejects.toThrow();
    expect(f.binaries()).toEqual(["old-0", "old-1"]);
    expect(existsSync(f.scratch())).toBe(false);
  },
);

test.each([1, 2, 3, 4])(
  "uncertainty at phase %i retains headers and recovery inputs",
  async (uncertainAt) => {
    // The runner is inert; this synthetic receipt owns no actual compiler.
    const f = fixture({ uncertainAt });
    await expect(buildWindowsSqlite(f.options)).rejects.toBe(f.failure);
    expect(existsSync(f.scratch())).toBe(true);
    if (uncertainAt === 4) {
      expect(f.binaries()).toEqual(["new-0", "new-1"]);
      expect(readFileSync(join(f.scratch(), "better-sqlite3.previous.node"), "utf8")).toBe("old-0");
    }
  },
);

test("refuses unpatched source before compiling or publishing", async () => {
  const f = fixture({ patched: false });
  await expect(buildWindowsSqlite(f.options)).rejects.toThrow(
    "lacks the SQLite Windows shared-memory recovery fix",
  );
  expect(f.calls).toHaveLength(1);
  expect(f.binaries()).toEqual(["old-0", "old-1"]);
});

test("rejects shared dependencies outside the requested checkout", async () => {
  const f = fixture();
  const nested = join(f.options.cwd, "another-checkout");
  mkdirSync(nested);
  await expect(resolveSqlitePackages(nested)).rejects.toThrow("inside its isolated checkout");
});

test("resolves the upstream plain binding and the retained cipher version from the checkout", async () => {
  const f = fixture();
  await expect(resolveSqlitePackages(f.options.cwd)).resolves.toEqual([
    { name: "better-sqlite3", root: f.roots[0] },
    { name: "better-sqlite3-multiple-ciphers", root: f.roots[1] },
  ]);
  writeFileSync(
    join(f.roots[0], "package.json"),
    JSON.stringify({ name: "better-sqlite3", version: "13.0.3" }),
  );
  await expect(resolveSqlitePackages(f.options.cwd)).rejects.toThrow(
    "requires better-sqlite3@13.1.1",
  );
});

test("does not rebuild the existing Linux or macOS bindings", async () => {
  await expect(buildWindowsSqlite({ platform: "linux" })).rejects.toThrow("requires Windows");
  await expect(buildWindowsSqlite({ platform: "darwin" })).rejects.toThrow("requires Windows");
});
