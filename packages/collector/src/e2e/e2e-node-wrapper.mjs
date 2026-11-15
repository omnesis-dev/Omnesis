// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
// The canonical Job owns this wrapper and every real IPC child it starts.
import { spawn } from "node:child_process";
import { requestChildShutdown } from "@omnesis/core";
import { E2EInputDecoder, encodeE2EControl } from "./e2e-process-protocol.js";
let nonce,
  child,
  launched = false,
  inputEnded = false,
  applicationClosed = false,
  failed = false;
let control = Promise.resolve();
function emit(frame) {
  if (nonce) process.stderr.write(encodeE2EControl(nonce, frame));
}
function fail(code) {
  if (failed) return;
  failed = true;
  process.exitCode = 1;
  try {
    emit({ type: "failed", code });
  } catch {
    // Failed publication cannot authorize success; the owner still must join.
  }
  // This uses the exact retained ChildProcess. The outer canonical Job owns
  // descendants and its parent still must cancel/join that entire Job.
  if (child && child.exitCode === null && child.signalCode === null)
    try {
      child.kill("SIGKILL");
    } catch {
      // The outer Job retains descendant termination and join responsibility.
    }
  if (!child) process.stdin.destroy();
}
async function receive(frame) {
  if (frame.type === "launch") {
    if (launched || inputEnded) throw Error("Invalid E2E launch state");
    launched = true;
    nonce = frame.nonce;
    child = spawn(frame.command, frame.args, {
      cwd: process.cwd(),
      env: process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    child.stdout.pipe(process.stdout, { end: false });
    child.stderr.pipe(process.stderr, { end: false });
    child.stdout.on("error", () => fail("output"));
    child.stderr.on("error", () => fail("output"));
    child.on("error", () => fail("spawn"));
    child.once("close", (code, signal) => {
      applicationClosed = true;
      void control
        .then(() => {
          emit({ type: "closed", code, signal });
          process.exitCode = failed ? 1 : (code ?? 1);
          process.stdin.destroy();
        })
        .catch(() => fail("control"));
    });
    await new Promise((resolve, reject) => {
      child.once("spawn", () => {
        emit({ type: "spawned", pid: child.pid });
        resolve();
      });
      child.once("error", () => reject(Error("E2E target creation failed")));
    });
  } else {
    if (!launched || frame.nonce !== nonce || !child || inputEnded)
      throw Error("Invalid E2E control state");
    const accepted = await requestChildShutdown(child);
    emit({ type: "shutdown-ack", accepted });
  }
}
const decoder = new E2EInputDecoder((frame) => {
  control = control.then(() => receive(frame)).catch(() => fail("control"));
});
process.stdin.on("data", (bytes) => {
  try {
    decoder.write(bytes);
  } catch {
    fail("protocol");
  }
});
process.stdin.on("end", () => {
  inputEnded = true;
  try {
    decoder.end();
  } catch {
    fail("protocol");
  }
  if (!applicationClosed) fail("control");
});
process.stdin.on("error", () => {
  inputEnded = true;
  if (!applicationClosed) fail("control");
});
