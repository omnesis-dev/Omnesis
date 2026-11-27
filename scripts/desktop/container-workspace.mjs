// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  constants,
  closeSync,
  fstatSync,
  globSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

if (
  !process.env.OMNESIS_DESKTOP_ACCOUNT_CONTAINER_NONCE ||
  !process.env.OMNESIS_ACCOUNT_DEPENDENCIES
)
  throw new Error("The isolated account container is required");
const root = realpathSync(resolve("."));
const dependencies = realpathSync(process.env.OMNESIS_ACCOUNT_DEPENDENCIES);
const modules = join(root, "node_modules");
const manifest = JSON.parse(readRegular(join(root, "package.json"), 1024 * 1024));
const workspaces = manifest.workspaces.flatMap((pattern) => [...globSync(pattern)]);
const local = new Map();
for (const workspace of workspaces) {
  const path = realpathSync(join(root, workspace));
  if (!within(root, path)) throw new Error("Unsafe copied workspace");
  const value = JSON.parse(readRegular(join(path, "package.json"), 1024 * 1024));
  if (value.name?.startsWith("@omnesis/") || value.name === "omnesis")
    local.set(value.name, { path, manifest: value });
}
mkdirSync(modules);
for (const entry of readdirSync(dependencies)) {
  if (entry === "@omnesis" || entry === "omnesis" || entry === ".bin") continue;
  symlinkSync(join(dependencies, entry), join(modules, entry));
}
mkdirSync(join(modules, "@omnesis"));
for (const [name, value] of local) symlinkSync(value.path, join(modules, name));
mkdirSync(join(modules, ".bin"));
const donorBin = join(dependencies, ".bin");
if (lstatSync(donorBin, { throwIfNoEntry: false }))
  for (const name of readdirSync(donorBin)) {
    if (name !== "omnesis") symlinkSync(join(donorBin, name), join(modules, ".bin", name));
  }
const cli = local.get("omnesis");
if (cli) {
  const bin = typeof cli.manifest.bin === "string" ? cli.manifest.bin : cli.manifest.bin?.omnesis;
  if (typeof bin !== "string" || !within(cli.path, resolve(cli.path, bin)))
    throw new Error("Unsafe copied CLI entry");
  const entry = realpathSync(join(cli.path, bin));
  if (!within(cli.path, entry)) throw new Error("Unsafe copied CLI entry");
  symlinkSync(entry, join(modules, ".bin/omnesis"));
}

// Nested packages must live in the copied workspace: linking into /input would
// make their own imports walk the donor's node_modules and workspace aliases.
const input = process.env.OMNESIS_ACCOUNT_INPUT_ROOT;
if (input) materializeNested(realpathSync(input));

function within(parent, path) {
  const suffix = relative(parent, path);
  return (
    suffix === "" || (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(".." + sep))
  );
}

function signature(info) {
  return [info.dev, info.ino, info.mode, info.size, info.mtimeMs, info.ctimeMs].join(":");
}

function readRegular(path, bound) {
  const reader = openSync(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const info = fstatSync(reader);
    if (!info.isFile() || info.size > bound)
      throw new Error("Unsafe container dependency metadata");
    const bytes = Buffer.alloc(info.size + 1);
    let used = 0;
    while (used < bytes.length) {
      const count = readSync(reader, bytes, used, bytes.length - used, null);
      if (count === 0) break;
      used += count;
    }
    if (
      used !== info.size ||
      signature(fstatSync(reader)) !== signature(info) ||
      signature(lstatSync(path)) !== signature(info)
    )
      throw new Error("Container dependency metadata changed");
    return bytes.subarray(0, used);
  } finally {
    closeSync(reader);
  }
}

function payloadPath(source) {
  try {
    return realpathSync(source);
  } catch {
    throw new Error("Nested container dependency is dangling");
  }
}

function materializeNested(inputRoot) {
  const lockBytes = readRegular(join(root, "package-lock.json"), 16 * 1024 * 1024);
  if (
    !lockBytes.equals(readRegular(join(inputRoot, "package-lock.json"), 16 * 1024 * 1024)) ||
    !readRegular(join(root, "package.json"), 1024 * 1024).equals(
      readRegular(join(inputRoot, "package.json"), 1024 * 1024),
    )
  )
    throw new Error("Account container source and dependency lock differ");
  const lock = JSON.parse(lockBytes);
  const plans = [];
  for (const workspace of workspaces) {
    if (
      !readRegular(join(root, workspace, "package.json"), 1024 * 1024).equals(
        readRegular(join(inputRoot, workspace, "package.json"), 1024 * 1024),
      )
    )
      throw new Error("Account container workspace manifest differs");
    const prefix = workspace.split(sep).join("/") + "/node_modules/";
    for (const [key, record] of Object.entries(lock.packages)) {
      if (!key.startsWith(prefix)) continue;
      const name = key.slice(prefix.length);
      if (
        !/^(@[^/]+\/)?[^/]+$/.test(name) ||
        name.split("/").some((part) => part === "." || part === "..")
      )
        throw new Error("Unsupported nested container lock placement");
      if (record.link) {
        if (!local.has(name)) throw new Error("Unknown nested workspace link");
        continue;
      }
      if (local.has(name)) throw new Error("Nested dependency shadows a local workspace");
      const source = join(inputRoot, key);
      if (!lstatSync(source, { throwIfNoEntry: false })) {
        if (record.optional === true) continue;
        throw new Error("Required nested container dependency is missing");
      }
      const payload = payloadPath(source);
      if (!within(inputRoot, payload) && !within(dependencies, payload))
        throw new Error("Unsafe nested container dependency");
      const metadata = JSON.parse(readRegular(join(payload, "package.json"), 1024 * 1024));
      if (metadata.name !== name || metadata.version !== record.version)
        throw new Error("Nested container dependency differs from lock");
      plans.push({ source: payload, target: join(root, key), workspace });
    }
  }
  if (plans.length > 4096) throw new Error("Nested container dependency count exceeds bound");
  const payloadRoots = [dependencies, ...plans.map((plan) => plan.source)];
  let entries = 0,
    bytes = 0;
  const copy = (source, target, parents, owner) => {
    if (++entries > 100000) throw new Error("Nested container dependency file count exceeds bound");
    const actual = payloadPath(source);
    if (!payloadRoots.some((parent) => within(parent, actual)))
      throw new Error("Nested container dependency escapes its payload");
    const info = lstatSync(actual);
    if (lstatSync(source).isSymbolicLink()) {
      if (parents.has(actual)) throw new Error("Cyclic nested container dependency");
      // The same donor can occupy more than one lock placement. Its internal
      // links must remain in THIS copy, where sibling versions belong to its caller.
      const contextual = plans.filter(
        (plan) => plan.workspace === owner.workspace && within(plan.source, actual),
      );
      const matching = plans.filter((plan) => within(plan.source, actual));
      const location = within(owner.source, actual)
        ? owner
        : contextual.length === 1
          ? contextual[0]
          : within(dependencies, actual)
            ? undefined
            : matching.length === 1
              ? matching[0]
              : null;
      if (location === null) throw new Error("Ambiguous nested container dependency link");
      const relocated = location
        ? join(location.target, relative(location.source, actual))
        : join(modules, relative(dependencies, actual));
      if (!info.isFile() && !info.isDirectory())
        throw new Error("Unsafe nested container dependency link");
      symlinkSync(relocated, target, info.isDirectory() ? "dir" : "file");
      return;
    }
    if (info.isDirectory()) {
      if (parents.has(actual)) throw new Error("Cyclic nested container dependency");
      mkdirSync(target, { mode: 0o700 });
      const directory = opendirSync(actual);
      const next = new Set([...parents, actual]);
      try {
        for (let child; (child = directory.readSync());)
          copy(join(actual, child.name), join(target, child.name), next, owner);
      } finally {
        directory.closeSync();
      }
      return;
    }
    if (!info.isFile() || bytes + info.size > 512 * 1024 * 1024)
      throw new Error("Unsafe or oversized nested container dependency");
    bytes += info.size;
    const reader = openSync(
      actual,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    try {
      if (signature(fstatSync(reader)) !== signature(info))
        throw new Error("Nested container dependency changed");
      const writer = openSync(
        target,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        info.mode & 0o777,
      );
      try {
        const buffer = Buffer.alloc(65536);
        let remaining = info.size;
        while (remaining > 0) {
          const count = readSync(reader, buffer, 0, Math.min(buffer.length, remaining), null);
          if (count === 0) throw new Error("Nested container dependency was truncated");
          for (let offset = 0; offset < count;) {
            const written = writeSync(writer, buffer, offset, count - offset);
            if (written <= 0) throw new Error("Nested container dependency copy made no progress");
            offset += written;
          }
          remaining -= count;
        }
        if (
          readSync(reader, buffer, 0, 1, null) !== 0 ||
          signature(fstatSync(reader)) !== signature(info) ||
          signature(lstatSync(actual)) !== signature(info)
        )
          throw new Error("Nested container dependency changed");
      } finally {
        closeSync(writer);
      }
    } finally {
      closeSync(reader);
    }
  };
  for (const plan of plans) {
    mkdirSync(dirname(plan.target), { recursive: true });
    copy(plan.source, plan.target, new Set(), plan);
  }
}
