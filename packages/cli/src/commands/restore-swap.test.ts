// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { SwapRollbackError, swapIntoPlace } from "./restore-swap.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A target with one entry to replace and one to remove, and a stage holding the replacement. */
function fixture() {
  const target = mkdtempSync(join(tmpdir(), "omnesis-swap-"));
  dirs.push(target);
  writeFileSync(join(target, "omnesis.db"), "before");
  writeFileSync(join(target, "index.db"), "stale index");
  writeFileSync(join(target, "keyring.pass"), "machine");
  const workDir = join(target, ".omnesis-restore-test");
  mkdirSync(join(workDir, "stage", "keyring", "storage-keys"), { recursive: true });
  writeFileSync(join(workDir, "stage", "omnesis.db"), "after");
  writeFileSync(join(workDir, "stage", "keyring", "storage-keys", "main-db.json"), "key");
  return {
    target,
    workDir,
    place: [
      { rel: "omnesis.db", from: join(workDir, "stage", "omnesis.db") },
      { rel: "keyring/storage-keys", from: join(workDir, "stage", "keyring", "storage-keys") },
    ],
    remove: ["index.db"],
  };
}

describe("swapping a stage into a config dir", () => {
  test("places, removes, keeps the rest and cleans up after itself", async () => {
    const plan = fixture();
    await swapIntoPlace(plan);
    expect(readFileSync(join(plan.target, "omnesis.db"), "utf8")).toBe("after");
    expect(readFileSync(join(plan.target, "keyring", "storage-keys", "main-db.json"), "utf8")).toBe(
      "key",
    );
    expect(existsSync(join(plan.target, "index.db"))).toBe(false);
    expect(readFileSync(join(plan.target, "keyring.pass"), "utf8")).toBe("machine");
    expect(existsSync(plan.workDir)).toBe(false);
  });

  test("a commit step that fails rolls every entry back, created directories included", async () => {
    const plan = fixture();
    await expect(
      swapIntoPlace({
        ...plan,
        commit: () => Promise.reject(new Error("the keyring refused the key")),
      }),
    ).rejects.toThrow(/the keyring refused the key/);
    expect(readFileSync(join(plan.target, "omnesis.db"), "utf8")).toBe("before");
    expect(readFileSync(join(plan.target, "index.db"), "utf8")).toBe("stale index");
    expect(existsSync(join(plan.target, "keyring"))).toBe(false);
    expect(readdirSync(join(plan.workDir, "superseded"))).toEqual([]);
  });

  test("a rollback that cannot put an entry back says where the previous files are", async () => {
    const plan = fixture();
    let calls = 0;
    const rename = (from: string, to: string): void => {
      calls += 1;
      // Fail the last placement, then the first move back.
      if (calls === 4 || calls === 5) throw new Error(`rename ${calls} failed`);
      renameSync(from, to);
    };
    const err = await swapIntoPlace({ ...plan, rename }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SwapRollbackError);
    expect((err as Error).message).toContain(join(plan.workDir, "superseded"));
    expect(existsSync(plan.workDir)).toBe(true);
  });
});
