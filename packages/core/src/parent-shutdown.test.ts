// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { installParentShutdownHandler, requestChildShutdown } from "./parent-shutdown.js";

describe("inherited parent shutdown control", () => {
  it("does not expose control for a standalone process", () => {
    const parent = new EventEmitter() as unknown as NodeJS.Process;
    const stop = installParentShutdownHandler(() => {
      throw new Error("Unexpected shutdown");
    }, parent);
    expect(parent.listenerCount("message")).toBe(0);
    stop();
  });

  it("ignores unknown or malformed control messages", () => {
    const parent = Object.assign(new EventEmitter(), {
      send: () => true,
    }) as unknown as NodeJS.Process;
    let count = 0;
    const stop = installParentShutdownHandler(() => {
      count += 1;
    }, parent);
    for (const message of [
      null,
      [],
      "shutdown",
      { type: "other", version: 1 },
      { type: "omnesis.parent-shutdown", version: 2 },
    ])
      parent.emit("message", message);
    expect(count).toBe(0);
    parent.emit("message", { type: "omnesis.parent-shutdown", version: 1 });
    expect(count).toBe(1);
    stop();
    expect(parent.listenerCount("message")).toBe(0);
  });

  it("delivers graceful shutdown through a real inherited parent channel", async () => {
    const moduleUrl = new URL("./parent-shutdown.ts", import.meta.url).href;
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import { installParentShutdownHandler } from ${JSON.stringify(moduleUrl)};
      installParentShutdownHandler(() => { process.stdout.write('stopped'); process.exit(0); });
      process.on('message', (message) => { if (message === 'probe') process.send('alive'); });
      process.send('ready');
    `,
      ],
      { stdio: ["ignore", "pipe", "ignore", "ipc"] },
    );
    let output = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      output += String(chunk);
    });
    const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("message", () => resolve());
        child.once("error", reject);
        child.once("exit", () => reject(new Error("Control fixture exited before ready")));
      });
      const alive = new Promise<void>((resolve) => child.once("message", () => resolve()));
      child.send!({ type: "unknown" });
      child.send!("probe");
      await alive;
      expect(await requestChildShutdown(child)).toBe(true);
      expect(await exited).toBe(0);
      expect(output).toBe("stopped");
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    }
  });

  it("declines a child without a parent channel", async () => {
    expect(await requestChildShutdown({ connected: false } as ChildProcess)).toBe(false);
  });
});
