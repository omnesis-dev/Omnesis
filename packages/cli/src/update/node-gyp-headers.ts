// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The Node headers a source build's native modules compile against, made
 * whole before each `npm ci`.
 *
 * node-gyp fetches Node's headers once per Node version into its cache and
 * trusts that directory from then on, as long as the version stamp it writes
 * there is present. Two things break it:
 *
 * - `npm ci` runs several native modules' `node-gyp rebuild` at once
 *   (better-sqlite3, its ciphers variant and smart-whisper), and on a cold
 *   cache each fetches the headers into the same directory: one copies a file
 *   over while another reads it, or removes the whole directory after an
 *   error of its own, and the reader fails on an empty or missing
 *   `common.gypi`.
 * - A fetch killed part-way can leave the stamp beside files that never got
 *   their bytes, and every later build fails the same way — so does a retry
 *   from an empty `node_modules`, which never looks outside the checkout.
 *
 * So before each `npm ci`, this Node version's header directory is discarded
 * unless it is whole, and the headers are fetched once, alone, with npm's own
 * node-gyp. Nothing else in the cache is touched, and a fetch that fails
 * leaves `npm ci` to fetch the headers itself, as it always did.
 *
 * The installer and the source launcher run this same script as
 * `prepare_node_gyp_headers` (scripts/install.sh); a test keeps the copies
 * identical. It is JavaScript run by the `node` on PATH — the one npm and its
 * node-gyp run under — because that is what decides which headers they need.
 * It holds no `$`, backtick, backslash or single quote, so the shell copies
 * embed it verbatim in single quotes.
 */

import { spawn } from "node:child_process";

export const NODE_GYP_HEADERS_SCRIPT = `const fs = require("fs"), os = require("os"), path = require("path");
const env = (name) => Object.entries(process.env).find(([key]) => key.toLowerCase() === name)?.[1] || "";
if (env("npm_config_nodedir")) process.exit(0);
const cache = env("npm_config_devdir").replace(/^~/, os.homedir()) || (process.platform === "darwin"
  ? path.join(os.homedir(), "Library", "Caches", "node-gyp")
  : path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "node-gyp"));
const dir = path.join(cache, process.versions.node);
const whole = () => ["installVersion", "include/node/node.h", "include/node/node_api.h",
  "include/node/common.gypi", "include/node/config.gypi"].every((file) => {
  try {
    const text = fs.readFileSync(path.join(dir, file), "utf8").trim();
    return text !== "" && (!file.endsWith(".gypi") || text.endsWith("}"));
  } catch {
    return false;
  }
});
if (whole()) process.exit(0);
if (fs.existsSync(dir)) console.error("The node-gyp headers for Node " + process.versions.node + " in " + dir + " are incomplete; fetching them again.");
fs.rmSync(dir, { recursive: true, force: true });
const gyp = process.argv[1];
if (gyp && fs.existsSync(gyp)) {
  require("child_process").spawnSync(process.execPath, [gyp, "install", "--ensure"], { stdio: "ignore", timeout: 180000 });
}
if (!whole()) fs.rmSync(dir, { recursive: true, force: true });`;

/** Run a command to completion, returning its stdout; never rejects. */
export type HeaderCommandRunner = (
  command: string,
  args: string[],
  opts: { cwd: string; capture: boolean },
) => Promise<{ code: number; stdout: string }>;

const runCommand: HeaderCommandRunner = (command, args, { cwd, capture }) =>
  new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", capture ? "pipe" : "inherit", "inherit"],
    });
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.on("error", () => resolve({ code: 1, stdout }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout }));
  });

/**
 * Make node-gyp's headers for the `node` on PATH whole, from `cwd` (the
 * checkout `npm ci` is about to run in). Best effort: whatever fails here,
 * `npm ci` still runs and fetches what it needs itself.
 */
export async function prepareNodeGypHeaders(
  cwd: string,
  run: HeaderCommandRunner = runCommand,
): Promise<void> {
  const located = await run("npm", ["config", "get", "node-gyp"], { cwd, capture: true });
  const nodeGyp = located.code === 0 ? located.stdout.trim() : "";
  await run("node", ["-e", NODE_GYP_HEADERS_SCRIPT, nodeGyp], { cwd, capture: false });
}
