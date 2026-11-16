// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { connect } from "node:net";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { WindowsProcessTree } from "@omnesis/core";
import { runEnrollmentTerminal } from "./enrollment-terminal-fixture.js";

function reachable(port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      socket.destroy();
      if (error.code === "ECONNREFUSED") resolve(false);
      else reject(error);
    });
    socket.setTimeout(2_000, () => {
      socket.destroy();
      reject(new Error("TCP proof timed out"));
    });
  });
}
async function waitFor<T>(probe: () => T | undefined): Promise<T> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const value = probe();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Terminal child did not publish readiness");
}

test.skipIf(process.platform !== "win32")(
  "ConPTY shutdown closes an observed detached descendant before releasing its input",
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "terminal cohort-"));
    const input = join(directory, "owned input.json");
    const record = join(directory, "ready.json");
    writeFileSync(input, JSON.stringify({ record }));
    const descendant = `
const fs=require('node:fs'),net=require('node:net');
const input=process.argv[1], fd=fs.openSync(input,'r');
const config=JSON.parse(fs.readFileSync(input,'utf8'));
const server=net.createServer(socket=>socket.end());
server.listen(0,'127.0.0.1',()=>fs.writeFileSync(config.record,JSON.stringify({root:process.ppid,port:server.address().port})));
setTimeout(()=>process.exit(0),60000);
`;
    const root = `
const {spawn}=require('node:child_process');
spawn(process.execPath,['-e',${JSON.stringify(descendant)},process.argv[1]],{detached:true,stdio:'ignore'}).unref();
setInterval(()=>{},1000);
`;
    const terminal = runEnrollmentTerminal(process.execPath, ["-e", root, input], {
      cwd: process.cwd(),
      env: process.env,
    });
    let recovery: WindowsProcessTree | undefined;
    let joined = false;
    try {
      const ready = await waitFor(() => {
        try {
          return JSON.parse(readFileSync(record, "utf8")) as { root: number; port: number };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
          throw error;
        }
      });
      expect(terminal.closed()).toBe(false);
      // This independent observer is retained only to recover a failing
      // baseline safely. It does not participate in the terminal's kill.
      recovery = new WindowsProcessTree(ready.root, { rootIsAlive: () => !terminal.closed() });
      await recovery.refresh();
      expect(recovery.alive).toBe(true);
      expect(await reachable(ready.port)).toBe(true);
      await terminal.kill();
      expect(terminal.closed()).toBe(true);
      expect(await reachable(ready.port)).toBe(false);
      expect(readFileSync(input, "utf8")).toContain("record");
    } finally {
      try {
        await terminal.kill();
        if (recovery) {
          await recovery.kill();
          joined = !recovery.alive;
        }
      } finally {
        if (joined) rmSync(directory, { recursive: true, force: true });
      }
    }
  },
  60_000,
);
