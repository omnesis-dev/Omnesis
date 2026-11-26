// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { constants } from "node:fs";
import { cp, lstat, mkdir, open, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createHash, X509Certificate } from "node:crypto";
import { builtinModules, createRequire } from "node:module";
import { dirname, join, relative, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { inventoryBundle, machoArchitectures } from "./native-inventory.mjs";
import { NODE_RUNTIME } from "./node-runtime.mjs";
import { prepareNativeCompositionFixture } from "./prepare-native-composition-fixture.mjs";
import { parseCompositionResource } from "../../macos/Tests/Composition/desktop-native-entry.mjs";
import { QA_SERVICE_MANIFEST_MAX_BYTES } from "../../macos/Tests/Composition/desktop-service-entry.mjs";

// Matches DesktopCore RuntimeUsageLease.validatedManifest; module reads remain 1 MiB.
const RUNTIME_MANIFEST_MAX_BYTES = 32 * 1024 * 1024;

const require = createRequire(import.meta.url);
const ts = require("typescript");
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const graph = Object.freeze([
  "scripts/desktop/native-composition-world.ts",
  "packages/collector/src/e2e/fixture-pki.ts",
  "packages/collector/src/e2e/desktop-account-dns.ts",
  "packages/cloud-relay/test/acme-authority.ts",
  "packages/cloud-relay/test/support.ts",
  "packages/cloud-relay/test/loopback-peers.ts",
]);
const copies = Object.freeze([
  "scripts/desktop/fixture-openssl.mjs",
  "macos/Tests/Composition/desktop-service-entry.mjs",
]);
const externals = new Set(["@omnesis/core", "@omnesis/cloud-relay/runtime", "jose", "ws"]);
const productionAdapters = Object.freeze([
  "packages/cloud-relay/dist/accounts.js",
  "packages/cloud-relay/dist/identity.js",
  "packages/cloud-relay/dist/server.js",
  "packages/cloud-relay/dist/tunnel-client.js",
  "packages/cloud-relay/dist/client-proxy.js",
]);
function inside(root, path) {
  const value = relative(root, path);
  return value === "" || (!value.startsWith("../") && value !== ".." && !isAbsolute(value));
}
async function directory(path, privateMode = false) {
  if (typeof process.getuid !== "function") throw new Error("QA services require POSIX ownership");
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid() ||
    info.mode & (privateMode ? 0o077 : 0o022) ||
    (await realpath(path)) !== resolve(path)
  )
    throw new Error("Unsafe QA service directory");
}
class CompositionInputValidationFailure extends Error {
  constructor(reason, info, bound) {
    super(
      reason === "changed"
        ? "QA service input changed"
        : reason === "read-bound"
          ? "QA service input exceeds read bound"
          : "Invalid QA service input",
    );
    const observed = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);
    this.validation = Object.freeze({
      reason,
      type: info.isFile() ? "regular" : info.isDirectory() ? "directory" : "other",
      linkCount: observed(info.nlink),
      byteCount: observed(info.size),
      readBound: bound,
    });
  }
}

/** Only our own fixed guard observations become public diagnostic fields. */
export function compositionInputFailureMetadata(error) {
  return error instanceof CompositionInputValidationFailure ? error.validation : null;
}

export async function readCompositionInput(path, bound = 1024 * 1024, openFile = open) {
  if (!Number.isSafeInteger(bound) || bound < 0 || bound > 128 * 1024 * 1024)
    throw new Error("Invalid QA read bound");
  const handle = await openFile(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new CompositionInputValidationFailure("not-regular", before, bound);
    if (before.nlink !== 1)
      throw new CompositionInputValidationFailure("multiple-links", before, bound);
    if (before.size > bound) throw new CompositionInputValidationFailure("oversize", before, bound);
    const buffer = Buffer.alloc(Math.min(bound + 1, before.size + 1));
    let used = 0;
    while (used < buffer.length) {
      const result = await handle.read(buffer, used, buffer.length - used, used);
      if (!result.bytesRead) break;
      used += result.bytesRead;
    }
    if (used > bound) throw new CompositionInputValidationFailure("read-bound", before, bound);
    const bytes = buffer.subarray(0, used);
    const after = await handle.stat(),
      published = await lstat(path);
    if (
      bytes.length !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      published.dev !== before.dev ||
      published.ino !== before.ino
    )
      throw new CompositionInputValidationFailure("changed", after, bound);
    return bytes;
  } finally {
    await handle.close();
  }
}
const file = readCompositionInput;
function imports(source, name) {
  const tree = ts.createSourceFile(
    name,
    source,
    ts.ScriptTarget.ESNext,
    true,
    name.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS,
  );
  if (tree.parseDiagnostics.length) throw new Error("Invalid QA source syntax");
  const values = [];
  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.importClause?.isTypeOnly) return;
      if (node.moduleSpecifier) {
        if (!ts.isStringLiteral(node.moduleSpecifier)) throw new Error("Invalid QA module import");
        values.push(node.moduleSpecifier.text);
      }
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      if (node.arguments.length !== 1 || !ts.isStringLiteral(node.arguments[0]))
        throw new Error("QA closure forbids computed module imports");
      values.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return values;
}
async function verifyModule(root, name, specifier) {
  if (specifier.startsWith("node:")) {
    if (!builtinModules.includes(specifier.slice(5))) throw new Error("Unknown QA builtin");
    return;
  }
  if (!specifier.startsWith(".")) {
    if (!externals.has(specifier)) throw new Error("QA closure requires an undeclared package");
    const target = await realpath(createRequire(join(root, name)).resolve(specifier));
    if (!inside(join(root, "runtime"), target))
      throw new Error("QA package escapes prepared runtime");
    await file(target);
    return;
  }
  const target = resolve(dirname(join(root, name)), specifier);
  if (!inside(root, target)) throw new Error("QA module escapes its artifact");
  const resolved = await realpath(target);
  if (!inside(root, resolved) || !/\.(?:js|mjs)$/u.test(resolved))
    throw new Error("QA module depends on source or an external path");
  await file(resolved);
}

/** Compiles ONLY fixed QA modules; copies the already built production runtime byte-for-byte. */
export async function prepareNativeCompositionServices({ runtime, output, architecture, version }) {
  runtime = resolve(runtime);
  output = resolve(output);
  await directory(runtime);
  await directory(dirname(output), true);
  if (inside(runtime, output) || inside(output, runtime))
    throw new Error("QA service output overlaps input");
  const manifestBytes = await file(
    join(runtime, "desktop-runtime.json"),
    RUNTIME_MANIFEST_MAX_BYTES,
  );
  const runtimeManifest = JSON.parse(manifestBytes);
  if (
    runtimeManifest.format !== 1 ||
    runtimeManifest.codeUsageProtocol !== 1 ||
    runtimeManifest.dataUsageProtocol !== 1 ||
    runtimeManifest.runtimeLauncher !== "runtime-exec" ||
    runtimeManifest.architecture !== architecture ||
    runtimeManifest.productVersion !== version ||
    runtimeManifest.nodeVersion !== NODE_RUNTIME.version ||
    runtimeManifest.processAuthorityProtocol !== 3
  )
    throw new Error("QA services require the exact prepared runtime");
  const before = await inventoryBundle(runtime, architecture);
  if (
    JSON.stringify(before.filter((item) => item.path !== "desktop-runtime.json")) !==
    JSON.stringify(runtimeManifest.inventory)
  )
    throw new Error("Prepared runtime inventory differs");
  for (const name of ["node", "runtime-exec"]) {
    const bytes = await file(join(runtime, name), 128 * 1024 * 1024);
    if (
      !machoArchitectures(bytes)?.includes(architecture) ||
      !((await lstat(join(runtime, name))).mode & 0o111)
    )
      throw new Error("QA runtime requires real target executables");
  }
  await file(join(runtime, "bin/node"));
  for (const path of productionAdapters) await file(join(runtime, path));
  const lockBytes = await file(join(repo, "package-lock.json"), 8 * 1024 * 1024);
  const lock = JSON.parse(lockBytes);
  await mkdir(output, { mode: 0o700 });
  const owned = await lstat(output);
  try {
    await cp(runtime, join(output, "runtime"), { recursive: true, verbatimSymlinks: true });
    const copiedRuntime = join(output, "runtime");
    const accounts = join(copiedRuntime, "packages/cloud-relay/dist/accounts.js");
    const consumer = createRequire(accounts);
    const expectedLockKey = (consumer.resolve.paths("better-sqlite3") ?? [])
      .filter((path) => inside(copiedRuntime, path))
      .map((path) => relative(copiedRuntime, join(path, "better-sqlite3")).split("\\").join("/"))
      .find((key) => Object.hasOwn(lock.packages, key));
    const sqliteManifest = await realpath(consumer.resolve("better-sqlite3/package.json"));
    if (!inside(copiedRuntime, sqliteManifest))
      throw new Error("Relay SQLite escapes its copied runtime");
    const sqliteRoot = dirname(sqliteManifest);
    const lockKey = relative(copiedRuntime, sqliteRoot).split("\\").join("/");
    if (!expectedLockKey || lockKey !== expectedLockKey)
      throw new Error("Relay SQLite differs from the lock's first consumer lookup location");
    const sqlitePackage = JSON.parse(await file(sqliteManifest));
    if (
      !lock.packages[lockKey] ||
      sqlitePackage.name !== "better-sqlite3" ||
      sqlitePackage.version !== lock.packages[lockKey].version
    )
      throw new Error("Relay SQLite differs from its exact workspace lock record");
    const binding = await realpath(
      createRequire(sqliteManifest).resolve("./build/Release/better_sqlite3.node"),
    );
    if (!inside(sqliteRoot, binding)) throw new Error("Relay SQLite binding escapes its package");
    const bindingBytes = await file(binding, 64 * 1024 * 1024);
    if (!machoArchitectures(bindingBytes)?.includes(architecture))
      throw new Error("Relay SQLite binding architecture differs");
    const sqlite = {
      package: relative(copiedRuntime, sqliteManifest),
      lockKey,
      version: sqlitePackage.version,
      binding: relative(copiedRuntime, binding),
      sha256: sha(bindingBytes),
    };

    const service = join(output, "service");
    await mkdir(service, { mode: 0o700 });
    await writeFile(join(service, "package.json"), '{"type":"module"}\n', { mode: 0o600 });
    const sources = [];
    for (const source of [...graph, ...copies]) {
      const input = join(repo, source);
      if ((await realpath(input)) !== input) throw new Error("QA source is aliased");
      const bytes = await file(input);
      const target = source.endsWith(".ts") ? source.slice(0, -3) + ".js" : source;
      const result = source.endsWith(".ts")
        ? ts.transpileModule(bytes.toString(), {
            fileName: source,
            compilerOptions: {
              target: ts.ScriptTarget.ESNext,
              module: ts.ModuleKind.ESNext,
              sourceMap: false,
              declaration: false,
            },
            reportDiagnostics: true,
          })
        : { outputText: bytes.toString(), diagnostics: [] };
      if (result.diagnostics?.some((item) => item.category === ts.DiagnosticCategory.Error))
        throw new Error("QA module compilation refused");
      await mkdir(dirname(join(service, target)), { recursive: true, mode: 0o700 });
      await writeFile(join(service, target), result.outputText, { mode: 0o600 });
      sources.push({ source, sha256: sha(bytes), target, outputSha256: sha(result.outputText) });
    }
    await symlink("../runtime/node_modules", join(service, "node_modules"));
    await mkdir(join(service, "packages/cloud-relay"), { recursive: true });
    await symlink(
      "../../../runtime/packages/cloud-relay/dist",
      join(service, "packages/cloud-relay/src"),
    );
    for (const source of sources)
      for (const specifier of imports(
        String(await file(join(service, source.target))),
        source.target,
      ))
        await verifyModule(output, "service/" + source.target, specifier);
    const copied = await inventoryBundle(join(output, "runtime"), architecture);
    if (
      JSON.stringify(copied) !== JSON.stringify(before) ||
      JSON.stringify(await inventoryBundle(runtime, architecture)) !== JSON.stringify(before)
    )
      throw new Error("QA service runtime changed during materialization");
    for (const source of sources)
      if (sha(await file(join(repo, source.source))) !== source.sha256)
        throw new Error("QA source changed during materialization");
    const inventory = await inventoryBundle(output, architecture);
    const manifest = {
      format: 1,
      kind: "unsigned-native-qa-services",
      architecture,
      version,
      nodeVersion: NODE_RUNTIME.version,
      compiler: {
        kind: "typescript.transpileModule",
        version: ts.version,
        sourceLockSha256: sha(lockBytes),
      },
      sqlite,
      runtimeManifestSha256: sha(manifestBytes),
      sources,
      entry: "service/macos/Tests/Composition/desktop-service-entry.mjs",
      crypto: { executable: "/usr/bin/openssl", required: ["req.addext", "x509.extfile"] },
      inventory,
    };
    const bytes = JSON.stringify(manifest) + "\n";
    if (Buffer.byteLength(bytes) > QA_SERVICE_MANIFEST_MAX_BYTES)
      throw new Error("QA service manifest exceeds its read contract");
    await writeFile(join(output, "qa-services.json"), bytes, { mode: 0o600 });
    return { artifact: output, manifestSha256: sha(bytes), scope: "unsigned-services-only" };
  } catch (error) {
    const current = await lstat(output).catch(() => null);
    if (current?.dev === owned.dev && current.ino === owned.ino && !current.isSymbolicLink())
      await rm(output, { recursive: true, force: true });
    throw error;
  }
}

/** No plaintext service receipt is native authority: this produces only another unsigned Debug fixture. */
export async function prepareNativeCompositionApplication({
  serviceArtifact,
  publicReadyReceipt,
  shellApp,
  output,
}) {
  serviceArtifact = resolve(serviceArtifact);
  await directory(serviceArtifact, true);
  const bytes = await file(
    join(serviceArtifact, "qa-services.json"),
    QA_SERVICE_MANIFEST_MAX_BYTES,
  );
  const manifest = JSON.parse(bytes),
    receipt = publicReadyReceipt;
  if (
    manifest.kind !== "unsigned-native-qa-services" ||
    receipt?.format !== 1 ||
    receipt.kind !== "native-qa-services-ready" ||
    receipt.artifactSha256 !== sha(bytes) ||
    Object.keys(receipt).sort().join() !==
      ["format", "kind", "artifactSha256", "resource", "ca", "relayCa", "systemOpenSsl"]
        .sort()
        .join()
  )
    throw new Error("QA service receipt does not match its artifact");
  const inventory = (await inventoryBundle(serviceArtifact, manifest.architecture)).filter(
    (item) => item.path !== "qa-services.json",
  );
  if (JSON.stringify(inventory) !== JSON.stringify(manifest.inventory))
    throw new Error("QA service artifact changed");
  const resource = parseCompositionResource(receipt.resource);
  for (const ca of [receipt.ca, receipt.relayCa])
    if (typeof ca !== "string" || Buffer.byteLength(ca) > 65536 || !new X509Certificate(ca).ca)
      throw new Error("Invalid public QA CA receipt");
  const crypto = receipt.systemOpenSsl;
  if (
    !crypto ||
    Object.keys(crypto).sort().join() !==
      ["executable", "sha256", "version", "reqAddext", "x509Extfile"].sort().join() ||
    crypto.executable !== "/usr/bin/openssl" ||
    !/^[a-f0-9]{64}$/u.test(crypto.sha256) ||
    typeof crypto.version !== "string" ||
    crypto.version.length > 120 ||
    /[\r\n]/u.test(crypto.version) ||
    !/^(?:LibreSSL|OpenSSL) /u.test(crypto.version) ||
    crypto.reqAddext !== true ||
    crypto.x509Extfile !== true
  )
    throw new Error("QA system crypto has not been observed");
  if (inside(serviceArtifact, resolve(output)))
    throw new Error("QA application must not mutate service artifact");
  return prepareNativeCompositionFixture({
    runtime: join(serviceArtifact, "runtime"),
    shellApp,
    output,
    architecture: manifest.architecture,
    version: manifest.version,
    resource,
    ca: receipt.ca,
  });
}
