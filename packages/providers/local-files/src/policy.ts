// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Index policy for the Local Files source: what gets indexed and what must
 * never be. Both axes are allow-lists — a small set of file types plus
 * operator-chosen roots — with a deny-list as the second line of defence
 * inside them. A deny-list over a home directory is a losing game; the
 * allow-list is what keeps a hostile tree out of the corpus.
 */

/** Extension (lowercase, no dot) → canonical MIME type the pipeline can extract. */
export const ALLOWED_EXTENSIONS: Record<string, string> = {
  // Plain text: read directly, never sent through the extraction pipeline.
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  // Everything else routes through the shared attachment-extraction pipeline
  // (`CreateOptions.extractAttachment`) — the first local source to do so.
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  doc: "application/msword",
  xls: "application/vnd.ms-excel",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
  rtf: "application/rtf",
  html: "text/html",
  eml: "message/rfc822",
  ics: "text/calendar",
  pkpass: "application/vnd.apple.pkpass",
};

/** Extensions read as UTF-8 directly instead of via the extraction pipeline. */
export const DIRECT_TEXT_EXTENSIONS = new Set(["txt", "md", "markdown", "csv", "json"]);

/**
 * Images are deliberately out of scope for the first cut. Screenshots are the
 * highest-value-per-byte content on most disks, but they need a
 * path-and-dimension-gated carve-out (not a blanket image allow-list) so
 * photo libraries don't flood the corpus — that ships separately.
 */
const DEFERRED_IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif",
  "tiff",
  "bmp",
  "heic",
  "heif",
]);

/** Archives and disk images: a recursion hazard, never indexed. */
const ARCHIVE_EXTENSIONS = new Set([
  "zip",
  "dmg",
  "pkg",
  "iso",
  "vmdk",
  "tar",
  "gz",
  "rar",
  "7z",
  "exe",
  "app",
]);

/** Media: transcription cost unbounded, revisit later. */
const MEDIA_EXTENSIONS = new Set(["mp4", "mov", "mp3", "wav", "m4a", "flac", "ogg", "avi", "mkv"]);

/** Directory names refused anywhere in the tree, case-insensitive. */
const REFUSED_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "__pycache__",
  ".venv",
  "venv",
  ".tox",
  "build",
  "dist",
  "target",
  "pods",
  // Never index under a platform config dir even if a root points at one —
  // this is where Omnesis's own keyring and token files live.
  ".config",
  "library",
  ".ssh",
  ".aws",
  ".gnupg",
]);

/**
 * Basenames refused before a file is ever read — indexing one puts a secret
 * into a search index, an embedding, and potentially a model prompt. Err on
 * the side of annoyance. Case-insensitive.
 */
const SECRET_BASENAMES = new Set([
  ".env",
  "id_rsa",
  "id_ed25519",
  "id_ecdsa",
  "credentials",
  "keychain",
]);

const SECRET_PREFIXES = [".env.", "id_rsa.", "id_ed25519.", "id_ecdsa."];
const SECRET_SUFFIXES = [".pem", ".key", ".p12", ".pfx", ".kdbx", ".keychain", ".wallet"];

const SECRET_DIR_NAMES = new Set([".ssh", ".aws", ".gnupg"]);

/**
 * Subtree markers: when a directory contains one of these entries the whole
 * subtree is pruned, not just the marker itself. `.git` matches as a file or
 * a directory — a linked worktree or submodule carries a `.git` *file*
 * (`gitdir: …`), a normal clone a `.git` directory — so both prune. Names
 * match exactly: git and Obsidian always create these lowercase.
 */
const SUBTREE_PRUNE_MARKERS: Record<string, "git-repo" | "obsidian-vault"> = {
  ".git": "git-repo",
  ".obsidian": "obsidian-vault",
};

/**
 * Reason to prune a directory's whole subtree, or null to descend normally.
 * A git working tree is code, not documents; an Obsidian vault belongs to
 * the Obsidian source — indexing either here double-counts the corpus.
 */
export function subtreePruneReason(entryNames: readonly string[]): string | null {
  let vault: string | null = null;
  for (const name of entryNames) {
    const reason = SUBTREE_PRUNE_MARKERS[name];
    if (reason === "git-repo") return reason;
    if (reason === "obsidian-vault") vault = reason;
  }
  return vault;
}

/** Hard ceilings for a hostile tree (cf. the agent-session harness). */
export const MAX_INDEXED_FILES = 25_000;
export const MAX_SCAN_ENTRIES = 250_000;
export const MAX_SCAN_DEPTH = 32;
/** Direct text reads are capped hard; binaries go through the pipeline caps. */
export const MAX_DIRECT_TEXT_BYTES = 1_000_000;
/** Files at or below this size carry no signal. */
export const MIN_FILE_BYTES = 1;

/** Outcome of classifying one directory entry. */
export type EntryVerdict =
  | { kind: "index"; mimeType: string; via: "text" | "extract" }
  | { kind: "skip"; reason: string };

function extensionOf(basename: string): string {
  const dot = basename.lastIndexOf(".");
  return dot > 0 ? basename.slice(dot + 1).toLowerCase() : "";
}

function isSecretFile(basename: string): boolean {
  const lower = basename.toLowerCase();
  if (SECRET_BASENAMES.has(lower)) return true;
  if (SECRET_PREFIXES.some((p) => lower.startsWith(p))) return true;
  if (SECRET_SUFFIXES.some((s) => lower.endsWith(s))) return true;
  return false;
}

/** True when a name is what macOS leaves behind for an evicted iCloud file. */
export function isIcloudPlaceholder(basename: string): boolean {
  return basename.startsWith(".") && basename.toLowerCase().endsWith(".icloud");
}

/**
 * The name the file has when its bytes are local again.
 *
 * macOS hides an evicted file and re-suffixes it, so the placeholder and the
 * file are two names for one thing. Everything this source stores is keyed on
 * the second one, which is what makes the mapping load-bearing rather than
 * cosmetic: without it an eviction reads as a deletion.
 */
export function icloudPlaceholderTarget(basename: string): string {
  return basename.slice(1, -".icloud".length);
}

/** True when any path segment of a root-relative path is refused. */
export function isRefusedPath(relativePath: string): boolean {
  const segments = relativePath.split("/");
  for (const segment of segments) {
    const lower = segment.toLowerCase();
    if (segment.startsWith(".")) return true;
    if (REFUSED_DIR_NAMES.has(lower)) return true;
    if (SECRET_DIR_NAMES.has(lower)) return true;
    // macOS application bundles are directories that look like files.
    if (lower.endsWith(".app")) return true;
  }
  const base = segments[segments.length - 1]!;
  return isSecretFile(base);
}

export function classifyFile(basename: string): EntryVerdict {
  // Secrets first: a secret dotfile is a secret, not merely a dotfile.
  if (isSecretFile(basename)) return { kind: "skip", reason: "secret" };
  // iCloud-evicted placeholders before the dotfile rule, because macOS names
  // one by hiding it: `report.pdf` evicted becomes `.report.pdf.icloud`, so
  // every placeholder is also a dotfile and the ordering decides which of the
  // two things it is reported as. Reading one triggers a download; the caller
  // records it as present-but-unread and never opens it.
  if (isIcloudPlaceholder(basename)) return { kind: "skip", reason: "icloud-placeholder" };
  if (basename.startsWith(".")) return { kind: "skip", reason: "dotfile" };
  const ext = extensionOf(basename);
  if (!ext) return { kind: "skip", reason: "no-extension" };
  if (DEFERRED_IMAGE_EXTENSIONS.has(ext)) return { kind: "skip", reason: "image-deferred" };
  if (ARCHIVE_EXTENSIONS.has(ext)) return { kind: "skip", reason: "archive" };
  if (MEDIA_EXTENSIONS.has(ext)) return { kind: "skip", reason: "media" };
  const mimeType = Object.hasOwn(ALLOWED_EXTENSIONS, ext) ? ALLOWED_EXTENSIONS[ext]! : undefined;
  if (!mimeType) return { kind: "skip", reason: "type-excluded" };
  return {
    kind: "index",
    mimeType,
    via: DIRECT_TEXT_EXTENSIONS.has(ext) ? "text" : "extract",
  };
}
