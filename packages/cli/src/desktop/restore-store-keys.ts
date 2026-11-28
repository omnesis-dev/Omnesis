// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdir } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import {
  atomicWriteFile,
  readStorageKey,
  storageKeyPath,
  type StorageKeyName,
  type StorageKeyOptions,
} from "@omnesis/core";
import type { DesktopProfile } from "./environment.js";
import type { DesktopRestoreEntries } from "./restore-entries.js";

const names = [
  "main-db",
  "index-db",
  "analytics-db",
  "watch2-db",
] as const satisfies readonly StorageKeyName[];
/** No root key is installed and no target file is modified while resolving a backup's store keys. */
export class DesktopRestoreStoreKeys {
  #source = new Map<StorageKeyName, Buffer>();
  #target = new Map<StorageKeyName, Buffer>();
  #wrapped = new Map<StorageKeyName, { logical: string; path: string }>();
  private constructor() {}
  static async prepare(
    options: {
      profile: DesktopProfile;
      entries: DesktopRestoreEntries;
      directory: string;
      signal: AbortSignal;
    },
    dependencies: { readKey?: typeof readStorageKey } = {},
  ): Promise<DesktopRestoreStoreKeys> {
    const result = new DesktopRestoreStoreKeys(),
      read = dependencies.readKey ?? readStorageKey;
    try {
      await mkdir(options.directory, { mode: 0o700 });
      for (const name of names) {
        options.signal.throwIfAborted();
        const keyOptions: StorageKeyOptions = {
          backend: "macos-keychain",
          service: options.profile.secretService,
          configDir: options.profile.configDir,
        };
        const target = await read(name, keyOptions);
        if (target) result.#target.set(name, target);
        const logical = relative(
          options.profile.configDir,
          storageKeyPath(name, options.profile.configDir),
        )
          .split(sep)
          .join("/");
        const candidates = [logical, `${logical}.enc`].filter((path) => options.entries.has(path));
        if (candidates.length > 1) throw new Error("The backup has ambiguous storage key records");
        if (!candidates.length) continue;
        const raw = await options.entries.read(candidates[0]!, 16_384);
        let wrapped: string;
        try {
          wrapped = options.entries.rewrapStorageKey(raw.toString("utf8"), name);
        } finally {
          raw.fill(0);
        }
        const path = storageKeyPath(name, options.directory);
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await atomicWriteFile(path, wrapped, { mode: 0o600 });
        const source = await read(name, { ...keyOptions, configDir: options.directory });
        if (!source || source.length !== 32)
          throw new Error("The backup storage key is unavailable");
        result.#source.set(name, source);
        result.#wrapped.set(name, { logical, path });
      }
      if (!result.#target.has("main-db"))
        throw new Error("Start this Mac's managed library before restoring a backup");
      return result;
    } catch {
      result.close();
      options.signal.throwIfAborted();
      throw new Error("The backup storage keys could not be reconciled with this Mac");
    }
  }
  source(name: StorageKeyName): Buffer | null {
    return this.#source.get(name) ?? null;
  }
  target(name: StorageKeyName): Buffer | null {
    return this.#target.get(name) ?? null;
  }
  wrapped(name: StorageKeyName): { logical: string; path: string } | null {
    const file = this.#wrapped.get(name);
    return file ? { ...file } : null;
  }
  close(): void {
    for (const key of [...this.#source.values(), ...this.#target.values()]) key.fill(0);
    this.#source.clear();
    this.#target.clear();
    this.#wrapped.clear();
  }
}
