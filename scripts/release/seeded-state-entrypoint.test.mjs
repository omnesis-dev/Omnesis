// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("seeded-state container entrypoint", () => {
  it("stops before installation when the schema-version probe fails", () => {
    const directory = mkdtempSync(join(tmpdir(), "omnesis-seeded-entrypoint-"));
    temporaryDirectories.push(directory);
    const binDirectory = join(directory, "bin");
    mkdirSync(binDirectory);
    const callsPath = join(directory, "node-calls");
    const finalCommandMarker = join(directory, "final-command-ran");
    const fakeNode = join(binDirectory, "node");
    writeFileSync(
      fakeNode,
      `#!/bin/sh
printf '%s\\n' "$1" >> "$FAKE_NODE_CALLS"
if [ "$1" = "-p" ]; then
  printf '1.0.0'
  exit 0
fi
if [ "$1" = "--input-type=module" ]; then
  exit 17
fi
exit 99
`,
      { mode: 0o755 },
    );

    const result = spawnSync(
      "/bin/sh",
      [
        join(process.cwd(), "scripts/seeded-state/entrypoint.sh"),
        "/bin/sh",
        "-c",
        `printf reached > ${JSON.stringify(finalCommandMarker)}`,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          FAKE_NODE_CALLS: callsPath,
          OMNESIS_CONFIG_DIR: directory,
          OMNESIS_SEEDED_STATE_DIR: directory,
          OMNESIS_SEEDED_STATE_MANIFEST_SHA256: "test-manifest-digest",
          PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
        },
      },
    );

    expect(result.status).toBe(17);
    expect(readFileSync(callsPath, "utf8").trim().split("\n")).toEqual([
      "-p",
      "--input-type=module",
    ]);
    expect(existsSync(finalCommandMarker)).toBe(false);
  });
});
