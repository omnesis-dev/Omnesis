// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFile, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { atomicWriteFile, secureMarkerPath } from "@omnesis/core";
import { omnesisConfigSchema } from "@omnesis/config";
import { desktopProfile } from "../../packages/cli/src/desktop/environment.js";
import {
  prepareDesktopInstall,
  readDesktopInstall,
  withDesktopInstallLease,
} from "../../packages/cli/src/desktop/bootstrap.js";
import {
  compositionProtections,
  ORIGINAL_ENTRY,
  parseCompositionResource,
  preflightCompositionProfile,
  reserveCompositionIntent,
} from "../../macos/Tests/Composition/desktop-native-entry.mjs";
import { prepareNativeCompositionFixture } from "./prepare-native-composition-fixture.mjs";
import { inventoryBundle } from "./native-inventory.mjs";
import { NODE_RUNTIME } from "./node-runtime.mjs";
import { assertReleaseApplication } from "./release-application.mjs";

const execute = promisify(execFile),
  sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const roots = [];
let certificate;
const posixTest = test.skipIf(process.platform === "win32");
beforeAll(async () => {
  if (process.platform === "win32") return;
  const root = await realpath(await mkdtemp(join(tmpdir(), "omnesis-qa-ca-")));
  roots.push(root);
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(root, "ca.key"),
      "-out",
      join(root, "ca.pem"),
      "-days",
      "1",
      "-subj",
      "/CN=QA fixture authority",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
    ],
    { stdio: "ignore", timeout: 10000 },
  );
  certificate = await readFile(join(root, "ca.pem"));
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});
async function temporary() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "omnesis-native-qa-")));
  roots.push(root);
  return root;
}
function resource() {
  return {
    format: 1,
    kind: "omnesis-native-composition",
    runId: randomUUID(),
    relayOrigin: "https://relay.example.test:17651",
    acmeDirectoryUrl: "http://127.0.0.1:17652/directory",
    caSha256: sha(certificate ?? "public fixture metadata"),
    modelOrigin: "http://127.0.0.1:17653",
    modelId: "fictional-native-model",
  };
}
async function put(path, bytes, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, bytes, { mode });
}
function thin() {
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32BE(0xcffaedfe, 0);
  bytes.writeUInt32LE(0x0100000c, 4);
  return bytes;
}
function plist(id, executable, configuration = "Debug") {
  return `<?xml version="1.0"?><plist><dict><key>CFBundleIdentifier</key><string>${id}</string><key>CFBundleExecutable</key><string>${executable}</string><key>CFBundleShortVersionString</key><string>0.8.1</string><key>OmnesisBuildConfiguration</key><string>${configuration}</string></dict></plist>`;
}
async function builderInputs() {
  const root = await temporary(),
    runtime = join(root, "runtime"),
    shellApp = join(root, "Shell.app");
  for (const name of ["node", "runtime-exec", "bin/node", "npm", "npx"])
    await put(
      join(runtime, name),
      name.includes("node") || name === "runtime-exec" ? thin() : "fixture executable",
      0o700,
    );
  const original = `import {writeFileSync} from 'node:fs'; writeFileSync(process.env.QA_FORWARD_OUTPUT,JSON.stringify(process.argv.slice(2)));`;
  await put(join(runtime, "packages/cli/dist/index.js"), original);
  await put(join(runtime, "packages/cli/package.json"), '{"type":"module"}');
  await put(join(runtime, "packages/gateway/portal/index.html"), "<html>QA fixture</html>");
  for (const name of ["NODE_LICENSE", "LICENSE"])
    await put(join(runtime, name), "Fictional test input");
  const manifest = {
    format: 1,
    architecture: "arm64",
    nodeVersion: NODE_RUNTIME.version,
    productVersion: "0.8.1",
    codeUsageProtocol: 1,
    dataUsageProtocol: 1,
    processAuthorityProtocol: 3,
    runtimeLauncher: "runtime-exec",
    inventory: await inventoryBundle(runtime, "arm64"),
  };
  await put(join(runtime, "desktop-runtime.json"), JSON.stringify(manifest));
  await put(join(shellApp, "Contents/Info.plist"), plist("dev.omnesis.desktop", "Omnesis"));
  await put(join(shellApp, "Contents/MacOS/Omnesis"), thin(), 0o700);
  await put(
    join(shellApp, "Contents/Library/LoginItems/OmnesisBackground.app/Contents/Info.plist"),
    plist("dev.omnesis.desktop.background", "OmnesisBackground"),
  );
  await put(
    join(
      shellApp,
      "Contents/Library/LoginItems/OmnesisBackground.app/Contents/MacOS/OmnesisBackground",
    ),
    thin(),
    0o700,
  );
  return {
    root,
    runtime,
    shellApp,
    output: join(root, "Omnesis-QA.app"),
    architecture: "arm64",
    version: "0.8.1",
    resource: resource(),
    ca: certificate,
    original,
  };
}

test("closed QA resources reject ambient authority, production hosts and injected paths", () => {
  const valid = resource();
  expect(parseCompositionResource(valid)).toEqual(valid);
  for (const change of [
    { acmeDirectoryUrl: "http://ca.example.test:17652/directory" },
    { acmeDirectoryUrl: "http://127.0.0.1:17652/other" },
    { acmeDirectoryUrl: "http://127.0.0.1:80/directory" },
    { acmeDirectoryUrl: "http://127.0.0.1:17652/directory?redirect=1" },
    { acmeDirectoryUrl: "http://127.0.0.1:17652/directory#fragment" },
    { acmeDirectoryUrl: "http://user:secret@127.0.0.1:17652/directory" },
    { relayOrigin: "http://127.0.0.1:17651" },
    { home: "/example/home" },
    { executable: "/example/tool" },
    { relayOrigin: "https://omnesis.app:17651" },
    { relayOrigin: "https://user:secret@relay.example.test:17651" },
    { modelOrigin: "https://provider.example.test:17653" },
    { modelOrigin: "http://127.0.0.1:17653\nKEY=value" },
    { runId: "not-a-uuid" },
  ])
    expect(() => parseCompositionResource({ ...valid, ...change })).toThrow();
});

posixTest(
  "unsigned Debug builder preserves and actually forwards the original same-directory entry",
  async () => {
    const input = await builderInputs();
    const result = await prepareNativeCompositionFixture(input);
    expect(result.scope).toBe("unsigned-debug-fixture-only");
    const runtime = join(input.output, "Contents/Resources/runtime"),
      entry = join(runtime, "packages/cli/dist/index.js");
    expect(await readFile(join(dirname(entry), ORIGINAL_ENTRY), "utf8")).toBe(input.original);
    const output = join(input.root, "forwarded.json");
    // Executable-header inputs are metadata fixtures, not native signing or authority proof.
    for (const args of [
      ["desktop", "daemon", "--background-owner"],
      ["desktop", "retire"],
      ["gateway", "serve"],
      ["desktop", "bridge", "extra"],
    ]) {
      await execute(process.execPath, [entry, ...args], {
        timeout: 3000,
        env: { ...process.env, QA_FORWARD_OUTPUT: output },
      });
      expect(JSON.parse(await readFile(output, "utf8"))).toEqual(args);
    }
    const manifest = JSON.parse(await readFile(join(runtime, "desktop-runtime.json"), "utf8"));
    expect(manifest.inventory).toEqual(
      (await inventoryBundle(runtime, "arm64")).filter(
        (item) => item.path !== "desktop-runtime.json",
      ),
    );
    expect(manifest.inventory.some((item) => item.path === "qa-resource.json")).toBe(true);
    expect(await readFile(join(input.runtime, "packages/cli/dist/index.js"), "utf8")).toBe(
      input.original,
    );
    const parsePlist = (_command, args) =>
      JSON.stringify({
        CFBundleIdentifier: args.at(-1).includes("LoginItems")
          ? "dev.omnesis.desktop.background"
          : "dev.omnesis.desktop",
        OmnesisBuildConfiguration: "Debug",
      });
    await expect(assertReleaseApplication(input.output, parsePlist)).rejects.toThrow(
      "requires Release builds",
    );
  },
);

posixTest(
  "postassembly failure removes only the created output and preserves retry inputs",
  async () => {
    const input = await builderInputs();
    const collision = join(input.shellApp, "Contents/Resources/qa-composition.json");
    await mkdir(collision, { recursive: true });
    const beforeRuntime = await inventoryBundle(input.runtime, "arm64");
    const beforeShell = await inventoryBundle(input.shellApp, "arm64");
    await expect(prepareNativeCompositionFixture(input)).rejects.toThrow();
    await expect(lstat(input.output)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await inventoryBundle(input.runtime, "arm64")).toEqual(beforeRuntime);
    expect(await inventoryBundle(input.shellApp, "arm64")).toEqual(beforeShell);
    await rm(collision, { recursive: true });
    expect((await prepareNativeCompositionFixture(input)).scope).toBe(
      "unsigned-debug-fixture-only",
    );
  },
);

posixTest(
  "builder refuses Release/wrong-ID shells, existing outputs, aliases and inventory drift",
  async () => {
    for (const scenario of ["release", "identity", "existing", "alias", "drift"]) {
      const input = await builderInputs();
      if (scenario === "release")
        await writeFile(
          join(input.shellApp, "Contents/Info.plist"),
          plist("dev.omnesis.desktop", "Omnesis", "Release"),
        );
      if (scenario === "identity")
        await writeFile(
          join(
            input.shellApp,
            "Contents/Library/LoginItems/OmnesisBackground.app/Contents/Info.plist",
          ),
          plist("dev.example.other", "OmnesisBackground"),
        );
      if (scenario === "existing") await mkdir(input.output);
      if (scenario === "alias") {
        const alias = join(input.root, "alias");
        await symlink(input.runtime, alias);
        input.runtime = alias;
      }
      if (scenario === "drift") await writeFile(join(input.runtime, "LICENSE"), "changed");
      await expect(prepareNativeCompositionFixture(input)).rejects.toThrow();
    }
  },
);

async function bootstrapFixture() {
  const root = await temporary(),
    profile = desktopProfile(join(root, "fake-os-home")),
    qa = resource(),
    signal = new AbortController();
  const runtime = join(root, "e".repeat(64));
  await mkdir(runtime, { mode: 0o700 });
  const state = { valid: true, store: { secure: true, backend: "macos-keychain" } };
  // OS protection spies expose journal ordering ONLY. They are never native Keychain proof.
  const core = {
    atomicWriteFile,
    ensureInstallRootKey: vi.fn(async () => state),
    inspectInstallRootKey: vi.fn(async () => state),
    markSecretFileEncryptionRequired: vi.fn(async (directory) => {
      await put(secureMarkerPath("secret-files", directory), "ordering-only-marker");
    }),
    markStorageEncryptionRequired: vi.fn(async (directory) => {
      await put(secureMarkerPath("storage-encryption", directory), "ordering-only-marker");
    }),
  };
  await reserveCompositionIntent(profile, qa, "e".repeat(64), {
    withLease: withDesktopInstallLease,
    atomicWriteFile,
    signal: signal.signal,
  });
  const options = { mode: "home", totalMemoryBytes: 8 * 1024 ** 3, signal: signal.signal };
  const dependencies = (checkpoint = async () => {}) =>
    compositionProtections(profile, qa, runtime, {
      core,
      signal: signal.signal,
      readInstall: readDesktopInstall,
      parseConfig: (value) => omnesisConfigSchema.parse(value),
      checkpoint,
    });
  return { root, profile, qa, signal, runtime, core, options, dependencies };
}

posixTest.each(["storage", "config", "environment", "marker"])(
  "interruption at %s stays claimed and retries before configured without reminting",
  async (stage) => {
    const f = await bootstrapFixture();
    const checkpoint = vi.fn(async (current) => {
      expect((await readDesktopInstall(f.profile)).phase).toBe("claimed");
      if (current === stage) throw new Error("owned interruption");
    });
    await expect(
      prepareDesktopInstall(f.profile, f.options, f.dependencies(checkpoint)),
    ).rejects.toThrow("owned interruption");
    expect((await readDesktopInstall(f.profile)).phase).toBe("claimed");
    const keyCalls = f.core.ensureInstallRootKey.mock.calls.length;
    await prepareDesktopInstall(f.profile, f.options, f.dependencies());
    expect((await readDesktopInstall(f.profile)).phase).toBe("configured");
    expect(f.core.ensureInstallRootKey).toHaveBeenCalledTimes(keyCalls);
    expect(f.core.inspectInstallRootKey).toHaveBeenCalledOnce();
    expect(
      omnesisConfigSchema.parse(
        JSON.parse(await readFile(join(f.profile.configDir, "omnesis.json"), "utf8")),
      ).inference.assignments.embedder,
    ).toBeNull();
    expect((await lstat(join(f.profile.configDir, "qa-composition.json"))).mode & 0o077).toBe(0);
  },
);

posixTest(
  "real bootstrap seam persists explicit QA telemetry policy before configured publication",
  async () => {
    const f = await bootstrapFixture();
    let observed;
    await prepareDesktopInstall(
      f.profile,
      f.options,
      f.dependencies(async (stage) => {
        if (stage !== "environment") return;
        expect((await readDesktopInstall(f.profile)).phase).toBe("claimed");
        observed = await readFile(join(f.profile.configDir, ".env"), "utf8");
        expect(
          observed.split("\n").filter((line) => /^OMNESIS_(?:RUNTIME_MODE|TELEMETRY)=/u.test(line)),
        ).toEqual(["OMNESIS_RUNTIME_MODE=test", "OMNESIS_TELEMETRY=0"]);
        expect(observed).toContain("OMNESIS_E2E_DISABLE_DEFAULT_RELAY=1\n");
      }),
    );
    expect(typeof observed).toBe("string");
    expect(await readFile(join(f.profile.configDir, ".env"), "utf8")).toBe(observed);
    expect((await readDesktopInstall(f.profile)).phase).toBe("configured");
    expect(f.core.markStorageEncryptionRequired).toHaveBeenCalledOnce();
    expect(f.core.markSecretFileEncryptionRequired).toHaveBeenCalledOnce();
  },
);

posixTest("real protection refusal and cancellation cannot publish configured", async () => {
  const f = await bootstrapFixture();
  f.core.markStorageEncryptionRequired.mockRejectedValueOnce(new Error("owned keychain refusal"));
  await expect(prepareDesktopInstall(f.profile, f.options, f.dependencies())).rejects.toThrow(
    "owned keychain refusal",
  );
  expect((await readDesktopInstall(f.profile)).phase).toBe("claimed");
  await expect(readFile(join(f.profile.configDir, "qa-composition.json"))).rejects.toThrow();
  await expect(
    prepareDesktopInstall(
      f.profile,
      f.options,
      f.dependencies(async (stage) => {
        if (stage === "marker") f.signal.abort();
      }),
    ),
  ).rejects.toThrow();
  expect((await readDesktopInstall(f.profile)).phase).toBe("claimed");
});

posixTest(
  "protected retry preserves private QA config while configured retry preserves valid UI edits",
  async () => {
    const f = await bootstrapFixture();
    await prepareDesktopInstall(f.profile, f.options, f.dependencies());
    const journalPath = join(f.profile.configDir, "desktop-install.json"),
      journal = JSON.parse(await readFile(journalPath, "utf8"));
    await atomicWriteFile(journalPath, JSON.stringify({ ...journal, phase: "protected" }), {
      mode: 0o600,
    });
    const before = await readFile(join(f.profile.configDir, "omnesis.json"));
    await prepareDesktopInstall(f.profile, f.options, f.dependencies());
    expect(await readFile(join(f.profile.configDir, "omnesis.json"))).toEqual(before);
    const changed = JSON.parse(before);
    changed.gateway.memoryLimitMb = 1024;
    await atomicWriteFile(join(f.profile.configDir, "omnesis.json"), JSON.stringify(changed), {
      mode: 0o600,
    });
    await prepareDesktopInstall(f.profile, f.options, f.dependencies());
    expect(
      JSON.parse(await readFile(join(f.profile.configDir, "omnesis.json"), "utf8")).gateway
        .memoryLimitMb,
    ).toBe(1024);
  },
);

posixTest(
  "foreign intent, modified prefix, linked file and configured missing marker refuse without overwrite",
  async () => {
    for (const stage of ["intent", "prefix", "link", "configured"]) {
      const f = await bootstrapFixture();
      if (stage === "intent") {
        const path = join(f.profile.configDir + ".bootstrap", "qa-composition-intent.json");
        await atomicWriteFile(path, "{}", { mode: 0o600 });
      } else {
        await expect(
          prepareDesktopInstall(
            f.profile,
            f.options,
            f.dependencies(async (point) => {
              if (point === "config") throw new Error("pause");
            }),
          ),
        ).rejects.toThrow("pause");
        if (stage === "prefix")
          await atomicWriteFile(join(f.profile.configDir, "omnesis.json"), "{}", { mode: 0o600 });
        if (stage === "link") {
          const path = join(f.profile.configDir, ".env");
          await symlink(join(f.profile.configDir, "omnesis.json"), path);
        }
        if (stage === "configured") {
          const path = join(f.profile.configDir, "desktop-install.json");
          const journal = JSON.parse(await readFile(path, "utf8"));
          await atomicWriteFile(path, JSON.stringify({ ...journal, phase: "configured" }), {
            mode: 0o600,
          });
        }
      }
      const before = await readFile(join(f.profile.configDir, "omnesis.json")).catch(() => null);
      await expect(prepareDesktopInstall(f.profile, f.options, f.dependencies())).rejects.toThrow();
      expect(await readFile(join(f.profile.configDir, "omnesis.json")).catch(() => null)).toEqual(
        before,
      );
    }
  },
);

posixTest(
  "preflight refuses foreign dotenv or missing configured marker before native launch",
  async () => {
    const f = await bootstrapFixture();
    await prepareDesktopInstall(f.profile, f.options, f.dependencies());
    await preflightCompositionProfile(f.profile, f.qa, f.runtime);
    const env = join(f.profile.configDir, ".env"),
      before = await readFile(env);
    await atomicWriteFile(env, "OMNESIS_TOKEN=unrelated-fixture-value\n", { mode: 0o600 });
    await expect(preflightCompositionProfile(f.profile, f.qa, f.runtime)).rejects.toThrow("dotenv");
    await atomicWriteFile(env, before, { mode: 0o600 });
    await rm(join(f.profile.configDir, "qa-composition.json"));
    await expect(preflightCompositionProfile(f.profile, f.qa, f.runtime)).rejects.toThrow();
  },
);

posixTest(
  "actual install lease serializes competing preparers and reserves only an empty profile",
  async () => {
    const f = await bootstrapFixture();
    await Promise.all([
      prepareDesktopInstall(f.profile, f.options, f.dependencies()),
      prepareDesktopInstall(f.profile, f.options, f.dependencies()),
    ]);
    expect(f.core.ensureInstallRootKey).toHaveBeenCalledOnce();
    expect(f.core.inspectInstallRootKey).toHaveBeenCalledOnce();
    await expect(
      reserveCompositionIntent(f.profile, { ...f.qa, runId: randomUUID() }, "e".repeat(64), {
        withLease: withDesktopInstallLease,
        atomicWriteFile,
        signal: f.signal.signal,
      }),
    ).rejects.toThrow();
    const other = desktopProfile(join(f.root, "another-fake-home"));
    await put(join(other.configDir, "existing-data"), "keep");
    await expect(
      reserveCompositionIntent(other, f.qa, "e".repeat(64), {
        withLease: withDesktopInstallLease,
        atomicWriteFile,
        signal: f.signal.signal,
      }),
    ).rejects.toThrow("cannot adopt");
  },
);

test.runIf(process.platform === "win32")(
  "private QA tools refuse unsupported ownership before filesystem operations",
  async () => {
    await expect(prepareNativeCompositionFixture({})).rejects.toThrow("POSIX ownership");
    await expect(preflightCompositionProfile({}, {}, "/not-opened")).rejects.toThrow(
      "POSIX ownership",
    );
  },
);
