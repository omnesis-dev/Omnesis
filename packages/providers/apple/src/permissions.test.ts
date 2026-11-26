// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { expect, test, vi } from "vitest";
import { appleStorePermissions } from "./permissions.js";
import definition from "./index.js";

test("protected Apple stores declare purpose without claiming global FDA or a responsible executable", async () => {
  for (const source of definition.sources) {
    expect(source.permissionRequirements?.[0]?.kind).toBe("protected-files");
    expect(source.permissionRequirements?.[0]?.blocking).toBe(true);
    expect(source.probePermissionAccess).toBeTypeOf("function");
  }
  const voicemail = definition.sources.find((source) => source.id === "apple-voicemail")!;
  expect(voicemail.permissionRequirements?.flatMap((item) => item.actions)).not.toContainEqual({
    kind: "open-system-settings",
    category: "full-disk-access",
  });
  const probe = vi.fn(async () => ({ status: "denied" as const }));
  const permission = appleStorePermissions("Invented local store", probe);
  expect(
    await permission.probePermissionAccess!({
      configDir: "/tmp/fixture",
      params: {},
      signal: new AbortController().signal,
    }),
  ).toEqual({ status: "denied" });
  expect(probe).toHaveBeenCalledOnce();
  expect(JSON.stringify(permission.permissionRequirements)).not.toContain("<collector-executable>");
});
