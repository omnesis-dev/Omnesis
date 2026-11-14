// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { beforeEach, expect, it, vi } from "vitest";
const guards = vi.hoisted(() => ({ prepare: vi.fn(), inspect: vi.fn(), stat: vi.fn() }));
vi.mock("@omnesis/core/private-files", () => ({
  prepareWindowsPrivateStorageDirectorySync: guards.prepare,
  inspectWindowsPrivatePathSync: guards.inspect,
}));
vi.mock("node:fs", async (original) => ({
  ...(await original<typeof import("node:fs")>()),
  lstatSync: guards.stat,
}));
import { prepareWindowsRelayDatabase } from "./windows-storage.js";
beforeEach(() => {
  guards.prepare.mockReset();
  guards.inspect.mockReset().mockReturnValue({ private: true, fixed: false });
  guards.stat.mockReset().mockReturnValue(undefined);
});

it.each([
  "",
  String.raw`C:\private\state.db:stream`,
  String.raw`C:\private\CON.db`,
  String.raw`C:\private\COM¹.db`,
  String.raw`C:\private\state.db.`,
  "C:\\private\\trailing ",
  String.raw`C:\alias.\state.db`,
  "C:\\private\\nul\0.db",
])("refuses ambiguous Win32 filename %j before directory creation", (path) => {
  expect(() => prepareWindowsRelayDatabase(path)).toThrow(/Relay/);
  expect(guards.prepare).not.toHaveBeenCalled();
  expect(guards.stat).not.toHaveBeenCalled();
});
it("prepares safe ancestry before inspecting every existing DB companion without repairing it", () => {
  const filename = String.raw`C:\invented private folder\state.db`;
  guards.stat.mockReturnValue({});
  expect(prepareWindowsRelayDatabase(filename)).toBe(filename);
  expect(guards.prepare).toHaveBeenCalledWith(String.raw`C:\invented private folder`);
  expect(guards.prepare.mock.invocationCallOrder[0]).toBeLessThan(
    guards.stat.mock.invocationCallOrder[0]!,
  );
  expect(guards.inspect.mock.calls).toEqual(
    ["", "-wal", "-shm", "-journal"].map((suffix) => [filename + suffix, "file"]),
  );
});
it.each(["", "-wal", "-shm", "-journal"])("refuses an unsafe existing companion %j", (suffix) => {
  const filename = String.raw`C:\private\state.db`;
  guards.stat.mockImplementation((path: string) => (path === filename + suffix ? {} : undefined));
  guards.inspect.mockReturnValue({ private: false, fixed: false, error: "EPRIVATE" });
  expect(() => prepareWindowsRelayDatabase(filename)).toThrow(
    "Existing relay database files require private",
  );
  expect(guards.inspect).toHaveBeenCalledExactlyOnceWith(filename + suffix, "file");
});
it("preserves native ancestor failure and never inspects files after it", () => {
  const failure = new Error("Invented unsafe ancestor");
  guards.prepare.mockImplementation(() => {
    throw failure;
  });
  expect(() => prepareWindowsRelayDatabase(String.raw`C:\private\state.db`)).toThrow(failure);
  expect(guards.stat).not.toHaveBeenCalled();
});

it("refuses ill-formed Unicode before Node and native path encodings could disagree", () => {
  const path = "C:\\private\\" + String.fromCharCode(0xd800) + ".db";
  expect(() => prepareWindowsRelayDatabase(path)).toThrow("invalid Unicode");
  expect(guards.prepare).not.toHaveBeenCalled();
});
