// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { computeContentHash, normalizeEmail } from "@omnesis/core";
import { parse as parseYaml } from "yaml";
import type {
  DocumentInput,
  PersonMention,
  PersonRole,
  ProviderId,
  SourceId,
} from "@omnesis/types";
import type { ParsedNote } from "./types.js";

/**
 * Parse YAML frontmatter from raw markdown content.
 * Returns null if no frontmatter block is found.
 */
export function parseFrontmatter(raw: string): Record<string, unknown> | null {
  if (!raw.startsWith("---")) return null;

  const endIndex = raw.indexOf("\n---", 3);
  if (endIndex === -1) return null;

  const yamlBlock = raw.slice(4, endIndex);
  try {
    const parsed = parseYaml(yamlBlock);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Strip frontmatter block from raw content, returning just the body.
 */
export function stripFrontmatter(raw: string): string {
  if (!raw.startsWith("---")) return raw;

  const endIndex = raw.indexOf("\n---", 3);
  if (endIndex === -1) return raw;

  // Skip past the closing --- and any trailing newline
  const bodyStart = endIndex + 4;
  return raw.slice(bodyStart).replace(/^\n/, "");
}

/**
 * Extract inline #tags from markdown content.
 * Matches #tag but not # headings and not URL fragments.
 */
export function extractInlineTags(content: string): string[] {
  const tags = new Set<string>();

  for (const line of content.split("\n")) {
    // Skip heading lines
    if (/^#{1,6}\s/.test(line)) continue;

    // Match #tag patterns: must be preceded by start of line or whitespace
    const matches = line.matchAll(/(?:^|(?<=\s))#([a-zA-Z][a-zA-Z0-9_/-]*)/g);
    for (const match of matches) {
      // Skip if this looks like it's inside a URL
      const beforeHash = line.slice(0, match.index);
      if (/https?:\/\/\S*$/.test(beforeHash)) continue;

      tags.add(match[1]);
    }
  }

  return [...tags];
}

/**
 * Version of what {@link normalizeNote} renders a note as. Raise it when a
 * change to the emitted document must reach notes that have not changed on
 * disk; the next sync re-reads and re-emits each one once.
 *
 * 2: notes declare their vault path in `extra.linkKeys`.
 */
export const OBSIDIAN_RENDER_VERSION = 2;

/**
 * Extract wikilink targets from markdown content.
 * Matches [[Target]] and [[Target|Display]], skips embeds (![[...]]).
 */
export function extractWikilinks(content: string): string[] {
  const links: string[] = [];
  const regex = /(?<!!)\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;

  let match;
  while ((match = regex.exec(content)) !== null) {
    links.push(match[1]);
  }

  return links;
}

/**
 * Merge frontmatter tags with inline tags, deduplicating.
 */
export function mergeTags(
  frontmatter: Record<string, unknown> | null,
  inlineTags: string[],
): string[] {
  const tags = new Set<string>();

  // Frontmatter tags
  if (frontmatter?.tags) {
    const fmTags = frontmatter.tags;
    if (Array.isArray(fmTags)) {
      for (const t of fmTags) {
        if (typeof t === "string") tags.add(t);
      }
    } else if (typeof fmTags === "string") {
      // Single tag as string
      tags.add(fmTags);
    }
  }

  // Inline tags
  for (const t of inlineTags) {
    tags.add(t);
  }

  return [...tags];
}

/**
 * Extract creation date from frontmatter (date, created fields) with ctime fallback.
 */
export function extractCreatedDate(
  frontmatter: Record<string, unknown> | null,
  ctime: number,
): Date {
  if (frontmatter) {
    for (const field of ["date", "created", "created_at", "createdAt"]) {
      const val = frontmatter[field];
      if (val) {
        const d = new Date(val as string | number);
        if (!isNaN(d.getTime())) return d;
      }
    }
  }
  return new Date(ctime);
}

/**
 * Map a frontmatter key to the PersonRole it implies.
 */
const FRONTMATTER_PEOPLE_KEYS: Record<string, PersonRole> = {
  author: "author",
  authors: "author",
  from: "author",
  attendees: "attendee",
  to: "recipient",
  cc: "recipient",
  people: "mentioned",
  with: "mentioned",
};

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Wikilinks that look like real person names: one or more capitalized words.
 * Skips URLs, dates, lowercase tokens, and other non-name targets.
 */
const PERSON_NAME_WIKILINK = /^[A-Z][a-zA-Z]+(\s+[A-Z][a-zA-Z]+)*$/;

function frontmatterValueToList(value: unknown): string[] {
  if (value == null) return [];
  if (Array.isArray(value)) {
    return value
      .filter((v) => typeof v === "string")
      .map((v) => (v as string).trim())
      .filter((v) => v.length > 0);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? [trimmed] : [];
  }
  return [];
}

/**
 * Extract people mentions from YAML frontmatter and body wikilinks.
 *
 * Frontmatter keys recognized: author, authors, from, attendees, to, cc,
 * people, with. Each value can be a string or list. Email-shaped values
 * become `emails: [normalized]`; everything else is treated as a name.
 *
 * Body wikilinks (`[[Name]]`) matching the capitalized-name heuristic are
 * emitted as `mentioned` people. Names that aren't actually people just
 * fail to resolve in the alias graph — no harm.
 *
 * Dedupe: a name appearing in frontmatter AND wikilink emits once with the
 * frontmatter role (author > attendee/recipient/mentioned).
 */
export function extractPeople(
  frontmatter: Record<string, unknown> | null,
  links: string[],
): PersonMention[] {
  const mentions: PersonMention[] = [];
  // Track names already emitted from frontmatter so wikilinks don't duplicate.
  const seenNames = new Set<string>();
  const seenEmails = new Set<string>();

  if (frontmatter) {
    for (const [key, role] of Object.entries(FRONTMATTER_PEOPLE_KEYS)) {
      const values = frontmatterValueToList(frontmatter[key]);
      for (const value of values) {
        if (EMAIL_SHAPE.test(value)) {
          const email = normalizeEmail(value);
          if (seenEmails.has(email)) continue;
          seenEmails.add(email);
          mentions.push({ role, emails: [email] });
        } else {
          const nameKey = value.toLowerCase();
          if (seenNames.has(nameKey)) continue;
          seenNames.add(nameKey);
          mentions.push({ role, name: value });
        }
      }
    }
  }

  for (const link of links) {
    if (!PERSON_NAME_WIKILINK.test(link)) continue;
    const nameKey = link.toLowerCase();
    if (seenNames.has(nameKey)) continue;
    seenNames.add(nameKey);
    mentions.push({ role: "mentioned", name: link });
  }

  return mentions;
}

/**
 * Normalize a parsed note into a DocumentInput.
 */
export function normalizeNote(
  note: ParsedNote,
  providerId: ProviderId,
  sourceId: SourceId,
  vaultName: string,
  vaultPath: string,
): DocumentInput {
  const createdAt = extractCreatedDate(note.frontmatter, note.ctime);
  const updatedAt = new Date(note.mtime);

  const content = note.content;
  const contentHash = computeContentHash(content);

  // Build obsidian:// deep link
  const filePathWithoutExt = note.relativePath.replace(/\.md$/, "");
  const sourceUrl = `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(filePathWithoutExt)}`;

  // Build extra metadata — include all frontmatter properties except tags (already in metadata.tags)
  const extra: Record<string, unknown> = {
    vaultPath,
    relativePath: note.relativePath,
  };

  if (note.links.length > 0) {
    extra.links = note.links;
  }

  if (note.frontmatter) {
    for (const [key, value] of Object.entries(note.frontmatter)) {
      if (key === "tags") continue;
      extra[key] = value;
    }
  }

  // The path Obsidian itself writes a link with when a bare name would be
  // ambiguous — `[[projects/roadmap]]` — so another note can reach this one by
  // it. The title alone only answers the bare form, and the external id is an
  // identity the author never types. Set after the frontmatter spread so a
  // property of the same name cannot displace it.
  extra.linkKeys = [filePathWithoutExt];

  // Obsidian vaults have no per-note authorship — single user per vault. Mark
  // every doc self-authored via isSelf primitive. Frontmatter mentions
  // (author:, people:, attendees:, etc.) and [[wikilinks]] are extracted
  // separately as additional people.
  const frontmatterPeople = extractPeople(note.frontmatter, note.links);
  const people: PersonMention[] = [{ role: "author", isSelf: true }, ...frontmatterPeople];

  return {
    providerId,
    sourceId: sourceId,
    // externalId is the stable identity, NOT the path. A
    // rename in the vault keeps the externalId so trigger history,
    // link-graph backlinks, and any user annotations survive.
    externalId: note.stableId,
    title: note.title,
    content,
    contentHash,
    metadata: {
      sourceUrl,
      documentType: "note",
      tags: note.tags.length > 0 ? note.tags : undefined,
      people,
      extra,
    },
    sourceCreatedAt: createdAt.toISOString(),
    sourceUpdatedAt: updatedAt.toISOString(),
  };
}

/**
 * Read `id` from frontmatter and validate it as a stable identity. Returns
 * the trimmed string when present and non-empty, otherwise null. Supports
 * the conventions used by the Obsidian UUID plugin and Templater
 * (`id: 0123abcd-...`, `id: 1234`, `id: my-perma-id`).
 */
export function frontmatterStableId(frontmatter: Record<string, unknown> | null): string | null {
  if (!frontmatter) return null;
  const raw = frontmatter.id ?? frontmatter.uid ?? frontmatter.uuid;
  if (raw == null) return null;
  const s = String(raw).trim();
  return s.length > 0 ? s : null;
}
