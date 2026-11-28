// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Trusted build code produces inert metadata; update inspection never runs a candidate. */
export async function writeDesktopUpdateMetadata(runtime, architecture, productVersion) {
  if (!["arm64", "x64"].includes(architecture) || !/^\d+\.\d+\.\d+$/.test(productVersion))
    throw new Error("Invalid desktop build identity");
  const coreVersion = JSON.parse(
    await readFile(join(runtime, "packages/core/package.json"), "utf8"),
  ).version;
  const gatewayVersion = JSON.parse(
    await readFile(join(runtime, "packages/gateway/package.json"), "utf8"),
  ).version;
  if (coreVersion !== productVersion || gatewayVersion !== productVersion)
    throw new Error("Desktop update metadata requires lockstep product versions");
  const { buildCompatManifest } = await import(
    pathToFileURL(join(runtime, "packages/core/dist/compat.js")).href
  );
  const { LATEST_SCHEMA_VERSION } = await import(
    pathToFileURL(join(runtime, "packages/gateway/dist/data/schema-version.js")).href
  );
  const compat = buildCompatManifest({
    productVersion,
    mainDbSchemaVersion: LATEST_SCHEMA_VERSION,
  });
  if (
    compat.productVersion !== productVersion ||
    !Number.isSafeInteger(compat.stores?.mainDb?.version) ||
    compat.stores.mainDb.version < 1
  )
    throw new Error("Invalid embedded compatibility manifest");
  const metadata = {
    format: 1,
    bundleIdentifier: "dev.omnesis.desktop",
    productVersion,
    architecture,
    compat,
  };
  await writeFile(join(runtime, "desktop-update.json"), `${JSON.stringify(metadata, null, 2)}\n`, {
    flag: "wx",
  });
  return metadata;
}
