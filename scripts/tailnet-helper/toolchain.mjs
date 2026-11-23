// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The Go toolchain the Tailscale helper is built with. A Go already installed
 * is used when it is at least the version packages/tailnet-helper/go.mod
 * names. Otherwise the official archive for this platform is downloaded from
 * go.dev, checked against the SHA-256 recorded in go-toolchain.json (the one
 * go.dev publishes), and unpacked into the checkout's own cache, where later
 * builds and updates find it. The helper's Go modules come through the Go
 * module proxy and are checked against go.sum as any Go build checks them.
 *
 * Everything lives under one directory of the checkout (`packages/tailnet-
 * helper/dist/go`, ignored by Git): the toolchain, the module cache and the build
 * cache, so a checkout removed on uninstall takes them with it.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const GO_DOWNLOADS = "https://go.dev/dl";

/** Node's names for an architecture, as Go names it in its archives. */
const GO_ARCH = {
  x64: "amd64",
  arm64: "arm64",
  arm: "armv6l",
  ia32: "386",
  riscv64: "riscv64",
  s390x: "s390x",
  loong64: "loong64",
  ppc64: "ppc64le",
};

/** Go's names for the operating systems a source install runs on. */
const GO_OS = { linux: "linux", darwin: "darwin", win32: "windows" };

/** The archive key (`linux-amd64`) for a Node platform and architecture, or null. */
export function goArchiveKey(platform = process.platform, arch = process.arch) {
  const goOs = GO_OS[platform];
  const goArch = GO_ARCH[arch];
  return goOs && goArch ? `${goOs}-${goArch}` : null;
}

/** The file go.dev publishes for an archive key: a .zip for Windows, a .tar.gz elsewhere. */
export function goArchiveFile(version, key) {
  return `go${version}.${key}.${key.startsWith("windows-") ? "zip" : "tar.gz"}`;
}

/** `[major, minor, patch]` from `1.27.4` or `go version go1.27.4 linux/amd64`, or null. */
export function parseGoVersion(text) {
  const match = /(?:^|go)(\d+)\.(\d+)(?:\.(\d+))?/u.exec(String(text).trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] : null;
}

/** Whether version `have` is `want` or newer. */
export function atLeast(have, want) {
  for (let i = 0; i < 3; i++) {
    if (have[i] !== want[i]) return have[i] > want[i];
  }
  return true;
}

/** The Go version a module's go.mod requires, from its `go` line. */
export function requiredGoVersion(goMod) {
  const match = /^go\s+(\d+\.\d+(?:\.\d+)?)\s*$/mu.exec(goMod);
  if (!match) throw new Error("go.mod has no go line");
  return match[1];
}

/** The `go` on PATH when it is at least `required`, else null. */
export function installedGo(required, run = spawnSync) {
  const result = run("go", ["version"], { encoding: "utf8" });
  if (result.error || result.status !== 0) return null;
  const have = parseGoVersion(result.stdout);
  const want = parseGoVersion(required);
  return have && want && atLeast(have, want) ? "go" : null;
}

/** The environment a build runs Go with: its caches in `cacheDir`, nothing fetched but modules. */
export function goEnv(cacheDir) {
  return {
    GOPATH: join(cacheDir, "path"),
    GOCACHE: join(cacheDir, "build"),
    // Module files stay writable, so removing the checkout removes them too.
    GOFLAGS: "-modcacherw",
    // The toolchain chosen here builds; Go must not fetch another one itself.
    GOTOOLCHAIN: "local",
    CGO_ENABLED: "0",
  };
}

async function sha256Of(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

/** Fetch `url` into `file` with curl, which honours the machine's proxy settings, or Node's fetch. */
export async function downloadFile(url, file, run = spawnSync) {
  const curl = run("curl", ["-fsSL", "--retry", "3", "--connect-timeout", "30", "-o", file, url], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  if (!curl.error) {
    if (curl.status !== 0)
      throw new Error(`downloading ${url} failed (curl exited ${curl.status})`);
    return;
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`downloading ${url} failed (HTTP ${response.status})`);
  writeFileSync(file, Buffer.from(await response.arrayBuffer()));
}

/**
 * The `go` binary of the pinned toolchain under `cacheDir`, downloaded and checked first
 * when it is not there yet. Toolchains of other versions there are removed.
 */
export async function pinnedGo({
  cacheDir,
  toolchain,
  key = goArchiveKey(),
  download = downloadFile,
  log = () => {},
}) {
  const name = `go${toolchain.version}`;
  const home = join(cacheDir, "toolchains", name);
  const go = join(home, "bin", key?.startsWith("windows-") ? "go.exe" : "go");
  if (existsSync(join(home, ".complete"))) return go;
  const archive = key ? toolchain.archives[key] : undefined;
  if (!archive)
    throw new Error(
      `no Go ${toolchain.version} download is known for this platform (${key ?? `${process.platform}/${process.arch}`}); install Go ${toolchain.version} or newer`,
    );
  const file = goArchiveFile(toolchain.version, key);
  const work = join(cacheDir, "toolchains", `.${name}-${process.pid}`);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  try {
    log(
      `Downloading Go ${toolchain.version} (${Math.round(archive.size / 1e6)} MB) to build the Tailscale helper...`,
    );
    const downloaded = join(work, file);
    await download(`${GO_DOWNLOADS}/${file}`, downloaded);
    const digest = await sha256Of(downloaded);
    if (digest !== archive.sha256)
      throw new Error(
        `${file} does not match its published SHA-256 (got ${digest}); nothing was unpacked`,
      );
    // GNU tar and bsdtar both detect the compression; Windows' own tar also reads a .zip.
    // On Windows it is named by path: a GNU tar earlier on PATH, such as Git's, reads
    // `C:\...` as a remote host.
    const tar =
      process.platform === "win32"
        ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
        : "tar";
    const unpacked = spawnSync(tar, ["-xf", downloaded, "-C", work], { stdio: "inherit" });
    if (unpacked.error || unpacked.status !== 0) throw new Error(`could not unpack ${file}`);
    writeFileSync(join(work, "go", ".complete"), `${digest}\n`);
    // Another build may have finished the same toolchain meanwhile, and may be using it.
    if (existsSync(join(home, ".complete"))) return go;
    rmSync(home, { recursive: true, force: true });
    renameSync(join(work, "go"), home);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  for (const entry of readdirSync(join(cacheDir, "toolchains"))) {
    if (entry !== name && entry.startsWith("go"))
      rmSync(join(cacheDir, "toolchains", entry), { recursive: true, force: true });
  }
  return go;
}
