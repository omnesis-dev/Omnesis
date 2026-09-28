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
 * - A root that is itself a mailbox is the account's inbox, `INBOX`, and so is
 *   a top-level folder named `inbox` in any casing.
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
import { fullDiskAccessRemediation } from "@omnesis/core";
import { SyncError } from "@omnesis/types";
import type { SyncRemediation } from "@omnesis/types";

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
  /** Maildir flag letters, sorted: `F` flagged, `R` replied, `S` seen, `P` passed. Keywords are dropped. */
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
  // Only capital letters are flags. Lowercase letters are keywords a tool
  // assigned (Dovecot writes them a–z), and treating them as flags would read
  // a keyword `d` or `t` as a draft or a deletion.
  const flags = [...new Set(match[2]!.replace(/[^A-Z]/g, ""))].sort().join("");
  return { uniq: match[1]!, flags };
}

/** Whether a file is marked for deletion or is an unsent draft. */
export function isIgnoredByFlags(flags: string): boolean {
  return flags.includes("T") || flags.includes("D");
}

function decodeSegment(segment: string): string {
  return segment.startsWith(".") ? segment.slice(1).split(".").join("/") : segment;
}

/**
 * The name a mailbox is known by. The inbox is always `INBOX`, the name IMAP
 * reserves for it, however the tool spelled the folder — mbsync's usual
 * layout writes it as `Inbox` — so a question about the inbox finds it.
 */
function mailboxName(segments: readonly string[]): string {
  if (segments.length === 0) return "INBOX";
  if (segments.length === 1 && segments[0]!.toLowerCase() === "inbox") return "INBOX";
  return segments.join("/");
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

/**
 * What to do about a Maildir the collector may not read. On macOS a folder
 * under Documents, Desktop or an external volume needs a privacy grant; on
 * Linux it is the folder's own permissions.
 */
function readAccessRemediation(): SyncRemediation {
  if (process.platform === "darwin") return fullDiskAccessRemediation(process.execPath);
  return {
    summary: "The collector cannot read the Maildir",
    steps: [
      "Give the account the collector runs as permission to read the Maildir folder and every folder inside it.",
    ],
    restartRequired: false,
  };
}

/**
 * A tree past one of the walk's limits. Retrying cannot clear it; leaving
 * folders out can.
 */
export function tooLargeError(message: string): SyncError {
  return new SyncError(
    "unknown",
    `${message}; leave some folders out with the source's exclude setting`,
    {
      remediation: {
        summary: "The Maildir is larger than the source reads",
        steps: [
          "Open the source's settings and add the folders you do not need to Exclude folders — for example a folder that holds a copy of every message, such as [Gmail]/All Mail.",
        ],
        restartRequired: false,
      },
    },
  );
}

function readError(err: unknown, dir: string): SyncError {
  const code = (err as { code?: unknown } | null)?.code;
  const msg = err instanceof Error ? err.message : String(err);
  if (code === "EACCES" || code === "EPERM") {
    return new SyncError("permission", `Cannot read the Maildir at ${dir}: ${msg}`, {
      remediation: readAccessRemediation(),
    });
  }
  if (code === "ENOENT" || code === "ENOTDIR") {
    return new SyncError(
      "unknown",
      `The Maildir at ${dir} is not there: ${msg}. Check that the drive holding it is mounted, or point the source at the folder your mail tool writes to.`,
    );
  }
  return new SyncError("unknown", `Cannot read the Maildir at ${dir}: ${msg}`);
}

function listDir(dir: string): Array<{ name: string; isDir: boolean; isLink: boolean }> {
  return readdirSync(dir, { withFileTypes: true }).map((entry) => ({
    name: entry.name,
    isDir: entry.isDirectory(),
    // Symbolic links are never followed, as folders or as messages: no mail
    // tool writes one, and following one would let it lead the walk outside
    // the tree it was pointed at.
    isLink: entry.isSymbolicLink(),
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
  // `*`, `**` and `?` are wildcards; brackets are literal, because folder
  // names carry them — `[Gmail]/All Mail` means that folder, not a class.
  const excludeMatchers = exclude.map((pattern) =>
    picomatch(pattern.replace(/[[\]]/g, "\\$&"), { nocase: true }),
  );
  const isExcluded = (name: string) => excludeMatchers.some((matches) => matches(name));
  const isLeftOut = (name: string) => isSkippedFolderName(name) || isExcluded(name);

  const mailboxes: Mailbox[] = [];
  const gaps: MaildirWalk["gaps"] = [];

  const visit = (dir: string, relSegments: string[], nameSegments: string[], depth: number) => {
    let entries: ReturnType<typeof listDir>;
    try {
      entries = listDir(dir);
    } catch (err) {
      if (depth === 0) throw readError(err, dir);
      // A subfolder that will not list may be a mailbox or may hold some.
      // Either way its mail is missing from this walk — unless it is one the
      // source would leave out anyway.
      if (!isLeftOut(mailboxName(nameSegments))) {
        gaps.push({ mailboxId: relSegments.join("/"), reason: String((err as Error).message) });
      }
      return;
    }
    const names = new Set(entries.filter((e) => e.isDir).map((e) => e.name));
    if (isMailboxDir(names)) {
      const name = mailboxName(nameSegments);
      if (!isLeftOut(name)) {
        if (mailboxes.length >= limits.maxMailboxes) {
          throw tooLargeError(
            `The Maildir at ${root} holds more than ${limits.maxMailboxes} folders`,
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
        // rest belong to other tools. One that will not list could be either,
        // so it is a gap unless its name is one the source leaves out: taking
        // it for another tool's folder would read its mail as deleted.
        let childNames: Set<string>;
        try {
          childNames = new Set(
            listDir(child)
              .filter((e) => e.isDir)
              .map((e) => e.name),
          );
        } catch (err) {
          const name = mailboxName([...nameSegments, decodeSegment(entry.name)]);
          if (!isLeftOut(name)) {
            gaps.push({
              mailboxId: [...relSegments, entry.name].join("/"),
              reason: String((err as Error).message),
            });
          }
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
        if (entry.name.startsWith(".") || entry.isDir || entry.isLink) continue;
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
        throw tooLargeError(`The Maildir at ${root} holds more than ${limits.maxFiles} messages`);
      }
    }
  }
  return { mailboxes, files, gaps };
}
