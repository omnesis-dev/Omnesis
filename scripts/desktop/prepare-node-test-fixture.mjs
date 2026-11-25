#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { cp, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  acquireNodeArchive,
  extractNodeArchive,
  NODE_RUNTIME,
  nodeArchiveSpec,
} from "./node-runtime.mjs";
import { hashFile } from "./native-inventory.mjs";
import { parseArguments } from "./arguments.mjs";
import { isEntryScript } from "../lib/is-entry-script.mjs";
import { privateKeyTestFixture } from "./private-key-test-fixture.mjs";

/** Build input preparation, never a test-time download or a production runtime override. */
export async function prepareNodeTestFixture({ architecture, output, cache }, dependencies = {}) {
  output = resolve(output);
  const spec = nodeArchiveSpec(architecture);
  const privateKeyFixture = await privateKeyTestFixture();
  let present = false;
  try {
    const metadata = await lstat(output);
    present = true;
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
      throw new Error("Node fixture output is unsafe");
    const existing = JSON.parse(await readFile(join(output, "node-fixture.json"), "utf8"));
    if (existing.format !== 1 || existing.owner !== "omnesis-desktop-node-test-fixture")
      throw new Error("Node fixture output is not owned by this producer");
    if (
      existing.nodeVersion === NODE_RUNTIME.version &&
      existing.architecture === architecture &&
      existing.archiveSha256 === spec.sha256 &&
      JSON.stringify(existing.privateKeyFiles) === JSON.stringify(privateKeyFixture.hashes) &&
      (
        await Promise.all(
          Object.entries(privateKeyFixture.hashes).map(
            async ([name, hash]) => (await hashFile(join(output, "private-key", name))) === hash,
          ),
        )
      ).every(Boolean) &&
      existing.executableSha256 === (await hashFile(join(output, "node")))
    )
      return output;
    await rm(output, { recursive: true });
  } catch (error) {
    if (present && error.code === "ENOENT")
      throw new Error("Node fixture output is not owned by this producer", { cause: error });
    if (error.code !== "ENOENT") throw error;
  }
  await mkdir(dirname(output), { recursive: true });
  const staging = `${output}.stage-${randomUUID()}`;
  const distribution = `${output}.distribution-${randomUUID()}`;
  await mkdir(staging, { mode: 0o700 });
  try {
    const archive = await (dependencies.acquire ?? acquireNodeArchive)(architecture, cache);
    await (dependencies.extract ?? extractNodeArchive)(archive, architecture, distribution);
    await cp(join(distribution, "bin/node"), join(staging, "node"));
    const metadata = {
      format: 1,
      owner: "omnesis-desktop-node-test-fixture",
      nodeVersion: NODE_RUNTIME.version,
      architecture,
      archiveSha256: spec.sha256,
      executableSha256: await hashFile(join(staging, "node")),
      privateKeyFiles: privateKeyFixture.hashes,
    };
    await mkdir(join(staging, "private-key"), { mode: 0o700 });
    for (const [name, body] of Object.entries(privateKeyFixture.files))
      await writeFile(join(staging, "private-key", name), body, { mode: 0o600 });
    await writeFile(join(staging, "node-fixture.json"), JSON.stringify(metadata), { mode: 0o600 });
    await rename(staging, output);
    return output;
  } finally {
    await rm(staging, { recursive: true, force: true });
    await rm(distribution, { recursive: true, force: true });
  }
}

if (isEntryScript(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2), {
      values: ["arch", "out", "cache"],
      required: ["arch", "out"],
    });
    await prepareNodeTestFixture({
      architecture: options.get("arch"),
      output: options.get("out"),
      cache: options.get("cache") ?? join(homedir(), ".cache", "omnesis-desktop-node-test"),
    });
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Node fixture preparation failed"}\n`,
    );
    process.exitCode = 1;
  }
}
