// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const run = promisify(execFile);
const script = fileURLToPath(new URL("../bench-storage-accounting.mjs", import.meta.url));
const cwd = fileURLToPath(new URL("../../", import.meta.url));

test.each(["legacy", "needed"])(
  "keeps exact accounting parity in the %s benchmark",
  async (comparison) => {
    const { stdout } = await run(
      process.execPath,
      [
        "--import",
        "tsx",
        script,
        "--rows",
        "24",
        "--body-bytes",
        "64",
        "--large-every",
        "8",
        "--large-bytes",
        "128",
        "--runs",
        "1",
      ],
      { cwd, env: { ...process.env, OMNESIS_STORAGE_BENCH_COMPARISON: comparison } },
    );
    const output = stdout
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line));
    expect(output.find((entry) => entry.fixture)?.fixture).toMatchObject({
      comparison,
      documents: 24,
      chunks: 24,
    });
    const parity = output.find((entry) => entry.exactParityBaseline)?.exactParityBaseline;
    expect(parity).toMatchObject({ documents: 24, chunks: 24, embeddingBytes: 24 * 512 });
    if (comparison === "needed") {
      expect(parity.mainTables).toBeNull();
      const before = output.find((entry) => entry.phase === "before");
      const after = output.find((entry) => entry.phase === "after");
      expect(before.mainAllocationPages).toBeGreaterThan(0);
      expect(after.mainAllocationPages).toBe(0);
      expect(after.indexAllocationPages).toBeGreaterThan(0);
      expect(after.indexAllocationPages).toBe(before.indexAllocationPages);
    } else {
      expect(parity.mainTables).toContainEqual(expect.objectContaining({ name: "documents" }));
    }
    expect(output.filter((entry) => entry.summary)).toHaveLength(2);
  },
);
