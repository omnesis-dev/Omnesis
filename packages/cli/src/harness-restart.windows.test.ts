// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { spawnHarnessCommand } from "./harness-restart.js";

it.runIf(process.platform === "win32")(
  "capture completion retires and joins a detached owned descendant before returning",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "harness capture descendant-"));
    const entry = join(root, "root.cjs");
    writeFileSync(
      entry,
      `
const {spawn}=require('node:child_process');
const code="const s=require('node:net').createServer();s.listen(0,'127.0.0.1',()=>process.send({port:s.address().port}));";
const child=spawn(process.execPath,['-e',code],{detached:true,stdio:['ignore','ignore','ignore','ipc']});
child.once('message',({port})=>{child.disconnect();child.unref();process.stdout.write(JSON.stringify({port}));});
`,
    );
    try {
      const result = await spawnHarnessCommand(
        { command: process.execPath, args: [entry] },
        "capture",
      );
      expect(result.code).toBe(0);
      const message: unknown = JSON.parse(result.stdout);
      expect(message).toEqual({ port: expect.any(Number) });
      const port = (message as { port: number }).port;
      await expect(
        new Promise<void>((resolve, reject) => {
          const socket = connect({ host: "127.0.0.1", port });
          socket.once("connect", () => {
            socket.destroy();
            reject(new Error("owned descendant still accepts connections"));
          });
          socket.once("error", (error) => {
            socket.destroy();
            if ((error as NodeJS.ErrnoException).code === "ECONNREFUSED") resolve();
            else reject(error);
          });
        }),
      ).resolves.toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  70_000,
);
