// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  BACKUP_RECOVERY_ENVELOPE_NAME,
  backupManifestSchema,
  isEncryptedArtifactBuffer,
  readEncryptedArtifactStream,
  decryptEncryptedArtifactStream,
  openRecoveryEnvelope,
  parseRecoveryEnvelope,
  parseStorageKeyName,
  rewrapSecretFileValue,
  rewrapStorageKeyValue,
  type StorageKeyName,
} from "@omnesis/core";
import {
  reconcileDesktopMainEntry,
  inspectDesktopMainEntry,
  type RestoredMainInspection,
  type RestoredMainEntryOptions,
  type RestoredMainDatabase,
} from "@omnesis/gateway/restore";
import type { DesktopBackupArchive } from "./restore-archive.js";

export class DesktopRestoreRecoveryRequiredError extends Error {
  readonly code = "RECOVERY_CODE_REQUIRED";
  constructor() {
    super("Enter the recovery code for the selected backup");
  }
}
/** Source and target root keys remain private to the sidecar, never in preview results. */
export class DesktopRestoreEntries {
  #sourceRootKey: string;
  #archive: DesktopBackupArchive;
  #targetRootKey: string;
  #signal: AbortSignal;
  #sourceEpoch: string | null = null;
  #unlocked = false;
  constructor(archive: DesktopBackupArchive, targetRootKey: string, signal: AbortSignal) {
    this.#sourceRootKey = targetRootKey;
    this.#archive = archive;
    this.#targetRootKey = targetRootKey;
    this.#signal = signal;
  }

  async unlock(
    options: { recoveryCode?: string; recoveryEnvelope?: unknown } = {},
  ): Promise<{ needsRecoveryCode: boolean }> {
    this.#signal.throwIfAborted();
    try {
      await this.probe();
      this.#unlocked = true;
      return { needsRecoveryCode: false };
    } catch {
      /* A different source key needs its own recovery ceremony. */
    }
    this.#signal.throwIfAborted();
    if (!options.recoveryCode) return { needsRecoveryCode: true };
    if (options.recoveryCode.length > 512) throw new Error("The recovery code is not supported");
    let envelope = options.recoveryEnvelope;
    if (envelope === undefined) {
      if (!this.#archive.sealedFiles.has(BACKUP_RECOVERY_ENVELOPE_NAME))
        throw new Error("Choose the recovery file that belongs to this backup");
      const raw = await this.readRaw(BACKUP_RECOVERY_ENVELOPE_NAME, 16_384);
      try {
        envelope = JSON.parse(raw.toString("utf8"));
      } catch {
        throw new Error("The backup recovery file is invalid");
      } finally {
        raw.fill(0);
      }
    }
    if (Buffer.byteLength(JSON.stringify(envelope) ?? "") > 16_384)
      throw new Error("The recovery file is not supported");
    const parsed = parseRecoveryEnvelope(envelope);
    if (!parsed) throw new Error("The recovery file is not supported");
    let candidate: string;
    try {
      candidate = openRecoveryEnvelope(parsed, options.recoveryCode);
    } catch {
      throw new Error("The recovery code does not open this backup");
    }
    this.#sourceRootKey = candidate;
    this.#sourceEpoch = null;
    try {
      await this.probe();
    } catch {
      this.#sourceRootKey = this.#targetRootKey;
      this.#signal.throwIfAborted();
      throw new Error("The backup could not be verified with this recovery file");
    }
    this.#unlocked = true;
    return { needsRecoveryCode: false };
  }

  has(name: string): boolean {
    return this.#archive.sealedFiles.has(name);
  }

  close(): void {
    this.#sourceRootKey = "";
    this.#targetRootKey = "";
    this.#unlocked = false;
  }

  async read(name: string, maxBytes: number): Promise<Buffer> {
    if (!this.#unlocked) throw new DesktopRestoreRecoveryRequiredError();
    return this.readRaw(name, maxBytes);
  }
  async *stream(name: string): AsyncGenerator<Buffer, void, void> {
    if (!this.#unlocked) throw new DesktopRestoreRecoveryRequiredError();
    yield* this.streamRaw(name);
  }
  async inspectMain(
    name: "omnesis.db" | "omnesis.db.enc",
    options: { sourceKey: Buffer | null; sourceCipherPath: string },
  ): Promise<RestoredMainInspection> {
    if (!this.#unlocked) throw new DesktopRestoreRecoveryRequiredError();
    const file = this.#archive.sealedFiles.get(name),
      bytes = this.#archive.files.get(name);
    if (!file || bytes === undefined) throw new Error("The backup main database is unavailable");
    return inspectDesktopMainEntry(
      {
        ...options,
        entry: {
          path: file.path,
          scope: file.scope,
          logicalName: name,
          bytes,
          targetRootKey: this.#targetRootKey,
          sourceRootKey: this.#sourceRootKey,
          sourceScope: this.#sourceEpoch ? `backup:${this.#sourceEpoch}:omnesis.db` : null,
        },
      },
      this.#signal,
    );
  }

  async prepareMain(
    name: "omnesis.db" | "omnesis.db.enc",
    options: Omit<RestoredMainEntryOptions, "entry">,
  ): Promise<RestoredMainDatabase> {
    if (!this.#unlocked) throw new DesktopRestoreRecoveryRequiredError();
    const file = this.#archive.sealedFiles.get(name),
      bytes = this.#archive.files.get(name);
    if (!file || bytes === undefined) throw new Error("The backup main database is unavailable");
    return reconcileDesktopMainEntry(
      {
        ...options,
        entry: {
          path: file.path,
          scope: file.scope,
          logicalName: name,
          bytes,
          targetRootKey: this.#targetRootKey,
          sourceRootKey: this.#sourceRootKey,
          sourceScope: this.#sourceEpoch ? `backup:${this.#sourceEpoch}:omnesis.db` : null,
        },
      },
      this.#signal,
    );
  }

  rewrapStorageKey(raw: string, keyName: StorageKeyName): string {
    if (!this.#unlocked) throw new DesktopRestoreRecoveryRequiredError();
    return rewrapStorageKeyValue(raw, {
      keyName,
      sourceRootKey: this.#sourceRootKey,
      targetRootKey: this.#targetRootKey,
    });
  }
  rewrapSecret(raw: string, scope: string): string {
    if (!this.#unlocked) throw new DesktopRestoreRecoveryRequiredError();
    return rewrapSecretFileValue(raw, {
      sourceRootKey: this.#sourceRootKey,
      targetRootKey: this.#targetRootKey,
      sourceScope: scope,
      targetScope: scope,
    });
  }
  private async probe(): Promise<void> {
    const manifest = this.#archive.manifest;
    if (manifest.encryptedManifest) {
      const full = backupManifestSchema.parse(
        JSON.parse((await this.readRaw(manifest.encryptedManifest, 1024 * 1024)).toString("utf8")),
      );
      const publicFiles = manifest.files.filter((file) => file.name !== manifest.encryptedManifest);
      const normalize = (files: typeof full.files) =>
        files
          .map((file) => ({
            name: file.name,
            bytes: file.bytes,
            encrypted: file.encrypted === true,
          }))
          .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      if (
        full.version !== manifest.version ||
        full.startedAt !== manifest.startedAt ||
        full.finishedAt !== manifest.finishedAt ||
        full.includeIndex !== manifest.includeIndex ||
        JSON.stringify(normalize(full.files)) !== JSON.stringify(normalize(publicFiles))
      )
        throw new Error("The backup manifests disagree");
      return;
    }
    const wrapped = [...this.#archive.files.keys()].find(
      (name) => name.startsWith("keyring/storage-keys/") && name.endsWith(".json"),
    );
    if (wrapped) {
      const encoded = wrapped.slice("keyring/storage-keys/".length, -5);
      const keyName = parseStorageKeyName(decodeURIComponent(encoded));
      const raw = (await this.readRaw(wrapped, 16_384)).toString("utf8");
      rewrapStorageKeyValue(raw, {
        keyName,
        sourceRootKey: this.#sourceRootKey,
        targetRootKey: this.#targetRootKey,
      });
      return;
    }
    if (
      manifest.encryption ||
      manifest.files.some((file) => file.encrypted && file.name !== BACKUP_RECOVERY_ENVELOPE_NAME)
    )
      throw new Error("The encrypted backup has no verifiable key metadata");
  }
  private async readRaw(name: string, maxBytes: number): Promise<Buffer> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > 64 * 1024 * 1024)
      throw new Error("The restore memory bound is unsupported");
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of this.streamRaw(name)) {
      bytes += chunk.length;
      if (bytes > maxBytes) throw new Error("This backup entry exceeds the supported memory bound");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  private async *streamRaw(name: string): AsyncGenerator<Buffer, void, void> {
    const file = this.#archive.sealedFiles.get(name),
      bytes = this.#archive.files.get(name);
    if (!file || bytes === undefined) throw new Error("A required backup entry is unavailable");
    const outer = readEncryptedArtifactStream(file.path, {
      rootKey: this.#targetRootKey,
      expectedScope: file.scope,
      signal: this.#signal,
      maxBytes: bytes + 16_384,
    });
    const iterator = outer[Symbol.asyncIterator]();
    let prefix = Buffer.alloc(0);
    while (prefix.length < 64) {
      const next = await iterator.next();
      if (next.done) break;
      prefix = Buffer.concat([prefix, next.value]);
    }
    const replay = (async function* () {
      try {
        if (prefix.length) yield prefix;
        while (true) {
          const next = await iterator.next();
          if (next.done) break;
          yield next.value;
        }
      } finally {
        await iterator.return();
      }
    })();
    if (isEncryptedArtifactBuffer(prefix)) {
      const inner = decryptEncryptedArtifactStream(replay, {
        rootKey: this.#sourceRootKey,
        signal: this.#signal,
        maxBytes: bytes,
      });
      for await (const chunk of inner) yield chunk;
      const scope = inner.authentication().scope;
      const plainName = name.endsWith(".enc") ? name.slice(0, -4) : name;
      const suffix = `:${plainName}`;
      if (!scope.startsWith("backup:") || !scope.endsWith(suffix))
        throw new Error("The backup entry has an unexpected encryption scope");
      const epoch = scope.slice("backup:".length, -suffix.length);
      if (
        !epoch ||
        epoch.length > 256 ||
        (this.#sourceEpoch !== null && epoch !== this.#sourceEpoch)
      )
        throw new Error("The backup contains different encryption epochs");
      this.#sourceEpoch = epoch;
    } else {
      yield* replay;
    }
    outer.authentication();
  }
}
