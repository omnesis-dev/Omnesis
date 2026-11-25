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
import { fileURLToPath } from "node:url";
import { installManagedRuntimeLauncher } from "./node-command.js";

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
installManagedRuntimeLauncher({ root, launcher, preload });

// Third-party SDKs commonly spawn process.execPath directly with only stdio 0..2. Publish the
// verified native Node-compatible adapter so those children reserve the epoch before Node loads.
// Worker threads keep this OS process's existing descriptor; each subprocess gets its own lease.
Object.defineProperty(process, "execPath", {
  value: launcher,
  writable: false,
  configurable: false,
});
