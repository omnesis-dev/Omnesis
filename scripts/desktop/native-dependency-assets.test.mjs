// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  access,
  mkdir,
  mkdtemp,
  realpath,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createNativeDependencyFilter } from "./native-dependency-assets.mjs";
import { copyProductionDependencies } from "./runtime-assets.mjs";
import { inventoryBundle } from "./native-inventory.mjs";

const require = createRequire(import.meta.url);
const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const bareHosts = [
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
];
const sqliteHosts = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "linuxmusl-arm64",
  "linuxmusl-x64",
  "win32-arm64",
  "win32-x64",
];
function macho(arch) {
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32BE(0xcffaedfe);
  bytes.writeUInt32LE(arch === "arm64" ? 0x0100000c : 0x01000007, 4);
  return bytes;
}
function universal() {
  const bytes = Buffer.alloc(48);
  bytes.writeUInt32BE(0xcafebabe);
  bytes.writeUInt32BE(2, 4);
  bytes.writeUInt32BE(0x0100000c, 8);
  bytes.writeUInt32BE(0x01000007, 28);
  return bytes;
}
async function put(path, bytes) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
}
async function fixture(name = "bare-buffer", version = "3.7.3", nested = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "omnesis-native-assets-test-")));
  roots.push(root);
  const input = join(root, "input"),
    target = join(root, "output");
  const scope = nested ? "packages/example/node_modules" : "node_modules";
  const key = `${scope}/${name}`,
    directory = join(input, key);
  const layout = name.startsWith("bare-") ? "bare" : name === "usearch" ? "node-gyp" : "sqlite";
  const manifest = {
    name,
    version,
    ...(layout === "bare" ? { addon: true } : {}),
    ...(layout === "node-gyp" ? { dependencies: { "node-gyp-build": "^4.8.4" } } : {}),
  };
  await put(join(directory, "package.json"), JSON.stringify(manifest));
  await put(join(directory, "LICENSE"), "Invented native package license");
  await put(join(directory, "resources/kept.txt"), "Invented required resource");
  const hosts =
    layout === "bare"
      ? bareHosts
      : layout === "sqlite"
        ? sqliteHosts
        : ["darwin-arm64+x64", "linux-arm64", "linux-x64", "win32-x64"];
  const files = new Map();
  for (const host of hosts) {
    const file =
      layout === "sqlite"
        ? `${host}.node`
        : `${host}/${layout === "bare" ? `${name}.bare` : "usearch.node"}`;
    const bytes = host.includes("+")
      ? universal()
      : host.startsWith("darwin-") || host.startsWith("ios-")
        ? macho(host.includes("arm64") ? "arm64" : "x64")
        : Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
    files.set(file, bytes);
    await put(join(directory, "prebuilds", file), bytes);
  }
  await put(join(directory, "prebuilds/NOTICE.txt"), "Invented prebuild notice");
  const lock = { packages: { [key]: { version } } };
  return { root, input, target, scope, key, directory, layout, manifest, files, lock };
}
function copy(f, architecture) {
  copyProductionDependencies(
    join(f.input, f.scope),
    join(f.target, f.scope),
    undefined,
    createNativeDependencyFilter(f.input, f.lock, architecture),
  );
}

test.each([
  ["bare-buffer", "3.7.3"],
  ["bare-fs", "4.8.7"],
  ["bare-path", "3.1.3"],
  ["bare-url", "2.5.8"],
  ["better-sqlite3", "13.1.1"],
  ["better-sqlite3", "13.2.0"],
  ["better-sqlite3-multiple-ciphers", "13.0.3"],
  ["usearch", "2.26.5"],
])(
  "keeps only reviewed Darwin assets for %s@%s in root and nested copies",
  async (name, version) => {
    for (const architecture of ["arm64", "x64"]) {
      const f = await fixture(name, version, architecture === "x64");
      copy(f, architecture);
      const output = join(f.target, f.key);
      const expected = [];
      for (const [file, bytes] of f.files) {
        const host = file.split("/")[0].replace(/\.node$/u, "");
        const retained =
          host.startsWith("darwin-") && host.slice(7).split("+").includes(architecture);
        if (retained) {
          expected.push(host + (f.layout === "sqlite" ? ".node" : ""));
          expect(await readFile(join(output, "prebuilds", file))).toEqual(bytes);
        } else await expect(access(join(output, "prebuilds", file))).rejects.toThrow();
        expect(await readFile(join(f.directory, "prebuilds", file))).toEqual(bytes);
      }
      expect((await readdir(join(output, "prebuilds"))).sort()).toEqual(
        [...expected, "NOTICE.txt"].sort(),
      );
      expect(await readFile(join(output, "LICENSE"), "utf8")).toBe(
        "Invented native package license",
      );
      expect(await readFile(join(output, "resources/kept.txt"), "utf8")).toBe(
        "Invented required resource",
      );
      const inventory = await inventoryBundle(f.target, architecture);
      expect(inventory.some((entry) => entry.architectures?.includes(architecture))).toBe(true);
    }
  },
);

test.each([
  "unknown host",
  "missing target",
  "missing target file",
  "target file alias",
  "wrong manifest",
  "unreviewed version",
  "loader metadata",
  "prebuild alias",
  "variant alias",
  "package alias",
])("refuses %s rather than silently omitting assets", async (mode) => {
  const f = await fixture();
  if (mode === "unknown host")
    await put(join(f.directory, "prebuilds/unknown-arm64/addon.bare"), macho("arm64"));
  if (mode === "missing target")
    await rm(join(f.directory, "prebuilds/darwin-arm64"), { recursive: true });
  if (mode === "missing target file" || mode === "target file alias") {
    const native = join(f.directory, "prebuilds/darwin-arm64/bare-buffer.bare");
    await rm(native);
    if (mode === "target file alias") await symlink("../../darwin-x64/bare-buffer.bare", native);
  }
  if (mode === "wrong manifest")
    await writeFile(
      join(f.directory, "package.json"),
      JSON.stringify({ ...f.manifest, name: "another-package" }),
    );
  if (mode === "unreviewed version") {
    f.lock.packages[f.key].version = "99.0.0";
    await writeFile(
      join(f.directory, "package.json"),
      JSON.stringify({ ...f.manifest, version: "99.0.0" }),
    );
  }
  if (mode === "loader metadata")
    await writeFile(
      join(f.directory, "package.json"),
      JSON.stringify({ ...f.manifest, addon: false }),
    );
  if (mode === "prebuild alias") {
    await rm(join(f.directory, "prebuilds"), { recursive: true });
    await mkdir(join(f.root, "outside"));
    await symlink(join(f.root, "outside"), join(f.directory, "prebuilds"));
  }
  if (mode === "variant alias") {
    await rm(join(f.directory, "prebuilds/linux-x64"), { recursive: true });
    await symlink("darwin-arm64", join(f.directory, "prebuilds/linux-x64"));
  }
  if (mode === "package alias") {
    await rm(f.directory, { recursive: true });
    await mkdir(join(f.root, "outside"));
    await symlink(join(f.root, "outside"), f.directory);
  }
  expect(() => copy(f, "arm64")).toThrow();
});

test("does not filter an ordinary resource with a prebuild-shaped basename outside its package root", async () => {
  const f = await fixture();
  await put(
    join(f.directory, "resources/prebuilds/linux-x64/kept.txt"),
    "Invented non-native resource",
  );
  copy(f, "arm64");
  expect(
    await readFile(join(f.target, f.key, "resources/prebuilds/linux-x64/kept.txt"), "utf8"),
  ).toBe("Invented non-native resource");
});

test.each(["ELF", "wrong architecture", "unrecognized addon"])(
  "strict preflight still rejects %s outside reviewed foreign variants",
  async (kind) => {
    const f = await fixture();
    const bytes =
      kind === "ELF"
        ? Buffer.from([0x7f, 0x45, 0x4c, 0x46])
        : kind === "wrong architecture"
          ? macho("x64")
          : Buffer.from("invented invalid addon");
    await put(join(f.directory, "resources/unexpected.bare"), bytes);
    copy(f, "arm64");
    await expect(inventoryBundle(f.target, "arm64")).rejects.toThrow();
  },
);

test("the actual SQLite loader selects the retained host file without loading native code", async () => {
  const f = await fixture("better-sqlite3", "13.1.1");
  const upstream = join(dirname(require.resolve("better-sqlite3/package.json")), "lib/binding.js");
  await put(join(f.directory, "lib/binding.js"), await readFile(upstream));
  copy(f, "arm64");
  const selected = execFileSync(
    process.execPath,
    [
      "-e",
      `
    Object.defineProperty(process,'platform',{value:'darwin'});
    Object.defineProperty(process,'arch',{value:'arm64'});
    require('module')._extensions['.node']=(module,filename)=>{module.exports=filename};
    process.stdout.write(require(${JSON.stringify(join(f.target, f.key, "lib/binding.js"))}).getBinding());
  `,
    ],
    { encoding: "utf8" },
  );
  expect(selected).toBe(join(f.target, f.key, "prebuilds/darwin-arm64.node"));
});

test("the actual node-gyp resolver selects the retained universal host without loading native code", async () => {
  const f = await fixture("usearch", "2.26.5");
  copy(f, "arm64");
  const selected = execFileSync(
    process.execPath,
    [
      "-e",
      `
    process.stdout.write(require(${JSON.stringify(require.resolve("node-gyp-build"))}).resolve(${JSON.stringify(join(f.target, f.key))}));
  `,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        npm_config_platform: "darwin",
        npm_config_arch: "arm64",
        PREBUILDS_ONLY: "1",
      },
    },
  );
  expect(selected).toBe(join(f.target, f.key, "prebuilds/darwin-arm64+x64/usearch.node"));
});

test("a malformed direct SQLite prebuild cannot stand in for its required .node file", async () => {
  const f = await fixture("better-sqlite3", "13.1.1");
  const path = join(f.directory, "prebuilds/darwin-arm64.node");
  const bytes = await readFile(path);
  await rm(path);
  await put(join(f.directory, "prebuilds/darwin-arm64"), bytes);
  expect(() => copy(f, "arm64")).toThrow("layout changed");
});
