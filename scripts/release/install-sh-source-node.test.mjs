// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
  // The preload heredoc holds lines of its own that close with "}".
  const end = name === "npm_trust_preload" ? "\nEOF\n}\n" : "\n}\n";
  return installer.slice(at, installer.indexOf(end, at) + end.length);
};
const functions = [
  "node_install_compatible",
  "find_brew",
  "ensure_node",
  "prepare_node_for_install",
  "cleanup_temp_files",
  "npm_trust_preload",
  "with_npm_trust",
  "npm",
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
    forceColor,
    nodesourceCleans = false,
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
      `#!${process.execPath}\nconst fs=require('node:fs'),vm=require('node:vm');const version=fs.readFileSync(${JSON.stringify(versionFile)},'utf8');if(process.argv[2]==='--version')console.log('v'+version);else if(process.argv[2]==='-p')console.log(vm.runInNewContext(process.argv[3],{process:{versions:{node:version}}}));else if(process.argv[2]==='-e')vm.runInNewContext(process.argv[3],{process:{versions:{node:version},exit:process.exit}});else process.exit(64);\n`,
    );
  fakeNode(join(bin, "node"), currentFile);
  fakeNode(join(prefix, "bin", "node"), kegFile);
  executable(
    join(bin, "brew"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\ncase "$1" in --prefix) printf '%s\\n' '${prefix}' ;; upgrade|install) printf '%s' '${upgrade}' > '${kegFile}' ;; esac\n`,
  );
  if (manager === "apt") executable(join(bin, "apt-get"), "#!/bin/sh\nexit 99\n");
  if (nodesourceCleans) {
    for (const tool of ["cat", "mkdir", "rm", "sed"]) {
      const path = spawnSync("/bin/sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout;
      symlinkSync(path.trim(), join(bin, tool));
    }
    // A mktemp whose directories hold a space, as GNU mktemp gives under such a
    // TMPDIR: NODE_OPTIONS splits on spaces, so the preload URL must not.
    executable(
      join(bin, "mktemp"),
      `#!/bin/sh\nn=$(cat '${dir}/mktemp-n' 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > '${dir}/mktemp-n'\nd='${dir}/tmp with space #'"$n"\nmkdir "$d" && printf '%s\\n' "$d"\n`,
    );
    // A stand-in npm that records whether the preload URL it is given is one
    // NODE_OPTIONS keeps whole and names a file that exists.
    executable(
      join(bin, "npm"),
      `#!/bin/sh\npreload=$(printf '%s' "\${NODE_OPTIONS##*--import=file://}" | sed 's/%20/ /g; s/%23/#/g; s/%3F/?/g; s/%25/%/g')\ncase "\${NODE_OPTIONS##*--import=}" in *" "*) preload=; esac\nif [ -f "$preload" ]; then echo "npm preload ok" >> '${calls}'; else echo "npm preload missing" >> '${calls}'; fi\n`,
    );
  }
  if (manager === "dnf")
    executable(
      join(bin, "dnf"),
      `#!/bin/sh\nprintf 'dnf %s\\n' "$*" >> '${calls}'\nprintf '%s' '${upgrade}' > '${currentFile}'\n`,
    );
  const script = `${functions}\ninfo() { :; }\nfail() { printf '%s\\n' "$*" >&2; exit 1; }\nresolve_sudo() { return 0; }\nrun_nodesource_setup() { printf 'setup %s\\n' "$*" >> '${calls}';${nodesourceCleans ? " cleanup_temp_files;" : ""} }\napt_get() { printf 'apt %s\\n' "$*" >> '${calls}'; printf '%s' '${upgrade}' > '${currentFile}'; }\nrun_privileged() { "$@"; }\nresolve_method() { METHOD='${resolved}'; }\nMETHOD='${method}'\nPLATFORM='${platform}'\n${command}\n`;
  const result = spawnSync("/bin/sh", ["-eu", "-c", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      // Discover only fixture tools, including on hosts without apt-get.
      PATH: bin,
      ...(forceColor === undefined ? {} : { FORCE_COLOR: forceColor }),
    },
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
  test("source compatibility uses exit status even when terminal colors are forced", () => {
    const result = run("24.16.0", { forceColor: "1" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toBe("");
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

describe("installer npm trust preload", () => {
  test("an npm after a NodeSource install still gets the preload", () => {
    // run_nodesource_setup ends with cleanup_temp_files, which removes the
    // preload directory mid-run; the next npm must not reuse its dead path.
    const result = run("22.0.0", {
      platform: "linux",
      upgrade: "24.22.1",
      nodesourceCleans: true,
      command: 'NPM_TRUST_DIR=""; ensure_node; npm view omnesis version; cleanup_temp_files',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toContain("setup https://deb.nodesource.com/setup_24.x");
    expect(result.calls).toContain("npm preload ok");
    expect(result.calls).not.toContain("npm preload missing");
  });
});
