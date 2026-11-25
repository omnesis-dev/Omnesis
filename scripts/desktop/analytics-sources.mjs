// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readFile, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const MAX_ARCHIVE_BYTES = 256 * 1024 ** 2;
const sourceNames = ["duckdb", "httpfs", "openssl", "curl"];

export async function readAnalyticsBuildPins() {
  const pins = JSON.parse(
    await readFile(new URL("./analytics-build.json", import.meta.url), "utf8"),
  );
  if (
    pins.format !== 1 ||
    !/^v\d+\.\d+\.\d+$/.test(pins.duckdbVersion) ||
    !/^\d+\.\d+$/.test(pins.minimumMacOS) ||
    JSON.stringify(Object.keys(pins.sources).sort()) !== JSON.stringify([...sourceNames].sort()) ||
    JSON.stringify(Object.keys(pins.tools ?? {})) !== JSON.stringify(["cmake"])
  )
    throw new Error("Desktop analytics source pins are invalid");
  for (const pin of [...Object.values(pins.sources), ...Object.values(pins.tools)]) {
    const url = new URL(pin.url);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      !["codeload.github.com", "github.com", "curl.se"].includes(url.hostname) ||
      !/^[a-f0-9]{64}$/.test(pin.sha256) ||
      !/^[A-Za-z0-9._-]+$/.test(pin.root) ||
      (pin.license !== undefined && !/^[A-Za-z0-9._-]+$/.test(pin.license)) ||
      typeof pin.revision !== "string"
    )
      throw new Error("Desktop analytics source provenance is invalid");
  }
  return pins;
}

export async function privateBuildDirectory(path) {
  const metadata = await lstat(path);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o077) !== 0 ||
    (process.getuid && metadata.uid !== process.getuid()) ||
    (await realpath(path)) !== resolve(path)
  )
    throw new Error("The native build directory must be private, canonical and owned by you");
}

async function hashHandle(file) {
  const before = await file.stat();
  if (
    !before.isFile() ||
    before.nlink !== 1 ||
    before.size > MAX_ARCHIVE_BYTES ||
    (before.mode & 0o077) !== 0 ||
    (process.getuid && before.uid !== process.getuid())
  )
    throw new Error("The native source archive is not a private owned file");
  const hash = createHash("sha256");
  let total = 0;
  const buffer = Buffer.alloc(64 * 1024);
  for (;;) {
    const { bytesRead } = await file.read(buffer, 0, buffer.length, total);
    if (!bytesRead) break;
    total += bytesRead;
    if (total > MAX_ARCHIVE_BYTES) throw new Error("Native source archive exceeds its bound");
    hash.update(buffer.subarray(0, bytesRead));
  }
  const after = await file.stat();
  if (
    total !== before.size ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs
  )
    throw new Error("The native source archive changed while verifying it");
  return hash.digest("hex");
}
async function sourceHash(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    return await hashHandle(file);
  } finally {
    await file.close();
  }
}
async function withVerifiedArchive(pin, archive, work) {
  const file = await open(
    archive,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    if ((await hashHandle(file)) !== pin.sha256)
      throw new Error("Native source changed before extraction");
    return work(file.fd);
  } finally {
    await file.close();
  }
}

/** A complete reviewed archive is authenticated before any source is extracted or executed. */
export async function acquireAnalyticsSource(pin, cache, { fetchSource = fetch, signal } = {}) {
  signal?.throwIfAborted();
  await privateBuildDirectory(cache);
  const target = join(cache, `${pin.sha256}.tar.gz`);
  try {
    if ((await sourceHash(target)) !== pin.sha256)
      throw new Error("Cached native source failed its pinned checksum");
    return target;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const pending = join(cache, `.download-${randomUUID()}`);
  const file = await open(pending, "wx", 0o600);
  try {
    const requestSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(120_000)])
      : AbortSignal.timeout(120_000);
    const response = await fetchSource(pin.url, { signal: requestSignal, redirect: "follow" });
    if (
      !response.ok ||
      !response.body ||
      (response.url && new URL(response.url).protocol !== "https:")
    )
      throw new Error("The reviewed native source could not be downloaded over HTTPS");
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const block of response.body) {
      requestSignal.throwIfAborted();
      bytes += block.length;
      if (bytes > MAX_ARCHIVE_BYTES) throw new Error("Native source download exceeds its bound");
      hash.update(block);
      await file.writeFile(block);
    }
    if (bytes === 0 || hash.digest("hex") !== pin.sha256)
      throw new Error("Native source download failed its pinned checksum");
    await file.sync();
    requestSignal.throwIfAborted();
    await file.close();
    try {
      await link(pending, target);
      await rm(pending);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if ((await sourceHash(target)) !== pin.sha256)
        throw new Error("A concurrent native source cache entry failed its pinned checksum", {
          cause: error,
        });
    }
    return target;
  } finally {
    await file.close().catch(() => {});
    await rm(pending, { force: true });
  }
}

/** Only the reviewed archive root may enter a fresh, private compiler input directory. */
export async function extractAnalyticsSource(pin, archive, destination, run = execFileSync) {
  const listing = await withVerifiedArchive(pin, archive, (fd) =>
    run("tar", ["-tzf", "/dev/fd/3"], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 ** 2,
      stdio: ["ignore", "pipe", "pipe", fd],
    }),
  );
  const names = String(listing).trim().split("\n");
  if (
    names.length > 200_000 ||
    names.some((name) => {
      const parts = name.replace(/\/$/u, "").split("/");
      return (
        parts[0] !== pin.root ||
        /[\r\0\\]/u.test(name) ||
        parts.some((part) => !part || part === "." || part === "..")
      );
    })
  )
    throw new Error("Native source archive contains an unsafe path");
  await mkdir(destination, { mode: 0o700 });
  await privateBuildDirectory(destination);
  await withVerifiedArchive(pin, archive, (fd) =>
    run("tar", ["-xzf", "/dev/fd/3", "-C", destination, "--strip-components=1"], {
      stdio: ["ignore", "inherit", "inherit", fd],
    }),
  );
}
