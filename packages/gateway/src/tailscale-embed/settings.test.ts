// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { inspectWindowsPrivatePathSync } from "@omnesis/core";
import { DEFAULT_TAILSCALE_SETTINGS, TailscaleSettingsStore } from "./settings.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omnesis-ts-settings-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const file = () => join(dir, "tailscale", "settings.json");

test("defaults without writing anything", () => {
  const store = new TailscaleSettingsStore(dir);
  expect(store.get()).toEqual(DEFAULT_TAILSCALE_SETTINGS);
  expect(store.get()).toMatchObject({
    enabled: false,
    deviceName: "omnesis",
    publicAccess: false,
    joinPolicy: "ask",
  });
  expect(existsSync(join(dir, "tailscale"))).toBe(false);
});

test("a choice is saved privately and survives a restart", () => {
  new TailscaleSettingsStore(dir).update({
    enabled: true,
    joinPolicy: "automatic",
    deviceName: "Home-Box",
  });
  if (process.platform === "win32") {
    expect(inspectWindowsPrivatePathSync(file(), "file").private).toBe(true);
    expect(inspectWindowsPrivatePathSync(join(dir, "tailscale"), "directory").private).toBe(true);
  } else {
    expect(statSync(file()).mode & 0o777).toBe(0o600);
  }
  const reloaded = new TailscaleSettingsStore(dir).get();
  expect(reloaded).toEqual({
    enabled: true,
    deviceName: "home-box",
    publicAccess: false,
    joinPolicy: "automatic",
  });
});

test("an invalid change is refused and nothing is written", () => {
  const store = new TailscaleSettingsStore(dir);
  expect(() => store.update({ deviceName: "-bad name-" })).toThrow();
  expect(() => store.update({ joinPolicy: "sometimes" as never })).toThrow();
  expect(existsSync(file())).toBe(false);
  expect(store.get()).toEqual(DEFAULT_TAILSCALE_SETTINGS);
});

test("an unreadable file falls back to the defaults", () => {
  mkdirSync(join(dir, "tailscale"));
  writeFileSync(file(), "{ not json");
  expect(new TailscaleSettingsStore(dir).get()).toEqual(DEFAULT_TAILSCALE_SETTINGS);
  writeFileSync(file(), JSON.stringify({ ...DEFAULT_TAILSCALE_SETTINGS, enabled: "yes" }));
  expect(new TailscaleSettingsStore(dir).get()).toEqual(DEFAULT_TAILSCALE_SETTINGS);
  expect(readFileSync(file(), "utf8")).toContain('"yes"');
});
