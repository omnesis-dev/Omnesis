// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash, randomBytes } from "node:crypto";
import { RelayError } from "./tunnels.js";

export const CONNECT_PAGE_PATH = "/_relay/connect";
/** RFC 4648 base32: no 0, 1, 8 or 9 to mistake for letters when a code is read off another screen. */
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export interface ConnectLaunch {
  location: string;
  cookie: string;
}
interface Entry {
  expiresAt: number;
  launch(cookieHeader: string): ConnectLaunch;
}
const digest = (code: string) => createHash("sha256").update(code).digest("hex");

/**
 * Short codes for machines that cannot open a browser. A code is 40 bits and lives five minutes,
 * so the attempt cap below leaves a guesser nowhere near a live code. A code stays usable until it
 * expires, which is when its operation does: the operation decides on every use whether it can still
 * be launched, and refuses once somebody has signed in or the operation is gone.
 */
export class ConnectCodes {
  private readonly entries = new Map<string, Entry>();
  private window = -1;
  private attempts = 0;
  private readonly maxCodes: number;
  private readonly maxAttemptsPerMinute: number;
  private readonly random: () => Buffer;
  constructor(
    options: { maxCodes?: number; maxAttemptsPerMinute?: number; random?: () => Buffer } = {},
  ) {
    this.maxCodes = options.maxCodes ?? 1024;
    this.maxAttemptsPerMinute = options.maxAttemptsPerMinute ?? 30;
    this.random = options.random ?? (() => randomBytes(5));
  }

  issue(expiresAt: number, launch: Entry["launch"]): string {
    this.prune();
    if (this.entries.size >= this.maxCodes) throw new RelayError(429, "Too many connect codes");
    let code: string;
    do code = this.generate();
    while (this.entries.has(digest(code)));
    this.entries.set(digest(code), { expiresAt, launch });
    return `${code.slice(0, 4)}-${code.slice(4)}`;
  }

  claim(input: string, cookieHeader: string): ConnectLaunch {
    const minute = Math.floor(Date.now() / 60_000);
    if (minute !== this.window) {
      this.window = minute;
      this.attempts = 0;
    }
    if (this.attempts >= this.maxAttemptsPerMinute)
      throw new RelayError(429, "Too many connect attempts");
    this.attempts++;
    this.prune();
    const key = digest(input.toUpperCase().replace(/[\s-]/g, "")),
      entry = this.entries.get(key);
    if (!entry) throw new RelayError(404, "Connect code is not valid");
    return entry.launch(cookieHeader);
  }

  private generate(): string {
    const bits = this.random().readUIntBE(0, 5);
    return Array.from(
      { length: 8 },
      (_, index) => ALPHABET[Math.floor(bits / 32 ** index) % 32],
    ).join("");
  }
  private prune(): void {
    const now = Math.floor(Date.now() / 1000);
    for (const [key, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(key);
  }
}
