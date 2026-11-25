// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  generateInstallRootKey,
  openSecretFileValueAsync,
  produceEncryptedArtifact,
} from "@omnesis/core";
import { reconcileDesktopSecretEntry } from "./index.js";

test("owned worker protects legacy prose from its first persisted output byte and refuses authority paths or replaced destinations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omnesis-secret-restore-"));
  try {
    const targetRootKey = generateInstallRootKey(),
      sourceRootKey = generateInstallRootKey(),
      body = Buffer.from("Invented standing instructions for a test library."),
      scope = "desktop-restore:invented:entry:1",
      path = join(directory, "input.enc"),
      targetPath = join(directory, "fresh", "OMNESIS.md");
    await produceEncryptedArtifact(path, { rootKey: targetRootKey, scope }, async (output) => {
      output.write(body);
    });
    const entry = {
      path,
      scope,
      targetRootKey,
      sourceRootKey,
      sourceScope: null,
      logicalName: "OMNESIS.md",
      bytes: body.length,
    };
    expect(
      await reconcileDesktopSecretEntry({ entry, targetPath }, new AbortController().signal),
    ).toEqual({ protected: true });
    const serialized = await readFile(targetPath, "utf8");
    expect(serialized).not.toContain("Invented standing");
    expect(
      await openSecretFileValueAsync(serialized, {
        rootKey: targetRootKey,
        scope: "config:OMNESIS.md",
      }),
    ).toBe(body.toString());
    expect((await stat(targetPath)).mode & 0o077).toBe(0);
    await expect(
      reconcileDesktopSecretEntry({ entry, targetPath }, new AbortController().signal),
    ).rejects.toThrow("could not be prepared safely");
    expect(await readFile(targetPath, "utf8")).toBe(serialized);
    const refused = join(directory, "refused.json");
    for (const logicalName of ["token", "tls/private-key.pem", "keyring/foreign/credentials.json"])
      await expect(
        reconcileDesktopSecretEntry(
          { entry: { ...entry, logicalName }, targetPath: refused },
          new AbortController().signal,
        ),
      ).rejects.toThrow("could not be prepared safely");
    await expect(stat(refused)).rejects.toMatchObject({ code: "ENOENT" });
    const raw = await readFile(path);
    raw[raw.length - 1] = (raw.at(-1) ?? 0) ^ 1;
    await writeFile(path, raw);
    await expect(
      reconcileDesktopSecretEntry({ entry, targetPath: refused }, new AbortController().signal),
    ).rejects.toThrow("could not be prepared safely");
    await expect(stat(refused)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
