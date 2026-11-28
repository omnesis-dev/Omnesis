// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync } from "node:child_process";
import { cp, lstat, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, X509Certificate } from "node:crypto";
import { assembleApp } from "./assemble-app.mjs";
import { inventoryBundle, refreshRuntimeInventory } from "./native-inventory.mjs";
import {
  ORIGINAL_ENTRY,
  parseCompositionResource,
} from "../../macos/Tests/Composition/desktop-native-entry.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function canonicalDirectory(path, privateMode = false) {
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid() ||
    (info.mode & (privateMode ? 0o077 : 0o022)) !== 0 ||
    (await realpath(path)) !== resolve(path)
  )
    throw new Error("QA input/output directory is unsafe");
}
function outside(parent, child) {
  const local = relative(parent, child);
  return local.startsWith(".." + "/") || local === ".." || isAbsolute(local);
}
async function debugPlist(path, identifier, executable, version) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 65536)
    throw new Error("Invalid QA native metadata");
  let xml = await readFile(path, "utf8");
  if (!xml.trimStart().startsWith("<?xml")) {
    xml = execFileSync("/usr/bin/plutil", ["-convert", "xml1", "-o", "-", path], {
      encoding: "utf8",
      maxBuffer: 65536,
      timeout: 10000,
    });
  }
  const field = (key) => {
    const matches = [
      ...xml.matchAll(new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`, "gu")),
    ];
    if (matches.length !== 1) throw new Error("Ambiguous QA native metadata");
    return matches[0][1];
  };
  if (
    field("CFBundleIdentifier") !== identifier ||
    field("CFBundleExecutable") !== executable ||
    field("OmnesisBuildConfiguration") !== "Debug" ||
    field("CFBundleShortVersionString") !== version
  )
    throw new Error("QA requires exact Debug main and helper identities");
}

/** Produces only an unsigned DEBUG fixture; no downloads, signing, credentials or publication. */
export async function prepareNativeCompositionFixture({
  runtime,
  shellApp,
  output,
  architecture,
  version,
  resource,
  ca,
}) {
  if (typeof process.getuid !== "function")
    throw new Error("QA fixtures require POSIX ownership checks");
  resource = parseCompositionResource(resource);
  runtime = resolve(runtime);
  shellApp = resolve(shellApp);
  output = resolve(output);
  if (
    basename(output) !== "Omnesis-QA.app" ||
    !outside(runtime, output) ||
    !outside(shellApp, output)
  )
    throw new Error("QA output must be a separate Omnesis-QA.app");
  await canonicalDirectory(runtime);
  await canonicalDirectory(shellApp);
  await canonicalDirectory(dirname(output), true);
  try {
    await lstat(output);
    throw new Error("QA output already exists");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await debugPlist(
    join(shellApp, "Contents/Info.plist"),
    "dev.omnesis.desktop",
    "Omnesis",
    version,
  );
  await debugPlist(
    join(shellApp, "Contents/Library/LoginItems/OmnesisBackground.app/Contents/Info.plist"),
    "dev.omnesis.desktop.background",
    "OmnesisBackground",
    version,
  );
  const manifest = JSON.parse(await readFile(join(runtime, "desktop-runtime.json"), "utf8"));
  if (
    manifest.architecture !== architecture ||
    manifest.productVersion !== version ||
    manifest.processAuthorityProtocol !== 3
  )
    throw new Error("QA runtime identity mismatch");
  const before = (await inventoryBundle(runtime, architecture)).filter(
    (entry) => entry.path !== "desktop-runtime.json",
  );
  if (JSON.stringify(before) !== JSON.stringify(manifest.inventory))
    throw new Error("QA source runtime inventory drift");
  for (const name of ["qa-resource.json", "qa-ca.pem", "packages/cli/dist/" + ORIGINAL_ENTRY]) {
    try {
      await lstat(join(runtime, name));
      throw new Error("QA source already contains fixture inputs");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const caBytes = Buffer.from(ca);
  if (
    caBytes.length > 65536 ||
    !caBytes.toString().startsWith("-----BEGIN CERTIFICATE-----") ||
    sha(caBytes) !== resource.caSha256
  )
    throw new Error("QA public CA resource mismatch");
  if (!new X509Certificate(caBytes).ca) throw new Error("QA certificate must be a public test CA");
  const scratch = await mkdtemp(join(dirname(output), ".qa-composition-"));
  let createdOutput;
  try {
    const selected = join(scratch, "runtime");
    await cp(runtime, selected, { recursive: true, verbatimSymlinks: true });
    const entry = join(selected, "packages/cli/dist/index.js");
    const original = await readFile(entry);
    await rename(entry, join(dirname(entry), ORIGINAL_ENTRY));
    await cp(
      fileURLToPath(
        new URL("../../macos/Tests/Composition/desktop-native-entry.mjs", import.meta.url),
      ),
      entry,
    );
    if (!original.equals(await readFile(join(dirname(entry), ORIGINAL_ENTRY))))
      throw new Error("QA original CLI entry changed");
    await writeFile(join(selected, "qa-resource.json"), JSON.stringify(resource), { mode: 0o600 });
    await writeFile(join(selected, "qa-ca.pem"), caBytes, { mode: 0o600 });
    await refreshRuntimeInventory(selected, architecture);
    await assembleApp({ runtime: selected, shellApp, output, architecture, version });
    createdOutput = await lstat(output);
    await writeFile(
      join(output, "Contents/Resources/qa-composition.json"),
      JSON.stringify({
        format: 1,
        kind: "unsigned-debug-native-composition",
        runId: resource.runId,
        resourceSha256: sha(JSON.stringify(resource)),
        originalEntrySha256: sha(original),
      }) + "\n",
      { mode: 0o600 },
    );
    const inventory = await inventoryBundle(output, architecture);
    await writeFile(
      join(output, "Contents/Resources/bundle-inventory.json"),
      JSON.stringify({
        format: 1,
        architecture,
        version,
        inventory: inventory.filter(
          (entry) => entry.path !== "Contents/Resources/bundle-inventory.json",
        ),
      }) + "\n",
    );
    return {
      app: output,
      scope: "unsigned-debug-fixture-only",
      originalEntrySha256: sha(original),
    };
  } catch (error) {
    if (createdOutput) {
      const current = await lstat(output).catch(() => null);
      if (
        current?.isDirectory() &&
        !current.isSymbolicLink() &&
        current.dev === createdOutput.dev &&
        current.ino === createdOutput.ino
      )
        await rm(output, { recursive: true, force: true });
    }
    throw error;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
