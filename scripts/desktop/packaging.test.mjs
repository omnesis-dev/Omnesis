// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { access, chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
  await chmod(join(runtime, "node"), 0o755);
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

  test("private npm uses the bundled node even with an empty host PATH", async () => {
    const { copyNodeTools } = await import("./runtime-assets.mjs");
    const { execFileSync } = await import("node:child_process");
    const root = await temporary();
    const distribution = join(root, "distribution");
    const target = join(root, "runtime with spaces");
    await put(distribution, "bin/node", '#!/bin/sh\nprintf "%s\\n" "$@"\n');
    await put(distribution, "lib/node_modules/npm/bin/npm-cli.js", "// npm fixture\n");
    await put(distribution, "LICENSE", "Node license fixture");
    copyNodeTools(distribution, target);
    const result = execFileSync(join(target, "npm"), ["--version"], {
      encoding: "utf8",
      env: { PATH: "" },
    });
    expect(result.trim().split("\n")).toEqual([
      join(target, "lib/node_modules/npm/bin/npm-cli.js"),
      "--version",
    ]);
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
  test("rejects misspelled, duplicated and valueless flags", async () => {
    const { parseArguments } = await import("./arguments.mjs");
    const schema = { values: ["out", "arch"], required: ["out"] };
    expect(() => parseArguments(["--output", "new.app"], schema)).toThrow(/Unknown/);
    expect(() => parseArguments(["--out", "first", "--out", "second"], schema)).toThrow(/Repeated/);
    expect(() => parseArguments(["--out", "--arch", "arm64"], schema)).toThrow(/requires a value/);
    expect(() => parseArguments([], schema)).toThrow(/Missing/);
  });
});
