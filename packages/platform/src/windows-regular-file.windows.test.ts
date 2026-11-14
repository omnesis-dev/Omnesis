// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { readWindowsRegularFilePrefix } from "./windows-private-file.js";

test.runIf(process.platform === "win32")(
  "held-parent native reads preserve source ACLs and refuse junctions, directories and alternate streams",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "regular-source-read-"));
    try {
      const folder = join(root, "mail");
      mkdirSync(folder);
      const file = join(folder, "invented [$&] 雪.eml");
      const bytes = Buffer.from([0, 255, 10, 13, 65]);
      // A source file need not have the product's protected secret-file DACL.
      writeFileSync(file, bytes);
      for (const limit of [0, 3, 32 * 1024 * 1024]) {
        expect(await readWindowsRegularFilePrefix(file, limit)).toEqual({
          bytes: bytes.subarray(0, limit),
          size: BigInt(bytes.length),
        });
      }
      expect(readFileSync(file)).toEqual(bytes);
      symlinkSync(folder, join(root, "alias"), "junction");
      await expect(
        readWindowsRegularFilePrefix(join(root, "alias", "invented [$&] 雪.eml"), 3),
      ).rejects.toThrow();
      await expect(readWindowsRegularFilePrefix(folder, 3)).rejects.toThrow();
      writeFileSync(`${file}:invented-stream`, "invented excluded stream");
      await expect(readWindowsRegularFilePrefix(`${file}:invented-stream`, 3)).rejects.toThrow();
      await expect(readWindowsRegularFilePrefix(join(folder, "missing"), 3)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  45_000,
);
