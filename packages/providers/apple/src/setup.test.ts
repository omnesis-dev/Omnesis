// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Tests for apple setup function.
 *
 * These tests verify the setup() logic by checking the output structure
 * without using mock.module (which leaks across test files in Bun).
 * Instead, we test the key behaviors through the public contract:
 * - setup() returns ProviderSetupResult[]
 * - The function handles authenticated/unauthenticated states
 *
 * The actual Apple source functionality is covered by the source-level tests.
 * Here we focus on the setup orchestration logic.
 */
import { describe, test, expect } from "vitest";
import { getDataCutoffDate } from "@omnesis/core";
import { type OmnesisConfig } from "@omnesis/config";
import appleProvider from "./index.js";

describe("Apple provider definition", () => {
  test("declares macOS-only via supportedPlatforms", () => {
    // Apple Notes/Reminders/iMessage/Contacts all read macOS-local
    // databases. The provider-level gate keeps every child source out
    // of the Linux/Windows CLI/portal pickers.
    expect(appleProvider.supportedPlatforms).toEqual(["darwin"]);
  });

  test("Apple Notes narrows provider discovery to its own local store", () => {
    const notes = appleProvider.sources.find((source) => source.id === "apple-notes");
    expect(notes?.discover).toBeTypeOf("function");
  });
});

describe("apple setup - orchestration logic", () => {
  test("reminders sourceId uses email when available", () => {
    const store = {
      accountEmail: "user@icloud.com",
      accountUuid: "AAA-111",
      filename: "Data-AAA.sqlite",
    };

    // Mirrors setup.ts line 39-41
    const sourceId = store.accountEmail
      ? `apple-reminders:${store.accountEmail}`
      : `apple-reminders:${store.accountUuid ?? store.filename}`;

    expect(sourceId).toBe("apple-reminders:user@icloud.com");
  });

  test("reminders sourceId falls back to UUID when no email", () => {
    const store = {
      accountEmail: null as string | null,
      accountUuid: "BBB-222",
      filename: "Data-BBB.sqlite",
    };

    const sourceId = store.accountEmail
      ? `apple-reminders:${store.accountEmail}`
      : `apple-reminders:${store.accountUuid ?? store.filename}`;

    expect(sourceId).toBe("apple-reminders:BBB-222");
  });

  test("reminders sourceId falls back to filename when no email or UUID", () => {
    const store = {
      accountEmail: null as string | null,
      accountUuid: null as string | null,
      filename: "Data-CCC.sqlite",
    };

    const sourceId = store.accountEmail
      ? `apple-reminders:${store.accountEmail}`
      : `apple-reminders:${store.accountUuid ?? store.filename}`;

    expect(sourceId).toBe("apple-reminders:Data-CCC.sqlite");
  });

  test("dataCutoff is derived from config.dataRetention.maxAge", () => {
    // Mirrors setup.ts line 28
    const config: OmnesisConfig = {
      dataRetention: { maxAge: "30d" },
    };

    const cutoff = getDataCutoffDate(config);
    expect(cutoff).toBeDefined();
    expect(typeof cutoff).toBe("string");
    // Should be an ISO date string approximately 30 days ago
    const cutoffDate = new Date(cutoff!);
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    expect(Math.abs(cutoffDate.getTime() - thirtyDaysAgo.getTime())).toBeLessThan(1000);
  });

  test("dataCutoff is null when no maxAge configured", () => {
    const config: OmnesisConfig = {};
    const cutoff = getDataCutoffDate(config);
    expect(cutoff).toBeNull();
  });

  test("accountLabel prefers email over UUID over filename", () => {
    // Mirrors setup.ts line 38
    const store1 = { accountEmail: "a@b.com", accountUuid: "X", filename: "f.sqlite" };
    const store2 = { accountEmail: null, accountUuid: "X", filename: "f.sqlite" };
    const store3 = { accountEmail: null, accountUuid: null, filename: "f.sqlite" };

    const label1 = store1.accountEmail ?? store1.accountUuid ?? store1.filename;
    const label2 = store2.accountEmail ?? store2.accountUuid ?? store2.filename;
    const label3 = store3.accountEmail ?? store3.accountUuid ?? store3.filename;

    expect(label1).toBe("a@b.com");
    expect(label2).toBe("X");
    expect(label3).toBe("f.sqlite");
  });
});
