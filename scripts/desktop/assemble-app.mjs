#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { chmod, cp, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { inventoryBundle, machoArchitectures } from "./native-inventory.mjs";
import { NODE_RUNTIME } from "./node-runtime.mjs";
import { parseArguments } from "./arguments.mjs";

export function appPlist(version) {
  if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version))
    throw new Error("Invalid product version");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>dev.omnesis.desktop</string>
<key>CFBundleExecutable</key><string>Omnesis</string>
<key>CFBundleName</key><string>Omnesis</string>
<key>CFBundleDisplayName</key><string>Omnesis</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleVersion</key><string>${version.split("-")[0]}</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSLocalNetworkUsageDescription</key><string>Omnesis finds your other computers to connect to your private library nearby.</string>
<key>NSBonjourServices</key><array><string>_omnesis._tcp</string></array>
<key>CFBundleURLTypes</key><array><dict><key>CFBundleURLName</key><string>dev.omnesis.desktop</string><key>CFBundleURLSchemes</key><array><string>omnesis</string></array></dict></array>
</dict></plist>\n`;
}

/** Assemble prebuilt inputs without downloading, installing or publishing anything. */
export async function assembleApp({
  runtime,
  executable,
  shellApp,
  output,
  architecture,
  version,
  icon,
}) {
  if ((!executable && !shellApp) || (executable && shellApp))
    throw new Error("Provide exactly one native shell app or executable");
  if (shellApp && icon) throw new Error("A prebuilt shell app owns its native icon assets");
  let shellPlist;
  if (shellApp) {
    shellApp = resolve(shellApp);
    const plistPath = join(shellApp, "Contents/Info.plist");
    const raw = await readFile(plistPath);
    shellPlist = raw.toString("utf8").trimStart().startsWith("<?xml")
      ? raw.toString("utf8")
      : execFileSync("plutil", ["-convert", "xml1", "-o", "-", plistPath], { encoding: "utf8" });
    const value = (key) =>
      new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`).exec(shellPlist)?.[1];
    if (
      value("CFBundleShortVersionString") !== version ||
      value("CFBundleExecutable") !== "Omnesis"
    )
      throw new Error("Prebuilt shell version or executable does not match");
    executable = join(shellApp, "Contents/MacOS/Omnesis");
    try {
      await lstat(join(shellApp, "Contents/Resources/runtime"));
      throw new Error("Prebuilt shell must not contain a stale runtime");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await inventoryBundle(shellApp, architecture);
  }
  runtime = resolve(runtime);
  output = resolve(output);
  if (!output.endsWith(".app")) throw new Error("App output must end with .app");
  const manifest = JSON.parse(await readFile(join(runtime, "desktop-runtime.json"), "utf8"));
  if (
    manifest.format !== 1 ||
    manifest.codeUsageProtocol !== 1 ||
    manifest.dataUsageProtocol !== 1 ||
    manifest.processAuthorityProtocol !== 3 ||
    manifest.runtimeLauncher !== "runtime-exec" ||
    manifest.architecture !== architecture ||
    manifest.nodeVersion !== NODE_RUNTIME.version ||
    manifest.productVersion !== version
  )
    throw new Error("Runtime version or architecture does not match the app");
  for (const required of [
    "node",
    "runtime-exec",
    "bin/node",
    "npm",
    "npx",
    "packages/cli/dist/index.js",
    "packages/gateway/portal/index.html",
    "NODE_LICENSE",
    "LICENSE",
  ])
    await readFile(join(runtime, required));
  const nodeArchitectures = machoArchitectures(await readFile(join(runtime, "node")));
  const appArchitectures = machoArchitectures(await readFile(executable));
  const launcherArchitectures = machoArchitectures(await readFile(join(runtime, "runtime-exec")));
  if (
    !nodeArchitectures?.includes(architecture) ||
    !appArchitectures?.includes(architecture) ||
    !launcherArchitectures?.includes(architecture)
  )
    throw new Error(
      "App and bundled Node must be native macOS executables for the selected architecture",
    );
  const runtimeInventory = (await inventoryBundle(runtime, architecture)).filter(
    (entry) => entry.path !== "desktop-runtime.json",
  );
  for (const path of ["node", "runtime-exec", "bin/node", "npm", "npx"])
    if (runtimeInventory.find((entry) => entry.path === path)?.executable !== true)
      throw new Error("Bundled runtime entrypoints must be executable");
  if (JSON.stringify(runtimeInventory) !== JSON.stringify(manifest.inventory))
    throw new Error("Runtime contents differ from their build inventory");
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output);
  try {
    if (shellApp) await cp(shellApp, output, { recursive: true, verbatimSymlinks: true });
    const contents = join(output, "Contents");
    await mkdir(join(contents, "MacOS"), { recursive: true });
    await mkdir(join(contents, "Resources"), { recursive: true });
    await cp(runtime, join(contents, "Resources/runtime"), {
      recursive: true,
      verbatimSymlinks: true,
    });
    if (!shellApp) await cp(executable, join(contents, "MacOS/Omnesis"));
    await chmod(join(contents, "MacOS/Omnesis"), 0o755);
    await chmod(join(contents, "Resources/runtime/node"), 0o755);
    let plist = shellPlist ?? appPlist(version);
    if (icon) {
      await cp(icon, join(contents, "Resources/Omnesis.icns"));
      plist = plist.replace(
        "</dict></plist>",
        "<key>CFBundleIconFile</key><string>Omnesis</string></dict></plist>",
      );
    }
    await writeFile(join(contents, "Info.plist"), plist);
    await writeFile(join(contents, "PkgInfo"), "APPL????");
    const inventory = await inventoryBundle(output, architecture);
    await writeFile(
      join(contents, "Resources/bundle-inventory.json"),
      `${JSON.stringify({ format: 1, architecture, version, inventory }, null, 2)}\n`,
    );
    return output;
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    throw error;
  }
}

if (import.meta.main) {
  const flags = parseArguments(process.argv.slice(2), {
    values: ["runtime", "executable", "shell-app", "out", "arch", "version", "icon"],
    required: ["runtime", "out", "arch", "version"],
  });
  await assembleApp({
    runtime: flags.get("runtime"),
    executable: flags.get("executable"),
    shellApp: flags.get("shell-app"),
    output: flags.get("out"),
    architecture: flags.get("arch"),
    version: flags.get("version"),
    icon: flags.get("icon"),
  });
}
