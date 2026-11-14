// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { detectInstalledBrowsers, getBrowserInfo } from "./paths.js";

describe("browser discovery paths", () => {
  test("finds Windows browsers under LocalAppData without offering macOS-only stores", () => {
    const context = {
      platform: "win32" as const,
      home: "C:\\Users\\Example",
      localAppData: "D:\\App Data",
      exists: (path: string) => path.endsWith("\\Local State"),
    };
    expect(detectInstalledBrowsers(context).map(({ id, baseDir }) => ({ id, baseDir }))).toEqual([
      { id: "chrome", baseDir: "D:\\App Data\\Google\\Chrome\\User Data" },
      { id: "brave", baseDir: "D:\\App Data\\BraveSoftware\\Brave-Browser\\User Data" },
      { id: "edge", baseDir: "D:\\App Data\\Microsoft\\Edge\\User Data" },
      { id: "vivaldi", baseDir: "D:\\App Data\\Vivaldi\\User Data" },
    ]);
    expect(getBrowserInfo("chrome", context)?.baseDir).toBe(
      "D:\\App Data\\Google\\Chrome\\User Data",
    );
    expect(getBrowserInfo("safari", context)).toBeNull();
    expect(getBrowserInfo("arc", context)).toBeNull();
  });

  test("falls back to the Windows user's local application directory", () => {
    const context = {
      platform: "win32" as const,
      home: "C:\\Users\\Example",
      exists: (path: string) =>
        path === "C:\\Users\\Example\\AppData\\Local\\Microsoft\\Edge\\User Data\\Default\\History",
    };
    expect(detectInstalledBrowsers(context).map(({ id }) => id)).toEqual(["edge"]);
    expect(getBrowserInfo("edge", context)?.baseDir).toBe(
      "C:\\Users\\Example\\AppData\\Local\\Microsoft\\Edge\\User Data",
    );
  });

  test("retains Linux discovery paths and excludes macOS-only browsers", () => {
    const context = {
      platform: "linux" as const,
      home: "/home/example",
      exists: (path: string) => path.endsWith("/Local State"),
    };
    expect(detectInstalledBrowsers(context).map(({ id, baseDir }) => ({ id, baseDir }))).toEqual([
      { id: "chrome", baseDir: "/home/example/.config/google-chrome" },
      { id: "brave", baseDir: "/home/example/.config/BraveSoftware/Brave-Browser" },
      { id: "edge", baseDir: "/home/example/.config/microsoft-edge" },
      { id: "vivaldi", baseDir: "/home/example/.config/vivaldi" },
    ]);
  });

  test("retains macOS application-support paths and Safari's separate history store", () => {
    const context = {
      platform: "darwin" as const,
      home: "/Users/example",
      exists: (path: string) =>
        path.endsWith("/Local State") || path.endsWith("/Safari/History.db"),
    };
    expect(detectInstalledBrowsers(context).map(({ id, baseDir }) => ({ id, baseDir }))).toEqual([
      { id: "chrome", baseDir: "/Users/example/Library/Application Support/Google/Chrome" },
      { id: "arc", baseDir: "/Users/example/Library/Application Support/Arc/User Data" },
      {
        id: "brave",
        baseDir: "/Users/example/Library/Application Support/BraveSoftware/Brave-Browser",
      },
      { id: "edge", baseDir: "/Users/example/Library/Application Support/Microsoft Edge" },
      { id: "vivaldi", baseDir: "/Users/example/Library/Application Support/Vivaldi" },
      { id: "safari", baseDir: "/Users/example/Library/Safari" },
    ]);
  });

  test("does not offer a browser whose profile files are absent", () => {
    const context = { platform: "win32" as const, home: "C:\\Users\\Example", exists: () => false };
    expect(detectInstalledBrowsers(context)).toEqual([]);
    expect(getBrowserInfo("chrome", context)).toBeNull();
    expect(getBrowserInfo("unknown", context)).toBeNull();
  });
});

const ARC_WINDOWS_SUBDIR =
  "Packages\\TheBrowserCompany.Arc_ttt1ap7aakyb4\\LocalCache\\Local\\Arc\\User Data";

test.each(["D:\\App Data", "C:\\Users\\Example\\AppData\\Local"])(
  "discovers an Arc packaged Windows history store under %s",
  (localAppData) => {
    const baseDir = `${localAppData}\\${ARC_WINDOWS_SUBDIR}`;
    const observed = new Set([`${baseDir}\\Local State`, `${baseDir}\\Default\\History`]);
    const context = {
      platform: "win32" as const,
      home: "C:\\Users\\Example",
      ...(localAppData.startsWith("D:") ? { localAppData } : {}),
      exists: (path: string) => observed.has(path),
    };
    expect(getBrowserInfo("arc", context)).toEqual({
      id: "arc",
      name: "Arc",
      engine: "chromium",
      baseDir,
    });
    expect(detectInstalledBrowsers(context).map(({ id }) => id)).toEqual(["arc"]);
    observed.delete(`${baseDir}\\Default\\History`);
    expect(getBrowserInfo("arc", context)).toBeNull();
  },
);

test("Arc on Windows discovers a non-default profile only when its history actually exists", () => {
  const baseDir = `D:\\App Data\\${ARC_WINDOWS_SUBDIR}`;
  const observed = new Set([`${baseDir}\\Local State`, `${baseDir}\\Profile 3\\History`]);
  const context = {
    platform: "win32" as const,
    home: "C:\\Users\\Example",
    localAppData: "D:\\App Data",
    exists: (path: string) => observed.has(path),
    readText: () =>
      JSON.stringify({ profile: { info_cache: { "Profile 3": { name: "Invented profile" } } } }),
  };
  expect(getBrowserInfo("arc", context)?.baseDir).toBe(baseDir);
  observed.delete(`${baseDir}\\Profile 3\\History`);
  expect(getBrowserInfo("arc", context)).toBeNull();
});

test.each(["not JSON", "{}", '{"profile":{"info_cache":{"..\\\\outside":{}}}}'])(
  "Arc on Windows refuses missing or malformed profile layout %s",
  (contents) => {
    const context = {
      platform: "win32" as const,
      home: "C:\\Users\\Example",
      exists: (path: string) => path.endsWith("\\Local State"),
      readText: () => contents,
    };
    expect(getBrowserInfo("arc", context)).toBeNull();
  },
);
