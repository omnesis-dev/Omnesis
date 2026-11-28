// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, open, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireNodeArchive, extractNodeArchive, NODE_RUNTIME } from "./node-runtime.mjs";
import { parseArguments } from "./arguments.mjs";
import { qualifyNativeCompositionServices } from "./native-composition-smoke.mjs";
import { isEntryScript } from "../lib/is-entry-script.mjs";
import { projectAnalyticsRestoreFailure } from "./qualify-analytics.mjs";

/** Deliberately excludes host configuration, signing inputs, Git and installed dependencies. */
export const PACKAGE_INPUTS = [
  "packages",
  "scripts",
  "patches",
  "extension",
  "package.json",
  "package-lock.json",
  "tsconfig.base.json",
  "tsconfig.json",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  "TRADEMARKS.md",
  "macos/Tests/Composition/desktop-native-entry.mjs",
  "macos/Tests/Composition/desktop-service-entry.mjs",
];

// Qualification subprocess policy only; never written into the shipped runtime.
const qualificationEnvironment = Object.freeze({
  OMNESIS_RUNTIME_MODE: "test",
  OMNESIS_TELEMETRY: "0",
  OMNESIS_E2E_DESKTOP_COMPOSITION_SMOKE: "1",
});

export function packageEnvironment({ home, distribution, temporary, developerDirectory }) {
  return {
    HOME: home,
    PATH: `${join(distribution, "bin")}:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    TMPDIR: temporary,
    LANG: "en_US.UTF-8",
    NPM_CONFIG_USERCONFIG: join(home, "npm-user.npmrc"),
    NPM_CONFIG_GLOBALCONFIG: join(home, "npm-global.npmrc"),
    ...(developerDirectory ? { DEVELOPER_DIR: developerDirectory } : {}),
    ...qualificationEnvironment,
  };
}

/** npm distinguishes config layers by filename, even when both layers are empty. */
export async function createPackageNpmConfigs(home) {
  await requirePrivateDirectory(home);
  const paths = {
    userConfig: join(home, "npm-user.npmrc"),
    globalConfig: join(home, "npm-global.npmrc"),
  };
  for (const path of Object.values(paths)) await writeFile(path, "", { flag: "wx", mode: 0o600 });
  return paths;
}

async function requirePrivateDirectory(path) {
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid() ||
    (info.mode & 0o077) !== 0 ||
    (info.mode & 0o700) !== 0o700 ||
    (await realpath(path)) !== path
  )
    throw new Error("Package directories must be private owned canonical directories");
}
async function requirePackageScratch(scratch) {
  await requirePrivateDirectory(scratch);
  if ((await readFile(join(scratch, ".omnesis-desktop-scratch"), "utf8")) !== "desktop-native-v1\n")
    throw new Error("Package qualification requires its private native scratch");
}
/** The bridge pre-creates this shared cache. Reuse never adopts a link, file or public directory. */
export async function ensureNativePackageCache(scratch) {
  scratch = resolve(scratch);
  await requirePackageScratch(scratch);
  const cache = join(scratch, "package-cache");
  try {
    await mkdir(cache, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  await requirePrivateDirectory(cache);
  return cache;
}

const processReceiptKeys = ["format", "role", "rootClosed", "treeJoined", "code", "forced"];
const qualificationKeys = [
  "format",
  "compiledEntry",
  "staticModule",
  "sourceUnchanged",
  "keyedRowsAndConstraints",
  "encryptedPrivateOutputs",
  "authenticatedStagingRemoved",
  "nativeDataFdMatched",
];
function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
  );
}
async function ownedReceiptBytes(path, { maximum = 4096, privateFile = true } = {}) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.uid !== BigInt(process.getuid()) ||
      before.nlink !== 1n ||
      (privateFile ? (before.mode & 0o7777n) !== 0o600n : (before.mode & 0o022n) !== 0n) ||
      before.size < 1n ||
      before.size > BigInt(maximum)
    )
      throw new Error("Analytics receipt file refused");
    const bytes = Buffer.alloc(Number(before.size) + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = await handle.read(bytes, count, bytes.length - count, null);
      if (!read.bytesRead) break;
      count += read.bytesRead;
    }
    const after = await handle.stat({ bigint: true }),
      published = await lstat(path, { bigint: true });
    const identity = (v) => [v.dev, v.ino, v.size, v.mtimeNs, v.ctimeNs];
    if (
      BigInt(count) !== before.size ||
      !published.isFile() ||
      published.isSymbolicLink() ||
      identity(before).some((v, i) => v !== identity(after)[i] || v !== identity(published)[i])
    )
      throw new Error("Analytics receipt file changed");
    return bytes.subarray(0, count);
  } finally {
    await handle.close();
  }
}
function parseReceipt(bytes) {
  // Producers write canonical JSON. This also refuses duplicate keys without
  // echoing potentially untrusted receipt contents through a parser error.
  try {
    const text = bytes.toString("utf8"),
      value = JSON.parse(text);
    const canonical = JSON.stringify(value);
    if (text === canonical || text === canonical + "\n") return value;
  } catch {
    /* Report only a fixed refusal below. */
  }
  throw new Error("Analytics receipt JSON refused");
}
async function runtimeManifest(runtime) {
  if ((await realpath(runtime)) !== runtime) throw new Error("Analytics runtime path refused");
  const bytes = await ownedReceiptBytes(join(runtime, "desktop-runtime.json"), {
    maximum: 32 * 1024 * 1024,
    privateFile: false,
  });
  const manifest = JSON.parse(bytes.toString("utf8"));
  if (!["arm64", "x64"].includes(manifest.architecture))
    throw new Error("Analytics architecture refused");
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    architecture: manifest.architecture,
  };
}

/** Only this exact attempt's private artifact is a writable export destination. */
async function validateAnalyticsDestination(runtime, destination, leaf) {
  const output = dirname(runtime),
    scratch = dirname(output),
    attempt = basename(output);
  if (
    runtime !== resolve(runtime) ||
    basename(runtime) !== "runtime" ||
    !/^package-[0-9]+-[0-9]+$/u.test(attempt) ||
    destination !== join(scratch, "evidence", attempt, leaf)
  )
    throw new Error("Analytics receipt destination refused");
  await requirePackageScratch(scratch);
  for (const directory of [output, join(scratch, "evidence"), dirname(destination)])
    await requirePrivateDirectory(directory);
  try {
    await lstat(destination);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  throw new Error("Analytics receipt destination already exists");
}

export async function validateAnalyticsReceiptDestination(runtime, destination) {
  return validateAnalyticsDestination(runtime, destination, "analytics-restore.json");
}

/** Failure facts are distinct evidence and can never satisfy the success reader. */
export async function preserveAnalyticsRestoreFailure({
  runtime,
  home,
  destination,
  manifestSha256,
  failure,
}) {
  if (basename(destination) !== "analytics-restore.json")
    throw new Error("Analytics failure destination refused");
  const path = join(dirname(destination), "analytics-restore-failure.json");
  await validateAnalyticsDestination(runtime, path, "analytics-restore-failure.json");
  await requirePrivateDirectory(home);
  async function processReceipt(role) {
    let bytes;
    try {
      bytes = await ownedReceiptBytes(join(home, `analytics-restore-${role}-process.json`));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
    const value = parseReceipt(bytes);
    if (
      !exactKeys(value, processReceiptKeys) ||
      value.format !== 1 ||
      value.role !== role ||
      value.rootClosed !== true ||
      typeof value.treeJoined !== "boolean" ||
      typeof value.forced !== "boolean" ||
      !(
        value.code === null ||
        (Number.isInteger(value.code) && value.code >= 0 && value.code <= 255)
      )
    )
      throw new Error("Analytics failure process facts refused");
    return value;
  }
  const source = await processReceipt("source"),
    target = await processReceipt("target");
  const role = target ? "target" : source ? "source" : "unavailable";
  let diagnostic = projectAnalyticsRestoreFailure(failure?.analyticsRestoreFailure);
  if (diagnostic.role !== role) diagnostic = projectAnalyticsRestoreFailure(null);
  const manifest = await runtimeManifest(runtime);
  if (manifest.sha256 !== manifestSha256) throw new Error("Analytics failure manifest changed");
  const receipt = {
    format: 1,
    scope: "compiled-analytics-restore-failure",
    runtimeManifestSha256: manifest.sha256,
    architecture: manifest.architecture,
    role,
    stage: diagnostic.stage,
    errorClass: diagnostic.errorClass,
    errorCode: diagnostic.errorCode,
    source,
    target,
  };
  await writeFile(path, JSON.stringify(receipt) + "\n", { flag: "wx", mode: 0o600 });
  if (JSON.stringify(parseReceipt(await ownedReceiptBytes(path))) !== JSON.stringify(receipt))
    throw new Error("Analytics failure evidence changed");
}

/** Export fixed facts only after both real clients and their compiled proof succeeded. */
export async function preserveAnalyticsRestoreReceipt({
  runtime,
  home,
  destination,
  manifestSha256,
}) {
  try {
    await validateAnalyticsReceiptDestination(runtime, destination);
    await requirePrivateDirectory(home);
    const source = parseReceipt(
      await ownedReceiptBytes(join(home, "analytics-restore-source-process.json")),
    );
    const target = parseReceipt(
      await ownedReceiptBytes(join(home, "analytics-restore-target-process.json")),
    );
    const work = join(home, "database-fixture", "analytics-restore");
    await requirePrivateDirectory(work);
    const qualification = parseReceipt(await ownedReceiptBytes(join(work, "qualification.json")));
    for (const [role, receipt] of [
      ["source", source],
      ["target", target],
    ]) {
      if (
        !exactKeys(receipt, processReceiptKeys) ||
        receipt.format !== 1 ||
        receipt.role !== role ||
        receipt.rootClosed !== true ||
        receipt.treeJoined !== true ||
        receipt.code !== 0 ||
        receipt.forced !== false
      )
        throw new Error("Analytics process receipt refused");
    }
    if (
      !exactKeys(qualification, qualificationKeys) ||
      qualification.format !== 1 ||
      qualificationKeys.slice(1).some((key) => qualification[key] !== true)
    )
      throw new Error("Analytics compiled receipt refused");
    const manifest = await runtimeManifest(runtime);
    if (manifest.sha256 !== manifestSha256) throw new Error("Analytics manifest changed");
    const bytes =
      JSON.stringify({
        format: 1,
        scope: "compiled-analytics-restore",
        runtimeManifestSha256: manifest.sha256,
        architecture: manifest.architecture,
        source,
        target,
        qualification,
      }) + "\n";
    await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
    await readAnalyticsRestoreReceipt({ artifact: dirname(destination), runtime });
  } catch (cause) {
    throw Object.assign(new Error("Analytics restore evidence was not confirmed", { cause }), {
      cleanupFailure: "analytics-restore-evidence",
    });
  }
}

export async function readAnalyticsRestoreReceipt({ artifact, runtime }) {
  await requirePrivateDirectory(artifact);
  try {
    await lstat(join(artifact, "analytics-restore-failure.json"));
    throw new Error("Failed analytics qualification cannot be accepted as success");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const receipt = parseReceipt(await ownedReceiptBytes(join(artifact, "analytics-restore.json")));
  const manifest = await runtimeManifest(runtime);
  if (
    !exactKeys(receipt, [
      "format",
      "scope",
      "runtimeManifestSha256",
      "architecture",
      "source",
      "target",
      "qualification",
    ]) ||
    receipt.format !== 1 ||
    receipt.scope !== "compiled-analytics-restore" ||
    receipt.runtimeManifestSha256 !== manifest.sha256 ||
    receipt.architecture !== manifest.architecture
  )
    throw new Error("Analytics package evidence refused");
  for (const [role, value] of [
    ["source", receipt.source],
    ["target", receipt.target],
  ]) {
    if (
      !exactKeys(value, processReceiptKeys) ||
      value.format !== 1 ||
      value.role !== role ||
      value.rootClosed !== true ||
      value.treeJoined !== true ||
      value.code !== 0 ||
      value.forced !== false
    )
      throw new Error("Analytics package process refused");
  }
  if (
    !exactKeys(receipt.qualification, qualificationKeys) ||
    receipt.qualification.format !== 1 ||
    qualificationKeys.slice(1).some((key) => receipt.qualification[key] !== true)
  )
    throw new Error("Analytics package proof refused");
  return receipt;
}

/** Runs only inside the native pool's owned scratch and existing build reservation. */
export async function buildNativePackage(
  { scratch, architecture = process.arch },
  run = execFileSync,
) {
  if (process.platform !== "darwin") throw new Error("Package qualification requires macOS");
  scratch = resolve(scratch);
  await requirePackageScratch(scratch);
  const source = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  if (source !== join(scratch, "package-source/source"))
    throw new Error("Package source is outside its owned scratch");
  // Each attempt owns a new output: never clear another build or reuse a partial app.
  const attempt = `package-${Date.now()}-${process.pid}`;
  const output = join(scratch, attempt);
  await mkdir(output, { mode: 0o700 });
  await requirePrivateDirectory(join(scratch, "evidence"));
  const artifact = join(scratch, "evidence", attempt);
  await mkdir(artifact, { mode: 0o700 });
  const home = join(output, "home");
  const temporary = join(output, "tmp");
  await mkdir(home, { mode: 0o700 });
  await mkdir(temporary, { mode: 0o700 });
  await createPackageNpmConfigs(home);
  const cache = await ensureNativePackageCache(scratch);
  const archive = await acquireNodeArchive(architecture, cache);
  const distribution = join(output, "node-distribution");
  await extractNodeArchive(archive, architecture, distribution);
  const node = join(distribution, "bin/node");
  const env = packageEnvironment({
    home,
    distribution,
    temporary,
    developerDirectory: process.env.DEVELOPER_DIR,
  });
  const invoke = (command, args) => run(command, args, { cwd: source, env, stdio: "inherit" });
  // This is production compilation, never a backend test/typecheck lane moved to a Mac.
  invoke("/bin/bash", ["scripts/ci/npm-ci.sh"]);
  const runtime = join(output, "runtime");
  invoke(node, [
    "scripts/desktop/prepare-runtime.mjs",
    "--out",
    runtime,
    "--analytics-receipt",
    join(artifact, "analytics-restore.json"),
    "--cache",
    cache,
    "--runtime-exec",
    join(scratch, "macos/build/Build/Products/Release/OmnesisRuntimeExec"),
  ]);
  invoke(node, ["scripts/desktop/smoke-runtime.mjs", "--runtime", runtime]);
  const version = JSON.parse(
    await readFile(join(source, "packages/core/package.json"), "utf8"),
  ).version;
  const app = join(output, "Omnesis.app");
  invoke(node, [
    "scripts/desktop/assemble-app.mjs",
    "--runtime",
    runtime,
    "--shell-app",
    join(scratch, "macos/build/Build/Products/Release/Omnesis.app"),
    "--out",
    app,
    "--arch",
    architecture,
    "--version",
    version,
  ]);
  invoke(node, [
    "scripts/desktop/smoke-runtime.mjs",
    "--runtime",
    join(app, "Contents/Resources/runtime"),
  ]);
  // This lane qualifies an ephemeral build. Distribution owns any archive;
  // native hosts must not accumulate completed archives on their build disk.
  await qualifyNativePackageEvidence({ artifact, runtime, architecture, version, output, env });
  return artifact;
}

/** A success receipt is published only after the real services child physically joins. */
export async function qualifyNativePackageEvidence(
  { artifact, runtime, architecture, version, output, env },
  qualifyServices = qualifyNativeCompositionServices,
) {
  const analytics = await readAnalyticsRestoreReceipt({ artifact, runtime });
  await qualifyServices({
    runtime,
    artifact: join(artifact, "services"),
    architecture,
    version,
    work: join(output, "services-state"),
    env: { ...env, ...qualificationEnvironment },
  });
  if (
    JSON.stringify(await readAnalyticsRestoreReceipt({ artifact, runtime })) !==
    JSON.stringify(analytics)
  )
    throw new Error("Analytics package evidence changed during services");
  await writeFile(
    join(artifact, "qualification.json"),
    JSON.stringify(
      {
        format: 1,
        scope: "unsigned-release-package",
        architecture,
        nodeVersion: NODE_RUNTIME.version,
        productVersion: version,
        runtimeSmoke: "passed",
        assembledRuntimeSmoke: "passed",
        compositionServicesSmoke: "passed",
        analyticsRestore: "passed",
        analyticsRuntimeManifestSha256: analytics.runtimeManifestSha256,
      },
      null,
      2,
    ) + "\n",
    { flag: "wx", mode: 0o600 },
  );
}

if (isEntryScript(import.meta.url)) {
  const args = parseArguments(process.argv.slice(2), {
    values: ["scratch"],
    required: ["scratch"],
  });
  await buildNativePackage({ scratch: args.get("scratch") });
}
