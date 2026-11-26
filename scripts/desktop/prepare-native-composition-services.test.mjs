// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  symlink,
  realpath,
  lstat,
  readdir,
  open,
  appendFile,
  link,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { afterAll, beforeAll, expect, test } from "vitest";
import { spawnOwnedChildProcess, ownedProcessCleanupReceipt } from "@omnesis/core";
import { inventoryBundle } from "./native-inventory.mjs";
import { NODE_RUNTIME } from "./node-runtime.mjs";
import { runFixtureOpenSsl } from "./fixture-openssl.mjs";
import {
  readCompositionInput,
  compositionInputFailureMetadata,
  prepareNativeCompositionServices,
  prepareNativeCompositionApplication,
} from "./prepare-native-composition-services.mjs";

import {
  QA_SERVICE_MANIFEST_MAX_BYTES,
  readServiceMetadata,
} from "../../macos/Tests/Composition/desktop-service-entry.mjs";

const posix = test.skipIf(process.platform === "win32");
const roots = [],
  retained = new Set();
const sha = (value) => createHash("sha256").update(value).digest("hex");
let ca;
async function temporary() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "omnesis-qa-closure-")));
  roots.push(root);
  return root;
}
async function put(path, bytes, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, bytes, { mode });
}
beforeAll(async () => {
  if (process.platform === "win32") return;
  const root = await temporary();
  try {
    await runFixtureOpenSsl([
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(root, "key.pem"),
      "-out",
      join(root, "ca.pem"),
      "-days",
      "1",
      "-subj",
      "/CN=fixture.example.test",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
    ]);
    ca = await readFile(join(root, "ca.pem"), "utf8");
  } catch (error) {
    if (ownedProcessCleanupReceipt(error)) retained.add(root);
    throw error;
  }
});
afterAll(async () => {
  for (const root of roots)
    if (!retained.has(root)) await rm(root, { recursive: true, force: true });
});
function macho() {
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32BE(0xcffaedfe);
  bytes.writeUInt32LE(0x0100000c, 4);
  return bytes;
}
function plist(id, executable) {
  return `<?xml version="1.0"?><plist><dict><key>CFBundleIdentifier</key><string>${id}</string><key>CFBundleExecutable</key><string>${executable}</string><key>CFBundleShortVersionString</key><string>0.8.1</string><key>OmnesisBuildConfiguration</key><string>Debug</string></dict></plist>`;
}
async function inputs() {
  const root = await temporary(),
    runtime = join(root, "input"),
    shellApp = join(root, "Shell.app");
  // Native headers and module exports below are METADATA fixtures. They never run a guest/service.
  for (const path of ["node", "runtime-exec"]) await put(join(runtime, path), macho(), 0o700);
  for (const path of ["bin/node", "npm", "npx"])
    await put(join(runtime, path), "#!/bin/sh\nexit 1\n", 0o700);
  for (const path of ["LICENSE", "NODE_LICENSE"]) await put(join(runtime, path), "Fixture license");
  await put(join(runtime, "packages/cli/dist/index.js"), "export {};\n");
  await put(join(runtime, "packages/cli/package.json"), '{"type":"module"}');
  await put(join(runtime, "packages/gateway/portal/index.html"), "<html>Fixture</html>");
  const core =
    "export const spawnOwnedChildProcess=()=>{throw Error('metadata only')}; export const ownedProcessCleanupReceipt=()=>undefined; export const parseWebSocketAuthProtocolHeader=()=>[]; export const ensurePrivateFileSync=()=>{};\n";
  await put(join(runtime, "packages/core/dist/index.js"), core);
  await put(
    join(runtime, "packages/core/package.json"),
    JSON.stringify({ name: "@omnesis/core", type: "module", exports: "./dist/index.js" }),
  );
  const modules = {
    accounts: "export class RelayAccounts {}",
    identity: "export class RelaySessions {}; export const localIdentityProvider=()=>{};",
    server: "export const createCloudRelay=()=>{};",
    "tunnel-client": "export class GatewayTunnel {}",
    "client-proxy": "export const createRelayClientProxy=()=>{};",
    runtime: "export const startRelayDaemon=()=>{throw Error('metadata only')};",
  };
  for (const [name, text] of Object.entries(modules))
    await put(join(runtime, `packages/cloud-relay/dist/${name}.js`), text);
  await put(
    join(runtime, "packages/cloud-relay/package.json"),
    JSON.stringify({
      name: "@omnesis/cloud-relay",
      type: "module",
      exports: { "./runtime": "./dist/runtime.js" },
    }),
  );
  for (const name of ["core", "cloud-relay"]) {
    await mkdir(join(runtime, "node_modules/@omnesis"), { recursive: true });
    await symlink(`../../packages/${name}`, join(runtime, "node_modules/@omnesis", name));
  }
  for (const [name, text] of [
    [
      "jose",
      "export class SignJWT {}; export const decodeProtectedHeader=()=>{}; export const importJWK=()=>{}; export const flattenedVerify=()=>{}; export const calculateJwkThumbprint=()=>{};",
    ],
    ["ws", "export class WebSocketServer {}; export class WebSocket {}"],
  ]) {
    await put(
      join(runtime, `node_modules/${name}/package.json`),
      JSON.stringify({ type: "module", exports: "./index.js" }),
    );
    await put(join(runtime, `node_modules/${name}/index.js`), text);
  }
  const lock = JSON.parse(await readFile(new URL("../../package-lock.json", import.meta.url)));
  for (const key of [
    "node_modules/better-sqlite3",
    "packages/cloud-relay/node_modules/better-sqlite3",
  ]) {
    await put(
      join(runtime, key, "package.json"),
      JSON.stringify({
        name: "better-sqlite3",
        main: "lib/index.js",
        version: lock.packages[key].version,
      }),
    );
    await put(join(runtime, key, "lib/index.js"), "export {};\n");
    await put(
      join(runtime, key, "build/Release/better_sqlite3.node"),
      Buffer.concat([macho(), Buffer.from(key)]),
    );
  }
  const inventory = await inventoryBundle(runtime, "arm64");
  await put(
    join(runtime, "desktop-runtime.json"),
    JSON.stringify({
      format: 1,
      architecture: "arm64",
      productVersion: "0.8.1",
      nodeVersion: NODE_RUNTIME.version,
      codeUsageProtocol: 1,
      dataUsageProtocol: 1,
      processAuthorityProtocol: 3,
      runtimeLauncher: "runtime-exec",
      inventory,
    }),
  );
  await put(join(shellApp, "Contents/Info.plist"), plist("dev.omnesis.desktop", "Omnesis"));
  await put(join(shellApp, "Contents/MacOS/Omnesis"), macho(), 0o700);
  const helper = join(shellApp, "Contents/Library/LoginItems/OmnesisBackground.app");
  await put(
    join(helper, "Contents/Info.plist"),
    plist("dev.omnesis.desktop.background", "OmnesisBackground"),
  );
  await put(join(helper, "Contents/MacOS/OmnesisBackground"), macho(), 0o700);
  return {
    root,
    runtime,
    shellApp,
    output: join(root, "services"),
    architecture: "arm64",
    version: "0.8.1",
    rootSqliteVersion: lock.packages["node_modules/better-sqlite3"].version,
    relaySqliteVersion: lock.packages["packages/cloud-relay/node_modules/better-sqlite3"].version,
  };
}
async function node(args) {
  const owner = spawnOwnedChildProcess(process.execPath, args, {
    env: { PATH: process.env.PATH ?? "" },
  });
  let stdout = "",
    stderr = "",
    expired = false;
  owner.child.stdout.on("data", (part) => {
    stdout = (stdout + part).slice(0, 16385);
    if (stdout.length > 16384) void owner.stop().catch(() => {});
  });
  owner.child.stderr.on("data", (part) => {
    stderr = (stderr + part).slice(0, 16385);
    if (stderr.length > 16384) void owner.stop().catch(() => {});
  });
  owner.child.stdin.end();
  const timer = setTimeout(() => {
    expired = true;
    void owner.stop().catch(() => {});
  }, 5000);
  try {
    await owner.ready;
    await owner.joined;
    return { code: owner.child.exitCode, stdout, stderr, expired };
  } finally {
    clearTimeout(timer);
    await owner.stop();
    expect(owner.joinedConfirmed).toBe(true);
  }
}
posix(
  "a valid runtime inventory above one MiB materializes without changing any input bytes",
  async () => {
    const input = await inputs();
    for (let first = 0; first < 4096; first += 32) {
      await Promise.all(
        Array.from({ length: 32 }, (_, offset) => {
          const index = first + offset;
          const name =
            `invented-resource-${String(index).padStart(6, "0")}-` +
            "catalog-metadata-section-".repeat(7) +
            ".txt";
          return put(
            join(
              input.runtime,
              "assets/invented-catalog",
              `segment-${Math.floor(index / 128)}`,
              name,
            ),
            `Invented catalogue resource ${index}\n`,
          );
        }),
      );
    }
    const path = join(input.runtime, "desktop-runtime.json");
    const manifest = JSON.parse(await readFile(path));
    manifest.inventory = (await inventoryBundle(input.runtime, "arm64")).filter(
      (entry) => entry.path !== "desktop-runtime.json",
    );
    const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
    expect(bytes.length).toBeGreaterThan(1024 * 1024);
    expect(bytes.length).toBeLessThan(32 * 1024 * 1024);
    await writeFile(path, bytes);
    const original = await inventoryBundle(input.runtime, "arm64");
    await prepareNativeCompositionServices(input);
    expect(await readFile(join(input.output, "runtime/desktop-runtime.json"))).toEqual(bytes);
    expect(await inventoryBundle(input.runtime, "arm64")).toEqual(original);
    expect(await inventoryBundle(join(input.output, "runtime"), "arm64")).toEqual(original);
  },
  30000,
);

posix("compiled QA modules relocate without input access or a TS/source loader", async () => {
  const input = await inputs(),
    original = await inventoryBundle(input.runtime, "arm64");
  await prepareNativeCompositionServices(input);
  expect(await inventoryBundle(input.runtime, "arm64")).toEqual(original);
  const relocated = join(input.root, "relocated");
  await (await import("node:fs/promises")).rename(input.output, relocated);
  await rm(input.runtime, { recursive: true });
  const manifest = JSON.parse(await readFile(join(relocated, "qa-services.json")));
  expect(manifest.sources).toHaveLength(8);
  expect(manifest.sqlite).toMatchObject({
    lockKey: "packages/cloud-relay/node_modules/better-sqlite3",
    version: input.relaySqliteVersion,
  });
  expect(manifest.sqlite.binding).toBe(
    "packages/cloud-relay/node_modules/better-sqlite3/build/Release/better_sqlite3.node",
  );
  expect(manifest.sqlite.sha256).toBe(
    sha(await readFile(join(relocated, "runtime", manifest.sqlite.binding))),
  );
  expect(manifest.sqlite.sha256).not.toBe(
    sha(
      await readFile(
        join(relocated, "runtime/node_modules/better-sqlite3/build/Release/better_sqlite3.node"),
      ),
    ),
  );
  expect(manifest.sources.filter((item) => item.source.endsWith(".ts"))).toHaveLength(6);
  expect(
    manifest.inventory
      .filter((item) => item.path.startsWith("service/"))
      .some((item) => /(?<!\.d)\.tsx?$/u.test(item.path)),
  ).toBe(false);
  for (const record of manifest.inventory.filter((item) => item.symlink))
    expect((await realpath(join(relocated, record.path))).startsWith(relocated + "/")).toBe(true);
  const module = join(relocated, "service/scripts/desktop/native-composition-world.js");
  const required = createRequire(module);
  expect(await realpath(required.resolve("@omnesis/cloud-relay/runtime"))).toBe(
    join(relocated, "runtime/packages/cloud-relay/dist/runtime.js"),
  );
  const loaded = await node([
    "--input-type=module",
    "-e",
    `await import(${JSON.stringify(pathToFileURL(module).href)}); process.stdout.write('loaded');`,
  ]);
  expect(loaded).toMatchObject({ code: 0, stdout: "loaded", expired: false });
});

posix(
  "application wrapper invokes the existing unsigned Debug fixture builder through its public API",
  async () => {
    const input = await inputs();
    const service = await prepareNativeCompositionServices(input);
    const receipt = {
      format: 1,
      kind: "native-qa-services-ready",
      artifactSha256: service.manifestSha256,
      resource: {
        format: 1,
        kind: "omnesis-native-composition",
        runId: randomUUID(),
        relayOrigin: "https://relay.example.test:17651",
        acmeDirectoryUrl: "http://127.0.0.1:17652/directory",
        caSha256: sha(ca),
        modelOrigin: "http://127.0.0.1:17653",
        modelId: "fictional-native-model",
      },
      ca,
      relayCa: ca,
      systemOpenSsl: {
        executable: "/usr/bin/openssl",
        sha256: "a".repeat(64),
        version: "LibreSSL 3.3.6",
        reqAddext: true,
        x509Extfile: true,
      },
    };
    // This fabricated public receipt tests schema/assembly only, never guest observation or native authority.
    const output = join(input.root, "Omnesis-QA.app");
    expect(
      (
        await prepareNativeCompositionApplication({
          serviceArtifact: input.output,
          publicReadyReceipt: receipt,
          shellApp: input.shellApp,
          output,
        })
      ).scope,
    ).toBe("unsigned-debug-fixture-only");
    expect(
      await readFile(
        join(output, "Contents/Resources/runtime/packages/cli/dist/qa-production-index.js"),
        "utf8",
      ),
    ).toBe("export {};\n");
    expect(
      JSON.parse(await readFile(join(output, "Contents/Resources/qa-composition.json"))),
    ).toMatchObject({ runId: receipt.resource.runId });
    await expect(
      prepareNativeCompositionApplication({
        serviceArtifact: input.output,
        publicReadyReceipt: { ...receipt, artifactSha256: "b".repeat(64) },
        shellApp: input.shellApp,
        output: join(input.root, "other.app"),
      }),
    ).rejects.toThrow("receipt");
  },
);

posix(
  "materialization refuses inventory drift, wrong native architecture and existing output without modifying inputs",
  async () => {
    const input = await inputs();
    await prepareNativeCompositionServices(input);
    const before = await inventoryBundle(input.output, "arm64");
    await expect(prepareNativeCompositionServices(input)).rejects.toThrow();
    expect(await inventoryBundle(input.output, "arm64")).toEqual(before);
    await expect(
      prepareNativeCompositionServices({
        ...input,
        output: join(input.root, "wrong"),
        architecture: "x64",
      }),
    ).rejects.toThrow();
    await put(join(input.runtime, "foreign.js"), "export {};\n");
    await expect(
      prepareNativeCompositionServices({ ...input, output: join(input.root, "drift") }),
    ).rejects.toThrow("inventory");
    expect(await readdir(input.root)).not.toContain("drift");
  },
);

test.skipIf(process.platform === "darwin" || process.platform === "win32")(
  "guest entry refuses another OS before creating service data",
  async () => {
    const input = await inputs();
    await prepareNativeCompositionServices(input);
    const before = await inventoryBundle(input.output, "arm64");
    const result = await node([
      join(input.output, "service/macos/Tests/Composition/desktop-service-entry.mjs"),
      "start",
    ]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stderr)).toEqual({ state: "refused", cleanupUnconfirmed: false });
    expect(await inventoryBundle(input.output, "arm64")).toEqual(before);
  },
);

test.runIf(process.platform === "win32")(
  "service artifact builder refuses unsupported private ownership",
  async () => {
    await expect(
      prepareNativeCompositionServices({ runtime: "/not-opened", output: "/not-created" }),
    ).rejects.toThrow("POSIX ownership");
  },
);

posix.each([
  ["builder", readCompositionInput],
  ["guest metadata", readServiceMetadata],
])(
  "%s reader never exceeds bound+1 when an actual file grows after stat",
  async (_name, reader) => {
    const root = await temporary(),
      path = join(root, "growing.json");
    await writeFile(path, "short", { mode: 0o600 });
    let grew = false,
      closed = false,
      maximum = 0,
      unboundedCalls = 0;
    const openGrowing = async (...args) => {
      const handle = await open(...args);
      const grow = async () => {
        if (!grew) {
          grew = true;
          await appendFile(path, Buffer.alloc(1024));
        }
      };
      return {
        stat: () => handle.stat(),
        async read(...values) {
          await grow();
          maximum = Math.max(maximum, values[2]);
          return handle.read(...values);
        },
        async readFile() {
          unboundedCalls++;
          await grow();
          const bytes = await handle.readFile();
          maximum = Math.max(maximum, bytes.length);
          return bytes;
        },
        async close() {
          await handle.close();
          closed = true;
        },
      };
    };
    await expect(reader(path, 8, openGrowing)).rejects.toThrow(/changed|bound/u);
    expect(grew).toBe(true);
    expect((await lstat(path)).size).toBeGreaterThan(8);
    expect(maximum).toBeLessThanOrEqual(9);
    expect(unboundedCalls).toBe(0);
    expect(closed).toBe(true);
  },
);

posix(
  "selected nested relay SQLite must match its own lock and binding, independent of root version",
  async () => {
    const input = await inputs();
    const nested = join(
      input.runtime,
      "packages/cloud-relay/node_modules/better-sqlite3/package.json",
    );
    const value = JSON.parse(await readFile(nested));
    await writeFile(nested, JSON.stringify({ ...value, version: "0.0.0" }));
    const runtimeManifest = join(input.runtime, "desktop-runtime.json");
    const manifest = JSON.parse(await readFile(runtimeManifest));
    manifest.inventory = (await inventoryBundle(input.runtime, "arm64")).filter(
      (item) => item.path !== "desktop-runtime.json",
    );
    await writeFile(runtimeManifest, JSON.stringify(manifest));
    await expect(prepareNativeCompositionServices(input)).rejects.toThrow("workspace lock record");
    await expect(lstat(input.output)).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      JSON.parse(await readFile(join(input.runtime, "node_modules/better-sqlite3/package.json")))
        .version,
    ).toBe(input.rootSqliteVersion);
  },
);

posix("omitting nested SQLite cannot validate the older root fallback", async () => {
  const input = await inputs();
  await rm(join(input.runtime, "packages/cloud-relay/node_modules/better-sqlite3"), {
    recursive: true,
  });
  const runtimeManifest = join(input.runtime, "desktop-runtime.json");
  const manifest = JSON.parse(await readFile(runtimeManifest));
  manifest.inventory = (await inventoryBundle(input.runtime, "arm64")).filter(
    (item) => item.path !== "desktop-runtime.json",
  );
  await writeFile(runtimeManifest, JSON.stringify(manifest));
  const actualFallback = createRequire(
    join(input.runtime, "packages/cloud-relay/dist/accounts.js"),
  ).resolve("better-sqlite3/package.json");
  expect(await realpath(actualFallback)).toBe(
    join(input.runtime, "node_modules/better-sqlite3/package.json"),
  );
  await expect(prepareNativeCompositionServices(input)).rejects.toThrow(
    "first consumer lookup location",
  );
  await expect(lstat(input.output)).rejects.toMatchObject({ code: "ENOENT" });
  expect(JSON.parse(await readFile(actualFallback)).version).toBe(input.rootSqliteVersion);
});

posix(
  "runtime manifest readers retain the 32 MiB cap and report only finite file metadata",
  async () => {
    const root = await temporary();
    const path = join(root, "oversize.json");
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.truncate(32 * 1024 * 1024 + 1);
    } finally {
      await handle.close();
    }
    const failure = await readCompositionInput(path, 32 * 1024 * 1024).catch((error) => error);
    expect(compositionInputFailureMetadata(failure)).toEqual({
      reason: "oversize",
      type: "regular",
      linkCount: 1,
      byteCount: 32 * 1024 * 1024 + 1,
      readBound: 32 * 1024 * 1024,
    });
    expect(JSON.stringify(compositionInputFailureMetadata(failure))).not.toContain(root);
    await expect(readServiceMetadata(path, QA_SERVICE_MANIFEST_MAX_BYTES)).rejects.toThrow();
    expect(
      compositionInputFailureMetadata(
        Object.assign(new Error("invented-secret-value"), {
          validation: { reason: "oversize", path: root, secret: "invented-secret-value" },
        }),
      ),
    ).toBeNull();
  },
);

posix(
  "the shared QA metadata limit admits a real file over 16 MiB without raising module defaults",
  async () => {
    const root = await temporary();
    const path = join(root, "metadata-capacity.bin");
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.truncate(16 * 1024 * 1024 + 1);
    } finally {
      await handle.close();
    }
    expect((await readServiceMetadata(path, QA_SERVICE_MANIFEST_MAX_BYTES)).length).toBe(
      16 * 1024 * 1024 + 1,
    );
    await expect(readCompositionInput(path)).rejects.toThrow("Invalid QA service input");
  },
);

posix("input readers refuse actual hard links, symlinks and directories", async () => {
  const root = await temporary();
  const path = join(root, "owned.json");
  await writeFile(path, "{}", { mode: 0o600 });
  await link(path, join(root, "hard.json"));
  const failure = await readCompositionInput(path).catch((error) => error);
  expect(compositionInputFailureMetadata(failure)).toMatchObject({
    reason: "multiple-links",
    linkCount: 2,
  });
  await expect(readServiceMetadata(path, 64)).rejects.toThrow();
  await symlink(path, join(root, "symbolic.json"));
  for (const reader of [readCompositionInput, readServiceMetadata]) {
    await expect(reader(join(root, "symbolic.json"), 64)).rejects.toThrow();
    await expect(reader(root, 64)).rejects.toThrow();
  }
});
