// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, expect, test, vi } from "vitest";
const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("./windows-files.js", () => ({
  privateWindowsFiles: () => ({ readWindowsPrivateFileContentsSync: mocks.read }),
}));
import { loadPendingAuthorization } from "./pending-authorization.js";

afterEach(() => vi.unstubAllGlobals());

test("Windows refuses unsafe pending verifier material instead of treating it as absent", () => {
  vi.stubGlobal("process", { ...process, platform: "win32" });
  const unsafe = Object.assign(new Error("unsafe access control"), { code: "EPRIVATE" });
  mocks.read.mockImplementation(() => {
    throw unsafe;
  });
  expect(() => loadPendingAuthorization("invented")).toThrow(unsafe);
  expect(mocks.read).toHaveBeenCalledWith("invented.pending-authorization");
});

test("Windows still treats missing and privately stored malformed records as absent", () => {
  vi.stubGlobal("process", { ...process, platform: "win32" });
  mocks.read.mockImplementation(() => {
    throw Object.assign(new Error("absent"), { code: "ENOENT" });
  });
  expect(loadPendingAuthorization("invented")).toBeNull();
  mocks.read.mockReturnValue(Buffer.from("{invented incomplete JSON"));
  expect(loadPendingAuthorization("invented")).toBeNull();
});
