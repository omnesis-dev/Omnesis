// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

export const DESKTOP_ARCHITECTURES = ["arm64", "x64"];
export function desktopReleaseEnabled(value) {
  if (value === undefined || value === "" || value === "0") return false;
  if (value === "1") return true;
  throw new Error("OMNESIS_DESKTOP_RELEASE must be 0 or 1");
}
function exactKeys(value, keys) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === [...keys].sort().join(",")
  );
}
function assertBinding(version, sha) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(version) || !/^[a-f0-9]{40}$/u.test(sha))
    throw new Error("Desktop release needs an exact stable version and source revision");
}
export function desktopArtifactName(version, architecture) {
  assertBinding(version, "a".repeat(40));
  if (!DESKTOP_ARCHITECTURES.includes(architecture))
    throw new Error("Unsupported desktop release architecture");
  return `Omnesis-${version}-macos-${architecture}.dmg`;
}
/** Bounded memory and no links: downloaded workflow artifacts are still untrusted inputs. */
export function inspectReleaseFile(path, maximum = 16 * 1024 ** 3) {
  path = resolve(path);
  if (realpathSync(path) !== path)
    throw new Error("Release artifact must have a canonical owned path");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size <= 0 || before.size > maximum)
      throw new Error("Release artifact must be a bounded regular file");
    const hash = createHash("sha256"),
      chunk = Buffer.alloc(1024 * 1024);
    for (let position = 0; position < before.size;) {
      const count = readSync(
        fd,
        chunk,
        0,
        Math.min(chunk.length, before.size - position),
        position,
      );
      if (!count) throw new Error("Release artifact changed while hashing");
      hash.update(chunk.subarray(0, count));
      position += count;
    }
    const after = fstatSync(fd);
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new Error("Release artifact changed while hashing");
    return { bytes: before.size, sha256: hash.digest("hex") };
  } finally {
    closeSync(fd);
  }
}
function readMetadata(path) {
  if (realpathSync(path) !== resolve(path))
    throw new Error("Release metadata path is not canonical");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || info.size < 1 || info.size > 8192)
      throw new Error("Invalid release metadata file");
    const bytes = Buffer.alloc(info.size + 1);
    const count = readSync(fd, bytes, 0, bytes.length, 0);
    if (count !== info.size) throw new Error("Release metadata changed while reading");
    return JSON.parse(bytes.subarray(0, count).toString("utf8"));
  } finally {
    closeSync(fd);
  }
}
export function writeDesktopReleasePolicy(directory, { enabled, version, sha }) {
  assertBinding(version, sha);
  if (typeof enabled !== "boolean") throw new Error("Invalid desktop release policy");
  const policy = { format: 1, enabled, version, sha };
  writeFileSync(join(directory, "desktop-release.json"), `${JSON.stringify(policy)}\n`, {
    flag: "wx",
  });
  return policy;
}
export function readDesktopReleasePolicy(directory) {
  let policy;
  try {
    policy = readMetadata(join(directory, "desktop-release.json"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (
    !exactKeys(policy, ["format", "enabled", "version", "sha"]) ||
    policy.format !== 1 ||
    typeof policy.enabled !== "boolean"
  )
    throw new Error("Invalid desktop release policy");
  assertBinding(policy.version, policy.sha);
  return policy;
}
export function writeDesktopArtifact(directory, { version, sha, architecture, notarized }) {
  assertBinding(version, sha);
  if (notarized !== true) throw new Error("Release desktop installer must be notarized");
  const name = desktopArtifactName(version, architecture);
  const artifact = {
    format: 1,
    version,
    sha,
    architecture,
    name,
    ...inspectReleaseFile(join(directory, name)),
    notarized: true,
  };
  writeFileSync(join(directory, "manifest.json"), `${JSON.stringify(artifact)}\n`, { flag: "wx" });
  return artifact;
}
export function desktopReleaseArtifacts(directory, expected) {
  const policy = readDesktopReleasePolicy(directory);
  if (!policy) return [];
  if (policy.sha !== expected.sha || policy.version !== expected.version)
    throw new Error("Desktop release policy belongs to another revision or version");
  if (!policy.enabled) return [];
  return DESKTOP_ARCHITECTURES.map((architecture) => {
    const base = join(directory, "desktop", architecture);
    const artifact = readMetadata(join(base, "manifest.json"));
    const name = desktopArtifactName(policy.version, architecture);
    if (readdirSync(base).sort().join(",") !== [name, "manifest.json"].sort().join(","))
      throw new Error("Unexpected desktop artifact files");
    if (
      !exactKeys(artifact, [
        "format",
        "version",
        "sha",
        "architecture",
        "name",
        "bytes",
        "sha256",
        "notarized",
      ]) ||
      artifact.format !== 1 ||
      artifact.version !== policy.version ||
      artifact.sha !== policy.sha ||
      artifact.architecture !== architecture ||
      artifact.name !== name ||
      artifact.notarized !== true ||
      !/^[a-f0-9]{64}$/u.test(artifact.sha256)
    )
      throw new Error("Desktop artifact does not match its release binding");
    const path = join(base, name),
      actual = inspectReleaseFile(path);
    if (actual.bytes !== artifact.bytes || actual.sha256 !== artifact.sha256)
      throw new Error("Desktop installer checksum or size differs from its release manifest");
    return { ...artifact, path };
  });
}
/** GitHub supplies its own digest only after an asset is uploaded. Never substitute a sidecar. */
export function assertUploadedReleaseAssets(release, expected) {
  if (!Array.isArray(release.assets) || release.assets.length !== expected.length)
    throw new Error("Release attachment set is incomplete or unexpected");
  for (const item of expected) {
    const matches = release.assets.filter((asset) => asset.name === item.name);
    if (
      matches.length !== 1 ||
      matches[0].state !== "uploaded" ||
      matches[0].size !== item.bytes ||
      matches[0].digest !== `sha256:${item.sha256}`
    )
      throw new Error("GitHub release asset digest, size or upload state is unverified");
  }
}

if (import.meta.main) {
  const [command, directory] = process.argv.slice(2);
  if (command !== "policy" || !directory || process.argv.length !== 4)
    throw new Error("Usage: desktop-artifacts.mjs policy <directory>");
  writeDesktopReleasePolicy(directory, {
    enabled: desktopReleaseEnabled(process.env.OMNESIS_DESKTOP_RELEASE),
    version: (process.env.RELEASE_TAG ?? "").replace(/^v/u, ""),
    sha: process.env.RELEASE_SHA,
  });
}
