// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { canDenyFixtureReads, setFixtureMode } from "./file-permissions.js";

test.skipIf(!canDenyFixtureReads)(
  "owned fixtures stage actual file and directory read denial and restore it",
  () => {
    const root = mkdtempSync(join(tmpdir(), "owned-permission-fixture-"));
    const file = join(root, "note.txt");
    const directory = join(root, "folder");
    mkdirSync(directory);
    writeFileSync(file, "Invented private fixture");
    try {
      setFixtureMode(file, 0o000);
      expect(() => readFileSync(file)).toThrow(
        expect.objectContaining({ code: expect.stringMatching(/^(EACCES|EPERM)$/u) }),
      );
      setFixtureMode(file, 0o600);
      expect(readFileSync(file, "utf8")).toBe("Invented private fixture");
      setFixtureMode(directory, 0o000);
      expect(() => readdirSync(directory)).toThrow(
        expect.objectContaining({ code: expect.stringMatching(/^(EACCES|EPERM)$/u) }),
      );
      setFixtureMode(directory, 0o700);
      expect(readdirSync(directory)).toEqual([]);
    } finally {
      setFixtureMode(file, 0o600);
      setFixtureMode(directory, 0o700);
      rmSync(root, { recursive: true, force: true });
    }
  },
);
