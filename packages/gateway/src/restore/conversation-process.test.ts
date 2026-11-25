// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  generateInstallRootKey,
  openSecretFileValueAsync,
  produceEncryptedArtifact,
  sealSecretFileValueAsync,
} from "@omnesis/core";
import { reconcileDesktopConversationEntry } from "./index.js";

test("the owned process authenticates both artifact layers and publishes only inert target-sealed history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omnesis-history-process-"));
  const sourceRootKey = generateInstallRootKey(),
    targetRootKey = generateInstallRootKey(),
    logicalName = "conversations/s_invented.json",
    epoch = randomUUID();
  try {
    const record = {
      id: "s_invented",
      callerId: "foreign-caller",
      model: "foreign-model",
      backend: "foreign-backend",
      title: "Invented archived conversation",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
      messages: [{ role: "user", parts: [{ kind: "text", text: "Invented archived question." }] }],
      controls: {
        submissions: [{ id: "foreign-pending", status: "queued", text: "Must not run" }],
      },
      token: "foreign-credential",
    };
    const serialized = await sealSecretFileValueAsync(JSON.stringify(record), {
      rootKey: sourceRootKey,
      scope: `config:${logicalName}`,
    });
    const artifact = join(directory, "source.enc"),
      sourceScope = `backup:${epoch}:${logicalName}`;
    await produceEncryptedArtifact(
      artifact,
      { rootKey: sourceRootKey, scope: sourceScope },
      async (output) => {
        output.write(serialized);
      },
    );
    const nested = await readFile(artifact),
      path = join(directory, "stage.enc"),
      scope = "desktop-restore:invented:entry:1";
    await produceEncryptedArtifact(path, { rootKey: targetRootKey, scope }, async (output) => {
      output.write(nested);
    });
    const entry = {
        path,
        scope,
        sourceRootKey,
        targetRootKey,
        logicalName: `${logicalName}.enc`,
        sourceScope,
        bytes: nested.length,
      },
      targetPath = join(directory, "fresh", "s_invented.json");
    expect(
      await reconcileDesktopConversationEntry({ entry, targetPath }, new AbortController().signal),
    ).toEqual({ id: "s_invented", messages: 1 });
    const sealed = await readFile(targetPath, "utf8");
    expect(sealed).not.toContain("Invented archived");
    expect((await stat(targetPath)).mode & 0o077).toBe(0);
    const restored = JSON.parse(
      await openSecretFileValueAsync(sealed, {
        rootKey: targetRootKey,
        scope: `config:${logicalName}`,
      }),
    );
    expect(restored.callerId).toBe("restored-history");
    expect(restored.messages).toEqual(record.messages);
    expect(restored.controls).toBeUndefined();
    expect(restored.token).toBeUndefined();
    await expect(
      reconcileDesktopConversationEntry(
        {
          entry: { ...entry, sourceRootKey: generateInstallRootKey() },
          targetPath: join(directory, "refused.json"),
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow("could not be prepared safely");
    await expect(stat(join(directory, "refused.json"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
