// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";
import { codexKeyringAccount, codexPaths, createLogger } from "@omnesis/core";
import {
  assertNoManagedCodexAuthFile,
  managedCodexArgs,
  managedCodexPoolAuthFiles,
  removeManagedCodexPoolAuth,
} from "./codex-managed-auth.js";
import { CodexAppServerRuntime, buildCodexEnv } from "./codex-app-server-backend.js";
import { CodexRuntimePool } from "./codex-runtime-pool.js";
import * as modelDiscovery from "./codex-managed-model-discovery.js";
import { CODEX_RUNTIME_COMPAT } from "./codex-compat.js";

const managed = {
  OMNESIS_DESKTOP_MANAGED: "1",
  OMNESIS_FAKE_CODEX_VERSION: CODEX_RUNTIME_COMPAT.testedVersion,
};
const roots: string[] = [];
async function fixture(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "omnesis-codex-auth-fixture-")));
  roots.push(root);
  return root;
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true });
});

describe("managed Codex credential boundaries", () => {
  test("forces strict storage after other arguments and preserves ordinary headless arguments", () => {
    const input = ["login", "status", "-c", 'cli_auth_credentials_store="file"'];
    const args = managedCodexArgs(managed, input, "/example/state");
    expect(args.lastIndexOf('cli_auth_credentials_store="keyring"')).toBeGreaterThan(
      args.indexOf('cli_auth_credentials_store="file"'),
    );
    expect(args).toContain("features.secret_auth_storage=false");
    expect(args).toContain('history.persistence="none"');
    expect(args).toContain('sqlite_home="/example/state/sqlite"');
    expect(args).toContain('log_dir="/example/state/log"');
    expect(managedCodexArgs({}, input, "/example/state")).toEqual(input);
    expect(buildCodexEnv({ ...managed, RUST_LOG: "trace" }, "/example/home").RUST_LOG).toBe("off");
    expect(buildCodexEnv({}, "/example/home").RUST_LOG).toBeUndefined();
    const trust = {
      SSL_CERT_FILE: "/example/global.pem",
      SSL_CERT_DIR: "/example/global-certs",
      NODE_EXTRA_CA_CERTS: "/example/node.pem",
    };
    for (const key of Object.keys(trust))
      expect(buildCodexEnv({ ...trust, ...managed }, "/example/home")[key]).toBeUndefined();
    expect(buildCodexEnv(trust, "/example/home")).toMatchObject(trust);
  });

  test("canonical owned homes have distinct namespaces and aliases refuse before any account lookup", async () => {
    const root = await fixture();
    const first = join(root, "first");
    const second = join(root, "second");
    await mkdir(first);
    await mkdir(second);
    const alias = join(root, "alias");
    await symlink(first, alias, process.platform === "win32" ? "junction" : "dir");
    expect(() => codexKeyringAccount(alias)).toThrow(/alias/);
    expect(codexKeyringAccount(second)).not.toBe(codexKeyringAccount(first));
    expect(() => codexKeyringAccount("~/.codex")).toThrow(/absolute/);
  });

  test("managed startup refuses aliased home, workspace and state before launching a vendor process", async () => {
    const root = await fixture();
    const script = fileURLToPath(
      new URL("./test-fixtures/fake-codex-app-server.mjs", import.meta.url),
    );
    for (const selected of ["home", "workspace", "state"] as const) {
      const base = join(root, selected);
      const outside = join(base, "outside");
      await mkdir(outside, { recursive: true });
      const alias = join(base, "alias");
      await symlink(outside, alias, process.platform === "win32" ? "junction" : "dir");
      const log = join(base, "startup.jsonl");
      const runtime = new CodexAppServerRuntime({
        resolveManagedCommand: async (info) => info,
        managedCatalogPlatform: {
          invocation: (command, args) => ({ command, args: [...args] }),
          previousSha256: async () => null,
        },
        codexHome: selected === "home" ? alias : join(base, "home"),
        workspaceDir: selected === "workspace" ? alias : join(base, "workspace"),
        stateHome: selected === "state" ? alias : join(base, "state"),
        command: process.execPath,
        args: [script, "app-server", "--listen", "stdio://"],
        versionArgs: [script, "--version"],
        env: { ...managed, HOME: root, PATH: process.env.PATH, OMNESIS_FAKE_CODEX_LOG: log },
      });
      try {
        await expect(runtime.verifyManagedCredentialPolicy()).rejects.toThrow(/alias/);
        await expect(readFile(log)).rejects.toMatchObject({ code: "ENOENT" });
        expect(await readdir(outside)).toEqual([]);
      } finally {
        await runtime.dispose();
      }
    }
  });

  test("fresh installation identity changes the namespace while keep-data identity retains it", () => {
    const first = codexPaths("/example/owned-library", "desktop-0000000000000001");
    const kept = codexPaths("/example/owned-library", "desktop-0000000000000001");
    const fresh = codexPaths("/example/owned-library", "desktop-0000000000000002");
    expect(codexKeyringAccount(first.home)).toBe(codexKeyringAccount(kept.home));
    expect(codexKeyringAccount(first.home)).not.toBe(codexKeyringAccount(fresh.home));
    expect(first.poolHomeBase).not.toBe(fresh.poolHomeBase);
    expect(codexPaths("/example/owned-library").home).toBe("/example/owned-library/codex-home");
    expect(() => codexPaths("/example/owned-library", "../../untrusted")).toThrow(/identity/);
  });

  test("refuses legacy plaintext and dangling credential links without reading or replacing them", async () => {
    const root = await fixture();
    const auth = join(root, "auth.json");
    await writeFile(auth, "invented earlier credential");
    await expect(assertNoManagedCodexAuthFile(managed, [root])).rejects.toThrow(/Sign out/);
    expect(await readFile(auth, "utf8")).toBe("invented earlier credential");
    await rm(auth);
    await symlink(join(root, "missing"), auth);
    await expect(assertNoManagedCodexAuthFile(managed, [root])).rejects.toThrow(/Sign out/);
    await expect(assertNoManagedCodexAuthFile({}, [root])).resolves.toBeUndefined();
  });

  test("explicit cleanup unlinks only owned pool credentials and never follows their target", async () => {
    const root = await fixture();
    const outside = join(root, "outside.json");
    const pool = join(root, "pool");
    await mkdir(join(pool, "inference", "0"), { recursive: true });
    await writeFile(outside, "unchanged fixture");
    await symlink(outside, join(pool, "inference", "0", "auth.json"));
    expect(await managedCodexPoolAuthFiles(pool)).toHaveLength(1);
    await removeManagedCodexPoolAuth(pool);
    expect(await managedCodexPoolAuthFiles(pool)).toEqual([]);
    expect(await readFile(outside, "utf8")).toBe("unchanged fixture");
  });

  test("every lane and nested pool factory receives the same credential home with distinct workspaces", async () => {
    const root = await fixture();
    const home = join(root, "owned-home");
    const create = vi.fn((_home: string, _workspace: string, _index: number) => ({
      async *runTurn() {},
      dispose: async () => {},
    }));
    const pools = ["interactive", "background", "inference", "nested-1"].map(
      (lane) =>
        new CodexRuntimePool({
          runtimeOptions: { env: managed },
          sharedHome: home,
          poolHomeBase: join(root, "pool", lane),
          poolWorkspaceBase: join(root, "workspace", lane),
          size: 2,
          logger: createLogger("test:codex-managed"),
          createRuntime: create,
        }),
    );
    try {
      expect(create).toHaveBeenCalledTimes(8);
      expect(new Set(create.mock.calls.map((call) => call[0]))).toEqual(new Set([home]));
      expect(new Set(create.mock.calls.map((call) => call[1])).size).toBe(8);
    } finally {
      await Promise.all(pools.map((pool) => pool.dispose()));
    }
  });

  test("actual protocol workers share owned CODEX_HOME but launch with separate state paths and strict keyring flags", async () => {
    const root = await fixture();
    const home = join(root, "owned-home");
    const log = join(root, "protocol.jsonl");
    const script = fileURLToPath(
      new URL("./test-fixtures/fake-codex-app-server.mjs", import.meta.url),
    );
    const workers = ["one", "two"].map(
      (id) =>
        new CodexAppServerRuntime({
          resolveManagedCommand: async (info) => info,
          managedCatalogPlatform: {
            invocation: (command, args) => ({ command, args: [...args] }),
            previousSha256: async () => null,
          },
          codexHome: home,
          workspaceDir: join(root, "workspace", id),
          stateHome: join(root, "state", id),
          command: process.execPath,
          args: [script, "app-server", "--listen", "stdio://"],
          versionArgs: [script, "--version"],
          env: { ...managed, PATH: process.env.PATH, HOME: root, OMNESIS_FAKE_CODEX_LOG: log },
        }),
    );
    try {
      await Promise.all(workers.map((worker) => worker.verifyManagedCredentialPolicy()));
      const events = (await readFile(log, "utf8"))
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as { event: string; payload: { codexHome?: string; argv?: string[] } },
        );
      const startup = events
        .filter((event) => event.event === "startup")
        .map((event) => event.payload);
      expect(startup).toHaveLength(2);
      expect(new Set(startup.map((event) => event.codexHome))).toEqual(new Set([home]));
      for (const event of startup)
        expect(event.argv).toContain('cli_auth_credentials_store="keyring"');
      expect(startup[0]?.argv).not.toEqual(startup[1]?.argv);
      expect(await readFile(join(home, "config.toml"), "utf8")).toContain(
        'cli_auth_credentials_store = "keyring"',
      );
      await expect(assertNoManagedCodexAuthFile(managed, [home])).resolves.toBeUndefined();
    } finally {
      await Promise.all(workers.map((worker) => worker.dispose()));
    }
  });
});

async function managedRuntimeFixture() {
  const root = await fixture();
  const script = fileURLToPath(
    new URL("./test-fixtures/fake-codex-app-server.mjs", import.meta.url),
  );
  return {
    root,
    script,
    options: {
      codexHome: join(root, "owned-home"),
      workspaceDir: join(root, "workspace"),
      stateHome: join(root, "worker-state"),
      command: process.execPath,
      args: [script, "app-server", "--listen", "stdio://"],
      versionArgs: [script, "--version"],
      resolveManagedCommand: async (
        info: import("./codex-app-server-backend.js").CodexRuntimeCommandInfo,
      ) => info,
      managedCatalogPlatform: {
        invocation: (command: string, args: readonly string[]) => ({ command, args: [...args] }),
        previousSha256: async () => null,
      },
      env: {
        ...managed,
        PATH: process.env.PATH,
        HOME: root,
        OMNESIS_CONFIG_DIR: join(root, "library"),
        OMNESIS_SERVICE_INSTANCE: "desktop-" + "a".repeat(16),
        OMNESIS_SECRET_SERVICE: "dev.omnesis.desktop." + "a".repeat(64),
      },
    },
  };
}

test("unconfirmed private discovery cleanup fences runtime reuse and generation retirement", async () => {
  const f = await managedRuntimeFixture();
  const failed = Object.assign(new Error("Invented discovery cleanup uncertainty"), {
    cleanupFailure: "fixture-unjoined-sdk",
  });
  const discovery = vi
    .spyOn(modelDiscovery, "prepareManagedCodexModelCatalog")
    .mockRejectedValueOnce(failed);
  const runtime = new CodexAppServerRuntime(f.options);
  try {
    await expect(runtime.listModels()).rejects.toMatchObject({ cleanupFailure: failed });
    await expect(runtime.probeRuntime()).rejects.toThrow(/cleanup/u);
    await expect(runtime.dispose()).rejects.toThrow(/cleanup/u);
    expect(discovery).toHaveBeenCalledTimes(1);
  } finally {
    discovery.mockRestore();
    await runtime.dispose().catch(() => {});
  }
});

test("a joined or cancelled policy probe does not masquerade as pending process cleanup", async () => {
  const f = await managedRuntimeFixture();
  const runtime = new CodexAppServerRuntime({
    ...f.options,
    env: { ...f.options.env, OMNESIS_FAKE_CODEX_SCENARIO: "managed-policy-refused" },
  });
  const verification = expect(runtime.verifyManagedCredentialPolicy()).rejects.toThrow(
    /strict Keychain|disposed/u,
  );
  await expect(runtime.dispose()).resolves.toBeUndefined();
  await verification;
});
