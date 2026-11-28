// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { lstat } from "node:fs/promises";
import { z } from "zod";
import {
  atomicWriteFile,
  chatMessageSchema,
  isEncryptedSecretFile,
  openSecretFileValueAsync,
  sealSecretFileValueAsync,
} from "@omnesis/core";
import { parseConversationRecord, type ConversationRecord } from "../agent/conversation-store.js";
import { streamRestoredEntry, type SealedRestoreEntry } from "./entry-stream.js";

const schema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u),
  callerId: z.string().max(4096),
  model: z.string().min(1).max(512),
  backend: z.string().min(1).max(512),
  createdAt: z.string().refine((value) => Number.isFinite(Date.parse(value))),
  updatedAt: z.string().refine((value) => Number.isFinite(Date.parse(value))),
  title: z.string().max(4096),
  pinned: z.boolean().optional(),
  origin: z.unknown().optional(),
  messages: z.array(chatMessageSchema).max(100_000),
});

export interface RestoredConversationOptions {
  /** Bytes after the authenticated backup artifact layer has finished. */
  serialized: string;
  logicalName: string;
  sourceRootKey: string;
  targetRootKey: string;
  targetPath: string;
  signal: AbortSignal;
}

/** Import history as data, never a queued submission, credential, session owner or provider state. */
export async function restoreConversationHistory(
  options: RestoredConversationOptions,
): Promise<{ id: string; messages: number }> {
  const match = /^conversations\/([A-Za-z0-9_-]{1,128})\.json$/u.exec(options.logicalName);
  if (!match || Buffer.byteLength(options.serialized) > 16 * 1024 * 1024)
    throw new Error("This conversation history cannot be safely restored.");
  options.signal.throwIfAborted();
  const scope = `config:${options.logicalName}`;
  const text = isEncryptedSecretFile(options.serialized)
    ? await openSecretFileValueAsync(options.serialized, { rootKey: options.sourceRootKey, scope })
    : options.serialized;
  let parsed: z.infer<typeof schema>;
  try {
    parsed = schema.parse(JSON.parse(text));
  } catch {
    throw new Error("This conversation record is invalid or uses an unsupported format.");
  }
  if (parsed.id !== match[1] || Date.parse(parsed.updatedAt) < Date.parse(parsed.createdAt))
    throw new Error("The conversation history identity is invalid.");
  const restored: ConversationRecord = {
    id: parsed.id,
    callerId: "restored-history",
    model: parsed.model,
    backend: parsed.backend,
    createdAt: parsed.createdAt,
    updatedAt: parsed.updatedAt,
    title: parsed.title,
    pinned: parsed.pinned ?? false,
    messages: parsed.messages,
  };
  // Preserve supported anchors so hidden run seeds do not become a plain chat.
  // Unknown anchors require a matching app version, rather than exposing them.
  const checked = parseConversationRecord(
    parsed.id,
    JSON.stringify({
      ...restored,
      ...(parsed.origin !== undefined ? { origin: parsed.origin } : {}),
    }),
  );
  if (!checked || checked.originUnrecognized || (parsed.origin !== undefined && !checked.origin))
    throw new Error(
      "This conversation's origin needs a matching Omnesis version before it can be restored.",
    );
  options.signal.throwIfAborted();
  const sealed = await sealSecretFileValueAsync(JSON.stringify(checked, null, 2), {
    rootKey: options.targetRootKey,
    scope,
  });
  options.signal.throwIfAborted();
  try {
    await lstat(options.targetPath);
    throw new Error("Conversation recovery requires a fresh staging file.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await atomicWriteFile(options.targetPath, sealed, { mode: 0o600, ensureDir: true });
  return { id: checked.id, messages: checked.messages.length };
}

/** Run in the owned restore subprocess; authenticated ciphertext is the only disk input/output. */
export async function restoreConversationHistoryEntry(
  options: { entry: SealedRestoreEntry; targetPath: string },
  signal: AbortSignal,
): Promise<{ id: string; messages: number }> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const block of streamRestoredEntry(options.entry, signal)) {
      bytes += block.length;
      if (bytes > 16 * 1024 * 1024)
        throw new Error("This conversation exceeds the safe restore size limit.");
      chunks.push(block);
    }
    const raw = Buffer.concat(chunks);
    try {
      return await restoreConversationHistory({
        serialized: raw.toString("utf8"),
        logicalName: options.entry.logicalName.replace(/\.enc$/u, ""),
        sourceRootKey: options.entry.sourceRootKey,
        targetRootKey: options.entry.targetRootKey,
        targetPath: options.targetPath,
        signal,
      });
    } finally {
      raw.fill(0);
    }
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}
