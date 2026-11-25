// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstat, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  atomicWriteFile,
  codexKeyringAccount,
  codexPaths,
  confirmMacosKeychainEntriesAbsent,
  invalidateSecretFileKeyCache,
  OMNESIS_INSTALL_ROOT_KEY,
  secureMarkerStateKeyName,
} from "@omnesis/core";
import { withDesktopInstallLease } from "./bootstrap.js";
import { acquireDesktopRestoreSessionLease } from "./restore-owner.js";
import {
  desktopRootIdentity,
  readDesktopRetirement,
  type DesktopRetirement,
} from "./retirement.js";
import { readDesktopPrivateRecord } from "./private-record.js";
import {
  desktopConfigIdentity,
  desktopGenerationPath,
  desktopProfileForGeneration,
  readDesktopGeneration,
  type DesktopGeneration,
} from "./generation.js";
import type { DesktopProfile } from "./environment.js";

export interface DesktopFreshInstallPreview {
  kind: "desktopFreshInstallPreview";
  available: boolean;
  confirmationId?: string;
  summary: string;
  relaunchRequired: true;
}
export interface DesktopFreshInstallResult {
  kind: "desktopFreshInstallResult";
  status: "ready-for-relaunch";
  relaunchRequired: true;
}
interface Dependencies {
  keysAbsent(profile: DesktopProfile, metadataGeneration?: string): Promise<boolean>;
  publish(profile: DesktopProfile, generation: DesktopGeneration): Promise<void>;
}
const defaults: Dependencies = {
  keysAbsent: async (profile, metadataGeneration) => {
    const options = {
      backend: "macos-keychain" as const,
      service: profile.secretService,
      configDir: profile.configDir,
    };
    if (
      !(await confirmMacosKeychainEntriesAbsent(
        [
          OMNESIS_INSTALL_ROOT_KEY,
          secureMarkerStateKeyName("secret-files", profile.configDir),
          secureMarkerStateKeyName("storage-encryption", profile.configDir),
        ],
        options,
        metadataGeneration,
      ))
    )
      return false;
    return confirmMacosKeychainEntriesAbsent(
      [
        ...new Set([
          codexKeyringAccount(codexPaths(profile.configDir, profile.instance).home),
          codexKeyringAccount(codexPaths(profile.configDir).home),
        ]),
      ],
      { ...options, service: "Codex Auth" },
      metadataGeneration,
    );
  },
  publish: (profile, generation) =>
    atomicWriteFile(desktopGenerationPath(profile.configDir), JSON.stringify(generation), {
      mode: 0o600,
    }),
};
/** No key or data directory is created: a new bridge must explicitly prepare the new identity. */
export class DesktopFreshInstallService {
  #plan:
    { id: string; receipt: string; generation: DesktopGeneration; expires: number } | undefined;
  readonly #deps: Dependencies;
  constructor(
    private readonly profile: DesktopProfile,
    dependencies: Partial<Dependencies> = {},
  ) {
    this.#deps = { ...defaults, ...dependencies };
  }
  async preview(signal: AbortSignal): Promise<DesktopFreshInstallPreview> {
    this.#plan = undefined;
    const record = await readDesktopRetirement(this.profile);
    if (record?.mode !== "erase-data" || record.phase !== "complete")
      return {
        kind: "desktopFreshInstallPreview",
        available: false,
        summary:
          "Finish erasing this Mac's managed library and its saved keys before creating a new installation.",
        relaunchRequired: true,
      };
    return this.exclusive(signal, async () => {
      const current = await this.erased(signal);
      const generation: DesktopGeneration = {
        version: 1,
        owner: "omnesis-desktop",
        configIdentity: desktopConfigIdentity(this.profile.configDir),
        generation: randomUUID(),
        previous: {
          instance: this.profile.instance,
          secretService: this.profile.secretService,
          retirementId: current.operationId,
        },
      };
      const next = desktopProfileForGeneration(this.profile.configDir, generation.generation);
      if (
        !(await this.#deps.keysAbsent(this.profile)) ||
        !(await this.#deps.keysAbsent(next, generation.generation))
      )
        throw new Error("Finish Keychain cleanup before creating a new installation");
      signal.throwIfAborted();
      const id = randomBytes(32).toString("hex");
      this.#plan = { id, receipt: digest(current), generation, expires: Date.now() + 10 * 60_000 };
      return {
        kind: "desktopFreshInstallPreview",
        available: true,
        confirmationId: id,
        summary:
          "Create a new empty Omnesis installation on this Mac. Its old library and saved keys have been erased. Existing backups and recovery files outside this app stay where you saved them.",
        relaunchRequired: true,
      };
    });
  }
  async commit(confirmationId: string, signal: AbortSignal): Promise<DesktopFreshInstallResult> {
    const plan = this.#plan;
    this.#plan = undefined;
    if (!plan || plan.id !== confirmationId || plan.expires < Date.now())
      throw new Error("Review and confirm the new installation first");
    return this.exclusive(signal, async () => {
      const current = await this.erased(signal),
        next = desktopProfileForGeneration(this.profile.configDir, plan.generation.generation);
      if (
        digest(current) !== plan.receipt ||
        !(await this.#deps.keysAbsent(this.profile)) ||
        !(await this.#deps.keysAbsent(next, plan.generation.generation))
      )
        throw new Error("The erased installation changed; review the new installation again");
      // Only fixed, identity-bound control records are reset. The completed
      // erase receipt remains the fence until the final generation publication.
      for (const name of ["restore.json", "update.json", "active-runtime.json"] as const) {
        signal.throwIfAborted();
        const path = join(`${this.profile.configDir}.bootstrap`, name);
        let before;
        try {
          before = await lstat(path, { bigint: true });
        } catch (error) {
          if (missing(error)) continue;
          throw error;
        }
        const record = await readDesktopPrivateRecord(this.profile, name, (value) => {
          if (
            typeof value !== "object" ||
            value === null ||
            !("owner" in value) ||
            value.owner !== "omnesis-desktop" ||
            !("instance" in value) ||
            value.instance !== this.profile.instance ||
            !("secretService" in value) ||
            value.secretService !== this.profile.secretService
          )
            throw new Error("The old setup record belongs to another installation");
          return true;
        });
        const after = await lstat(path, { bigint: true });
        if (
          !record ||
          before.dev !== after.dev ||
          before.ino !== after.ino ||
          before.size !== after.size ||
          before.mtimeNs !== after.mtimeNs ||
          before.ctimeNs !== after.ctimeNs
        )
          throw new Error("The old setup record changed");
        await unlink(path);
      }
      await this.erased(signal);
      invalidateSecretFileKeyCache();
      signal.throwIfAborted();
      await this.#deps.publish(this.profile, plan.generation);
      return {
        kind: "desktopFreshInstallResult",
        status: "ready-for-relaunch",
        relaunchRequired: true,
      };
    });
  }
  close(): void {
    this.#plan = undefined;
  }
  private async erased(signal: AbortSignal): Promise<DesktopRetirement> {
    signal.throwIfAborted();
    const currentGeneration = readDesktopGeneration(this.profile.configDir);
    if (currentGeneration) {
      const current = desktopProfileForGeneration(
        this.profile.configDir,
        currentGeneration.generation,
      );
      if (
        current.instance !== this.profile.instance ||
        current.secretService !== this.profile.secretService
      )
        throw new Error("Reconnect the app before preparing its new installation");
    }
    const record = await readDesktopRetirement(this.profile);
    if (
      record?.mode !== "erase-data" ||
      record.phase !== "complete" ||
      (await desktopRootIdentity(this.profile))
    )
      throw new Error("The old library or its cleanup is still present; no new root was created");
    return record;
  }
  private async exclusive<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    const lease = await acquireDesktopRestoreSessionLease(this.profile, signal, {
      createParent: true,
    });
    try {
      return await withDesktopInstallLease(this.profile, signal, work);
    } finally {
      lease.release();
    }
  }
}
function digest(record: DesktopRetirement): string {
  return createHash("sha256").update(JSON.stringify(record)).digest("hex");
}
function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
