// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { basename, join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  fileSecretDirectory,
  fileSecretEntryPaths,
  passphraseSecretEntryPaths,
} from "./secret-store-paths.js";

describe("secret store filesystem identities", () => {
  test("Windows case-folding cannot merge distinct valid key names", () => {
    const first = fileSecretEntryPaths("example", "dev.omnesis", 'A" ', "win32");
    const second = fileSecretEntryPaths("example", "dev.omnesis", "B\u0206", "win32");
    expect(first.legacy?.exactBasename).toBe("QSIg.secret");
    expect(second.legacy?.exactBasename).toBe("QsiG.secret");
    expect(first.path.toLowerCase()).not.toBe(second.path.toLowerCase());
    expect(basename(first.path)).toMatch(/^key\.sha256-[0-9a-f]{64}\.secret$/u);
    expect(passphraseSecretEntryPaths("example", 'A" ', "win32").path.toLowerCase()).not.toBe(
      passphraseSecretEntryPaths("example", "B\u0206", "win32").path.toLowerCase(),
    );
  });

  test("Windows custom service identities are exact and filesystem-safe", () => {
    expect(fileSecretDirectory("example", "dev.omnesis", "win32")).toBe(
      join("example", "keyring", "dev.omnesis"),
    );
    expect(fileSecretDirectory("example", "Example", "win32")).not.toBe(
      fileSecretDirectory("example", "example", "win32"),
    );
    const paths = fileSecretEntryPaths("example", "service:with?characters", "key", "win32");
    expect(basename(fileSecretDirectory("example", "service:with?characters", "win32"))).toMatch(
      /^service-sha256-[0-9a-f]{64}$/u,
    );
    expect(paths.legacy).toBeUndefined();
  });

  test.each(["linux", "darwin"] as const)("preserves every existing %s path", (platform) => {
    expect(fileSecretEntryPaths("example", "Example", 'A" ', platform)).toEqual({
      path: join("example", "keyring", "Example", "QSIg.secret"),
    });
    expect(passphraseSecretEntryPaths("example", "B\u0206", platform)).toEqual({
      path: join("example", "keyring", "passphrase", "QsiG.json"),
    });
  });
});
