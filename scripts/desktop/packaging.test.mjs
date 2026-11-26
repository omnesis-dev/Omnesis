// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { stagePinnedDuckDbExtensions } from "./pinned-extensions.mjs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { assembleApp, appPlist } from "./assemble-app.mjs";
import { inventoryBundle, machoArchitectures } from "./native-inventory.mjs";
import {
  acquireNodeArchive,
  extractNodeArchive,
  nodeArchiveSpec,
  NODE_RUNTIME,
} from "./node-runtime.mjs";

const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function temporary() {
  const root = await mkdtemp(join(tmpdir(), "omnesis-desktop-package-test-"));
  roots.push(root);
  return root;
}
async function put(root, path, body) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), body);
}
function thin(architecture) {
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32BE(0xcffaedfe, 0);
  bytes.writeUInt32LE(architecture === "arm64" ? 0x0100000c : 0x01000007, 4);
  return bytes;
}
async function inputs() {
  const root = await temporary();
  const runtime = join(root, "runtime");
  await put(runtime, "node", thin("arm64"));
  await put(runtime, "runtime-exec", thin("arm64"));
  await put(runtime, "bin/node", '#!/bin/sh\nexec runtime-exec --node "$@"\n');
  await put(runtime, "npm", '#!/bin/sh\nexec runtime-exec --node npm-cli.js "$@"\n');
  await put(runtime, "npx", '#!/bin/sh\nexec runtime-exec --node npx-cli.js "$@"\n');
  for (const path of ["node", "runtime-exec", "bin/node", "npm", "npx"])
    await chmod(join(runtime, path), 0o755);
  await put(runtime, "packages/cli/dist/index.js", 'export const desktop = "bridge";');
  await put(runtime, "packages/gateway/portal/index.html", "<html>Omnesis</html>");
  await put(runtime, "packages/core/package.json", '{"name":"@omnesis/core","type":"module"}');
  await put(runtime, "packages/core/dist/worker.js", "export {};\n");
  await put(runtime, "node_modules/native/binding.node", thin("arm64"));
  await mkdir(join(runtime, "node_modules/@omnesis"), { recursive: true });
  await symlink("../../packages/core", join(runtime, "node_modules/@omnesis/core"));
  await put(runtime, "NODE_LICENSE", "Node license fixture");
  await put(runtime, "LICENSE", "Application license fixture");
  const executable = join(root, "Omnesis");
  await writeFile(executable, thin("arm64"));
  const manifest = {
    format: 1,
    architecture: "arm64",
    nodeVersion: NODE_RUNTIME.version,
    codeUsageProtocol: 1,
    dataUsageProtocol: 1,
    processAuthorityProtocol: 3,
    runtimeLauncher: "runtime-exec",
    productVersion: "0.7.8",
    inventory: await inventoryBundle(runtime, "arm64"),
  };
  await put(runtime, "desktop-runtime.json", JSON.stringify(manifest));
  return {
    root,
    runtime,
    executable,
    output: join(root, "Omnesis.app"),
    architecture: "arm64",
    version: "0.7.8",
  };
}

describe("native architecture inventory", () => {
  test("reads thin and universal architecture headers", () => {
    expect(machoArchitectures(thin("arm64"))).toEqual(["arm64"]);
    expect(machoArchitectures(thin("x64"))).toEqual(["x64"]);
    const fat = Buffer.alloc(48);
    fat.writeUInt32BE(0xcafebabe, 0);
    fat.writeUInt32BE(2, 4);
    fat.writeUInt32BE(0x0100000c, 8);
    fat.writeUInt32BE(0x01000007, 28);
    expect(machoArchitectures(fat)).toEqual(["arm64", "x64"]);
    expect(() => machoArchitectures(fat.subarray(0, 20))).toThrow(/architecture table/);
  });

  test("refuses a native module for another architecture", async () => {
    const root = await temporary();
    await put(root, "binding.node", thin("x64"));
    await expect(inventoryBundle(root, "arm64")).rejects.toThrow(/Wrong native architecture/);
  });

  test("refuses ELF native code instead of silently shipping a Linux build", async () => {
    const root = await temporary();
    await put(root, "native-helper", Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0, 0]));
    await expect(inventoryBundle(root, "arm64")).rejects.toThrow(/ELF/);
  });

  test("inventories a target Mach-O bundle even when its native module suffix is .so", async () => {
    const root = await temporary();
    const bytes = thin("arm64");
    bytes.writeUInt32BE(8, 12);
    await put(root, "native-module.so", bytes);
    const entries = await inventoryBundle(root, "arm64");
    expect(entries).toEqual([
      expect.objectContaining({
        path: "native-module.so",
        architectures: ["arm64"],
        bytes: bytes.length,
      }),
    ]);
  });

  test.each([
    ["ELF", Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0, 0]), /ELF/],
    ["wrong architecture", thin("x64"), /Wrong native architecture/],
    ["unrecognized bytes", Buffer.from("invented non-native module"), /Non-macOS native module/],
    [
      "unknown CPU",
      (() => {
        const bytes = thin("arm64");
        bytes.writeUInt32BE(0x0100000d, 4);
        return bytes;
      })(),
      /Wrong native architecture/,
    ],
  ])("refuses a .so containing %s", async (_label, bytes, error) => {
    const root = await temporary();
    await put(root, "native-module.so", bytes);
    await expect(inventoryBundle(root, "arm64")).rejects.toThrow(error);
  });

  test("refuses unrecognized target .bare bytes rather than treating an addon as data", async () => {
    const root = await temporary();
    await put(root, "prebuilds/darwin-arm64/addon.bare", "invented invalid addon");
    await expect(inventoryBundle(root, "arm64")).rejects.toThrow(/Non-macOS native module/);
  });

  test("native .so links cannot escape the bundle or dangle", async () => {
    const root = await temporary();
    await mkdir(join(root, "bundle"));
    await put(root, "outside.so", thin("arm64"));
    await symlink("../outside.so", join(root, "bundle/module.so"));
    await expect(inventoryBundle(join(root, "bundle"), "arm64")).rejects.toThrow(/escapes/);
    await rm(join(root, "bundle/module.so"));
    await symlink("missing.so", join(root, "bundle/module.so"));
    await expect(inventoryBundle(join(root, "bundle"), "arm64")).rejects.toThrow();
  });

  test("refuses escaping and dangling symlinks", async () => {
    const root = await temporary();
    await mkdir(join(root, "bundle"));
    await put(root, "outside", "private build material");
    await symlink("../outside", join(root, "bundle/escape"));
    await expect(inventoryBundle(join(root, "bundle"), "arm64")).rejects.toThrow(/escapes/);
    await rm(join(root, "bundle/escape"));
    await symlink("missing", join(root, "bundle/dangling"));
    await expect(inventoryBundle(join(root, "bundle"), "arm64")).rejects.toThrow();
  });
});

describe("app assembly", () => {
  test("copies a self-contained runtime closure and preserves relative workspace links", async () => {
    const options = await inputs();
    await assembleApp(options);
    await rm(options.runtime, { recursive: true, force: true });
    const bundled = join(options.output, "Contents/Resources/runtime");
    await expect(
      access(join(bundled, "node_modules/@omnesis/core/dist/worker.js")),
    ).resolves.toBeUndefined();
    expect(await readFile(join(bundled, "packages/cli/dist/index.js"), "utf8")).toContain("bridge");
    expect(await readFile(join(options.output, "Contents/Info.plist"), "utf8")).toContain(
      "dev.omnesis.desktop",
    );
    const inventory = await inventoryBundle(options.output, "arm64");
    expect(
      inventory.some(
        (item) => item.path.endsWith("binding.node") && item.architectures.includes("arm64"),
      ),
    ).toBe(true);
    expect(JSON.stringify(inventory)).not.toContain(options.root);
  });

  test("refuses stale runtime contents before creating an app", async () => {
    const options = await inputs();
    await put(options.runtime, "packages/cli/dist/index.js", "modified after inventory");
    await expect(assembleApp(options)).rejects.toThrow(/differ from their build inventory/);
    await expect(access(options.output)).rejects.toThrow();
  });

  test("refuses older process ownership protocols before creating an app", async () => {
    for (const protocol of [undefined, 1, 2, 4]) {
      const options = await inputs();
      const manifest = JSON.parse(
        await readFile(join(options.runtime, "desktop-runtime.json"), "utf8"),
      );
      manifest.processAuthorityProtocol = protocol;
      await put(options.runtime, "desktop-runtime.json", JSON.stringify(manifest));
      await expect(assembleApp(options)).rejects.toThrow(/does not match/);
      await expect(access(options.output)).rejects.toThrow();
    }
  });

  test("refuses skewed product versions and an existing output", async () => {
    const options = await inputs();
    await expect(assembleApp({ ...options, version: "0.8.0" })).rejects.toThrow(/does not match/);
    await mkdir(options.output);
    await put(options.output, "keep", "existing app");
    await expect(assembleApp(options)).rejects.toThrow();
    expect(await readFile(join(options.output, "keep"), "utf8")).toBe("existing app");
  });

  test("version interpolation cannot inject plist markup", () => {
    expect(() => appPlist("1.2.3</string>")).toThrow(/Invalid product version/);
  });
});

describe("pinned Node runtime", () => {
  test("uses exact official per-architecture artifacts", () => {
    expect(nodeArchiveSpec("arm64").url).toBe(
      "https://nodejs.org/download/release/v24.21.0/node-v24.21.0-darwin-arm64.tar.gz",
    );
    expect(nodeArchiveSpec("arm64").sha256).not.toBe(nodeArchiveSpec("x64").sha256);
    expect(() => nodeArchiveSpec("linux")).toThrow(/Unsupported/);
  });

  test("rejects corrupt downloads before publishing a cache entry", async () => {
    const cache = await temporary();
    await expect(
      acquireNodeArchive("arm64", cache, async () => new Response("bad archive")),
    ).rejects.toThrow(/checksum mismatch/);
    await expect(access(join(cache, nodeArchiveSpec("arm64").filename))).rejects.toThrow();
  });

  test("never extracts an archive whose checksum differs from its pin", async () => {
    const root = await temporary();
    await put(root, "bad.tar.gz", "untrusted");
    const run = vi.fn();
    await expect(
      extractNodeArchive(join(root, "bad.tar.gz"), "arm64", join(root, "unpacked"), run),
    ).rejects.toThrow(/checksum mismatch/);
    expect(run).not.toHaveBeenCalled();
    await expect(access(join(root, "unpacked"))).rejects.toThrow();
  });
});

describe("bundled runtime tools", () => {
  test("keeps production dependencies relocatable and omits source-only bin links", async () => {
    const { copyProductionDependencies } = await import("./runtime-assets.mjs");
    const root = await temporary();
    await put(root, "input/pkg/index.js", "export {};\n");
    await mkdir(join(root, "input/.bin"));
    await symlink("../../packages/cli/src/index.ts", join(root, "input/.bin/omnesis"));
    copyProductionDependencies(join(root, "input"), join(root, "output"));
    await expect(access(join(root, "output/pkg/index.js"))).resolves.toBeUndefined();
    await expect(access(join(root, "output/.bin"))).rejects.toThrow();
  });

  async function workspaceFixture() {
    const { localRuntimeClosure } = await import("../runtime/stage-runtime.mjs");
    const { createRuntimeDependencyPlan } = await import("./runtime-assets.mjs");
    const root = await temporary();
    const input = join(root, "input");
    const target = join(root, "output");
    const lock = JSON.parse(
      await readFile(new URL("../../package-lock.json", import.meta.url), "utf8"),
    );
    const entries = localRuntimeClosure(["omnesis"]);
    const plan = createRuntimeDependencyPlan(input, entries, lock);
    for (const record of plan.links.values()) {
      const alias = join(input, record.path);
      await mkdir(dirname(alias), { recursive: true });
      await symlink(relative(dirname(alias), join(input, record.directory)), alias);
    }
    for (const entry of entries) {
      await put(
        target,
        `${entry.dir}/package.json`,
        JSON.stringify({ name: entry.pkg.name, type: "module", exports: "./index.js" }),
      );
      await put(
        target,
        `${entry.dir}/index.js`,
        `export default ${JSON.stringify(entry.pkg.name)};`,
      );
    }
    return { root, input, target, entries, plan, lock };
  }

  test("copies every current runtime alias while omitting only exact non-runtime workspace links", async () => {
    const { copyProductionDependencies, assertRuntimeDependencyLinks } =
      await import("./runtime-assets.mjs");
    const { execFileSync } = await import("node:child_process");
    const f = await workspaceFixture();
    expect(f.plan.links.size).toBe(
      Object.values(f.lock.packages).filter((record) => record.link === true).length,
    );
    expect(f.entries.length).toBeGreaterThan(0);
    expect([...f.plan.links.values()].some((record) => !record.selected)).toBe(true);
    await put(
      f.input,
      "node_modules/third-party/node_modules/@omnesis/extension/index.js",
      "// ordinary third-party file",
    );
    await put(
      f.input,
      "packages/cli/node_modules/nested-dependency/index.js",
      "// nested dependency",
    );
    copyProductionDependencies(
      join(f.input, "node_modules"),
      join(f.target, "node_modules"),
      f.plan,
    );
    copyProductionDependencies(
      join(f.input, "packages/cli/node_modules"),
      join(f.target, "packages/cli/node_modules"),
      f.plan,
    );
    assertRuntimeDependencyLinks(f.target, f.plan);
    for (const record of f.plan.links.values()) {
      const alias = join(f.target, record.path);
      if (record.selected)
        expect(await realpath(alias)).toBe(await realpath(join(f.target, record.directory)));
      else await expect(access(alias)).rejects.toThrow();
    }
    expect(
      await readFile(
        join(f.target, "node_modules/third-party/node_modules/@omnesis/extension/index.js"),
        "utf8",
      ),
    ).toContain("ordinary third-party");
    await expect(
      access(join(f.target, "packages/cli/node_modules/nested-dependency/index.js")),
    ).resolves.toBeUndefined();
    const relocated = join(f.root, "relocated");
    await rename(f.target, relocated);
    assertRuntimeDependencyLinks(relocated, f.plan);
    expect(
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          'import value from "@omnesis/core";process.stdout.write(value)',
        ],
        { cwd: relocated, encoding: "utf8" },
      ),
    ).toBe("@omnesis/core");
  });

  test.each(["wrong target", "regular file"])(
    "does not omit a non-runtime workspace slot containing a %s",
    async (kind) => {
      const { copyProductionDependencies } = await import("./runtime-assets.mjs");
      const f = await workspaceFixture();
      const outside = [...f.plan.links.values()].find((record) => !record.selected);
      const alias = join(f.input, outside.path);
      await rm(alias);
      if (kind === "wrong target") await symlink("../../wrong-target", alias);
      else await writeFile(alias, "not a workspace alias");
      expect(() =>
        copyProductionDependencies(
          join(f.input, "node_modules"),
          join(f.target, "node_modules"),
          f.plan,
        ),
      ).toThrow("does not match its lock");
    },
  );

  test("a runtime dependency on an excluded private workspace fails before copying", async () => {
    const { createRuntimeDependencyPlan } = await import("./runtime-assets.mjs");
    const f = await workspaceFixture();
    const outside = [...f.plan.links.values()].find((record) => !record.selected);
    const name = f.lock.packages[outside.directory].name;
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      const entries = f.entries.map((entry, index) =>
        index === 0
          ? { ...entry, pkg: { ...entry.pkg, [field]: { ...entry.pkg[field], [name]: "*" } } }
          : entry,
      );
      expect(() => createRuntimeDependencyPlan(f.input, entries, f.lock)).toThrow(
        "missing from the runtime closure",
      );
    }
  });

  test.each(["missing selected", "dangling third-party", "escaping third-party"])(
    "link preflight rejects %s",
    async (kind) => {
      const { copyProductionDependencies, assertRuntimeDependencyLinks } =
        await import("./runtime-assets.mjs");
      const f = await workspaceFixture();
      copyProductionDependencies(
        join(f.input, "node_modules"),
        join(f.target, "node_modules"),
        f.plan,
      );
      if (kind === "missing selected")
        await rm(join(f.target, "node_modules", f.entries[0].pkg.name));
      else
        await symlink(
          kind === "dangling third-party" ? "missing-target" : "../../input",
          join(f.target, "node_modules/unknown-alias"),
        );
      expect(() => assertRuntimeDependencyLinks(f.target, f.plan)).toThrow();
    },
  );

  test("npm, npx and env-node enter the bundled lease launcher with an empty host PATH", async () => {
    const { copyNodeTools } = await import("./runtime-assets.mjs");
    const { execFileSync } = await import("node:child_process");
    const root = await temporary();
    const distribution = join(root, "distribution");
    const target = join(root, "runtime with spaces");
    await put(distribution, "bin/node", '#!/bin/sh\nprintf "%s\\n" "$@"\n');
    await put(distribution, "lib/node_modules/npm/bin/npm-cli.js", "// npm fixture\n");
    await put(distribution, "LICENSE", "Node license fixture");
    await put(target, "runtime-exec", '#!/bin/sh\nprintf "%s\\n" "$@"\n');
    await chmod(join(target, "runtime-exec"), 0o755);
    copyNodeTools(distribution, target);
    const result = execFileSync(join(target, "npm"), ["--version"], {
      encoding: "utf8",
      env: { PATH: "" },
    });
    expect(result.trim().split("\n")).toEqual([
      "--node",
      join(target, "lib/node_modules/npm/bin/npm-cli.js"),
      "--version",
    ]);
    expect(
      execFileSync(join(target, "bin/node"), ["--version"], { encoding: "utf8", env: { PATH: "" } })
        .trim()
        .split("\n"),
    ).toEqual(["--node", "--version"]);
    expect(
      execFileSync(join(target, "bin/npx"), ["--version"], { encoding: "utf8", env: { PATH: "" } })
        .trim()
        .split("\n"),
    ).toEqual(["--node", join(target, "lib/node_modules/npm/bin/npx-cli.js"), "--version"]);
  });
});

describe("prebuilt native shell integration", () => {
  test("preserves the background LoginItems helper and native privacy metadata", async () => {
    const options = await inputs();
    const shellApp = join(options.root, "shell/Omnesis.app");
    await put(shellApp, "Contents/MacOS/Omnesis", thin("arm64"));
    const plist = appPlist(options.version).replace(
      "</dict></plist>",
      "<key>NSContactsUsageDescription</key><string>Import your contacts</string></dict></plist>",
    );
    await put(shellApp, "Contents/Info.plist", plist);
    await put(
      shellApp,
      "Contents/Library/LoginItems/OmnesisBackground.app/Contents/MacOS/OmnesisBackground",
      thin("arm64"),
    );
    await assembleApp({ ...options, executable: undefined, shellApp });
    expect(await readFile(join(options.output, "Contents/Info.plist"), "utf8")).toContain(
      "NSContactsUsageDescription",
    );
    await expect(
      access(
        join(
          options.output,
          "Contents/Library/LoginItems/OmnesisBackground.app/Contents/MacOS/OmnesisBackground",
        ),
      ),
    ).resolves.toBeUndefined();
    const { nestedCodeBundles } = await import("./distribute.mjs");
    expect(nestedCodeBundles(await inventoryBundle(options.output, "arm64"))).toContain(
      "Contents/Library/LoginItems/OmnesisBackground.app",
    );
  });
});

describe("packaging command boundary", () => {
  test("a signed-runtime qualification failure prevents installer creation", async () => {
    const { distribute } = await import("./distribute.mjs");
    const options = await inputs();
    await assembleApp(options);
    await put(
      options.output,
      "Contents/Library/LoginItems/OmnesisBackground.app/Contents/Info.plist",
      "fixture helper metadata",
    );
    const installer = join(options.root, "Omnesis.dmg");
    const commands = [];
    const run = (command, args) => {
      commands.push([command, args]);
      if (command === "/usr/bin/plutil")
        return JSON.stringify({
          CFBundleIdentifier: args.at(-1).includes("LoginItems")
            ? "dev.omnesis.desktop.background"
            : "dev.omnesis.desktop",
          OmnesisBuildConfiguration: "Release",
        });
      if (command === process.execPath) {
        expect(args[0]).toMatch(/smoke-runtime\.mjs$/);
        expect(args.slice(1)).toEqual([
          "--runtime",
          join(options.output, "Contents/Resources/runtime"),
        ]);
        throw new Error("The signed analytics crypto could not load");
      }
    };
    await expect(
      distribute({
        app: options.output,
        architecture: "arm64",
        identity: "Invented signing identity",
        output: installer,
        platform: "darwin",
        run,
      }),
    ).rejects.toThrow("signed analytics crypto");
    expect(
      commands.some(([command, args]) => command === "codesign" && args.includes("--verify")),
    ).toBe(true);
    expect(commands.some(([command]) => command === "hdiutil" || command === "xcrun")).toBe(false);
    await expect(access(installer)).rejects.toThrow();
  });

  test("rejects misspelled, duplicated and valueless flags", async () => {
    const { parseArguments } = await import("./arguments.mjs");
    const schema = { values: ["out", "arch"], required: ["out"] };
    expect(() => parseArguments(["--output", "new.app"], schema)).toThrow(/Unknown/);
    expect(() => parseArguments(["--out", "first", "--out", "second"], schema)).toThrow(/Repeated/);
    expect(() => parseArguments(["--out", "--arch", "arm64"], schema)).toThrow(/requires a value/);
    expect(() => parseArguments([], schema)).toThrow(/Missing/);
  });
});

describe("signed runtime inventory", () => {
  test("records changed code bytes and remains stable across repeated refreshes", async () => {
    const { refreshRuntimeInventory } = await import("./native-inventory.mjs");
    const options = await inputs();
    const original = await readFile(join(options.runtime, "desktop-runtime.json"), "utf8");
    await put(options.runtime, "node", Buffer.concat([thin("arm64"), Buffer.from("signed-code")]));
    await refreshRuntimeInventory(options.runtime, "arm64");
    const refreshed = await readFile(join(options.runtime, "desktop-runtime.json"), "utf8");
    expect(refreshed).not.toBe(original);
    const manifest = JSON.parse(refreshed);
    expect(manifest.inventory).toEqual(
      (await inventoryBundle(options.runtime, "arm64")).filter(
        (entry) => entry.path !== "desktop-runtime.json",
      ),
    );
    expect(manifest.productVersion).toBe(options.version);
    await refreshRuntimeInventory(options.runtime, "arm64");
    expect(await readFile(join(options.runtime, "desktop-runtime.json"), "utf8")).toBe(refreshed);
    await expect(refreshRuntimeInventory(options.runtime, "x64")).rejects.toThrow(/does not match/);
  });
});

describe("inert update compatibility metadata", () => {
  test("embeds the exact compiled schema and version before inventory sealing", async () => {
    const { writeDesktopUpdateMetadata } = await import("./update-metadata.mjs");
    const root = await temporary();
    for (const name of ["core", "gateway"])
      await put(
        root,
        `packages/${name}/package.json`,
        JSON.stringify({ type: "module", version: "0.7.8" }),
      );
    await put(
      root,
      "packages/core/dist/compat.js",
      "export const buildCompatManifest = ({productVersion,mainDbSchemaVersion}) => ({productVersion,stores:{mainDb:{policy:'numbered-migrations',version:mainDbSchemaVersion}},protocols:{ws:3}});\n",
    );
    await put(
      root,
      "packages/gateway/dist/data/schema-version.js",
      "export const LATEST_SCHEMA_VERSION = 17;\n",
    );
    const metadata = await writeDesktopUpdateMetadata(root, "arm64", "0.7.8");
    expect(metadata.compat.stores.mainDb.version).toBe(17);
    expect(metadata.bundleIdentifier).toBe("dev.omnesis.desktop");
    expect(JSON.parse(await readFile(join(root, "desktop-update.json"), "utf8"))).toEqual(metadata);
    expect(
      (await inventoryBundle(root, "arm64")).some((item) => item.path === "desktop-update.json"),
    ).toBe(true);
    await expect(writeDesktopUpdateMetadata(root, "arm64", "0.7.9")).rejects.toThrow(/lockstep/);
    await expect(writeDesktopUpdateMetadata(root, "arm64", "0.7.8")).rejects.toThrow();
  });
});

describe("offline pinned analytics crypto staging", () => {
  test("runs the maintained producer and copies only the target Mac binary before sealing", async () => {
    const root = await temporary(),
      input = join(root, "input"),
      target = join(root, "target");
    const bytes = thin("arm64");
    const manifest = {
      duckdbVersion: "v1.5.6",
      extensions: {
        httpfs: {
          osx_arm64: {
            size: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          },
        },
      },
    };
    await put(input, "packages/gateway/duckdb-extensions/manifest.json", JSON.stringify(manifest));
    await put(
      input,
      "packages/gateway/duckdb-extensions/v1.5.6/osx_arm64/httpfs.duckdb_extension",
      bytes,
    );
    await put(
      input,
      "packages/gateway/duckdb-extensions/v1.5.6/linux_arm64/httpfs.duckdb_extension",
      "invented wrong host cache",
    );
    const producer = vi.fn();
    stagePinnedDuckDbExtensions(
      {
        input,
        target,
        node: "/invented/node",
        architecture: "arm64",
        env: { PATH: "/invented/bin" },
      },
      producer,
    );
    expect(producer).toHaveBeenCalledWith(
      "/invented/node",
      [
        join(input, "scripts/duckdb-extensions.mjs"),
        "--package-dir",
        join(input, "packages/gateway"),
        "--platform",
        "osx_arm64",
      ],
      expect.objectContaining({ cwd: input, stdio: "inherit" }),
    );
    expect(
      await readFile(
        join(target, "packages/gateway/duckdb-extensions/v1.5.6/osx_arm64/httpfs.duckdb_extension"),
      ),
    ).toEqual(bytes);
    await expect(
      access(join(target, "packages/gateway/duckdb-extensions/v1.5.6/linux_arm64")),
    ).rejects.toThrow();
    await put(
      input,
      "packages/gateway/duckdb-extensions/v1.5.6/osx_arm64/httpfs.duckdb_extension",
      "changed extension",
    );
    expect(() =>
      stagePinnedDuckDbExtensions(
        {
          input,
          target: join(root, "refused"),
          node: "/invented/node",
          architecture: "arm64",
          env: {},
        },
        producer,
      ),
    ).toThrow("differs");
    await expect(access(join(root, "refused"))).rejects.toThrow();
  });
});
