// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawn } from "node:child_process";
import { once } from "node:events";
import { watch } from "node:fs";
import { chmod, lstat, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const posixTest = test.skipIf(process.platform === "win32");

// Only the isolated child sees this shim. It opens the actual producer's chosen
// destination, pauses before writing content, and leaves the production reader
// and fixture's publication code unchanged.
const shim = `
const fs = require('node:fs');
const { basename } = require('node:path');
const { syncBuiltinESMExports } = require('node:module');
const original = fs.writeFileSync;
fs.writeFileSync = function(path, bytes, options) {
  if (!['endpoint.pending','endpoint.json'].includes(basename(String(path))))
    return original.apply(this,arguments);
  const fd = fs.openSync(path,options?.flag ?? 'w',options?.mode ?? 0o666);
  try {
    fs.writeSync(1,'P');
    fs.readSync(0,Buffer.alloc(1),0,1,null);
    original(fd,bytes);
  } finally { fs.closeSync(fd); }
};
syncBuiltinESMExports();
`;

posixTest.each(["api-context-fixture.mjs", "scripted-agent.mjs"])(
  "%s publishes no endpoint until the complete private JSON exists",
  async (name) => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "omnesis-endpoint-publication-")));
    await chmod(home, 0o700);
    const preload = join(home, "pause-write.cjs");
    await writeFile(preload, shim, { mode: 0o600 });
    const script = fileURLToPath(new URL(`../../macos/Tests/Support/${name}`, import.meta.url));
    const child = spawn(process.execPath, ["--require", preload, script], {
      cwd: home,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: home,
        TMPDIR: home,
        OMNESIS_GUI_FIXTURE_ROOT: home,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    // Consume private child diagnostics without publishing raw path/error text.
    child.stderr.resume();
    child.stdin.on("error", () => {});
    const closed = once(child, "close");
    let watcher, deadline;
    const expired = new Promise((_, reject) => {
      deadline = setTimeout(
        () => reject(new Error("Owned fixture publication barrier expired")),
        3000,
      );
    });
    const ended = closed.then(() => {
      throw new Error("Owned fixture exited before publication");
    });
    try {
      const paused = once(child.stdout, "data").then(([bytes]) => {
        expect(bytes).toEqual(Buffer.from("P"));
      });
      await Promise.race([paused, ended, expired]);
      await expect(lstat(join(home, "endpoint.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      const pending = await lstat(join(home, "endpoint.pending"));
      expect(pending.isFile()).toBe(true);
      expect(pending.size).toBe(0);
      expect(pending.mode & 0o777).toBe(0o600);
      const published = new Promise((resolve, reject) => {
        watcher = watch(home, (event, filename) => {
          if (event === "rename" && filename === "endpoint.json") resolve();
        });
        watcher.on("error", reject);
      });
      child.stdin.end("R");
      await Promise.race([published, ended, expired]);
      const bytes = await readFile(join(home, "endpoint.json"));
      const endpoint = JSON.parse(bytes.toString("utf8"));
      expect(Object.keys(endpoint)).toEqual(["port"]);
      expect(Number.isInteger(endpoint.port)).toBe(true);
      expect(endpoint.port).toBeGreaterThanOrEqual(1024);
      expect(endpoint.port).toBeLessThanOrEqual(65535);
      expect((await lstat(join(home, "endpoint.json"))).mode & 0o777).toBe(0o600);
    } finally {
      clearTimeout(deadline);
      watcher?.close();
      // Release a paused write on every assertion failure before requesting exit.
      child.stdin.end();
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await closed;
      await rm(home, { recursive: true, force: true });
    }
  },
);
