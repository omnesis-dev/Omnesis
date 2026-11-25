#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync } from "node:child_process";
import { cp, lstat, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hashFile, inventoryBundle, refreshRuntimeInventory } from "./native-inventory.mjs";
import { parseArguments } from "./arguments.mjs";

/** Bundle containers must be sealed after the native code they enclose. */
export function nestedCodeBundles(entries) {
  const bundles = new Set();
  for (const entry of entries) {
    const parts = entry.path.split("/");
    for (let index = 0; index < parts.length - 1; index += 1)
      if (/\.(?:app|framework|xpc)$/u.test(parts[index]))
        bundles.add(parts.slice(0, index + 1).join("/"));
  }
  return [...bundles].sort(
    (a, b) => b.split("/").length - a.split("/").length || a.localeCompare(b),
  );
}

/** Signing and notarization are explicit build operations; this never publishes an artifact. */
async function distribute({
  app,
  architecture,
  identity,
  output,
  notaryProfile,
  run = execFileSync,
}) {
  if (process.platform !== "darwin") throw new Error("Sign and package the app on macOS");
  if (!identity || identity === "-")
    throw new Error("A Developer ID Application signing identity is required");
  app = resolve(app);
  output = resolve(output);
  if (!app.endsWith(".app") || !output.endsWith(".dmg"))
    throw new Error("Expected .app input and .dmg output");
  try {
    await lstat(output);
    throw new Error("DMG output must not already exist");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const entries = await inventoryBundle(app, architecture);
  const exec = (command, args) => run(command, args, { stdio: "inherit" });
  const nodeEntitlements = fileURLToPath(new URL("./node-entitlements.plist", import.meta.url));
  // Sign nested code individually, deepest paths first. --deep is verification,
  // never a substitute for explicitly signing each native dependency.
  for (const entry of entries
    .filter((item) => item.architectures)
    .sort((a, b) => b.path.length - a.path.length)) {
    const args = ["--force", "--options", "runtime", "--timestamp", "--sign", identity];
    if (entry.path === "Contents/Resources/runtime/node")
      args.push("--entitlements", nodeEntitlements);
    exec("codesign", [...args, join(app, entry.path)]);
  }
  for (const bundle of nestedCodeBundles(entries))
    exec("codesign", [
      "--force",
      "--options",
      "runtime",
      "--timestamp",
      "--sign",
      identity,
      join(app, bundle),
    ]);
  // codesign changes Mach-O bytes, so the unsigned build inventory is stale.
  // Seal these updated runtime hashes inside the outer app signature.
  await refreshRuntimeInventory(join(app, "Contents/Resources/runtime"), architecture);
  exec("codesign", ["--force", "--options", "runtime", "--timestamp", "--sign", identity, app]);
  exec("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
  const temporary = await mkdtemp(join(tmpdir(), "omnesis-desktop-package-"));
  try {
    if (notaryProfile) {
      const zip = join(temporary, "Omnesis.zip");
      exec("ditto", ["-c", "-k", "--keepParent", app, zip]);
      exec("xcrun", ["notarytool", "submit", zip, "--keychain-profile", notaryProfile, "--wait"]);
      exec("xcrun", ["stapler", "staple", app]);
      exec("spctl", ["--assess", "--type", "execute", "--verbose=2", app]);
    }
    const volume = join(temporary, "volume");
    await cp(app, join(volume, basename(app)), { recursive: true, verbatimSymlinks: true });
    await symlink("/Applications", join(volume, "Applications"));
    // -ov is intentionally absent: no existing artifact is replaced.
    exec("hdiutil", [
      "create",
      "-volname",
      "Omnesis",
      "-srcfolder",
      volume,
      "-format",
      "UDZO",
      output,
    ]);
    if (notaryProfile) {
      exec("codesign", ["--timestamp", "--sign", identity, output]);
      exec("xcrun", [
        "notarytool",
        "submit",
        output,
        "--keychain-profile",
        notaryProfile,
        "--wait",
      ]);
      exec("xcrun", ["stapler", "staple", output]);
      exec("xcrun", ["stapler", "validate", output]);
    }
    await writeFile(`${output}.sha256`, `${await hashFile(output)}  ${basename(output)}\n`, {
      flag: "wx",
    });
    return { output, notarized: Boolean(notaryProfile) };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const options = parseArguments(process.argv.slice(2), {
    values: ["app", "arch", "identity", "out", "notary-profile"],
    required: ["app", "arch", "identity", "out"],
  });
  await distribute({
    app: options.get("app"),
    architecture: options.get("arch"),
    identity: options.get("identity"),
    output: options.get("out"),
    notaryProfile: options.get("notary-profile"),
  });
}
