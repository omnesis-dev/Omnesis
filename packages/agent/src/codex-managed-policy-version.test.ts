// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test } from "vitest";
import { MANAGED_CODEX_QUALIFIED_VERSION } from "./codex-managed-policy-version.js";
import { CODEX_RUNTIME_COMPAT, isSupportedCodexCliVersion } from "./codex-compat.js";

test("requested package must match the explicitly reviewed managed policy version", () => {
  expect(MANAGED_CODEX_QUALIFIED_VERSION).toBe("0.171.0");
  expect(CODEX_RUNTIME_COMPAT.testedVersion).toBe(MANAGED_CODEX_QUALIFIED_VERSION);
});
test("headless compatibility retains previous supported versions independently", () => {
  for (const version of [
    "0.142.0",
    "0.151.0",
    "0.163.0",
    "0.166.0",
    "0.167.0",
    "0.169.0",
    "0.171.0",
  ])
    expect(isSupportedCodexCliVersion(version)).toBe(true);
});
