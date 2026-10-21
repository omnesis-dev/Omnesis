// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, test } from "vitest";

const require = createRequire(new URL("../../packages/cli/package.json", import.meta.url));
const { satisfies } = require("semver");
const installer = readFileSync(new URL("../install.sh", import.meta.url), "utf8");
const root = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
const roots = [];
const definition = (name) => {
  const at = installer.indexOf(`${name}() {`);
  if (at < 0) throw new Error(`Missing installer function ${name}`);
  return installer.slice(at, installer.indexOf("\n}\n", at) + 3);
};
const functions = [
  "node_install_compatible",
  "find_brew",
  "ensure_node",
  "prepare_node_for_install",
]
  .map(definition)
  .join("\n");
const executable = (path, source) => {
  writeFileSync(path, source);
  chmodSync(path, 0o755);
};

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function run(
  version,
  {
    method = "source",
    resolved = method,
    platform = "darwin",
    upgrade = "24.16.0",
    keg = version,
    command = "prepare_node_for_install",
    manager = "apt",
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "omnesis-source-node-"));
  roots.push(dir);
  const bin = join(dir, "bin");
  const prefix = join(dir, "node-keg");
  mkdirSync(bin);
  mkdirSync(join(prefix, "bin"), { recursive: true });
  const currentFile = join(dir, "current-version");
  const kegFile = join(dir, "keg-version");
  const calls = join(dir, "calls");
  writeFileSync(currentFile, version);
  writeFileSync(kegFile, keg);
  writeFileSync(calls, "");
  const fakeNode = (path, versionFile) =>
    executable(
      path,
      `#!${process.execPath}\nconst fs=require('node:fs'),vm=require('node:vm');const version=fs.readFileSync(${JSON.stringify(versionFile)},'utf8');if(process.argv[2]==='--version')console.log('v'+version);else if(process.argv[2]==='-p')console.log(vm.runInNewContext(process.argv[3],{process:{versions:{node:version}}}));else process.exit(64);\n`,
    );
  fakeNode(join(bin, "node"), currentFile);
  fakeNode(join(prefix, "bin", "node"), kegFile);
  executable(
    join(bin, "brew"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\ncase "$1" in --prefix) printf '%s\\n' '${prefix}' ;; upgrade|install) printf '%s' '${upgrade}' > '${kegFile}' ;; esac\n`,
  );
  if (manager === "dnf")
    executable(
      join(bin, "dnf"),
      `#!/bin/sh\nprintf 'dnf %s\\n' "$*" >> '${calls}'\nprintf '%s' '${upgrade}' > '${currentFile}'\n`,
    );
  const script = `${functions}\ninfo() { :; }\nfail() { printf '%s\\n' "$*" >&2; exit 1; }\nresolve_sudo() { return 0; }\nrun_nodesource_setup() { printf 'setup %s\\n' "$*" >> '${calls}'; }\napt_get() { printf 'apt %s\\n' "$*" >> '${calls}'; printf '%s' '${upgrade}' > '${currentFile}'; }\nrun_privileged() { "$@"; }\nresolve_method() { METHOD='${resolved}'; }\n${manager === "dnf" ? 'command() { if [ "$1" = -v ] && [ "$2" = apt-get ]; then return 1; fi; builtin command "$@"; }\n' : ""}METHOD='${method}'\nPLATFORM='${platform}'\n${command}\n`;
  const result = spawnSync(manager === "dnf" ? "bash" : "sh", ["-eu", "-c", script], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  return { ...result, calls: readFileSync(calls, "utf8") };
}

describe("installer source Node requirements", () => {
  test.each([
    "24.15.0",
    "24.16.0",
    "25.0.0",
    "26.0.0",
    "26.1.0",
    "27.0.0",
    "24.16.0-rc.1",
    "26.1.0-rc.1",
    "27.0.0-rc.1",
  ])("matches source engines for Node %s", (version) => {
    const result = run(version, {
      command: "NODE_INSTALL_REQUIREMENT=source; node_install_compatible",
    });
    expect(result.status === 0).toBe(satisfies(version, root.engines.node));
  });
  test("the development pin is accepted by the source predicate", () => {
    const version = readFileSync(new URL("../../.nvmrc", import.meta.url), "utf8").trim();
    expect(
      run(version, { command: "NODE_INSTALL_REQUIREMENT=source; node_install_compatible" }).status,
    ).toBe(0);
  });
  test.each(["24.15.0", "25.0.0", "26.0.0"])(
    "upgrades an installed Homebrew keg for source Node %s",
    (version) => {
      const result = run(version, { keg: "24.15.0" });
      expect(result.status, result.stderr).toBe(0);
      expect(result.calls).toContain("upgrade node@24");
      expect(result.calls).not.toContain("install node@24");
    },
  );
  test.each(["24.16.0", "26.1.0"])("leaves supported source Node %s untouched", (version) => {
    const result = run(version);
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toBe("");
  });
  test("selects an existing supported keg before attempting an upgrade", () => {
    const result = run("24.15.0", { keg: "24.16.0" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toContain("--prefix node@24");
    expect(result.calls).not.toMatch(/upgrade|install/);
  });
  test("refuses to build when a Homebrew upgrade still selects an unsupported Node", () => {
    const result = run("24.15.0", { upgrade: "24.15.0" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Node install did not produce Node >=24.16.0 <25 || >=26.1.0");
  });
  test.each(["package", "auto"])(
    "keeps runtime Node 24.15 for resolved package method %s",
    (method) => {
      const result = run("24.15.0", { method, resolved: "package" });
      expect(result.status, result.stderr).toBe(0);
      expect(result.calls).toBe("");
    },
  );
  test.each(["apt", "dnf"])(
    "installs and verifies Node 24 with %s after auto resolves to source",
    (manager) => {
      const result = run("25.0.0", {
        method: "auto",
        resolved: "source",
        platform: "linux",
        manager,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.calls).toContain("setup https://");
      expect(result.calls).toContain(
        manager === "apt" ? "apt install -y nodejs" : "dnf install -y nodejs",
      );
    },
  );
});
