// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { writeProviderAccountCredentials, writeProviderCredentials } from "@omnesis/core";
import { cleanupCredentials, discoverAccounts } from "./provider.js";

test("cleanup retains sibling credentials but not an empty host-created account", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omnesis-coinbase-cleanup-"));
  try {
    await writeProviderCredentials(
      "coinbase",
      { api_key: "fictional-key", token: "fictional-token" },
      dir,
    );
    await writeProviderAccountCredentials(
      "coinbase",
      "account-one",
      { api_key: "fictional-one" },
      dir,
    );
    await writeProviderAccountCredentials(
      "coinbase",
      "account-two",
      { api_key: "fictional-two" },
      dir,
    );
    mkdirSync(join(dir, "coinbase", "host-state"), { recursive: true });
    await cleanupCredentials("account-one", dir);
    expect(discoverAccounts(dir).map(String)).toEqual(["account-two"]);
    expect(existsSync(join(dir, "coinbase-credentials.json"))).toBe(true);
    await cleanupCredentials("account-two", dir);
    expect(discoverAccounts(dir)).toEqual([]);
    expect(existsSync(join(dir, "coinbase-credentials.json"))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
