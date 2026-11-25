// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test } from "vitest";
import { reconcileDesktopMainDatabase } from "./index.js";
const input = () => ({
  sourcePath: "/does-not-exist/invented-private-source",
  targetPath: "/does-not-exist/invented-private-target",
  destinationPath: "/does-not-exist/invented-destination",
  sourceKey: Buffer.alloc(32, 1),
  targetKey: Buffer.alloc(32, 2),
  destinationKey: Buffer.alloc(32, 3),
});
test("real source worker is owned through exit and never forwards private exceptions", async () => {
  const options = input();
  const error = await reconcileDesktopMainDatabase(options, new AbortController().signal).catch(
    (error: unknown) => error,
  );
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe("The backup database could not be prepared safely");
  expect((error as Error).message).not.toContain("invented-private");
  expect(options.sourceKey).toEqual(Buffer.alloc(32, 1));
});
test("cancellation drains its own worker and releases admission without touching another operation", async () => {
  const controller = new AbortController();
  const pending = reconcileDesktopMainDatabase(input(), controller.signal);
  const rejection = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  await expect(reconcileDesktopMainDatabase(input(), new AbortController().signal)).rejects.toThrow(
    "already being prepared",
  );
  controller.abort();
  await rejection;
  await expect(reconcileDesktopMainDatabase(input(), new AbortController().signal)).rejects.toThrow(
    "could not be prepared safely",
  );
});
