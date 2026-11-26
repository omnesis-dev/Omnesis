// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test } from "vitest";
import { pathLanes } from "./ci-scope.mjs";
import { behavioralBundles } from "./bundles.mjs";

test.each([
  "packages/core/src/source-permissions.ts",
  "packages/core/src/managed-key-recovery.ts",
  "packages/core/src/managed-background.ts",
  "packages/core/src/managed-background-rebind.ts",
  "packages/core/src/node-command.ts",
  "packages/core/src/worker-entry.ts",
  "packages/agent/src/codex-managed-process.ts",
  "packages/agent/src/codex-app-server-backend.ts",
  "packages/cli/src/desktop/protocol.ts",
  "packages/gateway/src/http/services/SourcePermissionsService.ts",
  "packages/gateway/src/http/routes/admin/sources.ts",
])("desktop consumer fixtures follow their actual producer: %s", (path) => {
  expect(pathLanes([path]).desktop).toBe(true);
  expect(behavioralBundles([path])).toEqual(expect.arrayContaining(["macos-logic", "macos-test"]));
});

test.each([
  "knip.json",
  "packages/core/src/index.ts",
  "packages/gateway/src/http/routes/search.ts",
  "packages/agent/src/codex-managed-process.test.ts",
  "packages/core/src/source-permissions.test.ts",
])("unrelated shared inputs and unit-only edits do not claim Darwin coverage: %s", (path) => {
  expect(pathLanes([path]).desktop).toBe(false);
  expect(behavioralBundles([path])).not.toEqual(expect.arrayContaining(["macos-logic"]));
});
