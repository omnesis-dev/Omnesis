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
