// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export class FileLedgerStore {
  constructor(directory) {
    this.path = join(directory, "ledger.json");
  }

  async read({ required = true } = {}) {
    try {
      return JSON.parse(await readFile(this.path, "utf8"));
    } catch (error) {
      if (!required && error.code === "ENOENT") return null;
      throw error;
    }
  }

  async write(ledger, expectedFrontier = null) {
    const current = await this.read({ required: false });
    if (expectedFrontier != null && current?.frontier.scannedHeadSha !== expectedFrontier) {
      throw new Error("stale ledger compare-and-swap");
    }
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.path);
  }
}
