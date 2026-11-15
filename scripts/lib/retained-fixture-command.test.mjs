// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { expect, test } from "vitest";
import { startRetainedWindowsFixture } from "./retained-fixture-command.mjs";

const driver = fileURLToPath(
  new URL("../test-fixtures/retained-command-driver.mjs", import.meta.url),
);

test.each([0, 12])("the driver preserves command exit %i and literal UTF-8 arguments", (code) => {
  const root = mkdtempSync(join(tmpdir(), "retained-driver-test-"));
  const path = join(root, "result.json");
  const args = ["invented path with spaces", 'quote"', "$literal", "Δ"];
  try {
    execFileSync(
      process.execPath,
      [
        driver,
        JSON.stringify({
          command: process.execPath,
          args: [
            "-e",
            `process.stdout.write(JSON.stringify(process.argv.slice(1)));process.stderr.write('invented diagnostic');process.exit(${code});`,
            ...args,
          ],
          result: path,
          timeout: 10_000,
          maxBuffer: 65_536,
        }),
      ],
      { input: "", timeout: 15_000 },
    );
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      code,
      stdout: JSON.stringify(args),
      stderr: "invented diagnostic",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function reachable(port) {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const finish = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(1000, () => finish(false));
  });
}

test.runIf(process.platform === "win32")(
  "a completed command retains its daemon until a positively joined fixture close",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "retained-daemon-test-"));
    const portFile = join(root, "port");
    const daemon = `const net=require('node:net');const s=net.createServer();s.listen(0,'127.0.0.1',()=>require('node:fs').writeFileSync(${JSON.stringify(portFile)},String(s.address().port)));`;
    const command = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(daemon)}],{stdio:'ignore',windowsHide:true}).unref();process.stdout.write('finite root complete');`;
    const owner = startRetainedWindowsFixture(process.execPath, ["-e", command], {
      timeout: 30_000,
    });
    let port;
    try {
      expect(await owner.result).toMatchObject({ code: 0, stdout: "finite root complete" });
      const deadline = Date.now() + 5_000;
      while (!existsSync(portFile) && Date.now() < deadline) await sleep(20);
      port = Number(readFileSync(portFile, "utf8"));
      expect(await reachable(port)).toBe(true);
      expect(owner.child.exitCode).toBeNull();
    } finally {
      owner.child.kill("SIGKILL");
      await owner.closed;
      rmSync(root, { recursive: true, force: true });
    }
    expect(existsSync(owner.directory)).toBe(false);
    expect(await reachable(port)).toBe(false);
  },
  60_000,
);
