// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as fs from "node:fs";
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
}));
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
}));
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { ProviderId, SourceId } from "@omnesis/types";
import definition from "./index.js";

let root: string;
afterEach(async () => {
  vi.restoreAllMocks();
  if (root) await rm(root, { recursive: true, force: true });
});

test("fresh access checks reopen the declared input without parsing, copying or syncing", async () => {
  root = await mkdtemp(join(tmpdir(), "things-access-"));
  const input = join(root, "main.sqlite");
  await writeFile(input, "not a valid source document or database");
  const instance = await definition.create!({
    accountId: "local",
    sourceId: SourceId("things:local"),
    providerId: ProviderId("things:local"),
    config: { dbPath: input },
  });
  const open = vi.spyOn(fs, "open");
  const read = vi.spyOn(fs, "readFile");
  const copy = vi.spyOn(fs, "copyFile");
  const signal = new AbortController().signal;
  expect(await instance.probeReadAccess!({ signal })).toEqual({ status: "readable" });
  expect(await instance.probeReadAccess!({ signal })).toEqual({ status: "readable" });
  expect(open.mock.calls.map(([path]) => path)).toEqual([input, input]);
  expect(read).not.toHaveBeenCalled();
  expect(copy).not.toHaveBeenCalled();
  open.mockImplementationOnce((...args: unknown[]) => {
    const callback = args.at(-1);
    (callback as (error: Error) => void)(
      Object.assign(new Error("private source location"), { code: "EPERM" }),
    );
  });
  expect(await instance.probeReadAccess!({ signal })).toEqual({ status: "denied" });
  expect(await instance.probeReadAccess!({ signal })).toEqual({ status: "readable" });
  expect(await instance.probeReadAccess!({ signal: AbortSignal.abort() })).toEqual({
    status: "unavailable",
  });
  await rm(input, { recursive: true });
  expect(await instance.probeReadAccess!({ signal })).toEqual({ status: "unavailable" });
});
