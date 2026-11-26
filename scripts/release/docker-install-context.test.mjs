// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";

const dockerfile = readFileSync("Dockerfile", "utf8");
const manifest = JSON.parse(readFileSync("package.json", "utf8"));
// npm runs these root hooks during the selective workspace install. Derive
// their standalone Node entrypoints, rather than mirroring a fixed hook list.
const hooks = [manifest.scripts.preinstall, manifest.scripts.postinstall].flatMap((command) =>
  [...command.matchAll(/(?:^|&&)\s*node\s+(scripts\/[^\s]+\.mjs)/gu)].map((match) => match[1]),
);
function assertContext(source, stage) {
  const body = source.split(new RegExp(`^FROM .+ AS ${stage}$`, "mu"))[1]?.split(/^FROM /mu)[0];
  expect(body, "actual selective install stage").toBeTypeOf("string");
  const copied = new Set();
  for (const match of body.matchAll(/^COPY (scripts\/[^\n]+)$/gmu)) {
    const paths = match[1].split(/\s+/u);
    const destination = paths.pop();
    for (const path of paths)
      if (destination === path || (destination.endsWith("/") && path.startsWith(destination)))
        copied.add(path);
  }
  for (const hook of hooks) {
    expect(copied.has(hook), `${stage} must stage root lifecycle input ${hook}`).toBe(true);
    execFileSync(process.execPath, ["--check", resolve(hook)], { stdio: "pipe" });
  }
}
test("selective Docker install contexts contain every standalone root lifecycle hook", () => {
  expect(hooks.length).toBeGreaterThanOrEqual(2);
  assertContext(dockerfile, "workspace-install");
  assertContext(dockerfile, "runtime-dependencies");
});
test.each(["workspace-install", "runtime-dependencies"])(
  "missing postinstall input is rejected in %s",
  (stage) => {
    const omitted = dockerfile.replaceAll(" scripts/native-vector-compat.mjs", "");
    expect(() => assertContext(omitted, stage)).toThrow("native-vector-compat.mjs");
  },
);

// Materialize only the reachable module graph from the real stage COPY inputs.
// Missing transitive inputs are left absent so Node exercises the isolated image layout.
function copyModuleContext(root, stage) {
  const body = dockerfile.split(new RegExp(`^FROM .+ AS ${stage}$`, "mu"))[1]?.split(/^FROM /mu)[0];
  expect(body, "actual dependency stage").toBeTypeOf("string");
  const copies = [...body.matchAll(/^COPY (?!-{2})([^\n]+)$/gmu)].flatMap((match) => {
    const paths = match[1].split(/\s+/u);
    const destination = paths.pop();
    return paths.map((source) => ({ source, destination }));
  });
  const copied = new Set();
  function copyInput(path) {
    const entry = copies.find(
      ({ source }) => source === path || (source.endsWith("/") && path.startsWith(source)),
    );
    if (!entry) return;
    const destination = entry.source.endsWith("/")
      ? join(entry.destination, path.slice(entry.source.length))
      : entry.destination.endsWith("/")
        ? join(entry.destination, path.split("/").at(-1))
        : entry.destination;
    mkdirSync(dirname(join(root, destination)), { recursive: true });
    copyFileSync(path, join(root, destination));
  }
  function visit(path) {
    if (copied.has(path)) return;
    copied.add(path);
    copyInput(path);
    for (let directory = dirname(path); directory !== "."; directory = dirname(directory)) {
      const manifest = join(directory, "package.json");
      if (existsSync(manifest)) copyInput(manifest);
    }
    const source = readFileSync(path, "utf8");
    for (const match of source.matchAll(
      /\bfrom\s*["'](\.[^"']+)["']|\bimport\s*(?:\(\s*)?["'](\.[^"']+)["']/gu,
    )) {
      visit(
        relative(process.cwd(), resolve(dirname(path), match[1] ?? match[2])).replaceAll("\\", "/"),
      );
    }
  }
  copyInput("package.json");
  copyInput("package-lock.json");
  visit("scripts/runtime/stage-runtime.mjs");
}

test("production dependency stage imports its real staging module and copies workspace-local dependencies", () => {
  const root = mkdtempSync(join(tmpdir(), "omnesis-docker-dependency-context-"));
  try {
    copyModuleContext(root, "runtime-dependencies");
    const dependency = join(root, "packages/cli/node_modules/fixture-dependency");
    mkdirSync(dependency, { recursive: true });
    writeFileSync(join(dependency, "index.js"), "module.exports = 42;\n");
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
      const { stageWorkspaceDependencies } = await import("./scripts/runtime/stage-runtime.mjs");
      stageWorkspaceDependencies("./staged");
    `,
      ],
      {
        cwd: root,
        stdio: "pipe",
        env: { ...process.env, OMNESIS_RUNTIME_MODE: "test", OMNESIS_TELEMETRY: "off" },
      },
    );
    expect(
      readFileSync(
        join(root, "staged/packages/cli/node_modules/fixture-dependency/index.js"),
        "utf8",
      ),
    ).toBe("module.exports = 42;\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
