// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  clearSecretFileKeyCacheForTests,
  ensureInstallRootKey,
  isEncryptedSecretFile,
  markSecretFileEncryptionRequired,
  primeSecretFileKeyCache,
} from "@omnesis/core";
import { FsConversationStore, type ConversationRecord } from "./agent/conversation-store.js";
import { readConversationCleanupCandidates } from "./agent/conversation-retention.js";
import { FsCognitionTranscriptStore, type CognitionRunTranscript } from "./brain/transcripts.js";
import { protectManagedHistory } from "./managed-history.js";

const directories: string[] = [];
const stores: FsCognitionTranscriptStore[] = [];
function directory(): string {
  const dir = mkdtempSync(join(tmpdir(), "omnesis-history-crypto-"));
  directories.push(dir);
  return dir;
}
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  clearSecretFileKeyCacheForTests();
  vi.unstubAllEnvs();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
async function protectedDirectory(): Promise<string> {
  vi.stubEnv("OMNESIS_SECRET_STORE", "file");
  const dir = directory();
  await ensureInstallRootKey({ configDir: dir, backend: "file" });
  await markSecretFileEncryptionRequired(dir);
  await primeSecretFileKeyCache({ configDir: dir, backend: "file" });
  return dir;
}
function conversation(): ConversationRecord {
  return {
    id: "s_fixture",
    callerId: "fictional-caller",
    title: "Invented planning question",
    model: "fixture",
    backend: "fixture",
    createdAt: "2026-01-02T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
    pinned: false,
    messages: [
      {
        role: "user",
        parts: [{ kind: "text", text: "Review an invented mountain observatory plan." }],
      },
    ],
  };
}
function transcript(): CognitionRunTranscript {
  return {
    runId: "fixture-run",
    attempt: 1,
    kind: "data",
    startedAt: 1,
    finishedAt: 2,
    prompt: "Invented observatory background context",
    events: [{ type: "agent.text.delta", payload: { delta: "Invented review" } }],
    finalText: "Invented result",
    outcome: "completed",
    usage: null,
  };
}

test("chat content and summaries stay encrypted across restart, history listing and cleanup inspection", async () => {
  const configDir = await protectedDirectory();
  const dir = join(configDir, "conversations");
  const store = new FsConversationStore(dir);
  await store.save(conversation());
  for (const name of ["s_fixture.json", ".summary-index.v4"]) {
    const raw = readFileSync(join(dir, name), "utf8");
    expect(isEncryptedSecretFile(raw)).toBe(true);
    expect(raw).not.toContain("Invented planning question");
    expect(raw).not.toContain("observatory");
    if (process.platform !== "win32") expect(statSync(join(dir, name)).mode & 0o077).toBe(0);
  }
  const restarted = new FsConversationStore(dir);
  expect(await restarted.load("s_fixture")).toMatchObject(conversation());
  expect(await restarted.list()).toEqual([
    expect.objectContaining({ title: "Invented planning question" }),
  ]);
  const candidates = await readConversationCleanupCandidates(
    [{ id: "s_fixture", path: join(dir, "s_fixture.json") }],
    Date.parse("2026-02-01T00:00:00Z"),
  );
  expect(candidates).toEqual([
    expect.objectContaining({ candidate: expect.objectContaining({ id: "s_fixture" }) }),
  ]);
  writeFileSync(join(dir, "s_other.json"), readFileSync(join(dir, "s_fixture.json")), {
    mode: 0o600,
  });
  expect(await restarted.load("s_other")).toBeNull();
});

test("background debug transcripts are encrypted from first publication and both readers authenticate the logical final path", async () => {
  const configDir = await protectedDirectory();
  const dir = join(configDir, "briefs", "transcripts");
  const store = new FsCognitionTranscriptStore(dir);
  stores.push(store);
  store.save(transcript());
  const ref = store.list()[0]!;
  const raw = readFileSync(join(dir, ref.fileName), "utf8");
  expect(isEncryptedSecretFile(raw)).toBe(true);
  expect(raw).not.toContain("observatory");
  expect(store.load(ref.fileName)).toEqual(transcript());
  expect(await store.loadAsync(ref.fileName)).toEqual(transcript());
  expect(readdirSync(dir).some((name) => name.endsWith(".pending"))).toBe(false);
});

test("strict startup protects legacy chat, summary and background history without changing their content", async () => {
  const configDir = await protectedDirectory();
  const dir = join(configDir, "conversations"),
    brain = join(configDir, "briefs/transcripts");
  mkdirSync(dir, { recursive: true });
  mkdirSync(brain, { recursive: true });
  writeFileSync(join(dir, "s_fixture.json"), JSON.stringify(conversation()));
  writeFileSync(join(dir, ".summary-index.v4"), JSON.stringify({ version: 4, conversations: [] }));
  writeFileSync(join(brain, "2-fixture-run-a1.json"), JSON.stringify(transcript()));
  await protectManagedHistory(configDir);
  for (const path of [
    join(dir, "s_fixture.json"),
    join(dir, ".summary-index.v4"),
    join(brain, "2-fixture-run-a1.json"),
  ])
    expect(isEncryptedSecretFile(readFileSync(path, "utf8"))).toBe(true);
  expect(await new FsConversationStore(dir).load("s_fixture")).toEqual(conversation());
});

test("missing keys refuse personal content publication rather than leave a plaintext fallback", async () => {
  vi.stubEnv("OMNESIS_SECRET_STORE", "file");
  const configDir = directory();
  await markSecretFileEncryptionRequired(configDir);
  const dir = join(configDir, "conversations");
  await expect(new FsConversationStore(dir).save(conversation())).rejects.toThrow();
  expect(existsSync(join(dir, "s_fixture.json"))).toBe(false);
  const brain = new FsCognitionTranscriptStore(join(configDir, "briefs/transcripts"));
  stores.push(brain);
  expect(() => brain.save(transcript())).toThrow();
  expect(
    readdirSync(join(configDir, "briefs/transcripts")).some((name) => name.endsWith(".json")),
  ).toBe(false);
});

test("legacy migration refuses linked history without modifying an outside original", async () => {
  const configDir = await protectedDirectory();
  const outside = join(directory(), "original.json");
  writeFileSync(outside, JSON.stringify(conversation()));
  mkdirSync(join(configDir, "conversations"));
  symlinkSync(outside, join(configDir, "conversations/s_fixture.json"));
  await expect(protectManagedHistory(configDir)).rejects.toThrow("regular files");
  expect(JSON.parse(readFileSync(outside, "utf8"))).toEqual(conversation());
});

test("migration refuses a linked parent directory without encrypting outside originals", async () => {
  const configDir = await protectedDirectory();
  const outside = directory();
  mkdirSync(join(outside, "transcripts"));
  const original = join(outside, "transcripts/2-fixture-run-a1.json");
  writeFileSync(original, JSON.stringify(transcript()));
  symlinkSync(outside, join(configDir, "briefs"));
  await expect(protectManagedHistory(configDir)).rejects.toThrow("regular directory");
  expect(JSON.parse(readFileSync(original, "utf8"))).toEqual(transcript());
});
