// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  atomicWriteFile,
  createRecoveryEnvelopeAsync,
  generateRecoveryCode,
  parseRecoveryEnvelope,
  readInstallRootKey,
  recoveryEnvelopePath,
  type RecoveryEnvelopeV1,
} from "@omnesis/core";
import { DesktopRecoveryImportService } from "./recovery-import.js";
import { readDesktopInstall } from "./bootstrap.js";
import { withDesktopPublication } from "./publication.js";
import {
  desktopRootIdentity,
  readDesktopRetirement,
  sameDesktopRoot,
  type DesktopRootIdentity,
} from "./retirement.js";
import type { DesktopProfile } from "./environment.js";

const DRAFT_TTL_MS = 5 * 60_000;
const MAX_ENVELOPE_BYTES = 16_384;

export interface DesktopRecoveryStatus {
  available: boolean;
  hasEnvelope: boolean;
  envelopeValid: boolean;
}
export interface DesktopRecoveryDraft {
  draftId: string;
  expiresAt: number;
  recoveryCode: string;
  envelope: RecoveryEnvelopeV1;
}
interface RetainedDraft {
  expiresAt: number;
  envelope: RecoveryEnvelopeV1;
  root: DesktopRootIdentity;
  keyDigest: string;
  previousEnvelopeDigest: string | null;
}
interface EnvelopeState {
  present: boolean;
  valid: boolean;
  digest: string | null;
}
interface RecoveryDependencies {
  publish: typeof withDesktopPublication;
  readInstall: typeof readDesktopInstall;
  readKey: typeof readInstallRootKey;
  rootIdentity: typeof desktopRootIdentity;
  now(): number;
}
const defaults: RecoveryDependencies = {
  publish: withDesktopPublication,
  readInstall: readDesktopInstall,
  readKey: readInstallRootKey,
  rootIdentity: desktopRootIdentity,
  now: Date.now,
};

/**
 * Recovery drafts live only in this bridge process. The code is returned once
 * over its private pipe, never persisted here; only an explicitly committed
 * sealed envelope is published at the existing recovery-envelope location.
 */
export class DesktopRecoveryService {
  private readonly importer: DesktopRecoveryImportService;
  private readonly drafts = new Map<string, RetainedDraft>();
  private readonly deps: RecoveryDependencies;

  constructor(
    private readonly profile: DesktopProfile,
    dependencies: Partial<RecoveryDependencies> = {},
  ) {
    this.deps = { ...defaults, ...dependencies };
    this.importer = new DesktopRecoveryImportService(profile);
  }

  restoreExisting(envelope: unknown, recoveryCode: string, signal: AbortSignal) {
    return this.importer.restore(envelope, recoveryCode, signal);
  }

  async status(signal: AbortSignal): Promise<DesktopRecoveryStatus> {
    signal.throwIfAborted();
    const install = await this.deps.readInstall(this.profile);
    if (await readDesktopRetirement(this.profile))
      return { available: false, hasEnvelope: false, envelopeValid: false };
    if (!install || install.phase !== "configured" || install.mode !== "home")
      return { available: false, hasEnvelope: false, envelopeValid: false };
    const envelope = await readEnvelopeState(this.profile);
    signal.throwIfAborted();
    return { available: true, hasEnvelope: envelope.present, envelopeValid: envelope.valid };
  }

  async prepare(options: {
    replaceExisting?: boolean;
    signal: AbortSignal;
  }): Promise<DesktopRecoveryDraft> {
    return this.deps.publish(this.profile, options.signal, async () => {
      await this.requireHome(options.signal);
      const existing = await readEnvelopeState(this.profile);
      if (existing.present && options.replaceExisting !== true)
        throw new Error(
          "A recovery envelope already exists. Confirm replacement before making another code.",
        );
      const root = await this.deps.rootIdentity(this.profile);
      if (!root) throw new Error("The managed library is no longer available");
      const key = await this.requireKey(options.signal);
      const recoveryCode = generateRecoveryCode();
      const envelope = await createRecoveryEnvelopeAsync(key, recoveryCode);
      options.signal.throwIfAborted();
      const draftId = randomUUID();
      const expiresAt = this.deps.now() + DRAFT_TTL_MS;
      // A second deliberate request discards an unsaved code, not a saved envelope.
      this.drafts.clear();
      this.drafts.set(draftId, {
        expiresAt,
        envelope,
        root,
        keyDigest: digest(key),
        previousEnvelopeDigest: existing.digest,
      });
      return { draftId, expiresAt, recoveryCode, envelope };
    });
  }

  async commit(draftId: string, signal: AbortSignal): Promise<{ saved: true }> {
    const pending = this.pending(draftId);
    return this.deps.publish(this.profile, signal, async () => {
      await this.requireHome(signal);
      const current = this.pending(draftId);
      if (current !== pending) throw expired();
      const root = await this.deps.rootIdentity(this.profile);
      const key = await this.requireKey(signal);
      const envelope = await readEnvelopeState(this.profile);
      if (!root || !sameDesktopRoot(root, pending.root) || digest(key) !== pending.keyDigest)
        throw new Error(
          "The library's protection changed. Create a new recovery code for this library.",
        );
      if (envelope.digest !== pending.previousEnvelopeDigest)
        throw new Error(
          "Another recovery envelope was saved. Review replacement before creating another code.",
        );
      signal.throwIfAborted();
      const path = recoveryEnvelopePath(this.profile.configDir);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await assertPrivateDirectory(dirname(path));
      signal.throwIfAborted();
      await atomicWriteFile(path, `${JSON.stringify(pending.envelope, null, 2)}\n`, {
        mode: 0o600,
      });
      this.drafts.delete(draftId);
      return { saved: true };
    });
  }

  cancel(draftId: string): void {
    this.drafts.delete(draftId);
  }

  close(): void {
    this.drafts.clear();
  }

  private pending(id: string): RetainedDraft {
    for (const [key, value] of this.drafts)
      if (value.expiresAt <= this.deps.now()) this.drafts.delete(key);
    const draft = this.drafts.get(id);
    if (!draft) throw expired();
    return draft;
  }

  private async requireHome(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const install = await this.deps.readInstall(this.profile);
    if (!install || install.phase !== "configured" || install.mode !== "home")
      throw new Error("Prepare recovery on the computer that keeps your library.");
    signal.throwIfAborted();
  }

  private async requireKey(signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const key = await this.deps.readKey({
      backend: "macos-keychain",
      configDir: this.profile.configDir,
      service: this.profile.secretService,
    });
    signal.throwIfAborted();
    if (!key)
      throw new Error("Unlock the macOS Keychain to create a recovery code for this library.");
    return key;
  }
}

async function readEnvelopeState(profile: DesktopProfile): Promise<EnvelopeState> {
  const path = recoveryEnvelopePath(profile.configDir);
  try {
    await assertPrivateDirectory(dirname(path));
    const file = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    try {
      const metadata = await file.stat();
      if (
        !metadata.isFile() ||
        metadata.nlink !== 1 ||
        (metadata.mode & 0o077) !== 0 ||
        (process.getuid && metadata.uid !== process.getuid())
      )
        throw new Error("The recovery envelope must be a private file owned by you");
      const bytes = Buffer.alloc(MAX_ENVELOPE_BYTES + 1);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead > MAX_ENVELOPE_BYTES) throw new Error("The recovery envelope is too large");
      const content = bytes.subarray(0, bytesRead);
      let valid = false;
      try {
        valid = parseRecoveryEnvelope(JSON.parse(content.toString("utf8"))) !== null;
      } catch {
        /* A malformed existing envelope still requires explicit replacement. */
      }
      return { present: true, valid, digest: digest(content) };
    } finally {
      await file.close();
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return { present: false, valid: false, digest: null };
    throw error;
  }
}

async function assertPrivateDirectory(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o077) !== 0 ||
    (process.getuid && metadata.uid !== process.getuid()) ||
    (await realpath(path)) !== resolve(path)
  )
    throw new Error("The recovery folder must be private, owned by you and not a symbolic link");
}
function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
function expired(): Error {
  return new Error("This recovery choice expired or was cancelled. Create a new recovery code.");
}
