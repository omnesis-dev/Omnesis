// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { join, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const nativeHome = vi.hoisted(() => vi.fn<() => string>());
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: nativeHome,
}));

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("OMNESIS_CONFIG_DIR", undefined);
  vi.stubEnv("HOME", undefined);
  nativeHome.mockReturnValue(join(tmpdir(), "invented-native-profile"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  nativeHome.mockClear();
});

describe("default config directory", () => {
  test("uses the native home when the shell HOME variable is absent", async () => {
    const { DEFAULT_CONFIG_DIR } = await import("./utils.js");
    expect(DEFAULT_CONFIG_DIR).toBe(
      join(tmpdir(), "invented-native-profile", ".config", "omnesis"),
    );
    expect(isAbsolute(DEFAULT_CONFIG_DIR)).toBe(true);
  });
  test("preserves an explicitly supplied shell home", async () => {
    const home = join(tmpdir(), "invented-shell-profile");
    vi.stubEnv("HOME", home);
    const { DEFAULT_CONFIG_DIR } = await import("./utils.js");
    expect(DEFAULT_CONFIG_DIR).toBe(join(home, ".config", "omnesis"));
    expect(nativeHome).not.toHaveBeenCalled();
  });
  test("keeps the explicit config directory authoritative", async () => {
    const override = join(tmpdir(), "invented-config-override");
    vi.stubEnv("OMNESIS_CONFIG_DIR", override);
    const { DEFAULT_CONFIG_DIR } = await import("./utils.js");
    expect(DEFAULT_CONFIG_DIR).toBe(override);
    expect(nativeHome).not.toHaveBeenCalled();
  });
});
