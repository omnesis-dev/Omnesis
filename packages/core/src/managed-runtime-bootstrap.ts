// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isMainThread } from "node:worker_threads";
import {
  installManagedRuntimeLauncher,
  managedBackgroundExecArgv,
  type ManagedDesktopDataContext,
} from "./node-command.js";

// This is a command-line preload selected by the native lease-exec adapter. Ordinary CLI/source
// entries never import it, so they retain the existing Node and process-launching behavior.
const root = dirname(process.execPath);
const preload = fileURLToPath(import.meta.url);
if (
  !/^[a-f0-9]{64}$/.test(basename(root)) ||
  realpathSync(root) !== resolve(root) ||
  preload !== join(root, "packages/core/dist/managed-runtime-bootstrap.js")
)
  throw new Error("The managed runtime must start from its immutable verified payload");
const descriptor = openSync(
  join(root, "desktop-runtime.json"),
  constants.O_RDONLY | constants.O_NOFOLLOW,
);
let bytes: Buffer;
try {
  const metadata = fstatSync(descriptor);
  if (!metadata.isFile() || metadata.size > 32 * 1024 ** 2)
    throw new Error("The managed runtime inventory is invalid");
  const buffer = Buffer.alloc(32 * 1024 ** 2 + 1);
  const size = readSync(descriptor, buffer, 0, buffer.length, 0);
  if (size > 32 * 1024 ** 2) throw new Error("The managed runtime inventory is too large");
  bytes = buffer.subarray(0, size);
} finally {
  closeSync(descriptor);
}
const manifest: unknown = JSON.parse(bytes.toString("utf8"));
if (
  createHash("sha256").update(bytes).digest("hex") !== basename(root) ||
  typeof manifest !== "object" ||
  manifest === null ||
  !("format" in manifest) ||
  manifest.format !== 1 ||
  !("codeUsageProtocol" in manifest) ||
  manifest.codeUsageProtocol !== 1 ||
  !("runtimeLauncher" in manifest) ||
  manifest.runtimeLauncher !== "runtime-exec"
)
  throw new Error("The managed runtime inventory does not identify this payload");
const launcher = join(root, "runtime-exec"),
  metadata = lstatSync(launcher);
if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o111) === 0)
  throw new Error("The managed runtime lease adapter is unavailable");
let data: ManagedDesktopDataContext | undefined;
const encodedData =
  new URL(import.meta.url).searchParams.get("data") ?? process.env.OMNESIS_DESKTOP_DATA_CONTEXT;
if (encodedData) {
  if (encodedData.length > 16_384) throw new Error("The managed data authority is too large");
  data = JSON.parse(
    Buffer.from(encodedData, "base64url").toString("utf8"),
  ) as ManagedDesktopDataContext;
}
const ownerParams = new URL(import.meta.url).searchParams;
const daemonQuery = ownerParams.get("background-owner");
const retirementQuery = ownerParams.get("background-retirement");
if (daemonQuery !== null && retirementQuery !== null)
  throw new Error("The native background owner hint is ambiguous");
const ownerQuery = daemonQuery ?? retirementQuery;
let backgroundOwner: unknown;
if (ownerQuery !== null) {
  if (ownerQuery.length > 8192 || !/^[A-Za-z0-9_-]+$/u.test(ownerQuery))
    throw new Error("The native background owner hint is invalid");
  try {
    const ownerBytes = Buffer.from(ownerQuery, "base64url");
    if (ownerBytes.length > 4096 || ownerBytes.toString("base64url") !== ownerQuery)
      throw new Error("Invalid native owner bytes");
    backgroundOwner = JSON.parse(ownerBytes.toString("utf8"));
  } catch {
    backgroundOwner = undefined;
  }
  if (backgroundOwner === undefined) throw new Error("The native background owner hint is invalid");
  // fork() and raw Worker defaults inherit execArgv. Only the helper-owned main
  // isolate may capture this hint; descendants use the ordinary fixed preload.
  const ordinary = pathToFileURL(preload).href;
  process.execArgv.splice(
    0,
    process.execArgv.length,
    ...managedBackgroundExecArgv(process.execArgv, import.meta.url, ordinary),
  );
}
installManagedRuntimeLauncher({
  root,
  launcher,
  preload,
  ...(data ? { data } : {}),
  ...(ownerQuery === null || !isMainThread
    ? {}
    : retirementQuery !== null
      ? { backgroundRetirement: backgroundOwner }
      : { backgroundOwner }),
});

// Third-party SDKs commonly spawn process.execPath directly with only stdio 0..2. Publish the
// verified native Node-compatible adapter so those children reserve the epoch before Node loads.
// Worker threads keep this OS process's existing descriptor; each subprocess gets its own lease.
Object.defineProperty(process, "execPath", {
  value: launcher,
  writable: false,
  configurable: false,
});
