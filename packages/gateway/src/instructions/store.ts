// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `OMNESIS.md` — the operator's standing instructions to their own agent.
 *
 * One optional Markdown file at `<configDir>/OMNESIS.md`. When it exists, its
 * contents are injected into the system prompt of every reasoning agent run:
 * the interactive agent, its sub-agents, the deep-research specialists, the
 * background Cognition Steward and its brief talk-back threads. It is absent on
 * a fresh install and stays absent until someone writes it — no scaffolding, no
 * default content, and no behaviour change while it does not exist.
 *
 * Two editors, one file. The operator opens it in a terminal editor, or in the
 * portal's Settings → OMNESIS.md tab; the file on disk is the only state, so
 * neither editor can hold a stale private copy. That is also why reads are
 * cached on mtime+size rather than held in memory behind a filesystem watcher:
 * every prompt build re-reads (cheaply), a hand-edit is picked up on the next
 * run with no restart, and there is no watcher lifecycle to get wrong. This
 * mirrors `SweepFileStore`, the other operator-authored Markdown in the config
 * directory.
 *
 * Reads are synchronous because the background agent's prompt seam is
 * `systemPrompt: () => string` — a promise there would reshape the whole
 * run driver for a file that is at most a few kilobytes.
 */

import { readFileSync, rmSync, statSync, type Stats } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileSync, createLogger, OPERATOR_INSTRUCTIONS_FILENAME } from "@omnesis/core";

const log = createLogger("gateway:instructions");

/** File name in the config directory. */
export { OPERATOR_INSTRUCTIONS_FILENAME };

/**
 * Byte cap on what reaches a prompt — UTF-8 bytes, not JS string length,
 * because the cap exists to bound prompt size and multi-byte prose would
 * otherwise sneak past it.
 *
 * Twice the background agent's notes cap. The two are the durable text injected
 * into every one of its runs, so they share a budget: the agent curates its own
 * half down, and the operator gets the larger half because nothing compacts
 * theirs for them.
 *
 * The portal refuses to save past this. A file written outside the portal
 * cannot be refused — it already exists — so it is truncated with a marker the
 * model can see, rather than silently trimmed or silently dropped.
 */
export const MAX_OPERATOR_INSTRUCTIONS_BYTES = 16_384;

/**
 * Refuse to read a file larger than this at all. The read happens on the
 * gateway's main thread with synchronous fs on every prompt build, so a
 * pathological file (a stray log redirect into the config dir) must not be
 * pulled into memory just to throw most of it away.
 */
const MAX_READ_BYTES = MAX_OPERATOR_INSTRUCTIONS_BYTES * 16;

/** Appended to a truncated body so the model is told what it is not seeing. */
export const TRUNCATION_MARKER = `\n\n[OMNESIS.md is longer than ${MAX_OPERATOR_INSTRUCTIONS_BYTES} bytes and was cut off here; the rest was not included.]`;

/**
 * Why a file that exists could not be loaded. `null` is the ordinary case.
 *
 * Stated as its own field so a client never has to infer it from the shape of
 * the other three — an empty `content` on an existing file means something
 * quite different depending on which of these it is, and an editor that opened
 * on the wrong reading would save an empty document over a real file.
 */
export type OperatorInstructionsProblem =
  /** Far past the cap; deliberately not read, so nothing reaches a prompt. */
  | "too-large"
  /** Present but unreadable — wrong permissions, or an unresolvable symlink. */
  | "unreadable";

/** What the file currently holds. `exists: false` is the normal fresh state. */
export interface OperatorInstructions {
  exists: boolean;
  /** Full contents as written, un-truncated. Empty when absent or unloadable. */
  content: string;
  /** UTF-8 byte length on disk — of `content` when it was loaded, of the file when not. */
  bytes: number;
  /** File mtime in epoch ms, or null when absent. The concurrency token. */
  updatedAt: number | null;
  /** True when `bytes` exceeds the cap, so what reaches a prompt is cut short. */
  truncated: boolean;
  /** Set when the file exists but its contents are not in `content`. */
  problem: OperatorInstructionsProblem | null;
}

/**
 * The version a write or delete believes it is building on.
 *
 * Omitting `expectedUpdatedAt` entirely skips the check — for a caller with no
 * prior read to be stale about. Passing `null` is a positive claim that there
 * was NO file, which is what makes creating one safe: an editor that opened on
 * an empty tab and a terminal that wrote the file in the meantime would
 * otherwise race, and the portal's blind create would win. That race is the
 * likeliest one this feature has, because the page itself invites the operator
 * to go and use their own editor.
 */
export interface ExpectedVersion {
  expectedUpdatedAt?: number | null;
}

/**
 * Thrown when a write or delete names an `expectedUpdatedAt` that no longer
 * matches the file. Surfaces as a 409 so the portal can say the file changed
 * underneath the open editor instead of overwriting the other edit.
 */
export class OperatorInstructionsConflictError extends Error {
  override readonly name = "OperatorInstructionsConflictError";
  constructor(
    readonly expectedUpdatedAt: number | null,
    readonly actualUpdatedAt: number | null,
  ) {
    super("OMNESIS.md changed on disk since it was read");
  }
}

/**
 * Thrown when something other than a regular file sits at the path — a
 * directory, most plausibly a mistyped redirect. Caught before the write so
 * the operator gets a sentence about their config dir instead of a raw
 * `EISDIR` rendered as a 500.
 */
export class OperatorInstructionsNotAFileError extends Error {
  override readonly name = "OperatorInstructionsNotAFileError";
  constructor(readonly path: string) {
    super(`${path} is not a regular file — move or remove it before writing OMNESIS.md`);
  }
}

/** Thrown when a write exceeds the byte cap. Surfaces as a 400. */
export class OperatorInstructionsTooLargeError extends Error {
  override readonly name = "OperatorInstructionsTooLargeError";
  constructor(readonly bytes: number) {
    super(
      `OMNESIS.md write of ${bytes} bytes is ${bytes - MAX_OPERATOR_INSTRUCTIONS_BYTES} over the ${MAX_OPERATOR_INSTRUCTIONS_BYTES}-byte cap`,
    );
  }
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  value: OperatorInstructions;
}

const ABSENT: OperatorInstructions = {
  exists: false,
  content: "",
  bytes: 0,
  updatedAt: null,
  truncated: false,
  problem: null,
};

export class OperatorInstructionsStore {
  private readonly file: string;
  private cache: CacheEntry | null = null;

  constructor(configDir: string) {
    this.file = join(configDir, OPERATOR_INSTRUCTIONS_FILENAME);
  }

  /** Absolute path — surfaced so the operator can go and edit it directly. */
  get path(): string {
    return this.file;
  }

  /** Current contents. A missing file is the normal state, not an error. */
  read(): OperatorInstructions {
    let stat;
    try {
      stat = statSync(this.file);
    } catch {
      this.cache = null;
      return ABSENT;
    }
    if (!stat.isFile()) {
      this.cache = null;
      return ABSENT;
    }
    const hit = this.cache;
    if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.value;

    if (stat.size > MAX_READ_BYTES) {
      log.warn(
        `${this.file} is ${stat.size} bytes — far past the ${MAX_OPERATOR_INSTRUCTIONS_BYTES}-byte cap; ignoring it entirely`,
      );
      return this.remember(stat, {
        exists: true,
        content: "",
        bytes: stat.size,
        updatedAt: stat.mtimeMs,
        truncated: true,
        problem: "too-large",
      });
    }

    let content: string;
    try {
      content = readFileSync(this.file, "utf8");
    } catch (err) {
      log.warn(`Could not read ${this.file}: ${err instanceof Error ? err.message : String(err)}`);
      // Cached like any other reading, so an unreadable file warns once per
      // change rather than on every prompt build — and is reported as the
      // problem it is, not as an absent file the operator never wrote.
      return this.remember(stat, {
        exists: true,
        content: "",
        bytes: stat.size,
        updatedAt: stat.mtimeMs,
        truncated: false,
        problem: "unreadable",
      });
    }
    const bytes = Buffer.byteLength(content, "utf8");
    const truncated = bytes > MAX_OPERATOR_INSTRUCTIONS_BYTES;
    // Logged here rather than in `promptText` so the operator gets one warning
    // per edit of an oversize file, not one per agent run.
    if (truncated) {
      log.warn(
        `${this.file} is ${bytes} bytes; only the first ${MAX_OPERATOR_INSTRUCTIONS_BYTES} reach the agent`,
      );
    }
    return this.remember(stat, {
      exists: true,
      content,
      bytes,
      updatedAt: stat.mtimeMs,
      truncated,
      problem: null,
    });
  }

  private remember(stat: Stats, value: OperatorInstructions): OperatorInstructions {
    this.cache = { mtimeMs: stat.mtimeMs, size: stat.size, value };
    return value;
  }

  /**
   * What a prompt builder should inject: the contents, trimmed, and — when the
   * file is over the cap — cut at a character boundary with a marker saying so.
   * Empty string when the file is absent, unloadable, or only whitespace;
   * callers then render nothing at all rather than an empty section.
   */
  promptText(): string {
    const current = this.read();
    if (!current.exists || current.problem !== null) return "";
    if (current.content.trim().length === 0) return "";
    if (!current.truncated) return current.content.trim();
    return `${truncateToBytes(current.content, MAX_OPERATOR_INSTRUCTIONS_BYTES).trimEnd()}${TRUNCATION_MARKER}`;
  }

  /**
   * Replace the file. `expectedUpdatedAt` is the `updatedAt` the caller last
   * read: passing it turns a blind overwrite into a conflict when someone else
   * (a terminal editor, another portal tab) has written since.
   */
  write(content: string, opts: ExpectedVersion = {}): OperatorInstructions {
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > MAX_OPERATOR_INSTRUCTIONS_BYTES) throw new OperatorInstructionsTooLargeError(bytes);
    this.assertRegularFile();
    this.assertUnchanged(opts);
    atomicWriteFileSync(this.file, content, { mode: 0o600, ensureDir: true });
    this.cache = null;
    return this.read();
  }

  /** Delete the file. Returns false when there was nothing to delete. */
  remove(opts: ExpectedVersion = {}): boolean {
    this.assertRegularFile();
    const before = this.read();
    this.assertUnchanged(opts);
    if (!before.exists) return false;
    rmSync(this.file, { force: true });
    this.cache = null;
    return true;
  }

  /**
   * `read()` reports anything that is not a regular file as absent, which is
   * the right reading for a prompt but the wrong one for a write: writing
   * would then either fail deep in `rename` or, for `remove`, do nothing and
   * report success. Refuse up front instead.
   */
  private assertRegularFile(): void {
    try {
      if (!statSync(this.file).isFile()) throw new OperatorInstructionsNotAFileError(this.file);
    } catch (err) {
      if (err instanceof OperatorInstructionsNotAFileError) throw err;
      // Nothing at the path — the ordinary case for a first write.
    }
  }

  private assertUnchanged(opts: ExpectedVersion): void {
    if (!("expectedUpdatedAt" in opts)) return;
    const expected = opts.expectedUpdatedAt ?? null;
    const actual = this.read().updatedAt;
    if (actual !== expected) throw new OperatorInstructionsConflictError(expected, actual);
  }
}

/**
 * Cut a string to at most `maxBytes` UTF-8 bytes without splitting a character.
 * A plain buffer slice would happily halve a multi-byte sequence and leave a
 * replacement character at the seam, so walk the cut point back off any
 * continuation byte (`0b10xxxxxx`) until it lands on a character boundary.
 * Exported for the tests that prove that boundary.
 */
export function truncateToBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString("utf8");
}
