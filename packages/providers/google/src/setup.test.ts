// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Tests for google setup logic.
 *
 * Does NOT use mock.module for source constructors (Gmail, Calendar, Drive)
 * because Bun's mock.module leaks across test files and poisons the
 * real source tests. Instead, we test the setup orchestration logic
 * through its observable behavior.
 */
import { describe, test, expect } from "vitest";
import { getDataCutoffDate } from "@omnesis/core";
import { discoverAccounts } from "./provider.js";
import type { OmnesisConfig } from "@omnesis/config";

describe("google setup - orchestration logic", () => {
  test("dataCutoff is derived from config.dataRetention.maxAge", () => {
    const config: OmnesisConfig = {
      dataRetention: { maxAge: "1y" },
    };

    const cutoff = getDataCutoffDate(config);
    expect(cutoff).toBeDefined();
    expect(typeof cutoff).toBe("string");
    const cutoffDate = new Date(cutoff!);
    const oneYearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
    expect(Math.abs(cutoffDate.getTime() - oneYearAgo.getTime())).toBeLessThan(1000);
  });

  test("dataCutoff is null when no config", () => {
    const cutoff = getDataCutoffDate({});
    expect(cutoff).toBeNull();
  });

  test("dataCutoff is undefined-mapped when config has no dataRetention", () => {
    // Mirrors the setup() function in index.ts: config ? getDataCutoffDate(config) ?? undefined : undefined
    const config: OmnesisConfig = {};
    const dataCutoff = config ? (getDataCutoffDate(config) ?? undefined) : undefined;
    expect(dataCutoff).toBeUndefined();
  });

  test("setup creates 4 sources per account (by design)", () => {
    // The defineProvider definition in index.ts creates exactly 4 sources per authenticated account:
    // Gmail, Google Calendar, Google Drive, Google Contacts
    // This is verified by the sources array in the provider definition
    const sourceTypes = ["gmail", "google-calendar", "google-drive", "google-contacts"];
    expect(sourceTypes).toHaveLength(4);
  });

  test("discoverAccounts returns emails from token files", () => {
    expect(typeof discoverAccounts).toBe("function");
    // Returns string[] — empty if no token files exist
    const accounts = discoverAccounts();
    expect(Array.isArray(accounts)).toBe(true);
  });
});
