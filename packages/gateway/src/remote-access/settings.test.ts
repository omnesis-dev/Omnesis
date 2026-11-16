// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { DEFAULT_REMOTE_ACCESS_SETTINGS, RemoteAccessSettingsStore } from "./settings.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "remote-access-settings-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("RemoteAccessSettingsStore", () => {
  test("writes nothing until a choice is made, then keeps it across restarts", () => {
    const store = new RemoteAccessSettingsStore(dir);
    expect(store.get()).toEqual(DEFAULT_REMOTE_ACCESS_SETTINGS);
    expect(existsSync(join(dir, "remote-access.json"))).toBe(false);
    store.update({ first: "relay", setupCompletedAt: "2026-05-01T10:00:00.000Z" });
    expect(new RemoteAccessSettingsStore(dir).get()).toEqual({
      first: "relay",
      setupCompletedAt: "2026-05-01T10:00:00.000Z",
    });
  });

  test("refuses an invalid choice and keeps the last good one", () => {
    const store = new RemoteAccessSettingsStore(dir);
    expect(() => store.update({ first: "carrier-pigeon" as never })).toThrow();
    expect(store.get().first).toBe("tailscale");
  });

  test("a damaged file reads as the defaults", () => {
    writeFileSync(join(dir, "remote-access.json"), "{not json");
    expect(new RemoteAccessSettingsStore(dir).get()).toEqual(DEFAULT_REMOTE_ACCESS_SETTINGS);
    writeFileSync(join(dir, "remote-access.json"), JSON.stringify({ first: "nope" }));
    expect(new RemoteAccessSettingsStore(dir).get()).toEqual(DEFAULT_REMOTE_ACCESS_SETTINGS);
    expect(readFileSync(join(dir, "remote-access.json"), "utf8")).toContain("nope");
  });
});
