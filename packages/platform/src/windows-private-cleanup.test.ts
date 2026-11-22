// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { Readable } from "node:stream";
import { beforeEach, expect, test, vi } from "vitest";
const owned = vi.hoisted(() => ({ run: vi.fn(), sync: vi.fn() }));
vi.mock("./windows-worker-cache.js", () => ({
  prepareWindowsNativeWorker: () => {},
  windowsWorkerInvocation: () => ({ command: "C:\\example\\worker.exe", args: ["--private-file"] }),
}));
vi.mock("./windows-owned-process.js", () => ({
  runWindowsOwnedProcess: owned.run,
  runWindowsOwnedProcessSync: owned.sync,
}));
import {
  createWindowsPrivateFile,
  readWindowsPrivateFileSync,
  writeWindowsPrivateFileAtomicStream,
} from "./windows-private-file.js";

beforeEach(() => {
  owned.run.mockReset();
  owned.sync.mockReset();
});
const uncertainty = new Error("Invented owned cleanup was not confirmed");
function result(exitCode = 1) {
  return { exitCode, stdout: "", stderr: "EPRIVATE:rename:5", cleanupFailure: uncertainty };
}

test.each([0, 1])(
  "buffered private operation preserves explicit cleanup uncertainty with exit%d",
  async (exitCode) => {
    owned.run.mockResolvedValue(result(exitCode));
    await expect(
      createWindowsPrivateFile("C:\\example\\new.key", Buffer.from("invented")),
    ).rejects.toMatchObject({ cleanupFailure: uncertainty });
  },
);

test("synchronous private errors preserve cleanup uncertainty", () => {
  owned.sync.mockReturnValue(result());
  let failure: unknown;
  try {
    readWindowsPrivateFileSync("C:\\example\\existing.key");
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({ cleanupFailure: uncertainty });
});

test("unjoined stream publication never launches receipt cleanup against a possibly live writer", async () => {
  owned.run.mockImplementation((_run, _input, options: { onStderr: (bytes: Buffer) => void }) => {
    options.onStderr(Buffer.from("OMNESIS_PRIVATE_CREATED:1:2:3\n"));
    return Promise.resolve(result());
  });
  const source = Readable.from([Buffer.from("invented")]);
  await expect(
    writeWindowsPrivateFileAtomicStream("C:\\example\\selected.key", source, 8),
  ).rejects.toMatchObject({ cleanupFailure: uncertainty });
  expect(owned.run).toHaveBeenCalledTimes(1);
  expect(source.destroyed).toBe(true);
});

test("source failure remains first when native completion is also unconfirmed", async () => {
  const source = new Readable({ read() {} }),
    primary = new Error("Invented producer failure");
  owned.run.mockImplementation((_run, _input, options: { onStderr: (bytes: Buffer) => void }) => {
    options.onStderr(Buffer.from("OMNESIS_PRIVATE_CREATED:1:2:3\n"));
    source.emit("error", primary);
    return Promise.resolve(result());
  });
  let failure: unknown;
  try {
    await writeWindowsPrivateFileAtomicStream("C:\\example\\selected.key", source, 8);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(AggregateError);
  expect(failure).toMatchObject({
    cause: primary,
    cleanupFailure: uncertainty,
    errors: [primary, uncertainty],
  });
  expect(owned.run).toHaveBeenCalledTimes(1);
});
