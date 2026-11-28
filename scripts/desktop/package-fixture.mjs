// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { PACKAGE_INPUTS } from "./native-package.mjs";

const OWNER = "omnesis-desktop-package-fixture";
const EXCLUDED = new Set(["node_modules", "dist", "build", ".git"]);
function included(path) {
  return !path
    .split(/[\\/]/u)
    .some(
      (part) =>
        EXCLUDED.has(part) ||
        part.startsWith(".env") ||
        /\.(?:p12|p8|mobileprovision|tsbuildinfo)$/u.test(part),
    );
}
function publicInput(path) {
  return PACKAGE_INPUTS.some((input) => path === input || path.startsWith(input + "/"));
}

/** Normalize public build inputs into regular files before transferring one archive. */
export async function preparePackageFixture({ source, output }) {
  source = await realpath(source);
  output = resolve(output);
  let existing;
  try {
    const info = await lstat(output);
    existing = info;
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      JSON.parse(await readFile(join(output, "package-fixture.json"), "utf8")).owner !== OWNER
    )
      throw new Error("Package fixture output is not owned by this producer");
  } catch (error) {
    if (existing)
      throw new Error("Package fixture output is not owned by this producer", { cause: error });
    if (error.code !== "ENOENT") throw error;
  }
  await mkdir(dirname(output), { recursive: true });
  const stage = output + ".stage-" + randomUUID();
  await mkdir(stage, { mode: 0o700 });
  const tree = join(stage, "tree");
  await mkdir(tree, { mode: 0o700 });
  const copy = async (path) => {
    if (!included(path)) return;
    const input = join(source, path);
    const info = await lstat(input);
    if (info.isDirectory()) {
      await mkdir(join(tree, path), { recursive: true });
      return;
    }
    let resolved = input;
    if (info.isSymbolicLink()) {
      resolved = await realpath(input);
      const target = relative(source, resolved).split("\\").join("/");
      if (!publicInput(target) || !included(target) || !(await lstat(resolved)).isFile())
        throw new Error("Package build input contains an unsafe symbolic link");
    } else if (!info.isFile()) throw new Error("Package build inputs must be ordinary files");
    await mkdir(dirname(join(tree, path)), { recursive: true });
    await copyFile(resolved, join(tree, path));
    await chmod(join(tree, path), info.mode & 0o777);
  };
  try {
    for (const input of PACKAGE_INPUTS) await copy(input);
    // Ignored caches and local state never enter the transfer, even if nested in a workspace.
    const files = execFileSync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { cwd: source },
    )
      .toString("utf8")
      .split("\0")
      .filter((path) => path && publicInput(path) && included(path));
    for (const path of new Set(files)) {
      try {
        await copy(path);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    const archive = join(stage, "source.tar");
    execFileSync("tar", ["-cf", archive, "-C", tree, ...PACKAGE_INPUTS], { stdio: "inherit" });
    const bytes = await readFile(archive);
    await writeFile(
      join(stage, "package-fixture.json"),
      JSON.stringify({
        format: 1,
        owner: OWNER,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.length,
      }) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    await copyFile(
      new URL("./package-fixture-extract.mjs", import.meta.url),
      join(stage, "extract.mjs"),
    );
    await rm(tree, { recursive: true });
    // The existing directory was explicitly recognized above; never replace an unknown path.
    if (existing) {
      const current = await lstat(output);
      if (current.dev !== existing.dev || current.ino !== existing.ino)
        throw new Error("Package fixture output changed during preparation");
      await rm(output, { recursive: true });
    }
    await rename(stage, output);
    return output;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
