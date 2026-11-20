// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { gzipSync, zstdCompressSync } from "node:zlib";
import { afterEach, expect, test, vi } from "vitest";
import { readJsonLines } from "./local-agent-session-files.js";

const closeControl = vi.hoisted(() => ({
  hold: undefined as undefined | ((release: () => void) => void),
}));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    createReadStream: (...args: Parameters<typeof fs.createReadStream>) => {
      const [path, options] = args;
      return fs.createReadStream(path, {
        ...(typeof options === "object" ? options : {}),
        fs: {
          read: fs.read,
          close: (fd, callback) => {
            const release = () => fs.close(fd, callback);
            if (closeControl.hold) closeControl.hold(release);
            else release();
          },
        },
      });
    },
  };
});

const dirs: string[] = [];
afterEach(() => {
  closeControl.hold = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// See #1145 — parsing must not settle before its owned descriptor closes.
test.each([
  "eof",
  "gzip-eof",
  "zstd-eof",
  "break",
  "throw",
  "abort",
  "pre-abort",
  "decode-error",
] as const)("JSONL %s waits for its owned file descriptor to close", async (mode) => {
  const root = mkdtempSync(join(tmpdir(), "session-close-"));
  dirs.push(root);
  const gzip = mode === "gzip-eof" || mode === "decode-error";
  const path = join(
    root,
    gzip ? "session.jsonl.gz" : mode === "zstd-eof" ? "session.jsonl.zst" : "session.jsonl",
  );
  const content = Buffer.from('{"n":1}\n{"n":2}\n');
  writeFileSync(
    path,
    mode === "gzip-eof"
      ? gzipSync(content)
      : mode === "zstd-eof"
        ? zstdCompressSync(content)
        : content,
  );
  const requested = Promise.withResolvers<void>();
  let releaseClose = () => {};
  closeControl.hold = (release) => {
    releaseClose = release;
    requested.resolve();
  };
  const controller = new AbortController();
  const failure = new Error("Invented visitor failure");
  if (mode === "pre-abort") controller.abort(failure);
  let settled = false;
  const result = readJsonLines(
    path,
    () => {
      if (mode === "break") return false;
      if (mode === "throw") throw failure;
      if (mode === "abort") controller.abort(failure);
    },
    { signal: controller.signal },
  );
  void result.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  try {
    await requested.promise;
    // Let parsing settle independently of the held native close callback.
    await setImmediate();
    expect(settled).toBe(false);
  } finally {
    releaseClose();
    await result.catch(() => {});
  }
  if (mode === "throw") await expect(result).rejects.toBe(failure);
  else if (mode === "abort") await expect(result).rejects.toBe(failure);
  else if (mode === "pre-abort")
    await expect(result).rejects.toMatchObject({ name: "AbortError", cause: failure });
  else if (mode === "decode-error")
    await expect(result).rejects.toMatchObject({ code: "Z_DATA_ERROR" });
  else await expect(result).resolves.toEqual({ malformedLines: 0, trailingPartial: false });
});
