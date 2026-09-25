// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { parseFileBlob, type FileBlobInfo } from "./bplist.js";

/** A located, decryptable file entry from a backup's Manifest.db. */
export interface BackupFileRef extends FileBlobInfo {
  /** The 40-char SHA-1 fileID — on-disk path is `<dir>/<fileID[:2]>/<fileID>`. */
  fileID: string;
}

/**
 * Look up a single file in a decrypted Manifest.db by domain+relativePath
 * and/or fileID, returning its protection class + wrapped key. `flags = 1`
 * restricts to regular files (2 = directory). Returns null if absent or the
 * entry carries no encryption key.
 */
export function lookupFile(
  manifestDbPath: string,
  criteria: { domainLike?: string; relativePath?: string; fileID?: string },
): BackupFileRef | null {
  const db = new Database(manifestDbPath, { readonly: true, fileMustExist: true });
  try {
    const where: string[] = ["flags = 1"];
    const params: string[] = [];
    if (criteria.relativePath) {
      where.push("relativePath = ?");
      params.push(criteria.relativePath);
    }
    if (criteria.domainLike) {
      where.push("domain LIKE ?");
      params.push(criteria.domainLike);
    }
    if (criteria.fileID) {
      where.push("fileID = ?");
      params.push(criteria.fileID);
    }
    const row = db
      .prepare(`SELECT fileID, file FROM Files WHERE ${where.join(" AND ")} LIMIT 1`)
      .get(...params) as { fileID: string; file: Buffer } | undefined;
    if (!row) return null;
    const info = parseFileBlob(row.file);
    if (!info) return null;
    return { fileID: row.fileID, ...info };
  } finally {
    db.close();
  }
}
