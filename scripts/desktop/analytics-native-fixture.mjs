// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  acquireAnalyticsSource,
  privateBuildDirectory,
  readAnalyticsBuildPins,
} from "./analytics-sources.mjs";
import { hashFile } from "./native-inventory.mjs";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const owner = "omnesis-desktop-analytics-native-input";
const helpers = [
  "build-analytics.mjs",
  "analytics-sources.mjs",
  "analytics-notices.mjs",
  "analytics-build.json",
  "native-inventory.mjs",
  "arguments.mjs",
];

/** Prepare reviewed sources before admission's remote build phase; tests do not fetch code. */
export async function prepareAnalyticsNativeFixture(
  { output, cache },
  { acquire = acquireAnalyticsSource, readPins = readAnalyticsBuildPins } = {},
) {
  output = resolve(output);
  const pins = await readPins();
  const files = new Map();
  for (const name of helpers)
    files.set(`scripts/desktop/${name}`, await readFile(join(repository, "scripts/desktop", name)));
  files.set(
    "scripts/lib/is-entry-script.mjs",
    await readFile(join(repository, "scripts/lib/is-entry-script.mjs")),
  );
  const hashes = Object.fromEntries(
    [...files].map(([name, bytes]) => [name, createHash("sha256").update(bytes).digest("hex")]),
  );
  for (const pin of [...Object.values(pins.sources), ...Object.values(pins.tools ?? {})])
    hashes[`sources/${pin.sha256}.tar.gz`] = pin.sha256;
  let previous;
  try {
    await privateBuildDirectory(output);
    const metadata = join(output, "native-input.json"),
      info = await lstat(metadata);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1 ||
      info.size > 16_384 ||
      (info.mode & 0o077) !== 0 ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw new Error("The existing analytics native inputs are not owned by this producer");
    previous = JSON.parse(await readFile(metadata, "utf8"));
    if (previous.format !== 1 || previous.owner !== owner)
      throw new Error("The existing analytics native inputs are not owned by this producer");
    const root = await lstat(output);
    previous = { device: root.dev, inode: root.ino };
    let complete = true;
    for (const [name, hash] of Object.entries(hashes)) {
      try {
        const path = join(output, name),
          current = await lstat(path);
        if (
          !current.isFile() ||
          current.isSymbolicLink() ||
          current.nlink !== 1 ||
          (current.mode & 0o077) !== 0 ||
          (process.getuid && current.uid !== process.getuid()) ||
          (await realpath(path)) !== resolve(path) ||
          (await hashFile(path)) !== hash
        )
          complete = false;
      } catch (error) {
        if (error.code === "ENOENT") complete = false;
        else throw error;
      }
    }
    if (complete) return output;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    // An occupied directory with no valid marker is never replaced.
    try {
      await lstat(output);
      throw new Error("The existing analytics native inputs are unclaimed", { cause: error });
    } catch (missing) {
      if (missing.code !== "ENOENT") throw missing;
    }
  }
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  await mkdir(cache, { recursive: true, mode: 0o700 });
  await privateBuildDirectory(cache);
  const stage = `${output}.stage-${randomUUID()}`,
    old = `${output}.old-${randomUUID()}`;
  await mkdir(stage, { mode: 0o700 });
  let moved = false;
  try {
    for (const [name, bytes] of files) {
      const target = join(stage, name);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, bytes, { flag: "wx", mode: 0o600 });
    }
    await mkdir(join(stage, "sources"), { mode: 0o700 });
    for (const pin of [...Object.values(pins.sources), ...Object.values(pins.tools ?? {})]) {
      const source = await acquire(pin, cache);
      if ((await hashFile(source)) !== pin.sha256)
        throw new Error("The reviewed native source changed before staging");
      const target = join(stage, "sources", `${pin.sha256}.tar.gz`);
      await cp(source, target);
      if ((await hashFile(target)) !== pin.sha256)
        throw new Error("The reviewed native source changed during staging");
    }
    await writeFile(
      join(stage, "native-input.json"),
      JSON.stringify({ format: 1, owner, files: hashes }),
      { mode: 0o600 },
    );
    if (previous) {
      const current = await lstat(output);
      if (current.dev !== previous.device || current.ino !== previous.inode)
        throw new Error("The analytics native input directory changed before publication");
      await rename(output, old);
      moved = true;
    }
    try {
      await rename(stage, output);
    } catch (error) {
      if (moved) {
        await rename(old, output);
        moved = false;
      }
      throw error;
    }
    if (moved) await rm(old, { recursive: true, force: true });
    return output;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
