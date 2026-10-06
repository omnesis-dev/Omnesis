// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
const fixture = vi.hoisted(() => ({ home: "" }));
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: () => fixture.home,
}));
import { assertDemoIsolation } from "./synthetic-demo-host.js";

beforeEach(() => {
  fixture.home = mkdtempSync("/tmp/synthetic-isolation-test-");
  mkdirSync(join(fixture.home, ".config"), { recursive: true });
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(fixture.home, { recursive: true, force: true });
});
describe("synthetic demo host isolation", () => {
  it("refuses live config descendants and the live port before any connection", () => {
    vi.stubEnv("OMNESIS_SYNTHETIC", "1");
    const live = join(homedir(), ".config", "omnesis");
    expect(() => assertDemoIsolation(live, "https://localhost:18761")).toThrow();
    expect(() => assertDemoIsolation(join(live, "test"), "https://localhost:18761")).toThrow();
    expect(() => assertDemoIsolation("/tmp/demo-host", "https://localhost:7600")).toThrow();
    expect(() => assertDemoIsolation("/tmp/demo-host", "https://localhost")).toThrow();
    expect(() => assertDemoIsolation("/tmp/demo-host", "http://localhost:18761")).toThrow();
  });
  it("refuses an alias of the home directory even for a nonexistent live descendant", () => {
    vi.stubEnv("OMNESIS_SYNTHETIC", "1");
    const alias = join(fixture.home, "home-alias");
    symlinkSync(fixture.home, alias, "dir");
    expect(() =>
      assertDemoIsolation(
        join(alias, ".config", "omnesis", "not-created"),
        "https://localhost:18761",
      ),
    ).toThrow("isolated config directory");
  });
  it("refuses a canonical target and descendants when the live config root is a symlink", () => {
    vi.stubEnv("OMNESIS_SYNTHETIC", "1");
    const target = join(fixture.home, "fixture-live-target");
    mkdirSync(target);
    symlinkSync(target, join(fixture.home, ".config", "omnesis"), "dir");
    expect(() => assertDemoIsolation(target, "https://localhost:18761")).toThrow(
      "isolated config directory",
    );
    expect(() =>
      assertDemoIsolation(join(target, "not-created", "child"), "https://localhost:18761"),
    ).toThrow("isolated config directory");
    const alias = join(fixture.home, "target-alias");
    symlinkSync(target, alias, "dir");
    expect(() => assertDemoIsolation(alias, "https://localhost:18761")).toThrow();
  });
  it("permits a symlink to an independent fixture config directory", () => {
    vi.stubEnv("OMNESIS_SYNTHETIC", "1");
    const target = join(fixture.home, "fixture-isolated-target");
    mkdirSync(target);
    const alias = join(fixture.home, "isolated-alias");
    symlinkSync(target, alias, "dir");
    expect(() =>
      assertDemoIsolation(join(alias, "not-created"), "https://localhost:18761"),
    ).not.toThrow();
  });
  it("requires synthetic selection and permits an explicitly isolated HTTPS target", () => {
    vi.stubEnv("OMNESIS_SYNTHETIC", "0");
    expect(() => assertDemoIsolation("/tmp/demo-host", "https://localhost:18761")).toThrow(
      "OMNESIS_SYNTHETIC",
    );
    vi.stubEnv("OMNESIS_SYNTHETIC", "1");
    expect(() => assertDemoIsolation("/tmp/demo-host", "https://localhost:18761")).not.toThrow();
  });
});
