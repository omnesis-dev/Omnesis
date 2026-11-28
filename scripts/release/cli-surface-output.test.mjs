// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawn } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

test("surface output drains a slow pipe completely before exiting imported command handles", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "omnesis-surface-output-")));
  let child;
  let resume;
  try {
    await mkdir(join(root, "packages/cli/src"), { recursive: true });
    await mkdir(join(root, "node_modules"));
    await writeFile(join(root, "package.json"), '{"type":"module"}');
    await writeFile(join(root, "packages/cli/package.json"), '{"version":"1.2.3"}');
    const require = createRequire(import.meta.url);
    await symlink(
      dirname(require.resolve("tsx/package.json")),
      join(root, "node_modules/tsx"),
      "junction",
    );
    await writeFile(
      join(root, "packages/cli/src/subcommands.ts"),
      `
setInterval(() => {}, 60_000);
export const SUB_COMMANDS = Object.fromEntries(Array.from({ length: 2048 }, (_, i) => [
  "invented-command-" + i, { args: { "invented-option": { type: "string" } }, run() {} }
]));
`,
    );
    child = spawn(
      process.execPath,
      [fileURLToPath(new URL("./cli-surface.mjs", import.meta.url)), "--tree", root],
      {
        stdio: ["ignore", "pipe", "pipe"],
        signal: AbortSignal.timeout(10_000),
      },
    );
    const output = [],
      errors = [];
    child.stdout.on("data", (chunk) => output.push(chunk));
    child.stdout.pause();
    child.stdout.once("readable", () => {
      resume = setTimeout(() => child.stdout.resume(), 100);
    });
    child.stderr.on("data", (chunk) => errors.push(chunk));
    const code = await new Promise((done, reject) => {
      child.once("error", reject);
      child.once("close", done);
    });
    expect(code, Buffer.concat(errors).toString()).toBe(0);
    const text = Buffer.concat(output).toString();
    expect(Buffer.byteLength(text)).toBeGreaterThan(256 * 1024);
    const surface = JSON.parse(text);
    expect(surface.version).toBe("1.2.3");
    expect(Object.keys(surface.commands)).toHaveLength(2049);
    expect(surface.commands["invented-command-2047"].flags).toEqual({
      "invented-option": { type: "string" },
    });
  } finally {
    clearTimeout(resume);
    if (child && child.exitCode === null && child.signalCode === null) {
      const stopped = new Promise((done) => child.once("close", done));
      child.kill();
      await stopped;
    }
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
