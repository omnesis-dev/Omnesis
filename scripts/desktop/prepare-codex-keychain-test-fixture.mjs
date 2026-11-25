#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { chmod, cp, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { parseArguments } from "./arguments.mjs";
import { hashFile } from "./native-inventory.mjs";
import { isEntryScript } from "../lib/is-entry-script.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const OWNER = "omnesis-desktop-codex-keychain-test-fixture";
const MAX_ARCHIVE = 256 * 1024 * 1024;

/** Exact architecture artifact and SRI from the reviewed npm lock, never `latest`. */
export async function codexKeychainFixtureSpec(architecture) {
  if (!["arm64", "x64"].includes(architecture))
    throw new Error("Unsupported SDK test architecture");
  const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
  const compatibility = await readFile(join(root, "packages/agent/src/codex-compat.ts"), "utf8");
  const version = /testedVersion:\s*"([0-9]+\.[0-9]+\.[0-9]+)"/u.exec(compatibility)?.[1];
  const entry = lock.packages?.[`node_modules/@openai/codex-darwin-${architecture}`];
  const url = `https://registry.npmjs.org/@openai/codex/-/codex-${version}-darwin-${architecture}.tgz`;
  if (
    !version ||
    entry?.name !== "@openai/codex" ||
    entry.version !== `${version}-darwin-${architecture}` ||
    entry.resolved !== url ||
    !/^sha512-[A-Za-z0-9+/]{86}==$/u.test(entry.integrity)
  )
    throw new Error(
      "The pinned Codex test artifact does not match compatibility and npm integrity metadata",
    );
  return {
    version,
    architecture,
    url,
    integrity: entry.integrity,
    binary: `package/vendor/${architecture === "arm64" ? "aarch64" : "x86_64"}-apple-darwin/bin/codex`,
  };
}

async function verifyArchive(path, integrity) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size > MAX_ARCHIVE)
      throw new Error("The SDK test archive is not bounded regular data");
    const digest = createHash("sha512");
    for await (const chunk of file.createReadStream({ autoClose: false })) digest.update(chunk);
    if (`sha512-${digest.digest("base64")}` !== integrity)
      throw new Error("Codex test archive integrity verification failed");
  } finally {
    await file.close();
  }
}

async function download(spec, cache, fetcher) {
  await mkdir(cache, { recursive: true, mode: 0o700 });
  if ((await lstat(cache)).isSymbolicLink())
    throw new Error("The SDK test cache is an unsafe alias");
  const archive = join(cache, `codex-${spec.version}-darwin-${spec.architecture}.tgz`);
  try {
    if ((await lstat(archive)).isSymbolicLink())
      throw new Error("The SDK test archive is an unsafe alias");
    await verifyArchive(archive, spec.integrity);
    return archive;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const temporary = `${archive}.part-${randomUUID()}`;
  const response = await fetcher(spec.url, {
    redirect: "error",
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok || !response.body)
    throw new Error("The pinned Codex test artifact could not be downloaded");
  const file = await open(temporary, "wx", 0o600);
  try {
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > MAX_ARCHIVE) throw new Error("The SDK test artifact exceeds its size limit");
      await file.writeFile(chunk);
    }
    await file.sync();
    await file.close();
    await verifyArchive(temporary, spec.integrity);
    await rename(temporary, archive);
    return archive;
  } finally {
    await file.close().catch(() => {});
    await rm(temporary, { force: true });
  }
}

function extract(archive, target) {
  const run = (args) => {
    const result = spawnSync("tar", args, {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      timeout: 60_000,
    });
    if (result.error) throw result.error;
    if (result.status !== 0)
      throw new Error("The verified Codex test archive could not be extracted");
    return result.stdout;
  };
  const names = run(["-tzf", archive]).trim().split("\n");
  if (
    names.some(
      (name) =>
        !name.startsWith("package/") || name.includes("\\") || name.split("/").includes(".."),
    )
  )
    throw new Error("The SDK test archive contains an unsafe path");
  if (
    run(["-tvzf", archive])
      .trim()
      .split("\n")
      .some((line) => !["-", "d"].includes(line[0]))
  )
    throw new Error("The SDK test archive contains unsupported links or special files");
  run(["-xzf", archive, "-C", target]);
}

/** Build preflight only: tests never download or substitute a global Codex executable. */
export async function prepareCodexKeychainTestFixture(options, dependencies = {}) {
  const spec = await (dependencies.spec ?? codexKeychainFixtureSpec)(options.architecture);
  const output = resolve(options.output);
  try {
    const info = await lstat(output);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("Codex test fixture output is unsafe");
    const marker = await lstat(join(output, "codex-fixture.json"));
    if (!marker.isFile() || marker.isSymbolicLink() || marker.nlink !== 1 || marker.size > 4096)
      throw new Error("Codex test fixture ownership marker is unsafe");
    const metadata = JSON.parse(await readFile(join(output, "codex-fixture.json"), "utf8"));
    if (metadata.owner !== OWNER || metadata.format !== 1)
      throw new Error("Codex test fixture output is not owned");
    if (
      metadata.version === spec.version &&
      metadata.architecture === spec.architecture &&
      metadata.integrity === spec.integrity
    ) {
      let executable;
      try {
        executable = await lstat(join(output, "codex"));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (
        executable &&
        (!executable.isFile() || executable.isSymbolicLink() || executable.nlink !== 1)
      )
        throw new Error("The existing Codex test executable is unsafe");
      if (executable && metadata.executableSha256 === (await hashFile(join(output, "codex"))))
        return output;
    }
    await rm(output, { recursive: true });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    // An existing directory without its ownership marker is never adopted or removed.
    try {
      await lstat(output);
      throw new Error("SDK test fixture output has no ownership marker", { cause: error });
    } catch (missing) {
      if (missing.code !== "ENOENT") throw missing;
    }
  }
  await mkdir(dirname(output), { recursive: true });
  const stage = `${output}.stage-${randomUUID()}`;
  await mkdir(stage, { mode: 0o700 });
  try {
    const distribution = join(stage, "distribution");
    await mkdir(distribution, { mode: 0o700 });
    const archive = await download(spec, options.cache, dependencies.fetch ?? fetch);
    await (dependencies.extract ?? extract)(archive, distribution);
    const source = join(distribution, spec.binary);
    const sourceInfo = await lstat(source);
    if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink() || sourceInfo.nlink !== 1)
      throw new Error("The SDK test executable is unsafe");
    await cp(source, join(stage, "codex"));
    await chmod(join(stage, "codex"), 0o755);
    const file = await open(join(stage, "codex-fixture.json"), "wx", 0o600);
    try {
      await file.writeFile(
        JSON.stringify({
          format: 1,
          owner: OWNER,
          version: spec.version,
          architecture: spec.architecture,
          integrity: spec.integrity,
          executableSha256: await hashFile(join(stage, "codex")),
        }),
      );
    } finally {
      await file.close();
    }
    await rm(distribution, { recursive: true });
    await rename(stage, output);
    return output;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

if (isEntryScript(import.meta.url)) {
  try {
    const args = parseArguments(process.argv.slice(2), {
      values: ["arch", "out", "cache"],
      required: ["arch", "out"],
    });
    await prepareCodexKeychainTestFixture({
      architecture: args.get("arch"),
      output: args.get("out"),
      cache: args.get("cache") ?? join(homedir(), ".cache", "omnesis-codex-keychain-test"),
    });
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
