// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { connect, type Socket } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { WindowsJobControl } from "./windows-job-control.js";

const helperSource = String.raw`
import {readFileSync} from 'node:fs';
import {connect} from 'node:net';
const c=JSON.parse(readFileSync(0,'utf8'));
const s=connect(c.endpoint);
s.on('error',()=>process.exit(21));
s.once('connect',()=>s.write(JSON.stringify({cookie:c.cookie,pid:process.pid})+'\n'));
let ready=false;
s.on('data',bytes=>{
 if(!ready){
  if(bytes.length!==1||bytes[0]!==0)process.exit(22);
  ready=true;
  process.stdout.write('allowed\n',()=>{
   if(c.mode==='normal')s.write(Buffer.from([2]),()=>s.end());
   if(c.mode==='crash')process.exit(19);
  });
 }else if(c.mode==='cancel'&&bytes.length===1&&bytes[0]===1){
  process.exitCode=7;s.write(Buffer.from([2]),()=>s.end());
 }
});
`;
const controls: WindowsJobControl[] = [];
const sockets: Socket[] = [];
const children: ChildProcess[] = [];
function control(deadline?: number): WindowsJobControl {
  const value = new WindowsJobControl("123456789", deadline);
  controls.push(value);
  return value;
}
async function launch(value: WindowsJobControl, mode: string, holdInput = false) {
  value.start();
  await value.listening;
  const child = spawn(process.execPath, ["--input-type=module", "-e", helperSource], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);
  const exit = new Promise<{ code: number | null; signal: string | null }>((resolve) =>
    child.once("close", (code, signal) => resolve({ code, signal })),
  );
  let output = "",
    diagnostic = "";
  child.stderr.on("data", (bytes: Buffer) => {
    diagnostic += bytes.toString();
  });
  const allowed = new Promise<void>((resolve) =>
    child.stdout.on("data", (bytes: Buffer) => {
      output += bytes.toString();
      if (output.includes("allowed\n")) resolve();
    }),
  );
  const ready = Promise.race([
    allowed,
    exit.then(() => {
      throw new Error(`invented helper stopped before ACK: ${diagnostic}`);
    }),
  ]);
  // Timeout/early-abort tests intentionally never await target readiness.
  void ready.catch(() => {});
  value.attach(child, () => Promise.resolve());
  const send = () =>
    child.stdin.end(
      JSON.stringify({ endpoint: value.endpoint, cookie: value.configuration.cookie, mode }),
    );
  if (!holdInput) send();
  return { child, ready, exit, send, output: () => output };
}
function client(value: WindowsJobControl): Socket {
  const socket = connect(value.endpoint);
  socket.on("error", () => {});
  sockets.push(socket);
  return socket;
}
afterEach(async () => {
  for (const value of controls) value.abandon();
  await Promise.allSettled(controls.map((value) => value.closed));
  for (const socket of sockets) socket.destroy();
  for (const child of children) child.kill("SIGKILL");
  controls.length = sockets.length = children.length = 0;
});

it("authenticates a retained helper and joins its completion, process and control listener", async () => {
  const value = control(),
    helper = await launch(value, "normal");
  await helper.ready;
  await value.closed;
  expect(await helper.exit).toEqual({ code: 0, signal: null });
  const probe = client(value);
  const [error] = await once(probe, "error");
  expect(["ENOENT", "ECONNREFUSED"]).toContain((error as NodeJS.ErrnoException).code);
});
it("rejects foreign cookies and PIDs, and retires a stalled foreign connection", async () => {
  const value = control(),
    helper = await launch(value, "normal", true);
  for (const frame of [
    { cookie: "0".repeat(64), pid: helper.child.pid },
    { cookie: value.configuration.cookie, pid: helper.child.pid! + 1 },
  ]) {
    const socket = client(value),
      closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    await once(socket, "connect");
    socket.write(JSON.stringify(frame) + "\n");
    await closed;
  }
  const oversized = client(value),
    oversizedClosed = new Promise<void>((resolve) => oversized.once("close", () => resolve()));
  await once(oversized, "connect");
  oversized.write("x".repeat(513));
  await oversizedClosed;
  const stalled = client(value),
    stalledClosed = new Promise<void>((resolve) => stalled.once("close", () => resolve()));
  await once(stalled, "connect");
  helper.send();
  await value.closed;
  await stalledClosed;
  expect(await helper.exit).toEqual({ code: 0, signal: null });
});
it("preserves signal validation and the zero-signal liveness probe without cancellation", async () => {
  const value = control(),
    helper = await launch(value, "normal", true);
  expect(helper.child.kill(0)).toBe(true);
  expect(() => helper.child.kill("INVALID" as NodeJS.Signals)).toThrow();
  helper.send();
  await value.closed;
  expect(await helper.exit).toEqual({ code: 0, signal: null });
});
it("cancels cooperatively once and preserves the helper's drained exit status", async () => {
  const value = control(),
    helper = await launch(value, "cancel");
  await helper.ready;
  expect(helper.child.kill("SIGKILL")).toBe(true);
  expect(helper.child.kill("SIGTERM")).toBe(true);
  await value.closed;
  expect(await helper.exit).toEqual({ code: 7, signal: null });
});
it("an abort before authentication never permits payload start", async () => {
  const value = control(),
    helper = await launch(value, "normal", true);
  helper.child.kill("SIGKILL");
  await value.closed;
  expect((await helper.exit).signal).toBe("SIGKILL");
  expect(helper.output()).toBe("");
});
it("a helper crash does not forge an authenticated JOINED acknowledgement", async () => {
  const value = control(),
    helper = await launch(value, "crash");
  await expect(value.closed).rejects.toThrow(/completion-missing|unjoined/u);
  expect((await helper.exit).code).toBe(19);
});
it("a hard-kill backstop rejects join proof instead of claiming cancellation joined", async () => {
  const value = control(),
    helper = await launch(value, "ignore-cancel");
  await helper.ready;
  helper.child.kill("SIGKILL");
  await expect(value.closed).rejects.toMatchObject({ code: "unjoined-fallback" });
  expect((await helper.exit).signal).toBe("SIGKILL");
});
it("retains the original startup deadline while a helper has not authenticated", async () => {
  const value = control(Date.now() + 1_000),
    helper = await launch(value, "normal", true);
  await expect(value.closed).rejects.toMatchObject({ code: "ETIMEDOUT" });
  expect((await helper.exit).signal).toBe("SIGKILL");
  expect(helper.output()).toBe("");
});
it("drains JOINED dispatched after the raw process close event", async () => {
  const value = control();
  value.start();
  await value.listening;
  const child = Object.assign(new EventEmitter(), { pid: 123, kill: vi.fn(() => true) });
  value.attach(child as unknown as ChildProcess, () => Promise.resolve());
  const socket = client(value);
  await once(socket, "connect");
  const acknowledged = once(socket, "data");
  socket.write(JSON.stringify({ cookie: value.configuration.cookie, pid: 123 }) + "\n");
  await acknowledged;
  child.emit("close", 0, null);
  socket.end(Buffer.from([2]));
  await value.closed;
});
