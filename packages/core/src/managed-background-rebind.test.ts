// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { join } from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
const epoch = "a".repeat(64),
  root = join("/example/runtime", epoch);
const profile = {
  configDir: "/example/library",
  instance: `desktop-${"b".repeat(16)}`,
  secretService: `dev.omnesis.desktop.${"c".repeat(64)}`,
};
const binding = {
  version: 1 as const,
  scope: { format: 1 as const, ...profile },
  epoch: "d".repeat(64),
  pid: 123,
  birth: { seconds: "1", microseconds: "2" },
  origin: { state: "verified" as const },
};
beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
});
async function fixture(extra: Record<string, unknown> = {}) {
  const node = await import("./node-command.js");
  node.installManagedRuntimeLauncher({
    root,
    launcher: join(root, "runtime-exec"),
    preload: join(root, "packages/core/dist/managed-runtime-bootstrap.js"),
    ...extra,
  });
  return import("./managed-background-rebind.js");
}
test("binding and rebind factories pin target to captured epoch and exact old authenticated descriptor", async () => {
  const api = await fixture();
  const query = api.managedDesktopBackgroundBindingInvocation(profile, import.meta.url)!;
  expect(query.command).toBe(join(root, "runtime-exec"));
  expect(query.args[0]).toBe("--background-binding");
  expect(JSON.parse(Buffer.from(query.args[1]!, "base64url").toString())).toEqual({
    version: 1,
    scope: binding.scope,
    epoch,
  });
  const rebind = api.managedDesktopBackgroundRebindInvocation(profile, binding, import.meta.url)!;
  expect(rebind.args[0]).toBe("--background-rebind");
  expect(JSON.parse(Buffer.from(rebind.args[1]!, "base64url").toString())).toEqual({
    version: 1,
    scope: binding.scope,
    epoch,
    expected: {
      scope: binding.scope,
      epoch: binding.epoch,
      pid: binding.pid,
      birth: binding.birth,
      origin: binding.origin,
    },
  });
});
test.each([{ backgroundOwner: {} }, { backgroundRetirement: {} }])(
  "owned child cannot obtain a rebind controller invocation %#",
  async (extra) => {
    const api = await fixture(extra);
    expect(() => api.managedDesktopBackgroundBindingInvocation(profile, import.meta.url)).toThrow();
  },
);
test.each([
  { ...binding, pid: 0 },
  { ...binding, epoch: "old" },
  { ...binding, scope: { ...binding.scope, configDir: "/example/other" } },
  { ...binding, extra: true },
])("foreign or malformed binding refused %#", async (value) => {
  const api = await fixture();
  expect(() => api.parseManagedDesktopBackgroundBinding(value, profile.configDir)).toThrow();
});
test("source fallback ignores forged inherited binding metadata", async () => {
  vi.stubEnv("OMNESIS_DESKTOP_BACKGROUND_BINDING", JSON.stringify(binding));
  const api = await import("./managed-background-rebind.js");
  expect(api.managedDesktopBackgroundBindingInvocation(profile, import.meta.url)).toBeNull();
});
test("compiled Darwin cannot source-fallback when its preload is absent", async () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
  try {
    const api = await import("./managed-background-rebind.js");
    expect(() =>
      api.managedDesktopBackgroundBindingInvocation(profile, "file:///example/compiled.js"),
    ).toThrow();
  } finally {
    Object.defineProperty(process, "platform", platform);
  }
});

test("origin readiness and exact pending client incarnation are mandatory bounded metadata", async () => {
  const api = await fixture();
  const pending = {
    state: "pending" as const,
    client: { pid: 456, birth: { seconds: "3", microseconds: "4" } },
  };
  const observed = { ...binding, origin: pending };
  expect(api.parseManagedDesktopBackgroundBinding(observed, profile.configDir).origin).toEqual(
    pending,
  );
  const command = api.managedDesktopBackgroundRebindInvocation(profile, observed, import.meta.url)!;
  expect(JSON.parse(Buffer.from(command.args[1]!, "base64url").toString()).expected.origin).toEqual(
    pending,
  );
  for (const origin of [
    undefined,
    { state: "pending" },
    { state: "pending", client: { pid: 0, birth: pending.client.birth } },
    { state: "verified", client: pending.client },
    { state: "pending", client: { ...pending.client, nonce: "untrusted" } },
  ]) {
    expect(() =>
      api.parseManagedDesktopBackgroundBinding({ ...binding, origin }, profile.configDir),
    ).toThrow();
  }
});
