// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Preserve upstream notices verbatim, including the database's vendored components. */
export async function collectAnalyticsNotices(sources, destination) {
  const hashes = {};
  let files = 0,
    entries = 0,
    bytes = 0;
  async function visit(root, prefix, depth) {
    if (depth > 32) throw new Error("Native source notice directories exceed their bound");
    for (const item of await readdir(root, { withFileTypes: true })) {
      if (++entries > 200_000) throw new Error("Native source notice inventory exceeds its bound");
      const logical = `${prefix}/${item.name}`;
      if (item.isDirectory()) await visit(join(root, item.name), logical, depth + 1);
      else if (item.isFile() && /^(?:licen[cs]e|copying|notice)(?:[._-].*)?$/iu.test(item.name)) {
        if (++files > 1024) throw new Error("Native source contains too many notice files");
        const file = await open(join(root, item.name), constants.O_RDONLY | constants.O_NOFOLLOW);
        let body;
        try {
          const before = await file.stat();
          if (!before.isFile() || before.size > 2 * 1024 ** 2)
            throw new Error("An upstream notice exceeds its bound");
          body = Buffer.alloc(before.size + 1);
          let total = 0;
          while (total < body.length) {
            const read = await file.read(body, total, body.length - total, total);
            if (!read.bytesRead) break;
            total += read.bytesRead;
          }
          const after = await file.stat();
          if (
            total !== before.size ||
            before.size !== after.size ||
            before.mtimeMs !== after.mtimeMs
          )
            throw new Error("An upstream notice changed while copying it");
          body = body.subarray(0, total);
        } finally {
          await file.close();
        }
        bytes += body.length;
        if (bytes > 32 * 1024 ** 2)
          throw new Error("Native source notices exceed their total bound");
        const target = join(destination, logical);
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, body, { flag: "wx", mode: 0o600 });
        hashes[logical] = createHash("sha256").update(body).digest("hex");
      }
    }
  }
  for (const [name, source] of Object.entries(sources)) {
    if (!/^[a-z]+$/u.test(name)) throw new Error("The upstream notice namespace is invalid");
    await visit(source, name, 0);
  }
  return hashes;
}

export function validAnalyticsNoticePath(path) {
  const parts = path.split("/");
  return (
    parts.length >= 2 &&
    parts.length <= 34 &&
    path.length <= 4096 &&
    ["duckdb", "httpfs", "openssl", "curl"].includes(parts[0]) &&
    !/[\0\\\r\n]/u.test(path) &&
    parts.every((part) => part && part !== "." && part !== "..")
  );
}
