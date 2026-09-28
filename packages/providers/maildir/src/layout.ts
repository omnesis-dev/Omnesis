// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Reading the shape of a Maildir tree: which folders are mailboxes, what each
 * is called, and which message files each holds.
 *
 * A mailbox is any directory holding both `cur` and `new`. Where it sits and
 * what it is called depends on the tool that wrote it, and every tool in
 * common use is covered by two rules:
 *
 * - A root that is itself a mailbox is the account's inbox, `INBOX`.
 * - A directory name beginning with a dot is a Maildir++ folder: the dot is
 *   dropped and the dots inside it are hierarchy separators, so `.Work.Travel`
 *   is `Work/Travel`. Anything else is a folder named verbatim, nested as it
 *   is on disk (mbsync's `SubFolders Verbatim`, offlineimap's default).
 *
 * A dot-directory that is not itself a mailbox belongs to some other tool
 * (`.notmuch`, `.git`) and is not entered.
 *
 * Only directory listings happen here, never a file read. A message file is
 * never rewritten in place — a Maildir changes a message's flags by renaming
 * it — so its name is everything a walk needs to know about it.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import picomatch from "picomatch";
import { SyncError } from "@omnesis/types";

/** The deepest a mailbox may sit below the root. */
const MAX_DEPTH = 12;

/**
 * Last path segments of folders that hold no mail worth indexing: unsent
 * drafts, spam, and deleted mail. Matched case-insensitively against the
 * folder's own name, so `[Gmail]/Trash` and a top-level `Trash` are both
 * skipped. A mail server marks these with special-use flags; a Maildir keeps
 * no such flag, so the name is the only evidence there is.
 */
const SKIPPED_FOLDER_NAMES = new Set([
  "drafts",
  "draft",
  "spam",
  "junk",
  "junk e-mail",
  "junk email",
  "trash",
  "bin",
  "deleted items",
  "deleted messages",
]);

/** Last path segments of folders holding mail the account owner sent. */
const SENT_FOLDER_NAMES = new Set(["sent", "sent mail", "sent items", "sent messages"]);

interface Mailbox {
  /** Directory relative to the root (`""` for the root itself). The mailbox's identity. */
  id: string;
  /** The folder name a person knows it by, such as `INBOX` or `Work/Travel`. */
  name: string;
  /** Absolute directory holding `cur` and `new`. */
  dir: string;
  /** Whether the folder holds sent mail. */
  sent: boolean;
}

/**
 * One message file as a listing shows it. `uniq` is the part of the file name
 * the delivering tool chose once and never changes; the rest carries flags,
 * which change every time the message is read, answered or starred.
 */
interface MessageFile {
  mailboxId: string;
  uniq: string;
  /** Path relative to the mailbox directory: `cur/<name>` or `new/<name>`. */
  relPath: string;
  /** Maildir flag letters, sorted: `F` flagged, `R` replied, `S` seen, `P` passed. */
  flags: string;
}

export interface MaildirWalk {
  mailboxes: Mailbox[];
  files: MessageFile[];
  /**
   * Mailboxes whose listing could not be read. Every message under one is
   * missing from `files`, and a missing message is indistinguishable from a
   * deleted one, so a walk with gaps cannot vouch for what the tree holds.
   */
  gaps: Array<{ mailboxId: string; reason: string }>;
}

export interface WalkLimits {
  maxMailboxes: number;
  maxFiles: number;
}

/** Split a Maildir file name into the part that never changes and its flag letters. */
export function parseMessageFileName(fileName: string): { uniq: string; flags: string } {
  // The info delimiter is `:` everywhere but filesystems that forbid it,
  // where tools substitute `!` (mbsync on Windows) or `;` (Dovecot's option).
  const match = /^(.+?)[:!;]2,([A-Za-z]*)$/.exec(fileName);
  if (!match) return { uniq: fileName, flags: "" };
  const flags = [...new Set(match[2]!.toUpperCase())].sort().join("");
  return { uniq: match[1]!, flags };
}

/** Whether a file is marked for deletion or is an unsent draft. */
export function isIgnoredByFlags(flags: string): boolean {
  return flags.includes("T") || flags.includes("D");
}

function decodeSegment(segment: string): string {
  return segment.startsWith(".") ? segment.slice(1).split(".").join("/") : segment;
}

function lastSegment(name: string): string {
  return (name.split("/").at(-1) ?? name).toLowerCase();
}

export function isSkippedFolderName(name: string): boolean {
  return SKIPPED_FOLDER_NAMES.has(lastSegment(name));
}

export function isSentFolderName(name: string): boolean {
  return SENT_FOLDER_NAMES.has(lastSegment(name));
}

function isMailboxDir(names: ReadonlySet<string>): boolean {
  return names.has("cur") && names.has("new");
}

function readError(err: unknown, dir: string): SyncError {
  const code = (err as { code?: unknown } | null)?.code;
  const msg = err instanceof Error ? err.message : String(err);
  if (code === "EACCES" || code === "EPERM") {
    return new SyncError(
      "permission",
      `Cannot read the Maildir at ${dir}: ${msg}. Grant the collector read access to this folder.`,
    );
  }
  if (code === "ENOENT" || code === "ENOTDIR") {
    return new SyncError(
      "unknown",
      `The Maildir at ${dir} is not there: ${msg}. Check that the drive holding it is mounted, or point the source at the folder your mail tool writes to.`,
    );
  }
  return new SyncError("unknown", `Cannot read the Maildir at ${dir}: ${msg}`);
}

function listDir(dir: string): Array<{ name: string; isDir: boolean; isFile: boolean }> {
  return readdirSync(dir, { withFileTypes: true }).map((entry) => ({
    name: entry.name,
    // Symbolic links are neither: no mail tool writes one, and following them
    // would let a link lead the walk outside the tree it was pointed at.
    isDir: entry.isDirectory(),
    isFile: entry.isFile(),
  }));
}

/**
 * Find every mailbox under `root` and list its message files.
 *
 * The root must read, and must hold at least one mailbox: a root that has
 * gone missing, or an empty directory where a drive used to be mounted, is
 * reported as an error rather than returned as an empty walk, because an
 * empty walk says every message was deleted.
 */
export function walkMaildir(
  root: string,
  exclude: readonly string[],
  limits: WalkLimits,
): MaildirWalk {
  const excludeMatchers = exclude.map((pattern) => picomatch(pattern, { nocase: true }));
  const isExcluded = (name: string) => excludeMatchers.some((matches) => matches(name));

  const mailboxes: Mailbox[] = [];
  const gaps: MaildirWalk["gaps"] = [];

  const visit = (dir: string, relSegments: string[], nameSegments: string[], depth: number) => {
    let entries: ReturnType<typeof listDir>;
    try {
      entries = listDir(dir);
    } catch (err) {
      if (depth === 0) throw readError(err, dir);
      // A subfolder that will not list may be a mailbox or may hold some.
      // Either way its mail is missing from this walk.
      gaps.push({ mailboxId: relSegments.join("/"), reason: String((err as Error).message) });
      return;
    }
    const names = new Set(entries.filter((e) => e.isDir).map((e) => e.name));
    if (isMailboxDir(names)) {
      const name = nameSegments.length === 0 ? "INBOX" : nameSegments.join("/");
      if (!isSkippedFolderName(name) && !isExcluded(name)) {
        if (mailboxes.length >= limits.maxMailboxes) {
          throw new SyncError(
            "unknown",
            `The Maildir at ${root} holds more than ${limits.maxMailboxes} folders; use the source's exclude setting to leave some out`,
          );
        }
        mailboxes.push({ id: relSegments.join("/"), name, dir, sent: isSentFolderName(name) });
      }
    }
    if (depth >= MAX_DEPTH) return;
    for (const entry of entries) {
      if (!entry.isDir) continue;
      if (entry.name === "cur" || entry.name === "new" || entry.name === "tmp") continue;
      const child = join(dir, entry.name);
      if (entry.name.startsWith(".")) {
        // A dot-folder is entered only when it is a Maildir++ mailbox; the
        // rest belong to other tools.
        let childNames: Set<string>;
        try {
          childNames = new Set(
            listDir(child)
              .filter((e) => e.isDir)
              .map((e) => e.name),
          );
        } catch {
          continue;
        }
        if (!isMailboxDir(childNames)) continue;
      }
      visit(
        child,
        [...relSegments, entry.name],
        [...nameSegments, decodeSegment(entry.name)],
        depth + 1,
      );
    }
  };
  visit(root, [], [], 0);

  if (mailboxes.length === 0 && gaps.length === 0) {
    throw new SyncError(
      "unknown",
      `No mail folders found under ${root}. Point the source at the folder your mail tool writes to: it, or a folder inside it, holds cur and new directories.`,
    );
  }

  const files: MessageFile[] = [];
  for (const mailbox of mailboxes) {
    const byUniq = new Map<string, MessageFile>();
    let unreadable: string | undefined;
    // `new` first, so a message caught mid-move to `cur` resolves to `cur`.
    for (const sub of ["new", "cur"] as const) {
      let entries: ReturnType<typeof listDir>;
      try {
        entries = listDir(join(mailbox.dir, sub));
      } catch (err) {
        unreadable = String((err as Error).message);
        break;
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".") || entry.isDir) continue;
        const { uniq, flags } = parseMessageFileName(entry.name);
        const file: MessageFile = {
          mailboxId: mailbox.id,
          uniq,
          relPath: `${sub}/${entry.name}`,
          flags: sub === "new" ? "" : flags,
        };
        byUniq.set(uniq, file);
      }
    }
    if (unreadable !== undefined) {
      gaps.push({ mailboxId: mailbox.id, reason: unreadable });
      continue;
    }
    for (const file of byUniq.values()) {
      if (isIgnoredByFlags(file.flags)) continue;
      files.push(file);
      if (files.length > limits.maxFiles) {
        throw new SyncError(
          "unknown",
          `The Maildir at ${root} holds more than ${limits.maxFiles} messages; use the source's exclude setting to leave some folders out`,
        );
      }
    }
  }
  return { mailboxes, files, gaps };
}
