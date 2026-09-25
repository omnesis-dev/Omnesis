// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { readJsonLines, scanLocalAgentSessionFiles } from "./local-agent-session-files.js";

const MiB = 1024 * 1024;

describe("scanLocalAgentSessionFiles — file size", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** A root holding one session file of the given size. Sparse, so no disk is used. */
  function rootWith(sizeBytes: number): string {
    const root = mkdtempSync(join(tmpdir(), "agent-session-scan-"));
    dirs.push(root);
    mkdirSync(join(root, "2026"), { recursive: true });
    const file = join(root, "2026", "rollout.jsonl");
    writeFileSync(file, "");
    truncateSync(file, sizeBytes);
    return root;
  }

  test("a long session of several hundred MiB is scanned, not refused", () => {
    // Long coding sessions reach hundreds of MiB. Refusing one made the whole
    // root unreadable: its days were never indexed, and no deletion under the
    // root could be detected while it existed.
    const scan = scanLocalAgentSessionFiles(
      [{ id: "sessions", path: rootWith(700 * MiB) }],
      [".jsonl"],
    );

    expect(scan.complete).toBe(true);
    expect(scan.files).toHaveLength(1);
  });

  test("a file past the cap still fails the root, naming why", () => {
    // The cap bounds how long one read may take. Beyond it the root cannot be
    // vouched for, and saying so is what keeps deletions from being inferred.
    const scan = scanLocalAgentSessionFiles(
      [{ id: "sessions", path: rootWith(1100 * MiB) }],
      [".jsonl"],
    );

    expect(scan.complete).toBe(false);
    expect(scan.rootFailures).toEqual({ sessions: "a file in it is over the size limit" });
  });
});

describe("readJsonLines — crash residue", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function read(content: string) {
    const dir = mkdtempSync(join(tmpdir(), "agent-session-read-"));
    dirs.push(dir);
    const file = join(dir, "rollout.jsonl");
    writeFileSync(file, content);
    const values: unknown[] = [];
    const result = await readJsonLines(file, (value) => {
      values.push(value);
    });
    return { values, ...result };
  }

  test("a run of NUL bytes left by a crash is not a damaged record", async () => {
    // A crash mid-write can leave zero-filled space where a write never reached
    // the disk. Reading it as damage kept the records around it unreadable for
    // good, since the file is never rewritten.
    const result = await read(`{"n":1}\n${"\0".repeat(632)}\n{"n":2}\n`);

    expect(result.malformedLines).toBe(0);
    expect(result.values).toEqual([{ n: 1 }, { n: 2 }]);
  });

  test("a record quoting a Unicode line separator is one record", async () => {
    // U+2028 and U+2029 are legal unescaped inside a JSON string. Splitting on
    // them cut such a record into fragments and read the session as damaged.
    const result = await read(`{"text":"one\u2028two\u2029three"}\n{"n":2}\n`);

    expect(result.malformedLines).toBe(0);
    expect(result.values).toEqual([{ text: "one\u2028two\u2029three" }, { n: 2 }]);
  });

  test("a line mixing NUL bytes with text is still damaged", async () => {
    const result = await read(`{"n":1}\n{"n":${"\0".repeat(8)}\n{"n":2}\n`);

    expect(result.malformedLines).toBe(1);
  });
});
