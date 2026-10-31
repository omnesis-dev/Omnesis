// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { join } from "node:path";
import {
  createLogger,
  readSecretJsonFile,
  toErrorMessage,
  writeSecretTextFile,
} from "@omnesis/core";
import { isAlbumIndex, type ImmichAlbumIndex } from "./types.js";

const log = createLogger("source:immich");

const ALBUM_INDEX_FILE = "albums.json";

/**
 * Where the album index lives between sweeps. It is a cache of what Immich
 * already holds, so losing it costs one re-read of the albums, never data.
 */
export interface AlbumIndexStore {
  /** The stored index, or undefined when there is none or it cannot be read. */
  load(): Promise<ImmichAlbumIndex | undefined>;
  save(index: ImmichAlbumIndex): Promise<void>;
}

/** An index held for the life of the instance only: tests, and a host with no state directory. */
export function memoryAlbumStore(): AlbumIndexStore {
  let stored: ImmichAlbumIndex | undefined;
  return {
    load: () => Promise.resolve(stored),
    save: (index) => {
      stored = index;
      return Promise.resolve();
    },
  };
}

/**
 * The index in the source's state directory, encrypted with the install's
 * root key when it has one: album names are the operator's own words.
 */
export function fileAlbumStore(stateDir: string, configDir: string): AlbumIndexStore {
  const path = join(stateDir, ALBUM_INDEX_FILE);
  return {
    async load() {
      try {
        const value = await readSecretJsonFile<unknown>(path, { configDir });
        if (value === null) return undefined;
        if (isAlbumIndex(value)) return value;
        log.warn("The stored Immich album index is not one this build reads; rebuilding it");
      } catch (err) {
        log.warn(
          `Could not read the stored Immich album index, rebuilding it: ${toErrorMessage(err)}`,
        );
      }
      return undefined;
    },
    async save(index) {
      // Unindented: it grows with the library.
      await writeSecretTextFile(path, JSON.stringify(index), { configDir });
    },
  };
}
