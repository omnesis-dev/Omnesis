// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import { ownedProcessCleanupReceipt } from "@omnesis/core";
import { WhisperTranscriber } from "./whisper-transcriber.js";

// Replace only the model entrypoint; the real process owner and Windows
// native identity/Job workers remain intact.
vi.mock("@omnesis/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@omnesis/core")>();
  return {
    ...actual,
    resolveSubprocessEntry: (specifier: string, base: string) =>
      specifier === "./whisper-worker.ts"
        ? {
            command: process.execPath,
            args: [fileURLToPath(new URL("./testing/puppet-whisper-worker.mjs", import.meta.url))],
          }
        : actual.resolveSubprocessEntry(specifier, base),
  };
});
const fixtures: Array<{ transcriber: WhisperTranscriber; dir: string }> = [];
afterEach(async () => {
  const failures: unknown[] = [];
  for (const { transcriber, dir } of fixtures.splice(0)) {
    let uncertain = false;
    try {
      await transcriber.dispose();
    } catch (error) {
      uncertain = ownedProcessCleanupReceipt(error) !== undefined;
      failures.push(error);
    }
    const receipt = transcriber.cleanupFailure();
    if (ownedProcessCleanupReceipt(receipt)) {
      uncertain = true;
      failures.push(receipt);
    }
    if (!uncertain) rmSync(dir, { recursive: true, force: true });
  }
  if (failures.length) throw new AggregateError(failures, "Physical worker fixture cleanup failed");
});
function create(mode: "normal" | "invalid" | "loading", descendant = false) {
  const dir = mkdtempSync(join(tmpdir(), "whisper physical-"));
  const modelPath = join(dir, "invented model.json");
  const record = join(dir, "worker-record.json");
  const transcriber = new WhisperTranscriber({
    modelPath,
    modelId: "whisper-fixture",
    requestTimeoutMs: 30_000,
    decodeAudio: async () => new Float32Array(160),
  });
  fixtures.push({ transcriber, dir });
  writeFileSync(modelPath, JSON.stringify({ mode, record, descendant }));
  return { transcriber, record, modelPath };
}
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
    socket.setTimeout(1000, () => {
      socket.destroy();
      reject(new Error("Fixture listener probe timed out"));
    });
  });
}

test("the default owned spawner exchanges real framed PCM and joins physical worker disposal", async () => {
  const { transcriber } = create("normal");
  expect(await transcriber.transcribe(new Uint8Array([1]), "audio/wav")).toMatchObject({
    text: "Invented physical worker transcript.",
    language: "en",
    segments: [{ startMs: 0, endMs: 1200, text: "Invented physical worker transcript." }],
  });
  await transcriber.dispose();
  expect(transcriber.cleanupFailure()).toBeUndefined();
}, 60_000);

test("malformed physical worker output becomes a joined failure rather than an uncaught gateway callback", async () => {
  const { transcriber } = create("invalid");
  await expect(transcriber.transcribe(new Uint8Array([1]), "audio/wav")).rejects.toThrow(
    /worker response|failed to start/,
  );
  await transcriber.dispose();
  expect(transcriber.cleanupFailure()).toBeUndefined();
}, 60_000);

test.skipIf(process.platform !== "win32")(
  "startup disposal joins a detached Windows descendant before releasing model input",
  async () => {
    const { transcriber, record, modelPath } = create("loading", true);
    const request = transcriber
      .transcribe(new Uint8Array([1]), "audio/wav")
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(existsSync(record)).toBe(true), { timeout: 20_000 });
    const state = JSON.parse(readFileSync(record, "utf8")) as {
      port: number;
      descendantPid: number;
    };
    expect(Number.isInteger(state.descendantPid)).toBe(true);
    expect(await reachable(state.port)).toBe(true);
    expect(existsSync(modelPath)).toBe(true);
    await transcriber.dispose();
    expect(await request).toBeInstanceOf(Error);
    expect(await reachable(state.port)).toBe(false);
    expect(transcriber.cleanupFailure()).toBeUndefined();
    expect(existsSync(modelPath)).toBe(true);
  },
  60_000,
);
