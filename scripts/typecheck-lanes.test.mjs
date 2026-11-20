// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Every suite is in some typecheck program.
 *
 * Test files are typechecked by whichever tsconfig happens to include them, and
 * for most packages that is the package's own — `tsc --build` compiles them
 * along with the sources. Some packages exclude them there, on purpose, and for
 * those the suites are only checked if the package carries a
 * `tsconfig.tests.json` that the `typecheck:tests` script's globs reach.
 *
 * A package in neither state looks exactly like one that passes: its suites run
 * green under vitest while nothing checks that they still construct the types
 * they are annotated with. That is how a suite ends up building a config object
 * two required fields short of its own type, for as long as no code path reads
 * those fields.
 *
 * So the coverage is asserted rather than remembered, and asserted as the
 * property that matters — every suite file is in a program — rather than as the
 * mechanism, which differs per package and is not the thing worth protecting.
 */

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { suiteTypecheckConfigs, runSuiteTypechecks } from "./typecheck-tests.mjs";

import { describe, expect, test } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TSC = createRequire(import.meta.url).resolve("typescript/bin/tsc");
const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);

/** Every package under `packages/`, at whatever depth it sits. */
function packageDirs(relativeDir = "packages", found = []) {
  for (const entry of readdirSync(join(repoRoot, relativeDir), { withFileTypes: true })) {
    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
    const child = join(relativeDir, entry.name);
    if (existsSync(join(repoRoot, child, "package.json"))) found.push(child);
    else packageDirs(child, found);
  }
  return found.sort();
}

/** Every test file in a package, wherever it is kept. */
function suitesIn(relativeDir, found = []) {
  for (const entry of readdirSync(join(repoRoot, relativeDir), { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const child = join(relativeDir, entry.name);
    if (entry.isDirectory()) suitesIn(child, found);
    else if (entry.name.endsWith(".test.ts")) found.push(child);
  }
  return found;
}

/** What a tsconfig resolves to — the files it puts in a program, and what it holds back. */
function resolved(configRelativePath) {
  const shown = JSON.parse(
    execFileSync(process.execPath, [TSC, "-p", configRelativePath, "--showConfig"], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    }),
  );
  const base = join(repoRoot, dirname(configRelativePath));
  const paths = (list) => (list ?? []).map((f) => relative(repoRoot, resolve(base, f)));
  return { files: paths(shown.files), excluded: paths(shown.exclude) };
}

const packages = packageDirs().filter((p) => suitesIn(p).length > 0);

describe("the typecheck lanes", () => {
  test("put every suite in a program, or name it in a ratchet", () => {
    const uncovered = [];
    const stale = [];
    for (const pkg of packages) {
      const configs = ["tsconfig.json", "tsconfig.tests.json"]
        .map((name) => join(pkg, name))
        .filter((c) => existsSync(join(repoRoot, c)));
      const covered = new Set();
      // An exclusion is the ratchet: a suite that does not typecheck yet, named
      // where a reader will see it in a diff. It is not coverage, but it is a
      // deliberate absence rather than an accidental one.
      const ratcheted = new Set();
      for (const config of configs) {
        const { files, excluded } = resolved(config);
        for (const f of files) covered.add(f);
        if (config.endsWith("tsconfig.tests.json")) for (const f of excluded) ratcheted.add(f);
      }
      for (const suite of suitesIn(pkg)) {
        if (!covered.has(suite) && !ratcheted.has(suite)) uncovered.push(suite);
      }
      // A ratchet naming a file that no longer exists is a ratchet nobody is
      // turning: the entry outlives the problem and quietly widens what may be
      // skipped next to it.
      for (const entry of ratcheted) {
        if (!existsSync(join(repoRoot, entry))) stale.push(entry);
      }
    }
    expect(uncovered, "suites in no tsc program at all").toEqual([]);
    expect(stale, "ratchet entries naming files that are gone").toEqual([]);
  }, 180_000);

  test("the portable lane discovers every tests config that exists", () => {
    const script = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).scripts[
      "typecheck:tests:raw"
    ];
    expect(script).toBe("node scripts/typecheck-tests.mjs");
    const reached = new Set(
      suiteTypecheckConfigs(repoRoot).map((config) => resolve(repoRoot, config)),
    );
    const configs = packageDirs()
      .map((directory) => join(repoRoot, directory, "tsconfig.tests.json"))
      .filter(existsSync);
    if (existsSync(join(repoRoot, "extension", "tsconfig.tests.json")))
      configs.push(join(repoRoot, "extension", "tsconfig.tests.json"));
    expect(configs.filter((config) => !reached.has(config))).toEqual([]);
    expect(reached.size).toBe(configs.length);
  });
});

const makeWorkspace = () => {
  const root = mkdtempSync(join(tmpdir(), "suite typecheck # "));
  for (const directory of ["packages/first", "packages/nested/deeper/second", "extension"]) {
    mkdirSync(join(root, directory), { recursive: true });
    writeFileSync(join(root, directory, "package.json"), "{}");
    writeFileSync(join(root, directory, "tsconfig.tests.json"), "{}");
  }
  return root;
};

describe("portable suite typecheck execution", () => {
  test("runs actual Node compiler processes and stops on the first failed config", () => {
    const root = makeWorkspace();
    try {
      const output = join(root, "commands.jsonl");
      const compiler = join(root, "compiler.mjs");
      writeFileSync(
        compiler,
        `import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(output)}, JSON.stringify(args) + '\\n');
process.exit(args.includes('extension/tsconfig.tests.json') ? 7 : 0);
`,
      );
      expect(runSuiteTypechecks({ root, compilerPath: compiler })).toBe(7);
      expect(readFileSync(output, "utf8").trim().split("\n").map(JSON.parse)).toEqual([
        ["--build"],
        ["-p", "extension/tsconfig.tests.json"],
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("includes nested packages and does not run suite compilers after a failed production build", () => {
    const root = makeWorkspace();
    try {
      expect(suiteTypecheckConfigs(root)).toEqual([
        "extension/tsconfig.tests.json",
        "packages/first/tsconfig.tests.json",
        "packages/nested/deeper/second/tsconfig.tests.json",
      ]);
      const calls = [];
      expect(
        runSuiteTypechecks({
          root,
          compilerPath: "compiler",
          run: (command, args) => {
            calls.push([command, ...args]);
            return { status: 5 };
          },
        }),
      ).toBe(5);
      expect(calls).toEqual([[process.execPath, "compiler", "--build"]]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
