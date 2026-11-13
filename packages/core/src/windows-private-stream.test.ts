// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createReadStream } from "node:fs";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { writeWindowsPrivateFileAtomicStream } from "./windows-private-file.js";

vi.mock("node:crypto", async (original) => {
  const native = await original<typeof import("node:crypto")>();
  return { ...native, randomUUID: vi.fn(native.randomUUID) };
});
async function eventually(check: () => Promise<boolean>, timeout = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeout;
  do {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  return check();
}

describe.skipIf(process.platform !== "win32")("Windows authenticated private streams", () => {
  it("streams plaintext beyond old capture limits without buffering the whole input", async () => {
    const dir = await mkdtemp(join(tmpdir(), "windows-private-stream-")),
      path = join(dir, "plain.bin");
    const count = 384,
      chunkSize = 65536,
      expected = createHash("sha256");
    const source = Readable.from(
      (async function* () {
        for (let i = 0; i < count; i++) {
          const bytes = Buffer.alloc(chunkSize, i % 251);
          expected.update(bytes);
          yield bytes;
        }
      })(),
    );
    try {
      await writeWindowsPrivateFileAtomicStream(path, source, count * chunkSize);
      expect((await stat(path)).size).toBe(count * chunkSize);
      const actual = createHash("sha256");
      for await (const bytes of createReadStream(path)) actual.update(bytes);
      expect(actual.digest("hex")).toBe(expected.digest("hex"));
      expect(await readdir(dir)).toEqual(["plain.bin"]);
    } finally {
      source.destroy();
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("discards all emitted plaintext when authentication fails at the end", async () => {
    const dir = await mkdtemp(join(tmpdir(), "windows-private-auth-")),
      path = join(dir, "plain.bin");
    const failure = new Error("invented final authentication failure");
    const plaintext = Buffer.alloc(131072, 52);
    const source = Readable.from(
      (async function* () {
        yield plaintext;
        if (
          !(await eventually(async () => {
            const name = (await readdir(dir)).find((entry) => entry.includes(".omnesis-"));
            return name !== undefined && (await stat(join(dir, name))).size === plaintext.length;
          }))
        )
          throw new Error("Native plaintext staging did not finish before authentication");
        throw failure;
      })(),
    );
    try {
      await writeFile(path, "preserved original");
      await expect(
        writeWindowsPrivateFileAtomicStream(path, source, plaintext.length),
      ).rejects.toBe(failure);
      expect(await readFile(path, "utf8")).toBe("preserved original");
      expect(await readdir(dir)).toEqual(["plain.bin"]);
    } finally {
      source.destroy();
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("joins forced cancellation and deletes only the receipted staging identity", async () => {
    const dir = await mkdtemp(join(tmpdir(), "windows-private-abort-")),
      path = join(dir, "plain.bin");
    const abort = new AbortController();
    let sent = false;
    const source = new Readable({
      read() {
        if (!sent) {
          sent = true;
          this.push(Buffer.alloc(65536, 17));
        }
      },
    });
    const pending = writeWindowsPrivateFileAtomicStream(path, source, 1024 * 1024, {
      signal: abort.signal,
    }).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    try {
      expect(
        await eventually(async () => {
          const name = (await readdir(dir)).find((entry) => entry.includes(".omnesis-"));
          return name !== undefined && (await stat(join(dir, name))).size > 0;
        }),
      ).toBe(true);
      abort.abort();
      const result = await pending;
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Cancellation unexpectedly committed");
      expect(result.error).toMatchObject({ name: "AbortError" });
      expect(await readdir(dir)).toEqual([]);
    } finally {
      abort.abort();
      source.destroy();
      await pending;
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("does not overwrite a destination created after streaming began", async () => {
    const dir = await mkdtemp(join(tmpdir(), "windows-private-noclobber-")),
      path = join(dir, "plain.bin");
    const source = Readable.from(
      (async function* () {
        yield Buffer.from("verified");
        if (
          !(await eventually(async () =>
            (await readdir(dir)).some((name) => name.includes(".omnesis-")),
          ))
        )
          throw new Error("Native staging did not start");
        await writeFile(path, "concurrent preserved material");
      })(),
    );
    try {
      await expect(
        writeWindowsPrivateFileAtomicStream(path, source, 8, { replaceExisting: false }),
      ).rejects.toMatchObject({ code: "EEXIST" });
      expect(await readFile(path, "utf8")).toBe("concurrent preserved material");
      expect(await readdir(dir)).toEqual(["plain.bin"]);
    } finally {
      source.destroy();
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("never deletes a preexisting staging collision without a created receipt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "windows-private-collision-")),
      path = join(dir, "plain.bin");
    const staging = join(
      dir,
      basename(path) + ".omnesis-" + process.pid + "-11111111-2222-4333-8444-555555555555.tmp",
    );
    try {
      await writeFile(staging, "preserved foreign material");
      vi.mocked(randomUUID).mockReturnValueOnce("11111111-2222-4333-8444-555555555555");
      await expect(
        writeWindowsPrivateFileAtomicStream(path, Readable.from([Buffer.from("verified")]), 8),
      ).rejects.toMatchObject({ code: "EEXIST" });
      expect(await readFile(staging, "utf8")).toBe("preserved foreign material");
      expect(await readdir(dir)).toEqual([basename(staging)]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
