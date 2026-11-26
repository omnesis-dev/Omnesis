// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { preparePackageFixture } from "./package-fixture.mjs";
import { PACKAGE_INPUTS } from "./native-package.mjs";

const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function input() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "omnesis-package-input-")));
  roots.push(root);
  const source = join(root, "source");
  await mkdir(source);
  execFileSync("git", ["init", "-q", source]);
  for (const path of PACKAGE_INPUTS) {
    if (["packages", "scripts", "patches", "extension"].includes(path))
      await mkdir(join(source, path));
    else {
      await mkdir(join(source, path, ".."), { recursive: true });
      await writeFile(join(source, path), "public fixture\n");
    }
  }
  await writeFile(join(source, "macos/private-fixture.txt"), "excluded native fixture\n");
  await writeFile(join(source, ".gitignore"), "packages/ignored/\n");
  await mkdir(join(source, "packages/ignored"));
  await writeFile(join(source, "packages/ignored/private.txt"), "ignored fixture\n");
  await writeFile(join(source, "packages/public.ts"), "export const example = 1;\n");
  await writeFile(join(source, "packages/.env.local"), "private fixture\n");
  await writeFile(join(source, "packages/signing.p12"), "private fixture\n");
  await mkdir(join(root, "dependencies"));
  await symlink(join(root, "dependencies"), join(source, "packages/node_modules"));
  await symlink("../LICENSE", join(source, "extension/LICENSE"));
  return { root, source, output: join(root, "fixture") };
}

test("normalized archive omits secrets, ignored state and dependency links; its standalone receiver works", async () => {
  const options = await input();
  await preparePackageFixture(options);
  const output = join(options.root, "extracted");
  execFileSync(process.execPath, [
    join(options.output, "extract.mjs"),
    "--fixture",
    options.output,
    "--out",
    output,
  ]);
  expect(await readFile(join(output, "packages/public.ts"), "utf8")).toContain("example = 1");
  for (const path of [
    "packages/.env.local",
    "packages/signing.p12",
    "packages/node_modules",
    "packages/ignored/private.txt",
    "macos/private-fixture.txt",
  ])
    await expect(lstat(join(output, path))).rejects.toThrow();
  expect(PACKAGE_INPUTS.filter((path) => path.startsWith("macos/"))).toEqual([
    "macos/Tests/Composition/desktop-native-entry.mjs",
    "macos/Tests/Composition/desktop-service-entry.mjs",
  ]);
  for (const path of PACKAGE_INPUTS.filter((path) => path.startsWith("macos/")))
    expect(await readFile(join(output, path), "utf8")).toBe("public fixture\n");
  expect((await lstat(join(output, "extension/LICENSE"))).isFile()).toBe(true);
  expect(await readFile(join(output, "extension/LICENSE"), "utf8")).toBe("public fixture\n");
});

test("unknown fixture outputs and links outside public inputs are refused without replacement", async () => {
  const options = await input();
  await mkdir(options.output);
  await writeFile(join(options.output, "keep"), "unrelated fixture");
  await expect(preparePackageFixture(options)).rejects.toThrow(/not owned/);
  expect(await readFile(join(options.output, "keep"), "utf8")).toBe("unrelated fixture");
  await symlink(join(options.root, "dependencies"), join(options.source, "packages/unsafe"));
  await expect(
    preparePackageFixture({ ...options, output: join(options.root, "new-fixture") }),
  ).rejects.toThrow(/unsafe symbolic/);
});

test.skipIf(process.platform === "win32")(
  "the standalone receiver runs through a symlinked path",
  async () => {
    const options = await input();
    await preparePackageFixture(options);
    const alias = join(options.root, "linked-fixture");
    await symlink(options.output, alias);
    const output = join(options.root, "linked-extraction");
    execFileSync(process.execPath, [
      join(alias, "extract.mjs"),
      "--fixture",
      alias,
      "--out",
      output,
    ]);
    expect(await readFile(join(output, "packages/public.ts"), "utf8")).toContain("example = 1");
  },
);

test("a changed archive is rejected before extraction creates a destination", async () => {
  const options = await input();
  await preparePackageFixture(options);
  await writeFile(join(options.output, "source.tar"), "modified fixture");
  const output = join(options.root, "rejected");
  expect(() =>
    execFileSync(
      process.execPath,
      [join(options.output, "extract.mjs"), "--fixture", options.output, "--out", output],
      { stdio: "pipe" },
    ),
  ).toThrow();
  await expect(lstat(output)).rejects.toThrow();
});
