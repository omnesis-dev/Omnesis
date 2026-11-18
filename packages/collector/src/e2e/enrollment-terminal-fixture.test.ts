// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, it, onTestFinished, vi } from "vitest";
import { runEnrollmentTerminal } from "./enrollment-terminal-fixture.js";

it("provides a real terminal and preserves literal argv without a shell", async () => {
  const args = ["space value", "& $(literal)", "雪", "", "quote'\"value"];
  const run = runEnrollmentTerminal(
    process.execPath,
    [
      "-e",
      `
const value=JSON.stringify({tty:!!process.stdin.isTTY,args:process.argv.slice(1)});
console.log('OMNESIS_TERMINAL:'+Buffer.from(value).toString('base64'));
`,
      ...args,
    ],
    { cwd: process.cwd(), env: process.env },
  );
  onTestFinished(() => run.kill());
  try {
    expect(await run.exit).toBe(0);
    expect(run.stderr()).toBe(run.stdout());
    const encoded = /OMNESIS_TERMINAL:([A-Za-z0-9+/=]+)/u.exec(run.stdout())?.[1];
    expect(encoded).toBeDefined();
    expect(JSON.parse(Buffer.from(encoded!, "base64").toString("utf8"))).toEqual({
      tty: true,
      args,
    });
  } finally {
    await run.kill();
  }
});

it("owns terminal shutdown until the target exits", async () => {
  const run = runEnrollmentTerminal(
    process.execPath,
    ["-e", "process.stdout.write('TERMINAL_READY\\n');setInterval(()=>{},1000)"],
    {
      cwd: process.cwd(),
      env: process.env,
    },
  );
  onTestFinished(() => run.kill());
  try {
    await vi.waitFor(() => expect(run.stdout()).toContain("TERMINAL_READY"), { timeout: 15_000 });
    await run.kill();
    expect(run.closed()).toBe(true);
    expect(run.proc.exitCode).not.toBeNull();
  } finally {
    await run.kill();
  }
}, 30_000);

it("delivers a real Ctrl+C and joins a target that handles it and exits zero", async () => {
  const run = runEnrollmentTerminal(
    process.execPath,
    [
      "-e",
      "process.on('SIGINT',()=>{process.stdout.write('INTERRUPT_HANDLED\\n',()=>process.exit(0));});process.stdout.write('INTERRUPT_READY\\n');setInterval(()=>{},1000)",
    ],
    { cwd: process.cwd(), env: process.env },
  );
  onTestFinished(() => run.kill());
  try {
    await vi.waitFor(() => expect(run.stdout()).toContain("INTERRUPT_READY"), { timeout: 15_000 });
    await run.interrupt();
    await vi.waitFor(() => expect(run.proc.exitCode).toBe(0), { timeout: 15_000 });
    expect(await run.exit).toBe(0);
    expect(run.stdout()).toContain("INTERRUPT_HANDLED");
    expect(run.closed()).toBe(true);
  } finally {
    await run.kill();
  }
}, 40_000);

it("delivers a typed comparison code through the real terminal input", async () => {
  const run = runEnrollmentTerminal(
    process.execPath,
    [
      "-e",
      "const r=require('node:readline').createInterface({input:process.stdin,output:process.stdout});r.question('COMPARISON_READY:',answer=>{process.stdout.write('COMPARISON_RECEIVED:'+JSON.stringify(answer)+'\\n');r.close()});",
    ],
    { cwd: process.cwd(), env: process.env },
  );
  onTestFinished(() => run.kill());
  try {
    await vi.waitFor(() => expect(run.stdout()).toContain("COMPARISON_READY:"), {
      timeout: 15_000,
    });
    expect(run.closed()).toBe(false);
    await run.write("465 774\r");
    expect(await run.exit).toBe(0);
    expect(run.stdout()).toContain('COMPARISON_RECEIVED:"465 774"');
    await expect(run.write("too late")).rejects.toThrow("terminal is closed");
  } finally {
    await run.kill();
  }
}, 30_000);
