// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  NODE_GYP_HEADERS_SCRIPT,
  prepareNodeGypHeaders,
  type HeaderCommandRunner,
} from "./node-gyp-headers.js";

const VERSION = process.versions.node;
const FILES = [
  "installVersion",
  "include/node/node.h",
  "include/node/node_api.h",
  "include/node/common.gypi",
  "include/node/config.gypi",
];

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A header directory as node-gyp leaves it, with `overrides` replacing files. */
function writeHeaders(dir: string, overrides: Record<string, string | null> = {}): void {
  const whole: Record<string, string> = {
    installVersion: "11\n",
    "include/node/node.h": "#define NODE_H\n",
    "include/node/node_api.h": "#define NODE_API_H\n",
    "include/node/common.gypi": "{\n  'variables': {},\n}\n",
    "include/node/config.gypi": "# Do not edit.\n{ 'variables': {} }\n",
  };
  for (const file of FILES) {
    const text = file in overrides ? overrides[file] : whole[file];
    if (text === null || text === undefined) continue;
    mkdirSync(join(dir, file, ".."), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
}

/**
 * A stand-in for npm's node-gyp: records its arguments and, like `install
 * --ensure`, writes the headers into `<devdir>/<version>` -- whole, or only
 * the stamp, as a fetch that died part-way does.
 */
function fakeNodeGyp(root: string, writes: "whole" | "stamp-only" | "nothing"): string {
  const path = join(root, "node-gyp.js");
  writeFileSync(
    path,
    `const fs = require("node:fs"), path = require("node:path");
fs.appendFileSync(${JSON.stringify(join(root, "gyp.log"))}, process.argv.slice(2).join(" ") + "\\n");
const dir = path.join(process.env.npm_config_devdir, process.versions.node);
const files = ${JSON.stringify(FILES)};
const mode = ${JSON.stringify(writes)};
for (const file of mode === "whole" ? files : mode === "stamp-only" ? ["installVersion"] : []) {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), file.endsWith(".gypi") ? "{}\\n" : "x\\n");
}
`,
  );
  return path;
}

interface Run {
  status: number | null;
  stderr: string;
  gypCalls: string[];
}

/** Run the script as the shell copies do: `node -e <script> <node-gyp path>`. */
function runScript(root: string, nodeGyp: string, env: Record<string, string> = {}): Run {
  const base = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^npm_config_/i.test(key)),
  );
  const result = spawnSync(process.execPath, ["-e", NODE_GYP_HEADERS_SCRIPT, nodeGyp], {
    encoding: "utf8",
    env: { ...base, HOME: join(root, "home"), ...env },
  });
  const log = join(root, "gyp.log");
  return {
    status: result.status,
    stderr: result.stderr,
    gypCalls: existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [],
  };
}

function fixture(): { root: string; devdir: string; dir: string } {
  const root = mkdtempSync(join(tmpdir(), "omnesis-node-gyp-headers-"));
  scratch.push(root);
  const devdir = join(root, "devdir");
  mkdirSync(join(root, "home"));
  return { root, devdir, dir: join(devdir, VERSION) };
}

const isWhole = (dir: string): boolean =>
  FILES.every((file) => existsSync(join(dir, file)) && readFileSync(join(dir, file)).length > 0);

describe("the node-gyp header check run before npm ci", () => {
  test("a whole header directory is left alone and nothing is fetched", () => {
    const { root, devdir, dir } = fixture();
    writeHeaders(dir);
    const run = runScript(root, fakeNodeGyp(root, "whole"), { npm_config_devdir: devdir });
    expect(run.status).toBe(0);
    expect(run.gypCalls).toEqual([]);
    expect(run.stderr).toBe("");
    expect(readFileSync(join(dir, "include/node/common.gypi"), "utf8")).toContain("variables");
  });

  test("a stamp beside an empty common.gypi is discarded and fetched again, and nothing else is touched", () => {
    const { root, devdir, dir } = fixture();
    // What a header fetch killed part-way leaves, and node-gyp then trusts.
    writeHeaders(dir, { "include/node/common.gypi": "" });
    writeHeaders(join(devdir, "22.1.0"), { "include/node/common.gypi": "" });
    writeFileSync(join(devdir, "unrelated.txt"), "keep\n");
    const run = runScript(root, fakeNodeGyp(root, "whole"), { npm_config_devdir: devdir });
    expect(run.status).toBe(0);
    expect(run.gypCalls).toEqual(["install --ensure"]);
    expect(run.stderr).toContain(
      `The node-gyp headers for Node ${VERSION} in ${dir} are incomplete`,
    );
    expect(isWhole(dir)).toBe(true);
    // Headers for other versions, even broken ones, are not this build's.
    expect(readFileSync(join(devdir, "22.1.0", "include/node/common.gypi"), "utf8")).toBe("");
    expect(readFileSync(join(devdir, "unrelated.txt"), "utf8")).toBe("keep\n");
  });

  test.each([
    ["a missing common.gypi", { "include/node/common.gypi": null }],
    [
      "a common.gypi cut off before its closing brace",
      { "include/node/common.gypi": "{\n  'variables': {\n" },
    ],
    ["a missing version stamp", { installVersion: null }],
    ["an empty node.h", { "include/node/node.h": "" }],
  ])("%s is refetched", (_label, overrides) => {
    const { root, devdir, dir } = fixture();
    writeHeaders(dir, overrides);
    const run = runScript(root, fakeNodeGyp(root, "whole"), { npm_config_devdir: devdir });
    expect(run.gypCalls).toEqual(["install --ensure"]);
    expect(isWhole(dir)).toBe(true);
  });

  test("a cold cache is fetched once, alone, before npm ci builds several modules against it", () => {
    const { root, devdir, dir } = fixture();
    const run = runScript(root, fakeNodeGyp(root, "whole"), { npm_config_devdir: devdir });
    expect(run.gypCalls).toEqual(["install --ensure"]);
    expect(run.stderr).toBe("");
    expect(isWhole(dir)).toBe(true);
  });

  test("a fetch that leaves a partial directory does not leave it for npm ci to trust", () => {
    const { root, devdir, dir } = fixture();
    const run = runScript(root, fakeNodeGyp(root, "stamp-only"), { npm_config_devdir: devdir });
    expect(run.status).toBe(0);
    expect(run.gypCalls).toEqual(["install --ensure"]);
    expect(existsSync(dir)).toBe(false);
  });

  test("without npm's node-gyp a broken directory is still discarded, for npm ci to fetch", () => {
    const { root, devdir, dir } = fixture();
    writeHeaders(dir, { "include/node/common.gypi": "" });
    for (const nodeGyp of ["", "undefined", join(root, "absent.js")]) {
      const run = runScript(root, nodeGyp, { npm_config_devdir: devdir });
      expect(run.status).toBe(0);
      expect(existsSync(dir)).toBe(false);
    }
  });

  test("a build pointed at its own Node headers (nodedir) is not touched", () => {
    const { root, devdir, dir } = fixture();
    writeHeaders(dir, { "include/node/common.gypi": "" });
    const run = runScript(root, fakeNodeGyp(root, "whole"), {
      npm_config_devdir: devdir,
      NPM_CONFIG_NODEDIR: "/usr/local",
    });
    expect(run.status).toBe(0);
    expect(run.gypCalls).toEqual([]);
    expect(readFileSync(join(dir, "include/node/common.gypi"), "utf8")).toBe("");
  });

  test("without a devdir it reads node-gyp's default cache for this platform", () => {
    const { root } = fixture();
    const home = join(root, "home");
    const dir =
      process.platform === "darwin"
        ? join(home, "Library", "Caches", "node-gyp", VERSION)
        : join(root, "xdg", "node-gyp", VERSION);
    writeHeaders(dir, { "include/node/common.gypi": "" });
    const run = runScript(root, "", { XDG_CACHE_HOME: join(root, "xdg") });
    expect(run.status).toBe(0);
    expect(existsSync(dir)).toBe(false);
    expect(readdirSync(join(dir, ".."))).toEqual([]);
  });
});

describe("prepareNodeGypHeaders", () => {
  test("asks npm for its node-gyp, then runs the script with the node on PATH, from the checkout", async () => {
    const calls: { command: string; args: string[]; cwd: string; capture: boolean }[] = [];
    const run: HeaderCommandRunner = (command, args, opts) => {
      calls.push({ command, args, ...opts });
      return Promise.resolve(
        command === "npm"
          ? { code: 0, stdout: "/usr/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js\n" }
          : { code: 0, stdout: "" },
      );
    };
    await prepareNodeGypHeaders("/srv/omnesis", run);
    expect(calls).toEqual([
      { command: "npm", args: ["config", "get", "node-gyp"], cwd: "/srv/omnesis", capture: true },
      {
        command: "node",
        args: [
          "-e",
          NODE_GYP_HEADERS_SCRIPT,
          "/usr/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js",
        ],
        cwd: "/srv/omnesis",
        capture: false,
      },
    ]);
  });

  test("still runs the check when npm cannot say where its node-gyp is", async () => {
    const calls: string[][] = [];
    await prepareNodeGypHeaders("/srv/omnesis", (command, args) => {
      calls.push([command, ...args]);
      return Promise.resolve({ code: command === "npm" ? 1 : 0, stdout: "junk" });
    });
    expect(calls[1]).toEqual(["node", "-e", NODE_GYP_HEADERS_SCRIPT, ""]);
  });
});

describe("the installer's copies", () => {
  test("embed this script verbatim, in the installer and in the source launcher it writes", () => {
    // Single-quoted in the shell, and inside an unquoted heredoc in the
    // launcher: nothing in it may be quoted, expanded or substituted there.
    expect(NODE_GYP_HEADERS_SCRIPT).not.toMatch(/['`$\\]/);
    const installer = readFileSync(join(process.cwd(), "scripts", "install.sh"), "utf8");
    const copies = installer.split(`node -e '${NODE_GYP_HEADERS_SCRIPT}'`).length - 1;
    expect(copies).toBe(2);
    // Every `npm ci` the installer runs -- the install, its retry, and the
    // reinstall after a failed build -- comes straight after the check.
    const installs = installer.match(/\( cd "\$SOURCE_DIR" && npm ci \)/g) ?? [];
    const checked =
      installer.match(
        /prepare_node_gyp_headers "\$SOURCE_DIR"\n\s+(?:if ! )?\( cd "\$SOURCE_DIR" && npm ci \)/g,
      ) ?? [];
    expect(installs).toHaveLength(3);
    expect(checked).toHaveLength(installs.length);
  });
});
