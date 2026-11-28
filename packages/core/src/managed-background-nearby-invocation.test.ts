// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { join } from "node:path";
import { beforeEach, expect, test, vi } from "vitest";

const root = join("/example/runtime", "a".repeat(64));
const profile = {
  configDir: "/example/library",
  instance: "desktop-" + "b".repeat(16),
  secretService: "dev.omnesis.desktop." + "b".repeat(64),
};
beforeEach(() => {
  vi.resetModules();
});
async function captured(extra: Record<string, unknown> = {}) {
  const api = await import("./node-command.js");
  api.installManagedRuntimeLauncher({
    root,
    launcher: join(root, "runtime-exec"),
    preload: join(root, "packages/core/dist/managed-runtime-bootstrap.js"),
    ...extra,
  });
  return import("./managed-background-nearby.js");
}

test("interactive query fixes native mode and exact captured epoch without an arbitrary command", async () => {
  const api = await captured();
  const invocation = api.managedDesktopNearbyInvocation(profile, import.meta.url)!;
  expect(invocation.command).toBe(join(root, "runtime-exec"));
  expect(invocation.args[0]).toBe("--background-nearby");
  expect(JSON.parse(Buffer.from(invocation.args[1]!, "base64url").toString())).toEqual({
    version: 1,
    scope: { format: 1, ...profile },
    epoch: "a".repeat(64),
  });
});

test.each([{ backgroundRetirement: {} }, { backgroundOwner: {} }])(
  "retirement or a forged owner cannot obtain an invocation %#",
  async (extra) => {
    const api = await captured(extra);
    expect(() => api.managedDesktopNearbyInvocation(profile, import.meta.url)).toThrow();
  },
);

test.each([
  { ...profile, configDir: "/example/../library" },
  { ...profile, instance: "other" },
  { ...profile, secretService: "other" },
])("invalid scope cannot be passed to the native read query %#", async (value) => {
  const api = await captured();
  expect(() => api.managedDesktopNearbyInvocation(value, import.meta.url)).toThrow();
});

test("unregistered source does not start a browser or native child", async () => {
  const api = await import("./managed-background-nearby.js");
  expect(api.managedDesktopNearbyInvocation(profile, import.meta.url)).toBeNull();
});
