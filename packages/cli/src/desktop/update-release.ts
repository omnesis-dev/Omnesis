// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { gt, valid } from "semver";
import { z } from "zod";

const RELEASE_API = "https://api.github.com/repos/omnesis-dev/Omnesis/releases/latest";
const RELEASE_PREFIX = "https://github.com/omnesis-dev/Omnesis/releases/download/";
const MAX_ARTIFACT_BYTES = 16 * 1024 ** 3;
const releaseSchema = z.object({
  draft: z.literal(false),
  prerelease: z.literal(false),
  tag_name: z.string(),
  assets: z
    .array(
      z.object({
        name: z.string(),
        size: z.number().int().positive().max(MAX_ARTIFACT_BYTES),
        digest: z.string().nullable().optional(),
        browser_download_url: z.string().url(),
      }),
    )
    .max(256),
});
export interface DesktopUpdateRelease {
  version: string;
  architecture: "arm64" | "x64";
  bytes: number;
  sha256: string;
  url: string;
}

/** Discovery affects availability only. Native app signature assessment remains mandatory after download. */
export function parseDesktopUpdateRelease(
  value: unknown,
  currentVersion: string,
  architecture: "arm64" | "x64",
): DesktopUpdateRelease | null {
  const release = releaseSchema.parse(value);
  const version = release.tag_name.replace(/^v/, "");
  if (!valid(currentVersion) || !/^\d+\.\d+\.\d+$/.test(version) || !valid(version))
    throw new Error("The desktop update version is invalid");
  if (!gt(version, currentVersion)) return null;
  const name = `Omnesis-${version}-macos-${architecture}.dmg`;
  const assets = release.assets.filter((asset) => asset.name === name);
  if (assets.length !== 1) throw new Error("This release has no unique installer for this Mac");
  const asset = assets[0]!;
  if (!asset.digest || !/^sha256:[a-f0-9]{64}$/.test(asset.digest))
    throw new Error("The selected desktop installer has no SHA-256 digest");
  const expected = `${RELEASE_PREFIX}v${version}/${name}`;
  if (asset.browser_download_url !== expected)
    throw new Error("The desktop installer must come from the official release");
  return { version, architecture, bytes: asset.size, sha256: asset.digest.slice(7), url: expected };
}

export async function discoverDesktopUpdate(
  currentVersion: string,
  architecture: "arm64" | "x64",
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<DesktopUpdateRelease | null> {
  const response = await fetcher(RELEASE_API, {
    redirect: "error",
    headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("The desktop update service is unavailable");
  }
  const parts: Uint8Array[] = [];
  let bytes = 0;
  if (!response.body) throw new Error("The desktop update response is empty");
  const reader = response.body.getReader();
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 2 * 1024 * 1024) throw new Error("The desktop update response is too large");
      parts.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return parseDesktopUpdateRelease(
    JSON.parse(Buffer.concat(parts).toString("utf8")),
    currentVersion,
    architecture,
  );
}

/** Only official GitHub release redirects are followed; callers cannot supply a production update feed. */
async function artifactResponse(
  release: DesktopUpdateRelease,
  signal: AbortSignal,
  fetcher: typeof fetch,
) {
  const name = `Omnesis-${release.version}-macos-${release.architecture}.dmg`;
  if (
    !/^\d+\.\d+\.\d+$/.test(release.version) ||
    !valid(release.version) ||
    !["arm64", "x64"].includes(release.architecture) ||
    !/^[a-f0-9]{64}$/.test(release.sha256) ||
    !Number.isSafeInteger(release.bytes) ||
    release.bytes < 1 ||
    release.bytes > MAX_ARTIFACT_BYTES ||
    release.url !== `${RELEASE_PREFIX}v${release.version}/${name}`
  )
    throw new Error("Invalid desktop installer descriptor");
  let next = release.url;
  for (let redirects = 0; redirects < 6; redirects++) {
    signal.throwIfAborted();
    const response = await fetcher(next, { redirect: "manual", signal });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location) throw new Error("Invalid desktop installer redirect");
    const target = new URL(location, next);
    if (
      target.protocol !== "https:" ||
      target.username ||
      target.password ||
      target.port ||
      ![
        "github.com",
        "release-assets.githubusercontent.com",
        "objects.githubusercontent.com",
      ].includes(target.hostname)
    )
      throw new Error("The desktop installer redirected outside its official host");
    next = target.href;
  }
  throw new Error("Too many desktop installer redirects");
}

/** A downloaded DMG is inert until the native adapter authenticates the mounted app and its metadata. */
export async function downloadDesktopUpdate(
  release: DesktopUpdateRelease,
  directory: string,
  signal: AbortSignal,
  dependencies: {
    fetch?: typeof fetch;
    progress?(bytes: number, total: number): void | Promise<void>;
  } = {},
): Promise<string> {
  const metadata = await lstat(directory);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o077) !== 0 ||
    (process.getuid && metadata.uid !== process.getuid()) ||
    (await realpath(directory)) !== resolve(directory)
  )
    throw new Error("The desktop update folder must be private and owned by you");
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(30 * 60_000)]);
  const response = await artifactResponse(release, deadline, dependencies.fetch ?? fetch);
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error("The desktop installer could not be downloaded");
  }
  const temporary = join(directory, `.download-${randomUUID()}`);
  const target = join(directory, `${release.sha256}.dmg`);
  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    await response.body.cancel().catch(() => {});
    throw error;
  }
  const reader = response.body.getReader();
  let bytes = 0;
  const hash = createHash("sha256");
  try {
    for (;;) {
      deadline.throwIfAborted();
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > release.bytes) throw new Error("The desktop installer exceeds its declared size");
      hash.update(part.value);
      await file.writeFile(part.value);
      await dependencies.progress?.(bytes, release.bytes);
    }
    if (bytes !== release.bytes || hash.digest("hex") !== release.sha256)
      throw new Error("The desktop installer failed its integrity check");
    deadline.throwIfAborted();
    await file.sync();
    await file.close();
    await rename(temporary, target);
    return target;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
    await file.close().catch(() => {});
    await rm(temporary, { force: true });
  }
}
