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

  test("a file written before the MCP choices existed reads as before and is never rewritten", () => {
    const path = join(dir, "remote-access.json");
    const before = `${JSON.stringify({ setupCompletedAt: "2026-05-01T10:00:00.000Z", first: "relay" }, null, 2)}\n`;
    writeFileSync(path, before);
    const store = new RemoteAccessSettingsStore(dir);
    expect(store.get()).toEqual({ setupCompletedAt: "2026-05-01T10:00:00.000Z", first: "relay" });
    expect(store.get().mcp).toBeUndefined();
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("keeps only the MCP choices the owner made, alongside the others", () => {
    const store = new RemoteAccessSettingsStore(dir);
    store.update({ mcp: { domain: false } });
    store.update({ first: "relay" });
    expect(new RemoteAccessSettingsStore(dir).get()).toEqual({
      setupCompletedAt: null,
      first: "relay",
      mcp: { domain: false },
    });
    expect(() => store.update({ mcp: { carrier: false } as never })).toThrow();
    expect(() => store.update({ mcp: { domain: "off" } as never })).toThrow();
    expect(store.get().mcp).toEqual({ domain: false });
  });
});
