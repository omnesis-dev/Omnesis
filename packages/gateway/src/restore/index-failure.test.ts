// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test, vi } from "vitest";
const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("./process-launcher.js", () => ({ runRestoreProcess: run }));
import { reconcileDesktopMainDatabase } from "./index.js";
const options = {
  sourcePath: "/example/source",
  targetPath: "/example/target",
  destinationPath: "/example/destination",
  sourceKey: Buffer.alloc(32),
  targetKey: Buffer.alloc(32),
  destinationKey: Buffer.alloc(32),
};

test("domain projection preserves fixed reasons and generic copy while rejecting unknown or malformed results", async () => {
  for (const [reply, failureCode] of [
    [{ ok: false, failureCode: "unreviewed-table" }, "unreviewed-table"],
    [{ ok: false, failureCode: "worker-load-or-exit" }, "worker-load-or-exit"],
    [{ ok: false, failureCode: "invented-private-SQL" }, "invalid-reply"],
    [{ ok: true, result: { inventedPrivateField: "secret" } }, "invalid-result"],
  ] as const) {
    run.mockResolvedValueOnce(reply);
    const error: unknown = await reconcileDesktopMainDatabase(
      options,
      new AbortController().signal,
    ).catch((error) => error);
    expect(error).toMatchObject({
      message: "The backup database could not be prepared safely",
      failureCode,
    });
    expect(JSON.stringify(error)).not.toMatch(/inventedPrivateField|invented-private-SQL|secret/);
  }
});
