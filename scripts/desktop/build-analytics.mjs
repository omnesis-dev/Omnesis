#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  acquireAnalyticsSource,
  extractAnalyticsSource,
  privateBuildDirectory,
  readAnalyticsBuildPins,
} from "./analytics-sources.mjs";
import { hashFile, machoArchitectures } from "./native-inventory.mjs";
import { parseArguments } from "./arguments.mjs";
import { isEntryScript } from "../lib/is-entry-script.mjs";
import { collectAnalyticsNotices, validAnalyticsNoticePath } from "./analytics-notices.mjs";

const recipeVersion = 1;
const owner = "omnesis-desktop-analytics-build";
const digest = (value) => createHash("sha256").update(value).digest("hex");

/** Desktop-only static crypto; the normal npm and Docker DuckDB packages are untouched. */
export async function buildDesktopAnalytics(
  {
    architecture = process.arch,
    cache = join(homedir(), ".cache/omnesis-desktop-analytics"),
    sourceCache,
    jobs = 2,
  } = {},
  { run = execFileSync, platform = process.platform } = {},
) {
  if (
    platform !== "darwin" ||
    !["arm64", "x64"].includes(architecture) ||
    architecture !== process.arch ||
    !Number.isInteger(jobs) ||
    jobs < 1 ||
    jobs > 2
  )
    throw new Error("Build desktop analytics on its target Mac with one or two compiler workers");
  cache = resolve(cache);
  await mkdir(cache, { recursive: true, mode: 0o700 });
  await privateBuildDirectory(cache);
  sourceCache = resolve(sourceCache ?? join(cache, "sources"));
  await mkdir(sourceCache, { recursive: true, mode: 0o700 });
  await privateBuildDirectory(sourceCache);
  const pins = await readAnalyticsBuildPins();
  const inspect = (command, args) =>
    String(run(command, args, { encoding: "utf8", maxBuffer: 65_536 })).trim();
  const sdkVersion = inspect("/usr/bin/xcrun", ["--sdk", "macosx", "--show-sdk-version"]);
  if (!/^\d+(?:\.\d+){1,2}$/u.test(sdkVersion)) throw new Error("The macOS SDK version is invalid");
  const sdkRoot = inspect("/usr/bin/xcrun", ["--sdk", "macosx", "--show-sdk-path"]);
  if (!sdkRoot.startsWith("/") || /[\r\n\0]/u.test(sdkRoot))
    throw new Error("The macOS SDK path is invalid");
  const compilerVersion = inspect("/usr/bin/xcrun", ["clang", "--version"]).split("\n")[0];
  if (!compilerVersion.startsWith("Apple clang version "))
    throw new Error("An Apple Clang toolchain is required");
  const recipeSha256 = digest(
    Buffer.concat([
      await readFile(new URL(import.meta.url)),
      await readFile(new URL("./analytics-sources.mjs", import.meta.url)),
      await readFile(new URL("./analytics-notices.mjs", import.meta.url)),
    ]),
  );
  const sourcePinsSha256 = digest(JSON.stringify(pins));
  const identity = {
    recipeVersion,
    architecture,
    sdkVersion,
    compilerVersion,
    recipeSha256,
    sourcePinsSha256,
    duckdbVersion: pins.duckdbVersion,
    minimumMacOS: pins.minimumMacOS,
  };
  const output = join(cache, digest(JSON.stringify(identity)));
  try {
    return await verifyDesktopAnalyticsBuild(output, identity);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  // A fresh private tree prevents concurrent builds from sharing mutable compiler state.
  const work = await realpath(await mkdtemp("/private/tmp/omnesis-analytics-build-"));
  const paths = {};
  let published = false;
  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: homedir(),
    LANG: "C",
    LC_ALL: "C",
    MACOSX_DEPLOYMENT_TARGET: pins.minimumMacOS,
    SDKROOT: sdkRoot,
    CC: "/usr/bin/clang",
    CXX: "/usr/bin/clang++",
  };
  if (process.env.DEVELOPER_DIR) {
    const developer = await realpath(process.env.DEVELOPER_DIR);
    if (/[\r\n\0]/u.test(developer)) throw new Error("The developer toolchain path is invalid");
    env.DEVELOPER_DIR = developer;
  }
  const execute = (command, args, cwd = work) =>
    run(command, args, {
      cwd,
      env,
      stdio: "inherit",
      timeout: 30 * 60 * 1000,
    });
  try {
    const toolArchive = await acquireAnalyticsSource(pins.tools.cmake, sourceCache);
    const toolRoot = join(work, "cmake");
    await extractAnalyticsSource(pins.tools.cmake, toolArchive, toolRoot);
    const cmake = join(toolRoot, "CMake.app/Contents/bin/cmake");
    if (
      inspect(cmake, ["--version"]).split("\n")[0] !==
      "cmake version " + pins.tools.cmake.revision.slice(1)
    )
      throw new Error("The reviewed build tool version does not match its pin");
    for (const [name, pin] of Object.entries(pins.sources)) {
      const archive = await acquireAnalyticsSource(pin, sourceCache);
      paths[name] = join(work, name);
      await extractAnalyticsSource(pin, archive, paths[name]);
    }
    const cpu = architecture === "arm64" ? "arm64" : "x86_64";
    const crypto = join(work, "crypto-prefix"),
      curl = join(work, "curl-prefix");
    const flags = `-O2 -g0 -ffile-prefix-map=${work}=/omnesis-native-build`;
    const common = [
      "-G",
      "Unix Makefiles",
      "-DCMAKE_BUILD_TYPE=Release",
      "-DCMAKE_POSITION_INDEPENDENT_CODE=ON",
      "-DCMAKE_C_COMPILER=/usr/bin/clang",
      "-DCMAKE_CXX_COMPILER=/usr/bin/clang++",
      `-DCMAKE_OSX_SYSROOT=${sdkRoot}`,
      `-DCMAKE_OSX_ARCHITECTURES=${cpu}`,
      `-DCMAKE_OSX_DEPLOYMENT_TARGET=${pins.minimumMacOS}`,
      `-DCMAKE_C_FLAGS=${flags}`,
      `-DCMAKE_CXX_FLAGS=${flags}`,
    ];
    execute(
      "/usr/bin/perl",
      [
        "./Configure",
        architecture === "arm64" ? "darwin64-arm64-cc" : "darwin64-x86_64-cc",
        "no-shared",
        "no-module",
        "no-engine",
        "no-apps",
        "no-tests",
        "no-docs",
        `--prefix=${crypto}`,
        "--libdir=lib",
        "--openssldir=/etc/ssl",
        `-mmacosx-version-min=${pins.minimumMacOS}`,
        "-g0",
        `-ffile-prefix-map=${work}=/omnesis-native-build`,
      ],
      paths.openssl,
    );
    execute("/usr/bin/make", [`-j${jobs}`, "build_sw"], paths.openssl);
    execute("/usr/bin/make", ["install_sw"], paths.openssl);
    const ssl = [
      "-DOPENSSL_USE_STATIC_LIBS=TRUE",
      `-DOPENSSL_ROOT_DIR=${crypto}`,
      `-DOPENSSL_SSL_LIBRARY=${join(crypto, "lib/libssl.a")}`,
      `-DOPENSSL_CRYPTO_LIBRARY=${join(crypto, "lib/libcrypto.a")}`,
      `-DOPENSSL_INCLUDE_DIR=${join(crypto, "include")}`,
    ];
    const curlBuild = join(work, "curl-build");
    execute(cmake, [
      "-S",
      paths.curl,
      "-B",
      curlBuild,
      ...common,
      ...ssl,
      `-DCMAKE_INSTALL_PREFIX=${curl}`,
      "-DBUILD_SHARED_LIBS=OFF",
      "-DBUILD_STATIC_LIBS=ON",
      "-DBUILD_CURL_EXE=OFF",
      "-DBUILD_TESTING=OFF",
      "-DCURL_USE_OPENSSL=ON",
      "-DUSE_APPLE_SECTRUST=ON",
      "-DCURL_CA_BUNDLE=none",
      "-DCURL_CA_PATH=none",
      "-DCURL_ZLIB=OFF",
      "-DCURL_BROTLI=OFF",
      "-DCURL_ZSTD=OFF",
      "-DUSE_NGHTTP2=OFF",
      "-DUSE_LIBIDN2=OFF",
      "-DCURL_USE_LIBPSL=OFF",
      "-DCURL_USE_LIBSSH2=OFF",
      "-DCURL_USE_PKGCONFIG=OFF",
      "-DCURL_DISABLE_LDAP=ON",
      "-DCURL_DISABLE_LDAPS=ON",
    ]);
    execute(cmake, ["--build", curlBuild, "--parallel", String(jobs)]);
    execute(cmake, ["--install", curlBuild]);
    const extensionConfig = join(work, "extensions.cmake");
    await writeFile(
      extensionConfig,
      `duckdb_extension_load(httpfs SOURCE_DIR "${paths.httpfs}" EXTENSION_VERSION "${pins.sources.httpfs.revision}")\n`,
      { mode: 0o600 },
    );
    const databaseBuild = join(work, "duckdb-build");
    execute(cmake, [
      "-S",
      paths.duckdb,
      "-B",
      databaseBuild,
      ...common,
      ...ssl,
      `-DDUCKDB_EXTENSION_CONFIGS=${extensionConfig}`,
      "-DBUILD_UNITTESTS=OFF",
      "-DBUILD_SHELL=OFF",
      "-DNATIVE_ARCH=OFF",
      "-DSET_DUCKDB_LIBRARY_VERSION=OFF",
      "-DENABLE_EXTENSION_AUTOLOADING=OFF",
      "-DENABLE_EXTENSION_AUTOINSTALL=OFF",
      "-DCMAKE_SHARED_LINKER_FLAGS=-framework Security -framework CoreFoundation -framework CoreServices -framework SystemConfiguration",
      `-DOVERRIDE_GIT_DESCRIBE=${pins.duckdbVersion}-0-g${pins.sources.duckdb.revision.slice(0, 10)}`,
      `-DDUCKDB_EXPLICIT_PLATFORM=${architecture === "arm64" ? "osx_arm64" : "osx_amd64"}`,
      `-DCMAKE_PREFIX_PATH=${curl};${crypto}`,
      `-DCURL_INCLUDE_DIR=${join(curl, "include")}`,
      `-DCURL_LIBRARY_RELEASE=${join(curl, "lib/libcurl.a")}`,
      `-DCURL_LIBRARY=${join(curl, "lib/libcurl.a")}`,
    ]);
    execute(cmake, ["--build", databaseBuild, "--target", "duckdb", "--parallel", String(jobs)]);
    const library = join(databaseBuild, "src/libduckdb.dylib");
    if (
      JSON.stringify(machoArchitectures(await readFile(library))) !== JSON.stringify([architecture])
    )
      throw new Error("The compiled analytics library has the wrong architecture");
    execute("/usr/bin/install_name_tool", ["-id", "@rpath/libduckdb.dylib", library]);
    execute("/usr/bin/strip", ["-x", library]);
    execute("/usr/bin/codesign", ["--force", "--sign", "-", library]);
    execute("/usr/bin/codesign", ["--verify", "--strict", library]);
    const linked = inspect("/usr/bin/otool", ["-L", library])
      .split("\n")
      .slice(1)
      .map((line) => line.trim().split(" (", 1)[0]);
    if (
      linked.some(
        (name) =>
          name !== "@rpath/libduckdb.dylib" &&
          !name.startsWith("/usr/lib/") &&
          !name.startsWith("/System/Library/"),
      )
    )
      throw new Error("The compiled analytics library depends on a developer-machine library");
    const staged = join(work, "complete");
    await mkdir(join(staged, "licenses"), { recursive: true, mode: 0o700 });
    await cp(library, join(staged, "libduckdb.dylib"));
    const licenseHashes = await collectAnalyticsNotices(paths, join(staged, "licenses"));
    for (const [name, pin] of Object.entries(pins.sources))
      if (!licenseHashes[`${name}/${pin.license}`])
        throw new Error("An upstream dependency's license is missing");
    const provenance = {
      format: 1,
      owner,
      ...identity,
      duckdbVersion: pins.duckdbVersion,
      minimumMacOS: pins.minimumMacOS,
      librarySha256: await hashFile(join(staged, "libduckdb.dylib")),
      licenseHashes,
    };
    await writeFile(join(staged, "provenance.json"), JSON.stringify(provenance), { mode: 0o600 });
    let claimed = false;
    try {
      await mkdir(output, { mode: 0o700 });
      claimed = true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    if (claimed) {
      await cp(join(staged, "libduckdb.dylib"), join(output, "libduckdb.dylib"));
      await cp(join(staged, "licenses"), join(output, "licenses"), { recursive: true });
      await cp(join(staged, "provenance.json"), join(output, "provenance.json"));
    }
    const result = await verifyDesktopAnalyticsBuild(output, identity);
    published = true;
    return result;
  } catch (error) {
    throw Object.assign(
      new Error(
        "Desktop analytics compilation failed; the owned build tree was retained for diagnosis",
        { cause: error },
      ),
      { buildDirectory: work },
    );
  } finally {
    if (published) await rm(work, { recursive: true, force: true });
  }
}

export async function verifyDesktopAnalyticsBuild(directory, identity) {
  if (
    identity.recipeVersion !== recipeVersion ||
    !["arm64", "x64"].includes(identity.architecture) ||
    !/^\d+(?:\.\d+){1,2}$/u.test(identity.sdkVersion) ||
    typeof identity.compilerVersion !== "string" ||
    !identity.compilerVersion.startsWith("Apple clang version ") ||
    !/^[a-f0-9]{64}$/u.test(identity.recipeSha256) ||
    !/^[a-f0-9]{64}$/u.test(identity.sourcePinsSha256) ||
    !/^v\d+\.\d+\.\d+$/u.test(identity.duckdbVersion) ||
    !/^\d+\.\d+$/u.test(identity.minimumMacOS)
  )
    throw new Error("The expected analytics build identity is incomplete");
  await privateBuildDirectory(directory);
  try {
    const path = join(directory, "provenance.json");
    const info = await lstat(path);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1 ||
      info.size > 16_384 ||
      (info.mode & 0o077) !== 0 ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw new Error("The cached analytics provenance is unsafe");
    const record = JSON.parse(await readFile(path, "utf8"));
    const allowed = [
      "format",
      "owner",
      "recipeVersion",
      "architecture",
      "sdkVersion",
      "compilerVersion",
      "recipeSha256",
      "sourcePinsSha256",
      "duckdbVersion",
      "minimumMacOS",
      "librarySha256",
      "licenseHashes",
    ];
    if (
      !record ||
      typeof record !== "object" ||
      JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(allowed.sort())
    )
      throw new Error("The cached analytics provenance contains unsupported fields");
    const library = join(directory, "libduckdb.dylib"),
      libraryInfo = await lstat(library);
    if (
      !libraryInfo.isFile() ||
      libraryInfo.isSymbolicLink() ||
      libraryInfo.nlink !== 1 ||
      libraryInfo.size > 512 * 1024 ** 2 ||
      (process.getuid && libraryInfo.uid !== process.getuid())
    )
      throw new Error("The cached analytics library is unsafe");
    if (
      record.format !== 1 ||
      record.owner !== owner ||
      Object.entries(identity).some(([name, value]) => record[name] !== value) ||
      !/^[a-f0-9]{64}$/u.test(record.librarySha256) ||
      (await hashFile(library)) !== record.librarySha256 ||
      JSON.stringify(machoArchitectures(await readFile(library))) !==
        JSON.stringify([identity.architecture])
    )
      throw new Error("The cached analytics build failed its integrity check");
    if (
      !record.licenseHashes ||
      typeof record.licenseHashes !== "object" ||
      Object.keys(record.licenseHashes).length < 4 ||
      Object.keys(record.licenseHashes).length > 1024
    )
      throw new Error("The cached analytics notices are incomplete");
    for (const [path, hash] of Object.entries(record.licenseHashes)) {
      if (!validAnalyticsNoticePath(path) || !/^[a-f0-9]{64}$/u.test(hash))
        throw new Error("A cached analytics notice path is unsafe");
      const notice = join(directory, "licenses", path),
        metadata = await lstat(notice);
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        metadata.nlink !== 1 ||
        metadata.size > 2 * 1024 ** 2 ||
        (await realpath(notice)) !== resolve(notice) ||
        (await hashFile(notice)) !== hash
      )
        throw new Error("A cached analytics notice changed");
    }
    return { directory, library: join(directory, "libduckdb.dylib"), provenance: record };
  } catch (error) {
    throw new Error(
      "The cached analytics build is incomplete or changed; inspect this owned cache before retrying",
      { cause: error },
    );
  }
}

if (isEntryScript(import.meta.url)) {
  const args = parseArguments(process.argv.slice(2), {
    values: ["arch", "cache", "sources", "jobs"],
  });
  const result = await buildDesktopAnalytics({
    architecture: args.get("arch") ?? process.arch,
    cache: args.get("cache"),
    sourceCache: args.get("sources"),
    jobs: args.has("jobs") ? Number(args.get("jobs")) : 2,
  });
  process.stdout.write(JSON.stringify(result) + "\n");
}
