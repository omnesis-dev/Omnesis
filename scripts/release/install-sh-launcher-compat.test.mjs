// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";

const installer = readFileSync("scripts/install.sh", "utf8");
const scratch = [];
afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});
function definition(name) {
  const start = installer.indexOf(`${name}() {`);
  const end =
    name === "render_source_wrapper"
      ? installer.indexOf("\nEOF\n}", start) + 6
      : name === "npm_trust_preload" || name === "render_source_npm_trust"
        ? installer.indexOf("\nEOF\n}\n", start) + 7
        : installer.indexOf("\n}\n", start) + 3;
  expect(start).toBeGreaterThan(0);
  return installer.slice(start, end);
}
const functions = [
  "shell_single_quote",
  "npm_trust_preload",
  "render_source_npm_trust",
  "render_source_wrapper",
  "render_installed_source_wrapper",
  "write_source_wrapper",
  "source_wrapper_is_installer_owned",
]
  .map(definition)
  .join("\n");
function fixture({ reserved = true, temporaryRoot = tmpdir() } = {}) {
  // The installer records pwd -P paths; macOS TMPDIR can begin with /var,
  // whose physical path begins with /private/var. Match that contract here.
  const dir = realpathSync(mkdtempSync(join(temporaryRoot, "source-family-")));
  scratch.push(dir);
  const root = join(dir, reserved ? "source #with?owner's path" : "source with owner's path"),
    home = join(dir, "home"),
    config = join(dir, "config");
  mkdirSync(join(root, "packages/cli/src/update"), { recursive: true });
  mkdirSync(join(home, ".local/bin"), { recursive: true });
  mkdirSync(config);
  writeFileSync(join(root, "packages/cli/package.json"), JSON.stringify({ type: "module" }));
  symlinkSync(resolve("node_modules"), join(root, "node_modules"), "dir");
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", [
    "-C",
    root,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.com",
    "commit",
    "-qm",
    "fixture",
    "--allow-empty",
  ]);
  return {
    dir,
    root,
    home,
    config,
    helper: join(home, ".local/lib/omnesis/update-lock.cjs"),
    launcher: join(home, ".local/bin/omnesis"),
  };
}
function run(f, command) {
  return spawnSync(
    "sh",
    [
      "-eu",
      "-c",
      `${functions}\nwrite_source_update_lock_helper() { :; }\ninfo() { :; }\nprint_path_hint() { :; }\nfail() { echo "$*" >&2; exit 17; }\n${command}`,
    ],
    {
      encoding: "utf8",
      timeout: 15000,
      env: {
        ...process.env,
        HOME: f.home,
        CONFIG_DIR: f.config,
        ROOT: f.root,
        UPDATE_LOCK_HELPER: f.helper,
        SOURCE_WRAPPER: f.launcher,
        SOURCE_WRAPPER_EXPECTED_TMP: "",
      },
    },
  );
}
function render(f, family) {
  const result = run(f, `render_source_wrapper "$ROOT" ${family}`);
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}
function commitRenderer(f) {
  execFileSync("git", ["-C", f.root, "add", "packages/cli/src/update/source-launcher.ts"]);
  execFileSync("git", [
    "-C",
    f.root,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.com",
    "commit",
    "-qm",
    "target renderer",
    "--allow-empty",
  ]);
}
function target(f, content, { commit = true } = {}) {
  writeFileSync(join(f.root, "packages/cli/src/update/source-launcher.ts"), content);
  if (commit) commitRenderer(f);
}
function currentTarget(f) {
  for (const name of ["source-launcher.ts", "node-gyp-headers.ts"])
    writeFileSync(
      join(f.root, "packages/cli/src/update", name),
      readFileSync(`packages/cli/src/update/${name}`),
    );
  commitRenderer(f);
}
function managed(f) {
  execFileSync("git", ["init", "-q", f.root]);
  execFileSync("git", ["-C", f.root, "config", "omnesis.install", "managed"]);
  execFileSync("git", [
    "-C",
    f.root,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.com",
    "commit",
    "-qm",
    "fixture",
    "--allow-empty",
  ]);
  const commit = execFileSync("git", ["-C", f.root, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  writeFileSync(
    join(f.config, "update-state.json"),
    JSON.stringify({ version: 1, method: "source", phase: "complete", rootDir: f.root, commit }),
  );
}

// Frozen v0.6.0 ownership contract: that CLI requires the legacy runner
// literal even when the durable SOURCE_ROOT header is otherwise correct.
function stableOwns(content, root) {
  const quote = (value) => `'${value.replaceAll("'", `'"'"'`)}'`;
  const ownsRoot =
    content.includes(`SOURCE_ROOT=${quote(root)}\n`) ||
    (content.includes(`"${root}/node_modules/.bin/tsx"`) &&
      content.includes(`"${root}/packages/cli/src/index.ts"`));
  return (
    content.startsWith("#!/bin/sh\n") &&
    ownsRoot &&
    content.includes("node_modules/.bin/tsx") &&
    content.includes("packages/cli/src/index.ts")
  );
}
function stableCapture(content, canonical) {
  if (content !== canonical) throw new Error("not the installer-owned launcher");
  return content;
}

test("legacy bootstrap matches the v0.6.0 canonical reference and current stays distinct", () => {
  const f = fixture();
  const result = run(
    f,
    "CONFIG_DIR=/tmp/fictional-config; UPDATE_LOCK_HELPER=/tmp/fictional-helper.cjs; render_source_wrapper /tmp/fictional-source legacy",
  );
  expect(result.status, result.stderr).toBe(0);
  // Reference: v0.6.0 sourceRecoveryLauncher with the fixed fictional arguments above.
  expect(createHash("sha256").update(result.stdout).digest("hex")).toBe(
    "a9e00cbaff235bd376a3f6391b7b62d6cd0abb066e24c52bf54738088665fcee",
  );
  const legacy = render(f, "legacy"),
    current = render(f, "current");
  expect(current).not.toBe(legacy);
  expect(stableOwns(legacy, f.root)).toBe(true);
  expect(stableOwns(current, f.root)).toBe(false);
  expect(() => stableCapture(current, legacy)).toThrow("not the installer-owned launcher");
});

test("bootstrap precedes dependencies, then the actual target renderer replaces it", () => {
  // Typed tsx imports already fail for #/? paths in both old and current
  // launchers. Exercise actual target code on its supported quoted path.
  const f = fixture({ reserved: false });
  const legacy = render(f, "legacy");
  target(f, `export function sourceRecoveryLauncher() { return ${JSON.stringify(legacy)}; }`);
  let result = run(f, 'write_source_wrapper "$ROOT"; write_source_wrapper "$ROOT" installed');
  expect(result.status, result.stderr).toBe(0);
  const installedStable = readFileSync(f.launcher, "utf8");
  expect(stableOwns(installedStable, f.root)).toBe(true);
  expect(stableCapture(installedStable, legacy)).toBe(legacy);
  // An installer can swap an existing checkout after its bootstrap was written.
  currentTarget(f);
  result = run(f, 'write_source_wrapper "$ROOT" installed');
  expect(result.status, result.stderr).toBe(0);
  expect(readFileSync(f.launcher, "utf8")).toBe(render(f, "current"));
  expect(installer.indexOf('write_source_wrapper "$SOURCE_ROOT" installed')).toBeLessThan(
    installer.indexOf('write_source_update_state "complete" "$SOURCE_ROOT" "$SOURCE_COMMIT"'),
  );
});

test.each(["throw", "missing-export", "syntax-error"])(
  "failed %s final rendering preserves the recovery bootstrap and never reaches completion",
  (failure) => {
    const f = fixture({ reserved: false });
    target(
      f,
      failure === "throw"
        ? 'export function sourceRecoveryLauncher() { throw new Error("fictional renderer failure"); }'
        : failure === "missing-export"
          ? "export const unrelated = true;"
          : "export function sourceRecoveryLauncher( {",
    );
    const state = join(f.config, "state");
    const result = run(
      f,
      `write_source_wrapper "$ROOT"; printf applying >${JSON.stringify(state)}; write_source_wrapper "$ROOT" installed; printf complete >${JSON.stringify(state)}`,
    );
    expect(result.status).toBe(17);
    expect(result.stderr).toContain(
      failure === "throw"
        ? "fictional renderer failure"
        : failure === "missing-export"
          ? "Installed source launcher renderer is unavailable"
          : "Transform failed",
    );
    expect(readFileSync(state, "utf8")).toBe("applying");
    expect(readFileSync(f.launcher, "utf8")).toBe(render(f, "legacy"));
  },
);

test("migration recognizes exact known families without executing mutable installed code", () => {
  const f = fixture();
  managed(f);
  const executed = join(f.dir, "executed");
  target(
    f,
    `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(executed)},'unsafe'); throw new Error('must not execute');`,
    { commit: false },
  );
  for (const family of ["legacy", "current"]) {
    const canonical = render(f, family);
    writeFileSync(f.launcher, canonical);
    const recognized = run(f, "source_wrapper_is_installer_owned");
    expect(
      recognized.status,
      JSON.stringify({
        family,
        root: f.root,
        physicalRoot: realpathSync(f.root),
        stdout: recognized.stdout,
        stderr: recognized.stderr,
      }),
    ).toBe(0);
    writeFileSync(f.launcher, canonical + "# user-managed change\n");
    expect(run(f, "source_wrapper_is_installer_owned").status).not.toBe(0);
  }
  expect(spawnSync("test", ["-e", executed]).status).toBe(1);
  rmSync(f.launcher);
  symlinkSync(join(f.dir, "unowned"), f.launcher);
  expect(run(f, "source_wrapper_is_installer_owned").status).not.toBe(0);
});

test("only a renderer absent from the target git tree uses the legacy fallback", () => {
  const f = fixture({ reserved: false });
  const executed = join(f.dir, "executed");
  target(
    f,
    `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(executed)},'unexpected');`,
    { commit: false },
  );
  let result = run(f, 'write_source_wrapper "$ROOT" installed');
  expect(result.status, result.stderr).toBe(0);
  expect(readFileSync(f.launcher, "utf8")).toBe(render(f, "legacy"));
  expect(spawnSync("test", ["-e", executed]).status).toBe(1);
  currentTarget(f);
  rmSync(join(f.root, "packages/cli/src/update/source-launcher.ts"));
  result = run(f, 'write_source_wrapper "$ROOT" installed');
  expect(result.status).toBe(17);
  expect(result.stderr).toMatch(/Cannot find module|ERR_MODULE_NOT_FOUND/u);
  expect(result.stderr).toContain("source-launcher");
  expect(readFileSync(f.launcher, "utf8")).toBe(render(f, "legacy"));
  rmSync(join(f.root, ".git"), { recursive: true, force: true });
  result = run(f, 'write_source_wrapper "$ROOT" installed');
  expect(result.status).toBe(17);
  expect(result.stderr).toContain("not a git repository");
});

test.each(["nul", "oversized"])("invalid %s target output cannot replace the bootstrap", (kind) => {
  const f = fixture({ reserved: false });
  const content =
    "#!/bin/sh\n" + (kind === "nul" ? String.fromCharCode(0) : "#".repeat(1024 * 1024));
  target(f, `export function sourceRecoveryLauncher() { return ${JSON.stringify(content)}; }`);
  const result = run(f, 'write_source_wrapper "$ROOT"; write_source_wrapper "$ROOT" installed');
  expect(result.status).toBe(17);
  expect(result.stderr).toContain("Installed source launcher renderer returned invalid content");
  expect(readFileSync(f.launcher, "utf8")).toBe(render(f, "legacy"));
});

test("module stdout cannot corrupt the final launcher or complete the install", () => {
  const f = fixture({ reserved: false });
  const legacy = render(f, "legacy");
  target(
    f,
    `console.log('fictional renderer diagnostic'); export function sourceRecoveryLauncher() { return ${JSON.stringify(legacy)}; }`,
  );
  const state = join(f.config, "state");
  const result = run(
    f,
    `write_source_wrapper "$ROOT"; printf applying >${JSON.stringify(state)}; write_source_wrapper "$ROOT" installed; printf complete >${JSON.stringify(state)}`,
  );
  expect(result.status).toBe(17);
  expect(result.stderr).toContain("Invalid source recovery launcher output");
  expect(readFileSync(state, "utf8")).toBe("applying");
  expect(readFileSync(f.launcher, "utf8")).toBe(legacy);
});

test("an aliased temporary parent produces physical fixture paths accepted by migration", () => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "source-family-alias-")));
  scratch.push(parent);
  const physical = join(parent, "physical");
  const alias = join(parent, "alias");
  mkdirSync(physical);
  symlinkSync(physical, alias, "dir");
  const f = fixture({ temporaryRoot: alias });
  expect(f.dir.startsWith(physical + "/")).toBe(true);
  expect(f.dir).toBe(realpathSync(f.dir));
  expect(f.root).toBe(realpathSync(f.root));
  managed(f);
  for (const family of ["legacy", "current"]) {
    writeFileSync(f.launcher, render(f, family));
    const result = run(f, "source_wrapper_is_installer_owned");
    expect(
      result.status,
      JSON.stringify({ family, root: f.root, stdout: result.stdout, stderr: result.stderr }),
    ).toBe(0);
  }
});
