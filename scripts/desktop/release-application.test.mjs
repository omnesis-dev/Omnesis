// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { assertReleaseApplication } from "./release-application.mjs";
import { distribute } from "./distribute.mjs";

const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "omnesis-release-app-test-"));
  roots.push(root);
  const app = join(root, "Omnesis.app");
  const main = join(app, "Contents/Info.plist");
  const helper = join(app, "Contents/Library/LoginItems/OmnesisBackground.app/Contents/Info.plist");
  for (const file of [main, helper]) {
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, "fixture native plist input");
  }
  const run = vi.fn((_command, args) =>
    JSON.stringify({
      CFBundleIdentifier:
        args.at(-1) === helper ? "dev.omnesis.desktop.background" : "dev.omnesis.desktop",
      OmnesisBuildConfiguration: "Release",
    }),
  );
  return { root, app, main, helper, run };
}

test("requires Release stamps from both actual native application plists", async () => {
  const f = await fixture();
  await assertReleaseApplication(f.app, f.run);
  expect(f.run.mock.calls.map(([command]) => command)).toEqual([
    "/usr/bin/plutil",
    "/usr/bin/plutil",
  ]);
});

test.each(["main", "helper"])(
  "a Debug %s cannot be signed or archived by the distribution command",
  async (part) => {
    const f = await fixture();
    const read = f.run;
    const run = vi.fn((command, args) => {
      if (command !== "/usr/bin/plutil") throw new Error("A distribution side effect occurred");
      const metadata = JSON.parse(read(command, args));
      if (args.at(-1) === f[part]) metadata.OmnesisBuildConfiguration = "Debug";
      return JSON.stringify(metadata);
    });
    await expect(
      distribute({
        app: f.app,
        architecture: "arm64",
        identity: "Invented signing identity",
        output: join(f.root, "Omnesis.dmg"),
        platform: "darwin",
        run,
      }),
    ).rejects.toThrow("requires Release builds");
    expect(run.mock.calls.every(([command]) => command === "/usr/bin/plutil")).toBe(true);
  },
);

test("missing helpers, plist aliases, invalid identifiers and malformed metadata refuse", async () => {
  const f = await fixture();
  await rm(f.helper);
  await expect(assertReleaseApplication(f.app, f.run)).rejects.toThrow("complete Release");
  await symlink(f.main, f.helper);
  await expect(assertReleaseApplication(f.app, f.run)).rejects.toThrow("metadata is invalid");
  await rm(f.helper);
  await writeFile(f.helper, "fixture helper metadata");
  await expect(
    assertReleaseApplication(f.app, () =>
      JSON.stringify({
        CFBundleIdentifier: "dev.example.other",
        OmnesisBuildConfiguration: "Release",
      }),
    ),
  ).rejects.toThrow("requires Release builds");
  await expect(assertReleaseApplication(f.app, () => "invalid metadata")).rejects.toThrow(
    "could not be read",
  );
});
