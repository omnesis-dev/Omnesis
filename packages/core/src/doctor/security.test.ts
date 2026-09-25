// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createRecoveryEnvelope, generateRecoveryCode } from "../recovery-envelope.js";
import { collectSecurityData, type SecurityCommandRunner } from "./security.js";

/** Every directory in a tree, root first — what a fixture has to make 0700. */
function walkDirs(root: string): string[] {
  const found = [root];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) found.push(...walkDirs(join(root, entry.name)));
  }
  return found;
}

// Unit-file *generation* lives in the CLI, which is the only thing that
// writes units. This file drives the collector from hand-written fixtures
// so it is independent of that generator; the round-trip — that a generated
// unit satisfies the directives asserted here — is covered by
// `packages/cli/src/service/unit-audit.test.ts`.

const dirs: string[] = [];

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function runner(stdout: string, code = 0): SecurityCommandRunner {
  return async (cmd, args) => {
    if (cmd === "secret-tool") return { code: 127, stdout: "", stderr: "not found" };
    if (cmd === "security") return { code: 127, stdout: "", stderr: "not found" };
    return { code, stdout, stderr: code === 0 ? "" : stdout };
  };
}

function linuxKeyringRunner(rootKey: string | null): SecurityCommandRunner {
  return async (cmd, args) => {
    if (cmd === "findmnt") return { code: 0, stdout: "/dev/mapper/cryptroot ext4 rw", stderr: "" };
    if (cmd === "secret-tool" && args[0] === "lookup") {
      return rootKey === null
        ? { code: 1, stdout: "", stderr: "" }
        : { code: 0, stdout: rootKey, stderr: "" };
    }
    if (cmd === "busctl" && args.at(-1) === "Collections") {
      return {
        code: 0,
        stdout: 'ao 1 "/org/freedesktop/secrets/collection/login"\n',
        stderr: "",
      };
    }
    if (cmd === "busctl" && args.at(-1) === "Locked") {
      return { code: 0, stdout: "b false\n", stderr: "" };
    }
    return { code: 127, stdout: "", stderr: "not found" };
  };
}

describe("collectSecurityData — permissions", () => {
  test("reports owner-only files and directories as ok", async () => {
    const configDir = tmp("omnesis-security-ok-");
    writeFileSync(join(configDir, "token"), "omn_test\n", { mode: 0o600 });
    chmodSync(configDir, 0o700);

    const data = await collectSecurityData({
      configDir,
      fixPermissions: false,
      platform: "linux",
      homeDir: tmp("omnesis-home-"),
      runCommand: runner("/dev/mapper/cryptroot ext4 rw"),
    });

    expect(data.permissionEntries).toEqual([]);
    expect(data.permissionScanTruncated).toBe(false);
    expect(data.diskEncryption.status).toBe("on");
  });

  test("fixPermissions repairs file and directory modes", async () => {
    const configDir = tmp("omnesis-security-fix-");
    const providerDir = join(configDir, "provider-auth");
    mkdirSync(providerDir);
    writeFileSync(join(providerDir, "tokens.json"), "{}\n");
    chmodSync(configDir, 0o755);
    chmodSync(providerDir, 0o755);
    chmodSync(join(providerDir, "tokens.json"), 0o644);

    const data = await collectSecurityData({
      configDir,
      fixPermissions: true,
      platform: "darwin",
      homeDir: tmp("omnesis-home-"),
      runCommand: runner("FileVault is Off."),
    });

    expect(data.permissionEntries.filter((entry) => entry.fixed).length).toBeGreaterThanOrEqual(2);
    expect(statSync(configDir).mode & 0o777).toBe(0o700);
    expect(statSync(providerDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(providerDir, "tokens.json")).mode & 0o777).toBe(0o600);
    expect(data.diskEncryption.status).toBe("off");
  });

  test("fixPermissions preserves only the pinned Codex runtime executables", async () => {
    const configDir = tmp("omnesis-security-codex-runtime-");
    const wrapper = join(
      configDir,
      "codex-runtimes/versions/0.151.0--update-1/node_modules/@openai/codex/bin/codex.js",
    );
    const native = join(
      configDir,
      "codex-runtimes/staging/update-1/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex",
    );
    const adjacent = join(
      configDir,
      "codex-runtimes/versions/0.151.0--update-1/node_modules/@openai/codex/bin/unexpected",
    );
    const unrecognizedGeneration = join(
      configDir,
      "codex-runtimes/versions/not-a-generation/node_modules/@openai/codex/bin/codex.js",
    );
    for (const path of [wrapper, native, adjacent, unrecognizedGeneration]) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "synthetic", { mode: 0o700 });
    }

    await collectSecurityData({
      configDir,
      fixPermissions: true,
      platform: "linux",
      homeDir: tmp("omnesis-home-"),
      runCommand: runner("/dev/mapper/cryptroot ext4 rw"),
    });

    expect(statSync(wrapper).mode & 0o777).toBe(0o700);
    expect(statSync(native).mode & 0o777).toBe(0o700);
    expect(statSync(adjacent).mode & 0o777).toBe(0o600);
    expect(statSync(unrecognizedGeneration).mode & 0o777).toBe(0o600);
  });

  test.each([
    "codex-home",
    "codex-home-pool/0",
    "codex-home-pool/inference/1",
    "codex-home-pool/nested-2/0",
  ])("preserves existing executable plugin assets in %s while repairing exposure", async (home) => {
    const configDir = tmp("omnesis-security-plugin-assets-");
    const assets = [
      ".tmp/plugins/plugins/synthetic-plugin/scripts/convert.py",
      ".tmp/plugins/plugins/synthetic-plugin/bin/extensionless-tool",
      ".tmp/plugins/.agents/skills/synthetic-skill/scripts/build.py",
      ".tmp/plugins/.git/hooks/pre-commit.sample",
      "plugins/cache/synthetic-market/synthetic-plugin/1.0/bin/tool",
    ];
    for (const [index, asset] of assets.entries()) {
      const path = join(configDir, home, asset);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "synthetic executable fixture\n");
      chmodSync(path, index % 2 === 0 ? 0o700 : 0o755);
    }
    const dataFile = join(
      configDir,
      home,
      "plugins/cache/synthetic-market/synthetic-plugin/1.0/data.json",
    );
    writeFileSync(dataFile, "{}\n", { mode: 0o600 });
    for (const dir of walkDirs(configDir)) chmodSync(dir, 0o700);
    const inspect = (fixPermissions: boolean) =>
      collectSecurityData({
        configDir,
        fixPermissions,
        platform: "linux",
        homeDir: tmp("omnesis-home-"),
        runCommand: runner("/dev/mapper/cryptroot ext4 rw"),
      });
    const before = await inspect(false);
    expect(before.permissionEntries).toHaveLength(2);
    expect(before.permissionEntries.every((entry) => entry.expectedMode === 0o700)).toBe(true);
    await inspect(true);
    for (const asset of assets)
      expect(statSync(join(configDir, home, asset)).mode & 0o7777).toBe(0o700);
    expect(statSync(dataFile).mode & 0o7777).toBe(0o600);
    expect((await inspect(false)).permissionEntries).toEqual([]);
  });

  test("keeps credentials and paths outside managed plugin roots non-executable and removes special bits", async () => {
    const configDir = tmp("omnesis-security-plugin-boundary-");
    const ordinary = [
      "codex-home/auth.json",
      "codex-home/config.toml",
      "codex-home/installation_id",
      "codex-home/.tmp/unrelated/script",
      "codex-home/.tmp/plugins/unrelated/script",
      "codex-home/.tmp/plugins/.git/config",
      "codex-home/plugins/config.json",
      "codex-home-pool/inference/0/auth.json",
      "codex-home-pool/nested-1/0/config.toml",
      "codex-home-pool/other/0/.tmp/plugins/plugins/example/tool",
      "codex-home-pool/inference/no/.tmp/plugins/plugins/example/tool",
      "provider-auth/token",
      "codex-home\\.tmp\\plugins\\plugins\\example\\tool",
    ];
    for (const relative of ordinary) {
      const path = join(configDir, relative);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "synthetic fixture\n");
      chmodSync(path, 0o700);
    }
    const special = join(configDir, "codex-home/.tmp/plugins/plugins/example/bin/tool");
    mkdirSync(dirname(special), { recursive: true });
    writeFileSync(special, "synthetic fixture\n");
    chmodSync(special, 0o4700);
    for (const dir of walkDirs(configDir)) chmodSync(dir, 0o700);
    await collectSecurityData({
      configDir,
      fixPermissions: true,
      platform: "linux",
      homeDir: tmp("omnesis-home-"),
      runCommand: runner("/dev/mapper/cryptroot ext4 rw"),
    });
    for (const relative of ordinary)
      expect(statSync(join(configDir, relative)).mode & 0o7777).toBe(0o600);
    expect(statSync(special).mode & 0o7777).toBe(0o700);
  });

  test("reports symlinks as unsafe and does not chmod through them", async () => {
    const configDir = tmp("omnesis-security-symlink-");
    const outside = tmp("omnesis-security-outside-");
    const target = join(outside, "token-copy");
    writeFileSync(target, "secret\n", { mode: 0o644 });
    chmodSync(target, 0o644);
    symlinkSync(target, join(configDir, "token-link"));
    chmodSync(configDir, 0o700);

    const data = await collectSecurityData({
      configDir,
      fixPermissions: true,
      platform: "linux",
      homeDir: tmp("omnesis-home-"),
      runCommand: runner("/dev/mapper/cryptroot ext4 rw"),
    });

    const link = data.permissionEntries.find((entry) => entry.relativePath === "token-link");
    expect(link?.kind).toBe("symlink");
    expect(link?.ok).toBe(false);
    expect(link?.fixed).toBe(false);
    expect(statSync(target).mode & 0o777).toBe(0o644);
  });

  test("allows Codex argv0 helper symlinks under the runtime temp directory", async () => {
    const configDir = tmp("omnesis-security-codex-link-");
    const outside = tmp("omnesis-security-codex-bin-");
    const target = join(outside, "codex");
    const helperDir = join(configDir, "codex-home", "tmp", "arg0", "codex-test");
    writeFileSync(target, "#!/bin/sh\n", { mode: 0o755 });
    chmodSync(target, 0o755);
    mkdirSync(helperDir, { recursive: true });
    symlinkSync(target, join(helperDir, "codex-linux-sandbox"));
    chmodSync(configDir, 0o700);
    chmodSync(join(configDir, "codex-home"), 0o700);
    chmodSync(join(configDir, "codex-home", "tmp"), 0o700);
    chmodSync(join(configDir, "codex-home", "tmp", "arg0"), 0o700);
    chmodSync(helperDir, 0o700);

    const data = await collectSecurityData({
      configDir,
      fixPermissions: true,
      platform: "linux",
      homeDir: tmp("omnesis-home-"),
      runCommand: runner("/dev/mapper/cryptroot ext4 rw"),
    });

    expect(data.permissionEntries).toEqual([]);
    expect(statSync(target).mode & 0o777).toBe(0o755);
  });

  test.each(["0", "inference/0", "nested-1/0"])(
    "allows %s pooled Codex member helpers and its shared-login link",
    async (memberPath) => {
      // A pooled runtime gives every member an isolated home under an index, and
      // points each member's auth.json at the one shared login so a token
      // refreshed by one member is the token the next uses. Both are runtime-made
      // symlinks in the same layout beneath each member home.
      const configDir = tmp("omnesis-security-codex-pool-");
      const outside = tmp("omnesis-security-codex-pool-bin-");
      const target = join(outside, "codex");
      const shared = join(configDir, "codex-home", "auth.json");
      const member = join(configDir, "codex-home-pool", memberPath);
      const helperDir = join(member, "tmp", "arg0", "codex-test");
      writeFileSync(target, "#!/bin/sh\n", { mode: 0o755 });
      chmodSync(target, 0o755);
      mkdirSync(join(configDir, "codex-home"), { recursive: true });
      writeFileSync(shared, "{}\n", { mode: 0o600 });
      mkdirSync(helperDir, { recursive: true });
      symlinkSync(target, join(helperDir, "codex-linux-sandbox"));
      symlinkSync(shared, join(member, "auth.json"));
      for (const dir of walkDirs(configDir)) {
        chmodSync(dir, 0o700);
      }

      const data = await collectSecurityData({
        configDir,
        fixPermissions: true,
        platform: "linux",
        homeDir: tmp("omnesis-home-"),
        runCommand: runner("/dev/mapper/cryptroot ext4 rw"),
      });

      expect(data.permissionEntries).toEqual([]);
      expect(statSync(target).mode & 0o777).toBe(0o755);
    },
  );

  test.each(["0", "inference/0", "nested-1/0"])(
    "does not allow %s shared-login link to point somewhere else",
    async (memberPath) => {
      // The discriminating half, and the reason the login link is checked against
      // a path rather than by its name. A symlink is the one entry this scan
      // cannot judge by its mode, so an allowance by name alone would let any
      // link called auth.json out of the config directory unremarked — and the
      // realistic destination has exactly the right filename, in another
      // directory, which is why this one does too.
      const configDir = tmp("omnesis-security-codex-pool-escape-");
      const outside = tmp("omnesis-security-codex-elsewhere-");
      const elsewhere = join(outside, "auth.json");
      const member = join(configDir, "codex-home-pool", memberPath);
      writeFileSync(elsewhere, "{}\n", { mode: 0o600 });
      mkdirSync(member, { recursive: true });
      symlinkSync(elsewhere, join(member, "auth.json"));
      for (const dir of walkDirs(configDir)) chmodSync(dir, 0o700);

      const data = await collectSecurityData({
        configDir,
        fixPermissions: true,
        platform: "linux",
        homeDir: tmp("omnesis-home-"),
        runCommand: runner("/dev/mapper/cryptroot ext4 rw"),
      });

      expect(data.permissionEntries.map((e) => e.relativePath)).toEqual([
        join("codex-home-pool", memberPath, "auth.json"),
      ]);
      expect(data.permissionEntries[0]?.kind).toBe("symlink");
      expect(data.permissionEntries[0]?.fixed, "the scan chmodded through a symlink").toBe(false);
    },
  );

  test("does not allow the owner's own login to be a link", async () => {
    // Only a pooled member shares a login; the home the members point at holds
    // the real file. A link in its place is not something the runtime makes, and
    // the scan has no way to judge where it leads.
    const configDir = tmp("omnesis-security-codex-owner-link-");
    const home = join(configDir, "codex-home");
    const auth = join(home, "auth.json");
    mkdirSync(home, { recursive: true });
    symlinkSync(auth, join(home, "auth.json.link"));
    renameSync(join(home, "auth.json.link"), auth);
    chmodSync(configDir, 0o700);
    chmodSync(home, 0o700);

    const data = await collectSecurityData({
      configDir,
      fixPermissions: true,
      platform: "linux",
      homeDir: tmp("omnesis-home-"),
      runCommand: runner("/dev/mapper/cryptroot ext4 rw"),
    });

    expect(data.permissionEntries.map((e) => e.relativePath)).toEqual([
      join("codex-home", "auth.json"),
    ]);
  });

  test("does not read a filename as the path it spells", async () => {
    // A backslash is a legal character in a POSIX filename. Split on both
    // separators, a single flat entry whose *name* contains them is read as the
    // directories it never had — one link, sitting in the open, wearing the
    // whole allowed path as its name.
    const configDir = tmp("omnesis-security-codex-spelled-");
    const outside = tmp("omnesis-security-codex-spelled-target-");
    const target = join(outside, "codex");
    writeFileSync(target, "#!/bin/sh\n", { mode: 0o755 });
    const spelled = "codex-home-pool\\0\\tmp\\arg0\\codex-x\\codex-linux-sandbox";
    symlinkSync(target, join(configDir, spelled));
    chmodSync(configDir, 0o700);

    const data = await collectSecurityData({
      configDir,
      fixPermissions: true,
      platform: "linux",
      homeDir: tmp("omnesis-home-"),
      runCommand: runner("/dev/mapper/cryptroot ext4 rw"),
    });

    expect(data.permissionEntries.map((e) => e.relativePath)).toEqual([spelled]);
  });

  test("allows only the helper names, under a directory the runtime named", async () => {
    // Everything about the helper shape is a name: the scan cannot check where a
    // helper leads, because it leads to whichever binary the runtime was
    // launched from. So each part of the name has to carry its weight — a
    // member index that is an index, a temp directory the runtime made, and one
    // of the four helpers it makes there.
    const configDir = tmp("omnesis-security-codex-shape-");
    const outside = tmp("omnesis-security-codex-shape-target-");
    const target = join(outside, "codex");
    writeFileSync(target, "#!/bin/sh\n", { mode: 0o755 });
    const rejected = [
      join("codex-home-pool", "not-an-index", "tmp", "arg0", "codex-x", "apply_patch"),
      join("codex-home-pool", "inference", "not-an-index", "tmp", "arg0", "codex-x", "apply_patch"),
      join("codex-home-pool", "nested-no", "0", "tmp", "arg0", "codex-x", "apply_patch"),
      join("codex-home-pool", "other-lane", "0", "tmp", "arg0", "codex-x", "apply_patch"),
      join("codex-home-pool", "0", "tmp", "arg0", "sandbox", "apply_patch"),
      join("codex-home-pool", "0", "tmp", "arg0", "codex-x", "curl"),
      join("codex-home", "tmp", "arg0", "codex-x", "curl"),
    ];
    for (const relative of rejected) {
      mkdirSync(join(configDir, dirname(relative)), { recursive: true });
      symlinkSync(target, join(configDir, relative));
    }
    for (const dir of walkDirs(configDir)) chmodSync(dir, 0o700);

    const data = await collectSecurityData({
      configDir,
      fixPermissions: true,
      platform: "linux",
      homeDir: tmp("omnesis-home-"),
      runCommand: runner("/dev/mapper/cryptroot ext4 rw"),
    });

    expect(data.permissionEntries.map((e) => e.relativePath).sort()).toEqual([...rejected].sort());
  });

  test("continues scanning after a large safe subtree", async () => {
    const configDir = tmp("omnesis-security-large-");
    const safeDir = join(configDir, "a-safe");
    const badDir = join(configDir, "z-bad");
    mkdirSync(safeDir);
    mkdirSync(badDir);
    chmodSync(configDir, 0o700);
    chmodSync(safeDir, 0o700);
    chmodSync(badDir, 0o755);
    for (let i = 0; i < 5_050; i += 1) {
      writeFileSync(join(safeDir, `safe-${String(i).padStart(4, "0")}.txt`), "\n", {
        mode: 0o600,
      });
    }

    const data = await collectSecurityData({
      configDir,
      fixPermissions: false,
      platform: "linux",
      homeDir: tmp("omnesis-home-"),
      runCommand: runner("/dev/mapper/cryptroot ext4 rw"),
    });

    expect(data.permissionScanTruncated).toBe(false);
    expect(data.permissionEntries.map((entry) => entry.relativePath)).toContain("z-bad");
  });
});

describe("collectSecurityData — gateway isolation", () => {
  // A human login account and a system service account, as they appear in
  // /etc/passwd. `maya` is the operator; `jamie` is a second human on the
  // same machine; `omnesis-svc` is a dedicated service account.
  const PASSWD_FIXTURE = [
    "root:x:0:0:root:/root:/bin/bash",
    "omnesis-svc:x:970:970::/var/lib/omnesis-gateway:/usr/sbin/nologin",
    "nobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin",
    "maya:x:1000:1000::/home/maya:/bin/bash",
    "jamie:x:1001:1001::/home/jamie:/bin/bash",
    "",
  ].join("\n");

  function collect(homeDir: string, hardenedUnitPath: string) {
    const passwdPath = join(tmp("omnesis-passwd-"), "passwd");
    writeFileSync(passwdPath, PASSWD_FIXTURE);
    return collectSecurityData({
      configDir: join(homeDir, ".config", "omnesis"),
      fixPermissions: false,
      platform: "linux",
      homeDir,
      hardenedUnitPath,
      passwdPath,
      runCommand: runner("/dev/mapper/cryptroot ext4 rw"),
    });
  }

  function writeSystemUnit(body: string): { homeDir: string; unitPath: string } {
    const homeDir = tmp("omnesis-home-");
    const unitPath = join(tmp("omnesis-etc-"), "omnesis-gateway.service");
    writeFileSync(unitPath, body);
    return { homeDir, unitPath };
  }

  test("DynamicUser=yes is dedicated-user", async () => {
    const { homeDir, unitPath } = writeSystemUnit(
      "[Service]\nExecStart=/usr/local/bin/omnesis gateway serve\nDynamicUser=yes\n",
    );
    const data = await collect(homeDir, unitPath);
    expect(data.gatewayIsolation.status).toBe("dedicated-user");
    expect(data.gatewayIsolation.detail).toContain("DynamicUser");
  });

  test("a User= naming a system account is dedicated-user", async () => {
    const { homeDir, unitPath } = writeSystemUnit(
      "[Service]\nExecStart=/usr/local/bin/omnesis gateway serve\nUser=omnesis-svc\n",
    );
    const data = await collect(homeDir, unitPath);
    expect(data.gatewayIsolation.status).toBe("dedicated-user");
    expect(data.gatewayIsolation.detail).toContain("omnesis-svc");
  });

  test("a User= naming the operator's login account is login-user", async () => {
    const { homeDir, unitPath } = writeSystemUnit(
      "[Service]\nExecStart=/usr/local/bin/omnesis gateway serve\nUser=maya\n",
    );
    const data = await collect(homeDir, unitPath);
    expect(data.gatewayIsolation.status).toBe("login-user");
  });

  // The classification is a property of the host's account database, not of
  // whoever happens to be running the check. Any human login account is
  // "no isolation" — a second human's account grants a login session on the
  // same machine just as the operator's does, and a gateway evaluating its
  // own unit must reach the same verdict the CLI does.
  test("a User= naming a different human's account is still login-user", async () => {
    const { homeDir, unitPath } = writeSystemUnit(
      "[Service]\nExecStart=/usr/local/bin/omnesis gateway serve\nUser=jamie\n",
    );
    const data = await collect(homeDir, unitPath);
    expect(data.gatewayIsolation.status).toBe("login-user");
  });

  test("User=nobody is dedicated-user despite its high uid", async () => {
    const { homeDir, unitPath } = writeSystemUnit(
      "[Service]\nExecStart=/usr/local/bin/omnesis gateway serve\nUser=nobody\n",
    );
    const data = await collect(homeDir, unitPath);
    expect(data.gatewayIsolation.status).toBe("dedicated-user");
  });

  test("User=root is login-user — root is no isolation from the corpus", async () => {
    const { homeDir, unitPath } = writeSystemUnit(
      "[Service]\nExecStart=/usr/local/bin/omnesis gateway serve\nUser=root\n",
    );
    const data = await collect(homeDir, unitPath);
    expect(data.gatewayIsolation.status).toBe("login-user");
  });

  test("only a user-level gateway unit is login-user", async () => {
    const homeDir = tmp("omnesis-home-");
    const unitDir = join(homeDir, ".config", "systemd", "user");
    mkdirSync(unitDir, { recursive: true });
    writeFileSync(
      join(unitDir, "omnesis-gateway.service"),
      "[Service]\nExecStart=/usr/local/bin/omnesis gateway serve\nUMask=0077\n",
    );

    const data = await collect(homeDir, join(tmp("omnesis-etc-"), "omnesis-gateway.service"));
    expect(data.gatewayIsolation.status).toBe("login-user");
  });

  test("no gateway unit at all is not-installed", async () => {
    const homeDir = tmp("omnesis-home-");
    const data = await collect(homeDir, join(tmp("omnesis-etc-"), "omnesis-gateway.service"));
    expect(data.gatewayIsolation.status).toBe("not-installed");
  });

  // Every case below would previously have been reported as an isolated
  // install. A security check that cannot answer must say so rather than
  // pass, so these all land on `unknown`.
  test("an unreadable account database is unknown, not a pass", async () => {
    const homeDir = tmp("omnesis-home-");
    const unitPath = join(tmp("omnesis-etc-"), "omnesis-gateway.service");
    writeFileSync(
      unitPath,
      "[Service]\nExecStart=/usr/local/bin/omnesis gateway serve\nUser=omnesis-svc\n",
    );

    const data = await collectSecurityData({
      configDir: join(homeDir, ".config", "omnesis"),
      fixPermissions: false,
      platform: "linux",
      homeDir,
      hardenedUnitPath: unitPath,
      passwdPath: join(tmp("omnesis-passwd-"), "does-not-exist"),
      runCommand: runner("/dev/mapper/cryptroot ext4 rw"),
    });
    expect(data.gatewayIsolation.status).toBe("unknown");
  });

  test("a User= the account database does not know is unknown", async () => {
    // Directory-managed logins (LDAP, SSSD) are absent from /etc/passwd, so
    // an unrecognised name cannot be read as "therefore a service account".
    const { homeDir, unitPath } = writeSystemUnit(
      "[Service]\nExecStart=/usr/local/bin/omnesis gateway serve\nUser=directory-user\n",
    );
    const data = await collect(homeDir, unitPath);
    expect(data.gatewayIsolation.status).toBe("unknown");
  });

  test("a passwd entry with a non-numeric uid is unknown", async () => {
    const homeDir = tmp("omnesis-home-");
    const unitPath = join(tmp("omnesis-etc-"), "omnesis-gateway.service");
    writeFileSync(
      unitPath,
      "[Service]\nExecStart=/usr/local/bin/omnesis gateway serve\nUser=broken\n",
    );
    const passwdPath = join(tmp("omnesis-passwd-"), "passwd");
    writeFileSync(passwdPath, "broken:x:notanumber:1000::/home/broken:/bin/bash\n");

    const data = await collectSecurityData({
      configDir: join(homeDir, ".config", "omnesis"),
      fixPermissions: false,
      platform: "linux",
      homeDir,
      hardenedUnitPath: unitPath,
      passwdPath,
      runCommand: runner("/dev/mapper/cryptroot ext4 rw"),
    });
    expect(data.gatewayIsolation.status).toBe("unknown");
  });

  // systemd tolerates whitespace around a directive's `=`; the collector
  // must too, or a login-user unit reads as isolated.
  test("whitespace around User= does not hide the account", async () => {
    const { homeDir, unitPath } = writeSystemUnit(
      "[Service]\nExecStart=/usr/local/bin/omnesis gateway serve\nUser = maya \n",
    );
    const data = await collect(homeDir, unitPath);
    expect(data.gatewayIsolation.status).toBe("login-user");
  });

  test("DynamicUser accepts systemd's other affirmative spellings", async () => {
    for (const value of ["yes", "true", "1"]) {
      const { homeDir, unitPath } = writeSystemUnit(
        `[Service]\nExecStart=/usr/local/bin/omnesis gateway serve\nDynamicUser=${value}\n`,
      );
      const data = await collect(homeDir, unitPath);
      expect(data.gatewayIsolation.status).toBe("dedicated-user");
    }
  });

  test("an existing but unreadable system unit is assumed dedicated-user", async () => {
    // Root can read anything, so the unreadable-file branch is untestable there.
    if (typeof process.getuid === "function" && process.getuid() === 0) return;
    const { homeDir, unitPath } = writeSystemUnit("DynamicUser=yes\n");
    chmodSync(unitPath, 0o000);

    const data = await collect(homeDir, unitPath);
    expect(data.gatewayIsolation.status).toBe("dedicated-user");
    expect(data.gatewayIsolation.detail).toContain("not readable without root");
  });
});

describe("collectSecurityData — collector component", () => {
  test("excludes gateway services and gateway-only storage concerns", async () => {
    const configDir = tmp("omnesis-collector-security-");
    const homeDir = tmp("omnesis-collector-home-");
    const unitDir = join(homeDir, ".config", "systemd", "user");
    mkdirSync(unitDir, { recursive: true });
    writeFileSync(
      join(unitDir, "omnesis-gateway.service"),
      "[Service]\nEnvironment=OMNESIS_SECRET_STORE=passphrase\n",
    );
    writeFileSync(
      join(unitDir, "omnesis-collector.service"),
      "[Service]\nEnvironment=OMNESIS_SECRET_STORE=file\n",
    );

    const data = await collectSecurityData({
      configDir,
      component: "collector",
      fixPermissions: false,
      platform: "linux",
      homeDir,
      hardenedUnitPath: join(tmp("omnesis-collector-etc-"), "omnesis-gateway.service"),
      runCommand: runner("/dev/mapper/cryptroot ext4 rw"),
    });

    expect(data.serviceUnits.map((unit) => unit.component)).toEqual(["collector"]);
    expect(data.keyringWiring.map((unit) => unit.component)).toEqual(["collector"]);
    expect(data.gatewayIsolation.status).toBe("not-applicable");
    // The collector's own key inventory, not the gateway's: nothing is
    // armed on this fresh directory, so the stores are simply off.
    expect(data.databaseEncryption).toMatchObject({ status: "off", required: false });
    expect(data.databaseEncryption.stores.map((store) => store.keyName)).toEqual([
      "whatsapp-store",
      "imessage-transcripts",
    ]);
  });
});

describe("collectSecurityData — keyring", () => {
  // Backend resolution reads OMNESIS_SECRET_STORE from the ambient
  // environment. An operator shell that exports it (a passphrase-keyring
  // install does) would otherwise steer these cases away from the backend
  // under test, so the default-resolution tests run with it cleared and the
  // one test that cares sets it explicitly.
  let previousBackend: string | undefined;

  beforeEach(() => {
    previousBackend = process.env.OMNESIS_SECRET_STORE;
    delete process.env.OMNESIS_SECRET_STORE;
  });

  afterEach(() => {
    if (previousBackend === undefined) delete process.env.OMNESIS_SECRET_STORE;
    else process.env.OMNESIS_SECRET_STORE = previousBackend;
  });

  test("reports a valid OS-backed install root key", async () => {
    const data = await collectSecurityData({
      configDir: tmp("omnesis-keyring-config-"),
      fixPermissions: false,
      platform: "linux",
      homeDir: tmp("omnesis-home-"),
      runCommand: linuxKeyringRunner(`omn_root_v1_${"a".repeat(43)}`),
    });

    expect(data.keyring.store.backend).toBe("secret-service");
    expect(data.keyring.store.secure).toBe(true);
    expect(data.keyring.present).toBe(true);
    expect(data.keyring.valid).toBe(true);
  });

  test("reports missing Secret Service tooling as unavailable", async () => {
    const data = await collectSecurityData({
      configDir: tmp("omnesis-keyring-missing-"),
      fixPermissions: false,
      platform: "linux",
      homeDir: tmp("omnesis-home-"),
      runCommand: runner("/dev/mapper/cryptroot ext4 rw"),
    });

    expect(data.keyring.store.backend).toBe("secret-service");
    expect(data.keyring.store.available).toBe(false);
    expect(data.keyring.present).toBe(false);
  });

  test("reports Secret Service without a durable login collection as unavailable", async () => {
    const data = await collectSecurityData({
      configDir: tmp("omnesis-keyring-session-only-"),
      fixPermissions: false,
      platform: "linux",
      homeDir: tmp("omnesis-home-"),
      runCommand: async (cmd, args) => {
        if (cmd === "findmnt") {
          return { code: 0, stdout: "/dev/mapper/cryptroot ext4 rw", stderr: "" };
        }
        if (cmd === "secret-tool" && args[0] === "lookup") {
          return { code: 1, stdout: "", stderr: "" };
        }
        if (cmd === "busctl" && args.at(-1) === "Collections") {
          return {
            code: 0,
            stdout: 'ao 1 "/org/freedesktop/secrets/collection/session"\n',
            stderr: "",
          };
        }
        return { code: 127, stdout: "", stderr: "not found" };
      },
    });

    expect(data.keyring.store.backend).toBe("secret-service");
    expect(data.keyring.store.available).toBe(false);
    expect(data.keyring.store.detail).toMatch(/persistent login collection/);
  });

  test("honors an explicit OMNESIS_SECRET_STORE backend", async () => {
    const previous = process.env.OMNESIS_SECRET_STORE;
    process.env.OMNESIS_SECRET_STORE = "file";
    try {
      const data = await collectSecurityData({
        configDir: tmp("omnesis-keyring-file-"),
        fixPermissions: false,
        platform: "linux",
        homeDir: tmp("omnesis-home-"),
        runCommand: runner("/dev/mapper/cryptroot ext4 rw"),
      });

      expect(data.keyring.store.requestedBackend).toBe("file");
      expect(data.keyring.store.backend).toBe("file");
      expect(data.keyring.store.available).toBe(true);
      expect(data.keyring.store.secure).toBe(false);
    } finally {
      if (previous === undefined) {
        delete process.env.OMNESIS_SECRET_STORE;
      } else {
        process.env.OMNESIS_SECRET_STORE = previous;
      }
    }
  });
});

describe("collectSecurityData — recovery escrow", () => {
  function collect(configDir: string) {
    return collectSecurityData({
      configDir,
      fixPermissions: false,
      platform: "linux",
      homeDir: tmp("omnesis-home-"),
      runCommand: linuxKeyringRunner(null),
    });
  }

  function writeEnvelope(configDir: string, contents: string): void {
    mkdirSync(join(configDir, "keyring"), { recursive: true });
    writeFileSync(join(configDir, "keyring", "recovery-envelope.json"), contents);
  }

  test("reports missing when no envelope has been exported", async () => {
    const configDir = tmp("omnesis-escrow-missing-");
    const data = await collect(configDir);
    expect(data.recoveryEscrow.status).toBe("missing");
    expect(data.recoveryEscrow.path).toContain("recovery-envelope.json");
  });

  test("reports exported for a well-formed envelope", async () => {
    const configDir = tmp("omnesis-escrow-ok-");
    const envelope = createRecoveryEnvelope("omn_root_v1_test-root-key", generateRecoveryCode());
    writeEnvelope(configDir, JSON.stringify(envelope));
    const data = await collect(configDir);
    expect(data.recoveryEscrow.status).toBe("exported");
  });

  test("reports corrupt for non-JSON content", async () => {
    const configDir = tmp("omnesis-escrow-badjson-");
    writeEnvelope(configDir, "not json {");
    const data = await collect(configDir);
    expect(data.recoveryEscrow.status).toBe("corrupt");
  });

  test("reports corrupt for JSON that is not a v1 envelope", async () => {
    const configDir = tmp("omnesis-escrow-badshape-");
    writeEnvelope(configDir, JSON.stringify({ omnesis: "something-else", version: 1 }));
    const data = await collect(configDir);
    expect(data.recoveryEscrow.status).toBe("corrupt");
  });
});

describe("keyring wiring", () => {
  function collect(homeDir: string, hardenedUnitPath: string) {
    return collectSecurityData({
      configDir: join(homeDir, ".config", "omnesis"),
      fixPermissions: false,
      platform: "linux",
      homeDir,
      hardenedUnitPath,
      runCommand: async () => ({ code: 1, stdout: "", stderr: "" }),
    });
  }

  function writeUserUnit(homeDir: string, body: string): string {
    const dir = join(homeDir, ".config", "systemd", "user");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "omnesis-gateway.service");
    writeFileSync(path, body);
    return path;
  }

  test("reads the backend and a credential source out of a unit", async () => {
    const homeDir = tmp("omnesis-home-");
    writeUserUnit(
      homeDir,
      [
        "[Service]",
        "ExecStart=/usr/local/bin/omnesis gateway serve",
        "LoadCredential=omnesis-keyring-passphrase:/etc/omnesis/keyring.pass",
        "Environment=OMNESIS_CONFIG_DIR=/home/maya/.config/omnesis",
        "Environment=OMNESIS_SECRET_STORE=passphrase",
        "",
      ].join("\n"),
    );
    const data = await collect(homeDir, join(tmp("omnesis-etc-"), "absent.service"));
    const gateway = data.keyringWiring.find((u) => u.component === "gateway");
    // A unit carries one `Environment=` line per variable, so a last-wins map
    // keyed on the directive name would have kept only OMNESIS_SECRET_STORE or
    // only the config dir, never both.
    expect(gateway).toMatchObject({ backend: "passphrase", passphraseSource: "credential" });
  });

  test("a passphrase backend with no source reads as unwired", async () => {
    const homeDir = tmp("omnesis-home-");
    writeUserUnit(
      homeDir,
      "[Service]\nExecStart=/usr/local/bin/omnesis gateway serve\nEnvironment=OMNESIS_SECRET_STORE=passphrase\n",
    );
    const data = await collect(homeDir, join(tmp("omnesis-etc-"), "absent.service"));
    expect(data.keyringWiring.find((u) => u.component === "gateway")).toMatchObject({
      backend: "passphrase",
      passphraseSource: null,
    });
  });

  test("an unrelated credential is not mistaken for the keyring's", async () => {
    const homeDir = tmp("omnesis-home-");
    writeUserUnit(
      homeDir,
      [
        "[Service]",
        "LoadCredential=some-other-secret:/etc/other.pass",
        "Environment=OMNESIS_SECRET_STORE=passphrase",
        "",
      ].join("\n"),
    );
    const data = await collect(homeDir, join(tmp("omnesis-etc-"), "absent.service"));
    expect(data.keyringWiring.find((u) => u.component === "gateway")?.passphraseSource).toBeNull();
  });

  test("a passphrase file counts as a source, and quoted values are read", async () => {
    const homeDir = tmp("omnesis-home-");
    writeUserUnit(
      homeDir,
      '[Service]\nEnvironment="OMNESIS_KEYRING_PASSPHRASE_FILE=/etc/omnesis dir/keyring.pass"\nEnvironment=OMNESIS_SECRET_STORE=passphrase\n',
    );
    const data = await collect(homeDir, join(tmp("omnesis-etc-"), "absent.service"));
    expect(data.keyringWiring.find((u) => u.component === "gateway")?.passphraseSource).toBe(
      "file",
    );
  });

  test("an encrypted credential counts as a source too", async () => {
    // systemd-creds encrypt only changes how the file is stored at rest; the
    // daemon still reads it from $CREDENTIALS_DIRECTORY under the same name.
    const homeDir = tmp("omnesis-home-");
    writeUserUnit(
      homeDir,
      "[Service]\nLoadCredentialEncrypted=omnesis-keyring-passphrase:/etc/omnesis/keyring.cred\nEnvironment=OMNESIS_SECRET_STORE=passphrase\n",
    );
    const data = await collect(homeDir, join(tmp("omnesis-etc-"), "absent.service"));
    expect(data.keyringWiring.find((u) => u.component === "gateway")?.passphraseSource).toBe(
      "credential",
    );
  });

  test("the hardened unit is reported apart from the user unit of the same component", async () => {
    // One host can carry both, so the two must not collapse into one entry —
    // downstream they become checks that would otherwise share an id.
    const homeDir = tmp("omnesis-home-");
    writeUserUnit(homeDir, "[Service]\nEnvironment=OMNESIS_SECRET_STORE=passphrase\n");
    const systemUnit = join(tmp("omnesis-etc-"), "omnesis-gateway.service");
    writeFileSync(systemUnit, "[Service]\nEnvironment=OMNESIS_SECRET_STORE=file\n");
    const data = await collect(homeDir, systemUnit);
    expect(data.keyringWiring.map((u) => [u.scope, u.backend])).toEqual([
      ["user", "passphrase"],
      ["system", "file"],
    ]);
  });

  test("units that do not exist contribute nothing", async () => {
    const homeDir = tmp("omnesis-home-");
    const data = await collect(homeDir, join(tmp("omnesis-etc-"), "absent.service"));
    expect(data.keyringWiring).toEqual([]);
  });
});

describe("unreadable key material", () => {
  // Root ignores the mode bits this fixture relies on.
  const asUnprivilegedUser = (process.getuid?.() ?? 0) !== 0;
  let savedBackend: string | undefined;

  beforeEach(() => {
    savedBackend = process.env.OMNESIS_SECRET_STORE;
  });
  afterEach(() => {
    if (savedBackend === undefined) delete process.env.OMNESIS_SECRET_STORE;
    else process.env.OMNESIS_SECRET_STORE = savedBackend;
  });

  // Both arms matter and they fail at different depths: a backend whose store
  // lives in the config dir throws from the root-key read, while one whose
  // store lives outside it reads the root key fine and only trips on the
  // wrapped keys and markers underneath the same unreadable directory.
  for (const backend of ["file", "secret-service"] as const) {
    test.skipIf(!asUnprivilegedUser)(
      `reports the keyring as unreadable instead of abandoning the report (${backend})`,
      async () => {
        process.env.OMNESIS_SECRET_STORE = backend;
        // The condition an operator runs the doctor to diagnose: it must not
        // throw the report away, and must not describe the install as unarmed,
        // which is what every underlying reading answers on its own.
        const configDir = tmp("omnesis-doctor-unreadable-");
        const keyring = join(configDir, "keyring");
        mkdirSync(keyring, { recursive: true });
        writeFileSync(
          join(keyring, "storage-encryption-required"),
          "omnesis.storage-encryption.required.v1\n",
        );
        chmodSync(keyring, 0o000);
        try {
          const data = await collectSecurityData({
            configDir,
            fixPermissions: false,
            platform: "linux",
            homeDir: tmp("omnesis-doctor-home-"),
            runCommand: async () => ({ code: 1, stdout: "", stderr: "" }),
          });
          expect(data.keyringAccess).toMatchObject({ readable: false });
          // Not reported as a plain "off" install — that is the misreading.
          expect(data.databaseEncryption.status).toBe("blocked");
          expect(data.keyring.valid).toBe(false);
        } finally {
          chmodSync(keyring, 0o700);
        }
      },
    );
  }

  test("a readable install reports its keyring as readable", async () => {
    const configDir = tmp("omnesis-doctor-readable-");
    const data = await collectSecurityData({
      configDir,
      fixPermissions: false,
      platform: "linux",
      homeDir: tmp("omnesis-doctor-home-"),
      runCommand: async () => ({ code: 1, stdout: "", stderr: "" }),
    });
    expect(data.keyringAccess.readable).toBe(true);
  });
});
