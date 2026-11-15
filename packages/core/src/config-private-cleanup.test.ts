// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test, vi } from "vitest";
import { readCollectorTokenFile, readTokenFile } from "./config.js";

const operations = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("./secret-file.js", async (original) => ({
  ...(await original<typeof import("./secret-file.js")>()),
  readSecretTextFileSync: operations.read,
}));
afterEach(() => {
  operations.read.mockReset();
});

const readers = [
  { leaf: "token", read: readTokenFile },
  { leaf: "collector-token", read: readCollectorTokenFile },
] as const;
const directory = join(tmpdir(), "invented-token-reader");

for (const reader of readers) {
  test.each([false, true])(
    `${reader.leaf} preserves private cleanup uncertainty (nested=%s)`,
    (nested) => {
      const marker = Object.assign(new Error("invented private reader uncertainty"), {
        code: "ENOENT",
        cleanupFailure: undefined,
      });
      const failure = nested
        ? Object.assign(new Error("invented private reader wrapper", { cause: marker }), {
            code: "ENOENT",
          })
        : marker;
      operations.read.mockImplementation(() => {
        throw failure;
      });
      let caught: unknown;
      try {
        reader.read(directory);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(failure);
      expect(operations.read).toHaveBeenCalledExactlyOnceWith(join(directory, reader.leaf), {
        configDir: directory,
      });
    },
  );

  test.each(["ENOENT", "EACCES"])(
    `${reader.leaf} keeps the ordinary joined %s fallback`,
    (code) => {
      operations.read.mockImplementation(() => {
        throw Object.assign(new Error("invented joined read refusal"), { code });
      });
      expect(reader.read(directory)).toBeNull();
    },
  );

  test(`${reader.leaf} retains decoded token and absent-file behavior`, () => {
    operations.read.mockReturnValueOnce(" fixture-token\n").mockReturnValueOnce(null);
    expect(reader.read(directory)).toBe("fixture-token");
    expect(reader.read(directory)).toBeNull();
  });
}
