// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { WindowsJobControl } from "./windows-job-control.js";
import { runWindowsOwnedProcess, spawnWindowsOwnedProcess } from "./windows-owned-process.js";

// A real Node process implements only the public wire protocol. This exercises
// asynchronous listener setup and binary stdin ordering without claiming native
// Windows ownership or ancestry validation on another operating system.
const helperSource = String.raw`
const { connect } = require('node:net');
let bytes = Buffer.alloc(0), config, socket, acked = false, ended = false;
process.stdin.on('data', chunk => {
  bytes = Buffer.concat([bytes, chunk]);
  if (!config && bytes.length >= 4 && bytes.length >= 4 + bytes.readUInt32LE()) {
    const length = bytes.readUInt32LE();
    config = JSON.parse(bytes.subarray(4, 4 + length));
    bytes = bytes.subarray(4 + length);
    socket = connect(process.env.CONTROL_ENDPOINT, () => {
      socket.write(JSON.stringify({ cookie: config.cookie, pid: process.pid }) + '\n');
    });
    socket.on('data', data => {
      if (data.length !== 1 || data[0] !== 0) process.exit(91);
      acked = true;
      process.stderr.write('OMNESIS_JOB:0\n');
      finish();
    });
  }
});
process.stdin.on('end', () => { ended = true; finish(); });
function finish() {
  if (!acked || !ended) return;
  if (process.env.HELPER_CRASH === '1') process.exit(9);
  process.stdout.write(bytes, () => socket.end(Buffer.from([2])));
  socket.on('close', () => process.exit(7));
}
`;

function frame(control: WindowsJobControl): Buffer {
  const body = Buffer.from(JSON.stringify(control.configuration));
  const length = Buffer.alloc(4);
  length.writeUInt32LE(body.length);
  return Buffer.concat([length, body]);
}

function invocation(control: WindowsJobControl, crash = false) {
  return {
    command: process.execPath,
    args: ["-e", helperSource],
    env: { ...process.env, CONTROL_ENDPOINT: control.endpoint, HELPER_CRASH: crash ? "1" : "0" },
  };
}

describe("owned process control at the Node boundary", () => {
  it.each(["abort", "input"] as const)(
    "joins unused control resources after early %s refusal",
    async (reason) => {
      const control = new WindowsJobControl("123456789");
      const spec = invocation(control);
      const result = await runWindowsOwnedProcess(
        spec,
        frame(control),
        {
          env: spec.env,
          ...(reason === "abort"
            ? { signal: AbortSignal.abort() }
            : {
                input: Buffer.from([1]),
                inputStream: Readable.from([Buffer.from([2])]),
              }),
        },
        undefined,
        control,
      );
      expect(result.failure).toBe(reason === "abort" ? "aborted" : "spawn");
      expect(result.cleanupFailure).toBeUndefined();
      await expect(control.closed).resolves.toBeUndefined();
    },
  );

  it("preserves immediate binary writes across listener/configuration setup and joins exit 7", async () => {
    const control = new WindowsJobControl("123456789");
    const spec = invocation(control);
    const proc = spawnWindowsOwnedProcess(
      spec,
      frame(control),
      { env: spec.env },
      undefined,
      control,
    );
    const output: Buffer[] = [];
    proc.stdout!.on("data", (bytes: Buffer) => output.push(bytes));
    const input = Buffer.alloc(1024 * 1024);
    for (let i = 0; i < input.length; i++) input[i] = i % 256;
    // Intentionally write before the listening promise can dispatch.
    proc.stdin!.end(input);
    try {
      await proc.jobReady;
      await proc.jobClosed;
      expect(proc.exitCode).toBe(7);
      expect(Buffer.concat(output)).toEqual(input);
    } finally {
      proc.kill("SIGKILL");
      await proc.jobClosed.catch(() => {});
    }
  });

  it("reports missing native completion as an explicit cleanup failure", async () => {
    const control = new WindowsJobControl("123456789");
    const spec = invocation(control, true);
    const result = await runWindowsOwnedProcess(
      spec,
      frame(control),
      { env: spec.env, input: Buffer.from([0, 255]) },
      undefined,
      control,
    );
    expect(result).toMatchObject({ failure: "spawn", exitCode: null });
    expect(result.cleanupFailure).toBeInstanceOf(Error);
    expect(result.failureMessage).toContain("cleanup was not confirmed");
  });

  it("publication failure prevents any frame or target permission and still joins cleanup", async () => {
    const control = new WindowsJobControl("123456789");
    const spec = invocation(control);
    const original = new Error("invented publication failure");
    let called = false;
    await expect(
      runWindowsOwnedProcess(
        spec,
        frame(control),
        { env: spec.env },
        () => {
          called = true;
          throw original;
        },
        control,
      ),
    ).rejects.toBe(original);
    expect(called).toBe(true);
    await expect(control.closed).resolves.toBeUndefined();
  });
});
