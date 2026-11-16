// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { connect } from "node:net";
import { createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, onTestFinished, test } from "vitest";
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

async function respondsAsPeer(
  port: number,
  secret: string,
): Promise<{ connected: boolean; matched: boolean; error?: string }> {
  const challenge = randomBytes(16).toString("hex");
  const expected = createHmac("sha256", secret).update(challenge).digest("hex");
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    let connected = false,
      bytes = "",
      settled = false;
    const finish = (error?: string) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ connected, matched: bytes.trim() === expected, ...(error ? { error } : {}) });
    };
    socket.once("connect", () => {
      connected = true;
      socket.write(`${challenge}\n`);
    });
    socket.on("data", (chunk: Buffer) => {
      bytes += chunk.toString("utf8");
      if (bytes.includes("\n") || bytes.length > 128) finish();
    });
    socket.once("end", () => finish());
    socket.once("error", (error: NodeJS.ErrnoException) => finish(error.code ?? "unknown"));
    socket.setTimeout(2000, () => finish("timeout"));
  });
}

const investigationModes = [
  ...Array.from(
    { length: process.env.OMNESIS_COHORT_LOAD === "1" ? 1 : 20 },
    () => "kill" as const,
  ),
  ...Array.from(
    { length: process.env.OMNESIS_COHORT_LOAD === "1" ? 1 : 10 },
    () => "natural" as const,
  ),
];

test.skipIf(process.platform !== "win32").each(investigationModes)(
  "ConPTY %s completion closes an observed detached descendant before releasing its input [%#]",
  async (mode) => {
    const directory = mkdtempSync(join(tmpdir(), "terminal cohort-"));
    const input = join(directory, "owned input.json");
    const record = join(directory, "ready.json");
    const release = join(directory, "release");
    const nonce = randomBytes(32).toString("hex");
    writeFileSync(
      input,
      JSON.stringify({
        record,
        nonce,
        original: process.env.OMNESIS_COHORT_ORIGINAL_SERVER === "1",
      }),
    );
    const descendant = `
const fs=require('node:fs'),net=require('node:net');
const input=process.argv[1], fd=fs.openSync(input,'r');
const config=JSON.parse(fs.readFileSync(input,'utf8'));
const crypto=require('node:crypto');
const server=net.createServer(socket=>{if(config.original){socket.end();return;}let line='';socket.on('data',chunk=>{line+=chunk.toString('utf8');if(line.includes('\\n'))socket.end(crypto.createHmac('sha256',config.nonce).update(line.trim()).digest('hex')+'\\n');});});
server.listen(0,'127.0.0.1',()=>{const target=config.record+'.tmp';fs.writeFileSync(target,JSON.stringify({root:process.ppid,pid:process.pid,port:server.address().port}));fs.renameSync(target,config.record);});
setTimeout(()=>process.exit(0),60000);
`;
    const root = `
const {spawn}=require('node:child_process');
spawn(process.execPath,['-e',${JSON.stringify(descendant)},process.argv[1]],{detached:true,stdio:'ignore'}).unref();
const fs=require('node:fs');
setInterval(()=>{if(fs.existsSync(process.argv[2]))process.exit(0)},25);
`;
    const terminal = runEnrollmentTerminal(process.execPath, ["-e", root, input, release], {
      cwd: process.cwd(),
      env: process.env,
    });
    let recovery: WindowsProcessTree | undefined;
    let cleanupWork: Promise<void> | undefined;
    const cleanup = () =>
      (cleanupWork ??= (async () => {
        const results = await Promise.allSettled([terminal.kill(), recovery?.kill()]);
        const failures = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason as unknown] : [],
        );
        if (!failures.length && terminal.closed() && recovery && !recovery.alive)
          rmSync(directory, { recursive: true, force: true });
        if (failures.length)
          throw new AggregateError(failures, "Terminal fixture cleanup failed; inputs retained");
      })());
    // Vitest can time out an unresolved body without unwinding its finally.
    // The same idempotent cleanup also runs when the framework finishes it.
    onTestFinished(cleanup);
    try {
      const ready = await waitFor(() => {
        try {
          return JSON.parse(readFileSync(record, "utf8")) as {
            root: number;
            pid: number;
            port: number;
          };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
          throw error;
        }
      });
      expect(terminal.closed()).toBe(false);
      // This independent observer is retained only to recover a failing
      // baseline safely. It does not participate in the terminal's kill.
      const { snapshotWindowsProcesses } = await import("@omnesis/platform/windows-process");
      const snapshot = () => snapshotWindowsProcesses([ready.root, ready.pid]);
      recovery = new WindowsProcessTree(ready.root, {
        rootIsAlive: () => !terminal.closed(),
        snapshot,
      });
      await recovery.refresh();
      const before = await snapshot();
      const observedChild = before.find((row) => row.pid === ready.pid);
      const observedRoot = before.find((row) => row.pid === ready.root);
      expect(observedChild).toBeDefined();
      expect(observedRoot).toBeDefined();
      if (process.env.OMNESIS_COHORT_ORIGINAL_SERVER !== "1")
        expect((await respondsAsPeer(ready.port, nonce)).matched).toBe(true);
      expect(recovery.alive).toBe(true);
      expect(await reachable(ready.port)).toBe(true);
      if (mode === "kill") await terminal.kill();
      else {
        writeFileSync(release, "exit");
        expect(await terminal.exit).toBe(0);
      }
      expect(terminal.closed()).toBe(true);
      const connected = await reachable(ready.port);
      const after = await snapshot();
      const childAlive = after.some(
        (row) => row.pid === observedChild?.pid && row.birth === observedChild.birth,
      );
      const rootAlive = after.some(
        (row) => row.pid === observedRoot?.pid && row.birth === observedRoot.birth,
      );
      const application = await respondsAsPeer(ready.port, nonce);
      process.stdout.write(
        `[cohort-observation] ${JSON.stringify({ mode, connected, childAlive, rootAlive, application })}\n`,
      );
      expect(connected).toBe(false);
      expect(readFileSync(input, "utf8")).toContain("record");
    } finally {
      await cleanup();
    }
  },
  60_000,
);
