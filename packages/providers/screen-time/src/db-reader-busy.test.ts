// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SyncError } from "@omnesis/types";
import { KnowledgeDbReader } from "./db-reader.js";

// knowledgeC.db is written continuously while the machine is in use, so a copy
// of it can lose the race with that writer however many times it is retried.
// Standing in for that writer is the only way to reach the branch from a test:
// the hook changes the source the instant each copy finishes, which is exactly
// the shape the snapshot refuses.
const hooks = vi.hoisted(() => ({ afterCopy: () => {} }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    copyFileSync: (source: string, target: string) => {
      actual.copyFileSync(source, target);
      hooks.afterCopy();
    },
  };
});

const roots: string[] = [];
afterEach(() => {
  hooks.afterCopy = () => {};
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("reports a database that is mid-write as retryable, not as a broken source", () => {
  const root = mkdtempSync(join(tmpdir(), "knowledge-busy-"));
  roots.push(root);
  const path = join(root, "knowledgeC.db");
  writeFileSync(path, "initial");
  let writes = 0;
  hooks.afterCopy = () => {
    writes += 1;
    writeFileSync(path, `changed ${writes}`);
  };

  let thrown: unknown;
  try {
    new KnowledgeDbReader(path);
  } catch (error) {
    thrown = error;
  }

  // The kind is the whole point: `transient` keeps the source retryable and
  // keeps the operator from being told to fix something that is not broken.
  expect(thrown).toBeInstanceOf(SyncError);
  expect((thrown as SyncError).kind).toBe("transient");
  expect(writes).toBe(3);
});
