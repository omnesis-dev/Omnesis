// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  clearProviderAccountCredentials,
  hasProviderAccountCredentials,
  listProviderAccountDirs,
  listProviderAccountIds,
  loadOrAdoptProviderAccountCredentials,
  providerAccountCredentialsPath,
  providerCredentialsPath,
  readProviderAccountCredentials,
  readProviderAccountOrLegacyCredentials,
  redactSecrets,
  writeProviderAccountCredentials,
  writeProviderCredentials,
} from "./credentials.js";

const FILE_KEY = "test-provider";
const ACCOUNT_A = "maya.reeves@example.com";
const ACCOUNT_B = "jamie.lopez@example.org";

const created: string[] = [];
afterEach(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
  created.length = 0;
});

function tempConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "omnesis-per-account-"));
  created.push(dir);
  return dir;
}

describe("per-account credential storage", () => {
  test("two accounts hold independent credentials", async () => {
    // The whole point: a shared per-provider file made a second account
    // impossible, because storing one overwrote the other.
    const cfg = tempConfigDir();
    await writeProviderAccountCredentials(FILE_KEY, ACCOUNT_A, { api_key: "key-a" }, cfg);
    await writeProviderAccountCredentials(FILE_KEY, ACCOUNT_B, { api_key: "key-b" }, cfg);

    expect(await readProviderAccountCredentials(FILE_KEY, ACCOUNT_A, cfg)).toEqual({
      api_key: "key-a",
    });
    expect(await readProviderAccountCredentials(FILE_KEY, ACCOUNT_B, cfg)).toEqual({
      api_key: "key-b",
    });
    expect(listProviderAccountIds(FILE_KEY, cfg).sort()).toEqual([ACCOUNT_B, ACCOUNT_A].sort());
  });

  test("clearing one account leaves the other intact", async () => {
    const cfg = tempConfigDir();
    await writeProviderAccountCredentials(FILE_KEY, ACCOUNT_A, { api_key: "key-a" }, cfg);
    await writeProviderAccountCredentials(FILE_KEY, ACCOUNT_B, { api_key: "key-b" }, cfg);

    await clearProviderAccountCredentials(FILE_KEY, ACCOUNT_A, cfg);

    expect(hasProviderAccountCredentials(FILE_KEY, ACCOUNT_A, cfg)).toBe(false);
    expect(await readProviderAccountCredentials(FILE_KEY, ACCOUNT_B, cfg)).toEqual({
      api_key: "key-b",
    });
  });

  test("an absent account reads as null rather than throwing", async () => {
    const cfg = tempConfigDir();
    expect(await readProviderAccountCredentials(FILE_KEY, ACCOUNT_A, cfg)).toBeNull();
    expect(hasProviderAccountCredentials(FILE_KEY, ACCOUNT_A, cfg)).toBe(false);
  });

  test("an account id that cannot be a path segment is refused, not sanitised", () => {
    const cfg = tempConfigDir();
    expect(() => providerAccountCredentialsPath(FILE_KEY, "../escape", cfg)).toThrow();
    // The predicate still has to answer, because `discover()` calls it.
    expect(hasProviderAccountCredentials(FILE_KEY, "../escape", cfg)).toBe(false);
  });

  test("listing tolerates a directory whose name is not a usable account id", async () => {
    // `discover()` reads this. One unusable entry must not take the provider
    // down with it.
    const cfg = tempConfigDir();
    await writeProviderAccountCredentials(FILE_KEY, ACCOUNT_A, { api_key: "key-a" }, cfg);
    expect(() => listProviderAccountIds(FILE_KEY, cfg)).not.toThrow();
    expect(listProviderAccountIds(FILE_KEY, cfg)).toEqual([ACCOUNT_A]);
  });
});

describe("adopting a pre-per-account shared credential", () => {
  test("a status read can inspect legacy credentials without adopting them", async () => {
    const cfg = tempConfigDir();
    await writeProviderCredentials(FILE_KEY, { api_key: "legacy-key" }, cfg);

    expect(await readProviderAccountOrLegacyCredentials(FILE_KEY, ACCOUNT_A, cfg)).toEqual({
      api_key: "legacy-key",
    });
    expect(hasProviderAccountCredentials(FILE_KEY, ACCOUNT_A, cfg)).toBe(false);
    expect(listProviderAccountIds(FILE_KEY, cfg)).toEqual([]);
  });

  test("the first read adopts the shared file into the account", async () => {
    const cfg = tempConfigDir();
    await writeProviderCredentials(FILE_KEY, { api_key: "legacy-key" }, cfg);
    expect(hasProviderAccountCredentials(FILE_KEY, ACCOUNT_A, cfg)).toBe(false);

    const fields = await loadOrAdoptProviderAccountCredentials(FILE_KEY, ACCOUNT_A, cfg);

    expect(fields).toEqual({ api_key: "legacy-key" });
    expect(hasProviderAccountCredentials(FILE_KEY, ACCOUNT_A, cfg)).toBe(true);
    // Re-encrypted at the new path, not moved: a secret file's path is its
    // AES-GCM associated data, so a relocated envelope fails to authenticate.
    expect(existsSync(providerCredentialsPath(FILE_KEY, cfg))).toBe(true);
  });

  test("adoption is idempotent and does not re-read the shared file", async () => {
    const cfg = tempConfigDir();
    await writeProviderCredentials(FILE_KEY, { api_key: "legacy-key" }, cfg);
    await loadOrAdoptProviderAccountCredentials(FILE_KEY, ACCOUNT_A, cfg);

    // Change the shared file; the adopted account must keep its own copy.
    await writeProviderCredentials(FILE_KEY, { api_key: "changed" }, cfg);

    expect(await loadOrAdoptProviderAccountCredentials(FILE_KEY, ACCOUNT_A, cfg)).toEqual({
      api_key: "legacy-key",
    });
  });

  test("an account's own credential always wins over the shared file", async () => {
    const cfg = tempConfigDir();
    await writeProviderCredentials(FILE_KEY, { api_key: "legacy-key" }, cfg);
    await writeProviderAccountCredentials(FILE_KEY, ACCOUNT_A, { api_key: "own-key" }, cfg);

    expect(await loadOrAdoptProviderAccountCredentials(FILE_KEY, ACCOUNT_A, cfg)).toEqual({
      api_key: "own-key",
    });
  });

  test("nothing stored anywhere reads as null", async () => {
    expect(
      await loadOrAdoptProviderAccountCredentials(FILE_KEY, ACCOUNT_A, tempConfigDir()),
    ).toBeNull();
  });

  test("only an un-migrated install adopts; afterwards the shared file is a leftover", async () => {
    // A pre-per-account install holds exactly one key, for the one account it
    // could have. Once that account has adopted, handing the same file to a
    // DIFFERENT account would copy a live secret under a caller-supplied id and
    // conjure an account that was never connected.
    const cfg = tempConfigDir();
    await writeProviderCredentials(FILE_KEY, { api_key: "legacy-key" }, cfg);

    expect(await loadOrAdoptProviderAccountCredentials(FILE_KEY, ACCOUNT_A, cfg)).toEqual({
      api_key: "legacy-key",
    });
    expect(await loadOrAdoptProviderAccountCredentials(FILE_KEY, ACCOUNT_B, cfg)).toBeNull();
    expect(hasProviderAccountCredentials(FILE_KEY, ACCOUNT_B, cfg)).toBe(false);
  });

  test("an account that adopted can be re-authenticated independently afterwards", async () => {
    const cfg = tempConfigDir();
    await writeProviderCredentials(FILE_KEY, { api_key: "legacy-key" }, cfg);
    await loadOrAdoptProviderAccountCredentials(FILE_KEY, ACCOUNT_A, cfg);

    await writeProviderAccountCredentials(FILE_KEY, ACCOUNT_A, { api_key: "rotated" }, cfg);

    expect(await readProviderAccountCredentials(FILE_KEY, ACCOUNT_A, cfg)).toEqual({
      api_key: "rotated",
    });
  });
});

describe("listProviderAccountDirs", () => {
  test("reports an empty marker dir that holds no credential yet", async () => {
    // This is what a pre-per-account install looks like, and why `discover()`
    // cannot rely on stored credentials alone.
    const cfg = tempConfigDir();
    await writeProviderAccountCredentials(FILE_KEY, ACCOUNT_A, { api_key: "k" }, cfg);
    await clearProviderAccountCredentials(FILE_KEY, ACCOUNT_A, cfg);
    expect(listProviderAccountDirs(FILE_KEY, cfg)).toEqual([]);
  });

  test("is empty when the provider directory does not exist", () => {
    expect(listProviderAccountDirs(FILE_KEY, tempConfigDir())).toEqual([]);
  });
});

describe("redactSecrets", () => {
  test("replaces a secret wherever it appears", () => {
    const secret = "sk-live-abcdef123456";
    expect(redactSecrets(`request failed for ${secret} at /v1`, [secret])).toBe(
      "request failed for *** at /v1",
    );
  });

  test("replaces every occurrence, not just the first", () => {
    const secret = "sk-live-abcdef123456";
    expect(redactSecrets(`${secret} then ${secret}`, [secret])).toBe("*** then ***");
  });

  test("leaves short values alone rather than mangling unrelated text", () => {
    // A value this short carries too little entropy to be worth protecting,
    // and blanking it would corrupt text that merely contains those letters.
    expect(redactSecrets("the cat sat", ["cat"])).toBe("the cat sat");
  });

  test("is a no-op with no secrets", () => {
    expect(redactSecrets("nothing to hide", [])).toBe("nothing to hide");
  });
});

describe("credential file permissions", () => {
  test("the account directory and its file are owner-only", async () => {
    const cfg = tempConfigDir();
    await writeProviderAccountCredentials(FILE_KEY, ACCOUNT_A, { api_key: "k" }, cfg);

    const path = providerAccountCredentialsPath(FILE_KEY, ACCOUNT_A, cfg);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
  });
});
