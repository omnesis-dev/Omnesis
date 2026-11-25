// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { decryptEncryptedArtifactStream, type EncryptedArtifactStream } from "@omnesis/core";
import { ValidationError } from "../errors.js";
import { exportManifestSchema } from "./ExportService.js";
import {
  artifactUnavailable,
  openArtifactFile,
  verifyArtifactFile,
  type ArtifactFile,
  type ArtifactPlan,
} from "./artifact-files.js";
import type { FileHandle } from "node:fs/promises";

const FULL_MANIFEST = "manifest.full.json.enc";
const MANIFEST_BYTES = 1024 * 1024;
export interface ReadableExport {
  manifest: Buffer;
  files: Array<{ stored: ArtifactFile; name: string; scope: string }>;
}

export function requireReadableExport(plan: ArtifactPlan): void {
  const manifest = plan.exportManifest;
  if (plan.item.kind !== "export")
    throw new ValidationError("Readable downloads are available for data exports only.");
  if (
    !manifest?.exportId ||
    !manifest.encryption ||
    manifest.encryptedManifest !== FULL_MANIFEST ||
    plan.item.protection !== "encrypted-payloads"
  ) {
    throw new ValidationError(
      "Create a new encrypted export before saving readable JSON or CSV files. You can still save the stored copy.",
    );
  }
}

/** Only authenticated metadata chooses export scopes. No payload plaintext is staged. */
export async function prepareReadableExport(
  plan: ArtifactPlan,
  rootKey: string,
  signal: AbortSignal,
  ensureActive: () => void,
): Promise<ReadableExport> {
  requireReadableExport(plan);
  const publicManifest = plan.exportManifest!;
  const file = plan.files.find((entry) => entry.name === FULL_MANIFEST);
  if (!file || file.bytes > MANIFEST_BYTES + 16384) throw artifactUnavailable();
  const handle = await openArtifactFile(plan, file);
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    const reading = decryptPinnedExport(
      handle,
      file,
      rootKey,
      `export:${publicManifest.exportId}:manifest.full.json`,
      signal,
      ensureActive,
    );
    for await (const block of reading) {
      bytes += block.length;
      if (bytes > MANIFEST_BYTES) throw artifactUnavailable();
      chunks.push(block);
    }
    reading.authentication();
    await verifyArtifactFile(handle, file);
    const content = Buffer.concat(chunks);
    try {
      const manifest = exportManifestSchema.parse(JSON.parse(content.toString("utf8")));
      if (
        !manifest.exportId ||
        manifest.exportId !== publicManifest.exportId ||
        !manifest.encryption ||
        manifest.encryptedManifest ||
        manifest.format !== publicManifest.format ||
        manifest.version !== publicManifest.version ||
        manifest.startedAt !== publicManifest.startedAt ||
        manifest.finishedAt !== publicManifest.finishedAt ||
        new Set(manifest.files).size !== manifest.files.length ||
        !manifest.files.includes("manifest.json")
      )
        throw artifactUnavailable();
      const declared = manifest.files.filter((name) => name !== "manifest.json");
      const publicFiles = publicManifest.files.filter((name) => name !== FULL_MANIFEST);
      if (
        declared.length !== publicFiles.length ||
        new Set(publicFiles).size !== publicFiles.length ||
        declared.some((name) => !publicFiles.includes(name)) ||
        plan.directories.length > 0 ||
        plan.files.length !== declared.length + 2
      )
        throw artifactUnavailable();
      const files = declared.map((storedName) => {
        const stored = plan.files.find((entry) => entry.name === storedName);
        if (!stored?.sealed || !storedName.endsWith(".enc")) throw artifactUnavailable();
        const name = storedName.slice(0, -4);
        // The producer emits JSONL or CSV files only; never provide credentials/config through this route.
        if (!/^[a-zA-Z0-9_-]+\.(jsonl|csv)$/u.test(name) || name === "manifest.json")
          throw artifactUnavailable();
        return { stored, name, scope: `export:${manifest.exportId}:${name}` };
      });
      const { encryption: _encryption, encryptedManifest: _sealed, ...readable } = manifest;
      return {
        files,
        manifest: Buffer.from(
          JSON.stringify(
            { ...readable, files: [...files.map((entry) => entry.name), "manifest.json"] },
            null,
            2,
          ) + "\n",
        ),
      };
    } finally {
      content.fill(0);
    }
  } finally {
    chunks.forEach((chunk) => chunk.fill(0));
    await handle.close();
  }
}

/** Replay uses the SAME descriptor with explicit offsets, not an attacker-replaceable pathname. */
export function decryptPinnedExport(
  handle: FileHandle,
  file: ArtifactFile,
  rootKey: string,
  expectedScope: string,
  signal: AbortSignal,
  ensureActive: () => void,
): EncryptedArtifactStream {
  async function* ciphertext(): AsyncGenerator<Buffer> {
    await verifyArtifactFile(handle, file);
    let offset = 0;
    while (offset < file.bytes) {
      ensureActive();
      signal.throwIfAborted();
      const buffer = Buffer.alloc(Math.min(64 * 1024, file.bytes - offset));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      if (!bytesRead) throw artifactUnavailable();
      offset += bytesRead;
      yield buffer.subarray(0, bytesRead);
    }
    await verifyArtifactFile(handle, file);
  }
  return decryptEncryptedArtifactStream(ciphertext(), {
    rootKey,
    expectedScope,
    signal,
    maxBytes: file.bytes,
  });
}

/** The first pass discards unauthenticated blocks and proves the TAR entry's exact size. */
export async function authenticateReadableExport(
  handle: FileHandle,
  file: ArtifactFile,
  rootKey: string,
  scope: string,
  signal: AbortSignal,
  ensureActive: () => void,
): Promise<number> {
  const reading = decryptPinnedExport(handle, file, rootKey, scope, signal, ensureActive);
  for await (const block of reading) block.fill(0);
  await verifyArtifactFile(handle, file);
  return reading.authentication().bytes;
}
