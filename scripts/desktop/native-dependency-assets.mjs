// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

// These pinned loaders select one host tuple, not arbitrary files by extension.
const reviewed = new Map([
  ["bare-buffer", { versions: ["3.7.3"], layout: "bare" }],
  ["bare-fs", { versions: ["4.8.7"], layout: "bare" }],
  ["bare-path", { versions: ["3.1.3"], layout: "bare" }],
  ["bare-url", { versions: ["2.5.8"], layout: "bare" }],
  ["better-sqlite3", { versions: ["13.1.1", "13.2.0"], layout: "sqlite" }],
  ["better-sqlite3-multiple-ciphers", { versions: ["13.0.3"], layout: "sqlite" }],
  ["usearch", { versions: ["2.26.5"], layout: "node-gyp" }],
]);
const bareHosts = new Set([
  "android-arm",
  "android-arm64",
  "android-ia32",
  "android-x64",
  "darwin-arm64",
  "darwin-x64",
  "ios-arm64",
  "ios-arm64-simulator",
  "ios-x64-simulator",
  "linux-arm64",
  "linux-x64",
  "win32-arm64",
  "win32-x64",
]);
const sqliteHosts = new Set([
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "linuxmusl-arm64",
  "linuxmusl-x64",
  "win32-arm64",
  "win32-x64",
]);
const nodeGypHosts = new Set([
  "darwin-arm64+x64",
  "darwin-x64+arm64",
  "linux-arm64",
  "linux-x64",
  "win32-x64",
]);
const notices = /^(?:LICENSE|NOTICE)(?:\.txt)?$|^README\.md$/u;

/** Copy only host variants chosen by the reviewed, lock-bound dependency loaders. */
export function createNativeDependencyFilter(inputRoot, lock, architecture) {
  if (!["arm64", "x64"].includes(architecture))
    throw new Error("The desktop native dependency architecture is invalid");
  const packages = new Map();
  for (const [path, record] of Object.entries(lock.packages)) {
    if (record.link === true || !path.includes("node_modules/")) continue;
    const name = path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
    const policy = reviewed.get(name);
    if (policy) packages.set(resolve(inputRoot, path), { name, version: record.version, policy });
  }
  const excluded = new Set();
  const validated = new Set();
  return (path) => {
    path = resolve(path);
    const record = packages.get(path);
    if (record && !validated.has(path)) {
      const info = lstatSync(path);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error("The desktop native dependency package cannot be an alias");
      const manifestPath = join(path, "package.json");
      const manifestInfo = lstatSync(manifestPath);
      if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink())
        throw new Error("The desktop native dependency manifest cannot be an alias");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (
        manifest.name !== record.name ||
        manifest.version !== record.version ||
        !record.policy.versions.includes(record.version)
      )
        throw new Error("The desktop native dependency does not match its reviewed lock version");
      if (
        (record.policy.layout === "bare" && manifest.addon !== true) ||
        (record.policy.layout === "node-gyp" && !manifest.dependencies?.["node-gyp-build"])
      )
        throw new Error("The desktop native dependency loader metadata changed");
      const prebuilds = join(path, "prebuilds");
      const prebuildInfo = lstatSync(prebuilds);
      if (!prebuildInfo.isDirectory() || prebuildInfo.isSymbolicLink())
        throw new Error("The desktop native dependency prebuilds cannot be an alias");
      let targetFound = false;
      for (const child of readdirSync(prebuilds, { withFileTypes: true })) {
        const childPath = join(prebuilds, child.name);
        if (child.isFile() && notices.test(child.name)) continue;
        const direct = record.policy.layout === "sqlite";
        const host = direct && child.name.endsWith(".node") ? child.name.slice(0, -5) : child.name;
        const hosts = direct
          ? sqliteHosts
          : record.policy.layout === "bare"
            ? bareHosts
            : nodeGypHosts;
        if (
          !hosts.has(host) ||
          (direct && !child.name.endsWith(".node")) ||
          (direct ? !child.isFile() : !child.isDirectory()) ||
          child.isSymbolicLink()
        )
          throw new Error("The desktop native dependency prebuild layout changed");
        const [platform, cpus] = host.split("-");
        if (platform === "darwin" && cpus.split("+").includes(architecture)) {
          const nativePath = direct
            ? childPath
            : join(
                childPath,
                record.policy.layout === "bare" ? `${record.name}.bare` : "usearch.node",
              );
          const nativeInfo = lstatSync(nativePath);
          if (!nativeInfo.isFile() || nativeInfo.isSymbolicLink())
            throw new Error("The desktop native dependency target is not a regular file");
          targetFound = true;
        } else excluded.add(childPath);
      }
      if (!targetFound) throw new Error("The desktop native dependency has no target prebuild");
      validated.add(path);
    }
    return !excluded.has(path);
  };
}
