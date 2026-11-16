// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { expect, onTestFinished, test } from "vitest";
import { closeEnrollmentFixture, closeEnrollmentServers } from "./enrollment-fixture-cleanup.js";

function fixture(): { root: string; input: string } {
  const root = mkdtempSync(join(tmpdir(), "enrollment-cleanup-"));
  const input = join(root, "invented input.txt");
  writeFileSync(input, "fictional fixture input");
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  return { root, input };
}

test("removes shared inputs only after each owner has completed", async () => {
  const { root, input } = fixture();
  const order: number[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const closing = closeEnrollmentFixture(root, [
    async () => {
      expect(existsSync(input)).toBe(true);
      await held;
      order.push(1);
    },
    () => {
      expect(existsSync(input)).toBe(true);
      order.push(2);
    },
  ]);
  expect(existsSync(input)).toBe(true);
  expect(order).toEqual([]);
  release();
  await closing;
  expect(order).toEqual([1, 2]);
  expect(existsSync(root)).toBe(false);
});

test.each([undefined, new Error("Synthetic closure uncertainty")])(
  "retains files and the opaque cleanup marker while attempting other owners: %s",
  async (cleanupFailure) => {
    const { root, input } = fixture();
    const failure = Object.assign(new Error("Synthetic owner failure"), { cleanupFailure });
    let finalOwnerClosed = false;
    const error: unknown = await closeEnrollmentFixture(root, [
      () => {
        throw failure;
      },
      () => {
        finalOwnerClosed = true;
      },
    ]).catch((error: unknown) => error);
    expect(error).toHaveProperty("cleanupFailure");
    expect(error).toMatchObject({ cleanupFailure, errors: [failure] });
    expect(finalOwnerClosed).toBe(true);
    expect(readFileSync(input, "utf8")).toBe("fictional fixture input");
  },
);

test("an ordinary close failure also retains inputs without inventing a cleanup receipt", async () => {
  const { root, input } = fixture();
  const failure = new Error("Synthetic browser close failure");
  const error: unknown = await closeEnrollmentFixture(root, [() => Promise.reject(failure)]).catch(
    (error: unknown) => error,
  );
  expect(error).toBeInstanceOf(AggregateError);
  expect(error).not.toHaveProperty("cleanupFailure");
  expect(existsSync(input)).toBe(true);
});

test("closes an actual listener alongside a server whose startup never completed", async () => {
  const listening = createServer();
  const unstarted = createServer();
  onTestFinished(() => closeEnrollmentServers([listening, unstarted]));
  await new Promise<void>((resolve, reject) => {
    listening.once("error", reject);
    listening.listen(0, "127.0.0.1", resolve);
  });
  expect(listening.listening).toBe(true);
  await closeEnrollmentServers([listening, unstarted]);
  expect(listening.listening).toBe(false);
  expect(unstarted.listening).toBe(false);
});
