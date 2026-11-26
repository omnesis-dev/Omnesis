// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SyncError } from "@omnesis/types";
import { CALLS_STORE, defaultDataDir, MESSAGES_STORE, openStore } from "./store.js";
import { omatelFixture, type OmatelFixture } from "./testing/fixtures.js";

let fx: OmatelFixture;
beforeEach(() => {
  fx = omatelFixture();
});
afterEach(() => fx.cleanup());

describe("omatel stores", () => {
  it("finds the data folder under XDG_DATA_HOME, else under the home folder", () => {
    expect(defaultDataDir({ XDG_DATA_HOME: "/data", HOME: "/home/u" })).toBe("/data/omatel");
    expect(defaultDataDir({ XDG_DATA_HOME: "", HOME: "/home/u" })).toBe(
      "/home/u/.local/share/omatel",
    );
  });

  it("answers null for a store that does not exist yet", () => {
    expect(openStore(fx.dir, CALLS_STORE)).toBeNull();
  });

  it("opens a store of a known schema read-only", () => {
    fx.calls();
    const db = openStore(fx.dir, CALLS_STORE)!;
    try {
      expect(() => db.prepare("DELETE FROM calls").run()).toThrow(/readonly/i);
    } finally {
      db.close();
    }
  });

  it("refuses a store missing a column it reads", () => {
    fx.messages().exec("ALTER TABLE messages DROP COLUMN transport");

    const opened = () => openStore(fx.dir, MESSAGES_STORE);
    expect(opened).toThrow(SyncError);
    expect(opened).toThrow(/messages\.transport/);
  });

  it("refuses a store written by a newer omatel", () => {
    fx.calls().pragma("user_version = 3");

    expect(() => openStore(fx.dir, CALLS_STORE)).toThrow(/schema 3, newer than the 2/);
  });
});
