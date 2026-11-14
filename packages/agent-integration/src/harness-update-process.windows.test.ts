// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, connect } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { expect, it } from "vitest";
import { runHarnessUpdateProcess } from "./harness-update-process.js";

it.runIf(process.platform === "win32")(
  "runs a published npm CLI shim and joins its detached update descendant after cancellation",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "standalone update process-")),
      nonce = randomBytes(24).toString("hex");
    let report!: (port: number) => void, refuse!: (error: Error) => void;
    const ready = new Promise<number>((resolve, reject) => {
      report = resolve;
      refuse = reject;
    });
    const control = createServer((socket) => {
      let bytes = "";
      socket.on("error", refuse);
      socket.on("data", (chunk) => {
        bytes += chunk.toString("utf8");
        if (bytes.length > 512) {
          socket.destroy();
          refuse(new Error("oversized invented readiness frame"));
          return;
        }
        if (!bytes.endsWith("\n")) return;
        try {
          const value: unknown = JSON.parse(bytes);
          if (
            !value ||
            typeof value !== "object" ||
            !("nonce" in value) ||
            value.nonce !== nonce ||
            !("port" in value) ||
            typeof value.port !== "number" ||
            !Number.isInteger(value.port) ||
            value.port < 1 ||
            value.port > 65535
          )
            throw new Error("invalid invented readiness frame");
          report(value.port);
          socket.end();
        } catch (error) {
          socket.destroy();
          refuse(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
    control.on("error", refuse);
    await new Promise<void>((resolve) => control.listen(0, "127.0.0.1", resolve));
    const address = control.address();
    if (!address || typeof address === "string") throw new Error("missing fixture controller port");
    const packageRoot = join(root, "node_modules", "omnesis");
    mkdirSync(join(packageRoot, "dist"), { recursive: true });
    writeFileSync(
      join(packageRoot, "package.json"),
      JSON.stringify({ name: "omnesis", type: "module", bin: { omnesis: "./dist/index.js" } }),
    );
    const shim = join(root, "omnesis.cmd");
    writeFileSync(shim, "THIS MUST NEVER EXECUTE");
    const entry = join(packageRoot, "dist", "index.js");
    writeFileSync(
      entry,
      `
import {spawn} from 'node:child_process';
import {connect} from 'node:net';
if(JSON.stringify(process.argv.slice(2))!==JSON.stringify(['update','--yes','--no-restart','--target-version=0.5.0']))process.exit(64);
const code="const server=require('node:net').createServer();server.listen(0,'127.0.0.1',()=>process.send({port:server.address().port}));";
const child=spawn(process.execPath,['-e',code],{detached:true,stdio:['ignore','ignore','ignore','ipc']});
child.once('message',({port})=>{
 process.stdout.write('invented update ready');
 const socket=connect({host:'127.0.0.1',port:${address.port}},()=>socket.end(JSON.stringify({nonce:${JSON.stringify(nonce)},port})+'\\n'));
});
`,
    );
    const abort = new AbortController();
    const inheritedPath = process.env.PATH;
    process.env.PATH = [root, inheritedPath].filter(Boolean).join(delimiter);
    const running = runHarnessUpdateProcess(
      "omnesis",
      ["update", "--yes", "--no-restart", "--target-version=0.5.0"],
      {
        deadlineMs: 60_000,
        signal: abort.signal,
      },
    );
    try {
      const port = await Promise.race([
        ready,
        running.then((value) => {
          throw new Error(`update stopped before readiness: ${value.failure ?? value.code}`);
        }),
      ]);
      abort.abort();
      const outcome = await running;
      expect(outcome.failure).toBe("cancelled");
      expect(outcome.output).toContain("invented update ready");
      await new Promise<void>((resolve, reject) => {
        const socket = connect({ host: "127.0.0.1", port });
        socket.once("connect", () => {
          socket.destroy();
          reject(new Error("owned update descendant still accepts connections"));
        });
        socket.once("error", (error) => {
          socket.destroy();
          if ((error as NodeJS.ErrnoException).code === "ECONNREFUSED") resolve();
          else reject(error);
        });
      });
    } finally {
      abort.abort();
      await running;
      if (inheritedPath === undefined) delete process.env.PATH;
      else process.env.PATH = inheritedPath;
      await new Promise<void>((resolve, reject) =>
        control.close((error) => (error ? reject(error) : resolve())),
      );
      rmSync(root, { recursive: true, force: true });
    }
  },
  70_000,
);
