// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { cp, lstat, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { verifyDesktopAnalyticsBuild } from "./build-analytics.mjs";
import { readAnalyticsBuildPins } from "./analytics-sources.mjs";
import { hashFile, machoArchitectures } from "./native-inventory.mjs";

/** Replace only the fresh desktop stage's native engine; source/npm assets stay intact. */
export async function stageDesktopAnalytics({ target, architecture, build }) {
  target = resolve(target);
  if (!["arm64", "x64"].includes(architecture) || (await realpath(target)) !== target)
    throw new Error("The desktop analytics stage is invalid");
  const pins = await readAnalyticsBuildPins();
  const sourcePinsSha256 = createHash("sha256").update(JSON.stringify(pins)).digest("hex");
  const expected = Object.fromEntries(
    ["recipeVersion", "sdkVersion", "compilerVersion", "recipeSha256", "minimumMacOS"].map(
      (name) => [name, build.provenance[name]],
    ),
  );
  Object.assign(expected, { architecture, sourcePinsSha256, duckdbVersion: pins.duckdbVersion });
  const verified = await verifyDesktopAnalyticsBuild(build.directory, expected);
  const packageDir = join(target, "node_modules/@duckdb", `node-bindings-darwin-${architecture}`);
  if ((await realpath(packageDir)) !== packageDir)
    throw new Error("The staged analytics binding cannot be an alias");
  const manifest = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
  if (
    manifest.name !== `@duckdb/node-bindings-darwin-${architecture}` ||
    manifest.version !== pins.nodeBindingsVersion
  )
    throw new Error("The staged analytics binding does not match the reviewed engine");
  const library = join(packageDir, "libduckdb.dylib");
  const info = await lstat(library);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    JSON.stringify(machoArchitectures(await readFile(library))) !== JSON.stringify([architecture])
  )
    throw new Error("The staged analytics engine is not an owned target library");
  await cp(verified.library, library);
  if ((await hashFile(library)) !== verified.provenance.librarySha256)
    throw new Error("The desktop analytics library changed while staging");
  const gateway = join(target, "packages/gateway");
  if ((await realpath(gateway)) !== gateway)
    throw new Error("The staged gateway cannot be an alias");
  const rawExtensions = join(gateway, "duckdb-extensions");
  try {
    const raw = await lstat(rawExtensions);
    if (
      !raw.isDirectory() ||
      raw.isSymbolicLink() ||
      (await realpath(rawExtensions)) !== rawExtensions
    )
      throw new Error("The staged analytics extensions cannot be an alias");
    await rm(rawExtensions, { recursive: true });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const notices = join(gateway, "desktop-analytics-notices");
  try {
    await lstat(notices);
    throw new Error("Desktop analytics notices already exist");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await cp(join(verified.directory, "licenses"), notices, { recursive: true });
  await writeFile(
    join(gateway, "desktop-analytics.json"),
    JSON.stringify(verified.provenance) + "\n",
    { flag: "wx", mode: 0o644 },
  );
}
