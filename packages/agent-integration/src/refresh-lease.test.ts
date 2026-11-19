// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, expect, test, vi } from "vitest";
const mocks = vi.hoisted(() => ({ open: vi.fn(), stat: vi.fn(), unlink: vi.fn() }));
vi.mock("node:fs/promises", () => mocks);
import { removeStaleRefreshLock, withCredentialRefreshLock } from "./refresh-lease.js";

afterEach(() => vi.restoreAllMocks());

test("stale inspection retains exact NTFS identities above Number precision", async () => {
  const close = vi.fn();
  const inspected = vi
    .fn()
    .mockResolvedValue({ dev: 1n, ino: 9007199254740992n, mtimeMs: BigInt(Date.now() - 500000) });
  mocks.open.mockResolvedValue({ stat: inspected, readFile: async () => "999999\n", close });
  mocks.stat.mockResolvedValue({ dev: 1n, ino: 9007199254740993n });
  mocks.unlink.mockReset();
  vi.spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error("gone"), { code: "ESRCH" });
  });
  await removeStaleRefreshLock("invented.refresh.lock");
  expect(inspected).toHaveBeenCalledWith({ bigint: true });
  expect(mocks.stat).toHaveBeenCalledWith("invented.refresh.lock", { bigint: true });
  expect(mocks.unlink).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledOnce();
});

test("release never removes a distinct successor and always closes the held lease", async () => {
  const close = vi.fn();
  mocks.open.mockResolvedValue({
    writeFile: async () => {},
    stat: async () => ({ dev: 1n, ino: 9007199254740992n }),
    close,
  });
  mocks.stat.mockResolvedValue({ dev: 1n, ino: 9007199254740993n });
  mocks.unlink.mockReset();
  await withCredentialRefreshLock(
    "invented",
    undefined,
    () => undefined,
    async () => {},
  );
  expect(mocks.unlink).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledOnce();
});
