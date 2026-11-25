// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  generateInstallRootKey,
  openSecretFileValueAsync,
  produceEncryptedArtifact,
  sealSecretFileValueAsync,
} from "@omnesis/core";
import {
  restoreConversationHistory,
  restoreConversationHistoryEntry,
} from "./conversation-history.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "omnesis-history-restore-"));
  roots.push(directory);
  return {
    directory,
    sourceRootKey: generateInstallRootKey(),
    targetRootKey: generateInstallRootKey(),
    targetPath: join(directory, "fresh/s_fixture.json"),
    logicalName: "conversations/s_fixture.json",
    signal: new AbortController().signal,
  };
}
function record() {
  return {
    id: "s_fixture",
    callerId: "foreign-administrative-identity",
    model: "old-model",
    backend: "old-backend",
    title: "Invented restored discussion",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
    pinned: true,
    messages: [
      { role: "user", parts: [{ kind: "text", text: "Invented conversation context." }] },
      { role: "assistant", parts: [{ kind: "text", text: "Invented preserved answer." }] },
    ],
    controls: {
      submissions: [{ id: "foreign-pending-action", status: "queued", text: "Must never resume" }],
    },
    token: "must-not-import",
    providerState: "must-not-import",
    terminalFailure: { message: "obsolete old model failure" },
  };
}

test("validates and rekeys history without importing queued actions, provider state or session ownership", async () => {
  const f = await fixture();
  const serialized = await sealSecretFileValueAsync(JSON.stringify(record()), {
    rootKey: f.sourceRootKey,
    scope: `config:${f.logicalName}`,
  });
  expect(await restoreConversationHistory({ ...f, serialized })).toEqual({
    id: "s_fixture",
    messages: 2,
  });
  const output = await readFile(f.targetPath, "utf8");
  expect(output).not.toContain("Invented");
  const restored = JSON.parse(
    await openSecretFileValueAsync(output, {
      rootKey: f.targetRootKey,
      scope: `config:${f.logicalName}`,
    }),
  );
  expect(restored.messages).toEqual(record().messages);
  expect(restored.callerId).toBe("restored-history");
  for (const key of ["controls", "token", "providerState", "terminalFailure"])
    expect(restored[key]).toBeUndefined();
  expect((await stat(f.targetPath)).mode & 0o077).toBe(0);
});

test("supported origin anchors retain hidden seed boundaries; unknown anchors never become ordinary chats", async () => {
  const f = await fixture();
  const origin = {
    kind: "task",
    runId: "fixture-run",
    taskId: "fixture-task",
    seedMessageCount: 1,
  };
  await restoreConversationHistory({ ...f, serialized: JSON.stringify({ ...record(), origin }) });
  const restored = JSON.parse(
    await openSecretFileValueAsync(await readFile(f.targetPath, "utf8"), {
      rootKey: f.targetRootKey,
      scope: `config:${f.logicalName}`,
    }),
  );
  expect(restored.origin).toEqual(origin);
  const unknown = { ...origin, kind: "unsupported_future_origin" };
  await expect(
    restoreConversationHistory({
      ...f,
      targetPath: join(f.directory, "unknown.json"),
      serialized: JSON.stringify({ ...record(), origin: unknown }),
    }),
  ).rejects.toThrow("matching Omnesis version");
  await expect(stat(join(f.directory, "unknown.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("wrong scopes, malformed private JSON, cancellation and existing destinations save nothing", async () => {
  const f = await fixture();
  const serialized = await sealSecretFileValueAsync(JSON.stringify(record()), {
    rootKey: f.sourceRootKey,
    scope: "config:conversations/another.json",
  });
  await expect(restoreConversationHistory({ ...f, serialized })).rejects.toThrow("authenticated");
  await expect(
    restoreConversationHistory({ ...f, serialized: "private malformed fixture text" }),
  ).rejects.toThrow("conversation record is invalid");
  await expect(stat(f.targetPath)).rejects.toMatchObject({ code: "ENOENT" });
  const abort = new AbortController();
  abort.abort();
  await expect(
    restoreConversationHistory({
      ...f,
      signal: abort.signal,
      serialized: JSON.stringify(record()),
    }),
  ).rejects.toMatchObject({ name: "AbortError" });
  const existing = join(f.directory, "existing.json");
  await writeFile(existing, "untouched existing file");
  await expect(
    restoreConversationHistory({
      ...f,
      targetPath: existing,
      serialized: JSON.stringify(record()),
    }),
  ).rejects.toThrow("fresh staging file");
  expect(await readFile(existing, "utf8")).toBe("untouched existing file");
});

test("nested backup and staging layers authenticate through EOF before publishing any conversation", async () => {
  const f = await fixture();
  const source = await sealSecretFileValueAsync(JSON.stringify(record()), {
    rootKey: f.sourceRootKey,
    scope: `config:${f.logicalName}`,
  });
  const inner = await produceEncryptedArtifact(
    join(f.directory, "source.enc"),
    { rootKey: f.sourceRootKey, scope: `backup:fixture:${f.logicalName}` },
    (body) =>
      new Promise<void>((resolve, reject) => {
        body.write(source, (error) => (error ? reject(error) : resolve()));
      }),
  );
  const contents = await readFile(inner.path);
  const outer = await produceEncryptedArtifact(
    join(f.directory, "staged.enc"),
    { rootKey: f.targetRootKey, scope: "restore-entry:0" },
    (body) =>
      new Promise<void>((resolve, reject) => {
        body.write(contents, (error) => (error ? reject(error) : resolve()));
      }),
  );
  const entry = {
    path: outer.path,
    scope: "restore-entry:0",
    targetRootKey: f.targetRootKey,
    sourceRootKey: f.sourceRootKey,
    logicalName: `${f.logicalName}.enc`,
    sourceScope: `backup:fixture:${f.logicalName}`,
    bytes: contents.length,
  };
  await restoreConversationHistoryEntry({ entry, targetPath: f.targetPath }, f.signal);
  const broken = await readFile(outer.path);
  broken[broken.length - 1] = broken[broken.length - 1]! ^ 1;
  await writeFile(outer.path, broken);
  const refused = join(f.directory, "refused.json");
  await expect(
    restoreConversationHistoryEntry({ entry, targetPath: refused }, f.signal),
  ).rejects.toThrow();
  await expect(stat(refused)).rejects.toMatchObject({ code: "ENOENT" });
});
