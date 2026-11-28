// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/** Standalone, builtin-only receiver copied beside the public source archive. */
export async function extractPackageFixture({ fixture, output }) {
  const metadata = JSON.parse(await readFile(join(fixture, "package-fixture.json"), "utf8"));
  const archive = join(fixture, "source.tar");
  const info = await lstat(archive);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 512 * 1024 * 1024)
    throw new Error("Package build fixture archive is unsafe");
  const bytes = await readFile(archive);
  if (
    metadata.owner !== "omnesis-desktop-package-fixture" ||
    metadata.format !== 1 ||
    metadata.bytes !== bytes.length ||
    createHash("sha256").update(bytes).digest("hex") !== metadata.sha256
  )
    throw new Error("Package build fixture checksum mismatch");
  // Only our regular-file producer supplies this fixture; existing destinations are refused.
  await mkdir(output, { mode: 0o700 });
  execFileSync("tar", ["-xf", archive, "-C", output], { stdio: "inherit" });
}

if (import.meta.main) {
  const [fixtureFlag, fixture, outputFlag, output, ...extra] = process.argv.slice(2);
  if (fixtureFlag !== "--fixture" || !fixture || outputFlag !== "--out" || !output || extra.length)
    throw new Error("Usage: package fixture extractor --fixture <directory> --out <new directory>");
  await extractPackageFixture({ fixture, output });
}
