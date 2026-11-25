// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Produce offline crypto on the target architecture; never copy another host's extension cache. */
export function stagePinnedDuckDbExtensions(
  { input, target, node, architecture, env },
  run = execFileSync,
) {
  const platform = { arm64: "osx_arm64", x64: "osx_amd64" }[architecture];
  if (!platform) throw new Error("Unsupported desktop extension architecture");
  const gateway = join(input, "packages/gateway");
  run(
    node,
    [
      join(input, "scripts/duckdb-extensions.mjs"),
      "--package-dir",
      gateway,
      "--platform",
      platform,
    ],
    { cwd: input, env, stdio: "inherit" },
  );
  const source = join(gateway, "duckdb-extensions");
  const manifestPath = join(source, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const version = manifest.duckdbVersion,
    pin = manifest.extensions?.httpfs?.[platform];
  if (
    typeof version !== "string" ||
    !/^v\d+\.\d+\.\d+$/.test(version) ||
    !pin ||
    !Number.isSafeInteger(pin.size) ||
    pin.size <= 0 ||
    !/^[a-f0-9]{64}$/.test(pin.sha256)
  )
    throw new Error("The offline analytics crypto extension has no valid build pin");
  const extension = join(source, version, platform, "httpfs.duckdb_extension");
  const bytes = readFileSync(extension);
  if (bytes.length !== pin.size || createHash("sha256").update(bytes).digest("hex") !== pin.sha256)
    throw new Error("The offline analytics crypto extension differs from its build pin");
  const destination = join(target, "packages/gateway/duckdb-extensions");
  mkdirSync(join(destination, version, platform), { recursive: true });
  cpSync(manifestPath, join(destination, "manifest.json"));
  cpSync(extension, join(destination, version, platform, "httpfs.duckdb_extension"));
}
