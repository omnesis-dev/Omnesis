// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import { ProviderId, SourceId } from "@omnesis/types";
import {
  parseFrontmatter,
  stripFrontmatter,
  extractInlineTags,
  extractWikilinks,
  mergeTags,
  extractCreatedDate,
  extractPeople,
  normalizeNote,
} from "./normalizer.js";
import type { ParsedNote } from "./types.js";

describe("parseFrontmatter", () => {
  test("parses valid YAML frontmatter", () => {
    const raw = `---
title: My Note
tags:
  - project
  - idea
date: 2025-01-15
---
Body content here`;
    const fm = parseFrontmatter(raw);
    expect(fm).not.toBeNull();
    expect(fm!.title).toBe("My Note");
    expect(fm!.tags).toEqual(["project", "idea"]);
    expect(fm!.date).toBe("2025-01-15");
  });

  test("returns null when no frontmatter", () => {
    const raw = "# Just a heading\n\nSome content";
    expect(parseFrontmatter(raw)).toBeNull();
  });

  test("returns null for malformed YAML", () => {
    const raw = `---
invalid: yaml: content: [
---
Body`;
    expect(parseFrontmatter(raw)).toBeNull();
  });

  test("returns null when closing --- is missing", () => {
    const raw = `---
title: Unclosed
Body content`;
    expect(parseFrontmatter(raw)).toBeNull();
  });

  test("handles empty frontmatter", () => {
    const raw = `---
---
Body content`;
    // Empty YAML parses to null
    expect(parseFrontmatter(raw)).toBeNull();
  });
});

describe("stripFrontmatter", () => {
  test("strips frontmatter block", () => {
    const raw = `---
title: Test
---
Body content here`;
    expect(stripFrontmatter(raw)).toBe("Body content here");
  });

  test("returns full content when no frontmatter", () => {
    const raw = "# Heading\n\nContent";
    expect(stripFrontmatter(raw)).toBe(raw);
  });

  test("handles content immediately after closing ---", () => {
    const raw = `---
key: value
---
First line`;
    expect(stripFrontmatter(raw)).toBe("First line");
  });
});

describe("extractInlineTags", () => {
  test("extracts simple tags", () => {
    const content = "This has #project and #idea tags";
    const tags = extractInlineTags(content);
    expect(tags).toContain("project");
    expect(tags).toContain("idea");
  });

  test("skips heading lines", () => {
    const content = "# Heading\n## Another heading\nText with #real-tag";
    const tags = extractInlineTags(content);
    expect(tags).not.toContain("Heading");
    expect(tags).not.toContain("Another");
    expect(tags).toContain("real-tag");
  });

  test("handles tags with slashes (nested tags)", () => {
    const content = "Tagged with #project/alpha";
    const tags = extractInlineTags(content);
    expect(tags).toContain("project/alpha");
  });

  test("does not extract tags from URLs", () => {
    const content = "Visit https://example.com/page#section for info";
    const tags = extractInlineTags(content);
    expect(tags).not.toContain("section");
  });

  test("deduplicates tags", () => {
    const content = "#duplicate and #duplicate again";
    const tags = extractInlineTags(content);
    expect(tags.filter((t) => t === "duplicate")).toHaveLength(1);
  });

  test("handles tag at start of line", () => {
    const content = "#standalone tag at start";
    const tags = extractInlineTags(content);
    expect(tags).toContain("standalone");
  });
});

describe("extractWikilinks", () => {
  test("extracts simple wikilinks", () => {
    const content = "See [[Project Alpha]] and [[Meeting Notes]]";
    const links = extractWikilinks(content);
    expect(links).toEqual(["Project Alpha", "Meeting Notes"]);
  });

  test("extracts aliased wikilinks (target only)", () => {
    const content = "Check [[Project Alpha|the project]]";
    const links = extractWikilinks(content);
    expect(links).toEqual(["Project Alpha"]);
  });

  test("skips embeds (![[...]])", () => {
    const content = "![[image.png]] and [[real link]]";
    const links = extractWikilinks(content);
    expect(links).toEqual(["real link"]);
  });

  test("handles path-style wikilinks", () => {
    const content = "See [[Notes/meeting/2025-01-15]]";
    const links = extractWikilinks(content);
    expect(links).toEqual(["Notes/meeting/2025-01-15"]);
  });

  test("returns empty array when no links", () => {
    expect(extractWikilinks("No links here")).toEqual([]);
  });
});

describe("mergeTags", () => {
  test("merges frontmatter and inline tags", () => {
    const fm = { tags: ["project", "idea"] };
    const inline = ["idea", "todo"];
    const merged = mergeTags(fm, inline);
    expect(merged).toContain("project");
    expect(merged).toContain("idea");
    expect(merged).toContain("todo");
    expect(merged).toHaveLength(3); // deduped
  });

  test("handles no frontmatter", () => {
    const merged = mergeTags(null, ["tag1"]);
    expect(merged).toEqual(["tag1"]);
  });

  test("handles frontmatter with single string tag", () => {
    const merged = mergeTags({ tags: "solo" }, []);
    expect(merged).toEqual(["solo"]);
  });

  test("handles no tags at all", () => {
    const merged = mergeTags(null, []);
    expect(merged).toEqual([]);
  });

  test("handles frontmatter without tags field", () => {
    const merged = mergeTags({ title: "test" }, ["inline"]);
    expect(merged).toEqual(["inline"]);
  });
});

describe("extractCreatedDate", () => {
  test("uses frontmatter date field", () => {
    const fm = { date: "2025-01-15" };
    const d = extractCreatedDate(fm, Date.now());
    expect(d.toISOString()).toContain("2025-01-15");
  });

  test("uses frontmatter created field", () => {
    const fm = { created: "2024-06-01T12:00:00Z" };
    const d = extractCreatedDate(fm, Date.now());
    expect(d.toISOString()).toBe("2024-06-01T12:00:00.000Z");
  });

  test("falls back to ctime", () => {
    const ctime = new Date("2023-03-01").getTime();
    const d = extractCreatedDate(null, ctime);
    expect(d.getTime()).toBe(ctime);
  });

  test("falls back to ctime for invalid date", () => {
    const ctime = new Date("2023-03-01").getTime();
    const d = extractCreatedDate({ date: "not-a-date" }, ctime);
    expect(d.getTime()).toBe(ctime);
  });
});

describe("normalizeNote", () => {
  const baseNote: ParsedNote = {
    relativePath: "Projects/Alpha/kickoff.md",
    title: "kickoff",
    content: "# Kickoff Meeting\n\nDiscussion about the project.",
    rawContent: "---\ntags:\n  - meeting\n---\n# Kickoff Meeting\n\nDiscussion about the project.",
    frontmatter: { tags: ["meeting"] },
    tags: ["meeting", "project"],
    links: ["Project Alpha"],
    ctime: new Date("2025-01-10").getTime(),
    mtime: new Date("2025-01-15").getTime(),
    stableId: "inode:42",
  };

  test("produces correct document fields", () => {
    const doc = normalizeNote(
      baseNote,
      ProviderId("obsidian:MyVault"),
      SourceId("obsidian-notes:MyVault"),
      "MyVault",
      "/path/to/vault",
    );
    expect(doc.title).toBe("kickoff");
    expect(doc.externalId).toBe("inode:42");
    expect(doc.providerId).toBe(ProviderId("obsidian:MyVault"));
    expect(doc.sourceId).toBe(SourceId("obsidian-notes:MyVault"));
    expect(doc.contentHash).toBeDefined();
    expect(doc.metadata.documentType).toBe("note");
  });

  test("sets correct metadata", () => {
    const doc = normalizeNote(
      baseNote,
      ProviderId("obsidian:MyVault"),
      SourceId("obsidian-notes:MyVault"),
      "MyVault",
      "/path/to/vault",
    );
    expect(doc.metadata.tags).toEqual(["meeting", "project"]);
    expect(doc.metadata.sourceUrl).toContain("obsidian://open?vault=MyVault");
    expect(doc.metadata.sourceUrl).toContain("file=Projects%2FAlpha%2Fkickoff");
    expect(doc.metadata.extra?.links).toEqual(["Project Alpha"]);
    expect(doc.metadata.extra?.vaultPath).toBe("/path/to/vault");
    expect(doc.metadata.extra?.relativePath).toBe("Projects/Alpha/kickoff.md");
  });

  test("uses frontmatter date for sourceCreatedAt", () => {
    const note = { ...baseNote, frontmatter: { date: "2024-12-01" } };
    const doc = normalizeNote(
      note,
      ProviderId("obsidian:V"),
      SourceId("obsidian-notes:V"),
      "V",
      "/v",
    );
    expect(doc.sourceCreatedAt).toContain("2024-12-01");
  });

  test("uses mtime for sourceUpdatedAt", () => {
    const doc = normalizeNote(
      baseNote,
      ProviderId("obsidian:V"),
      SourceId("obsidian-notes:V"),
      "V",
      "/v",
    );
    expect(doc.sourceUpdatedAt).toBe(new Date(baseNote.mtime).toISOString());
  });

  test("omits tags when empty", () => {
    const note = { ...baseNote, tags: [] };
    const doc = normalizeNote(
      note,
      ProviderId("obsidian:V"),
      SourceId("obsidian-notes:V"),
      "V",
      "/v",
    );
    expect(doc.metadata.tags).toBeUndefined();
  });

  test("omits links from extra when empty", () => {
    const note = { ...baseNote, links: [] };
    const doc = normalizeNote(
      note,
      ProviderId("obsidian:V"),
      SourceId("obsidian-notes:V"),
      "V",
      "/v",
    );
    expect(doc.metadata.extra?.links).toBeUndefined();
  });

  test("includes non-tags frontmatter in extra", () => {
    const note = { ...baseNote, frontmatter: { tags: ["t"], status: "draft", priority: 1 } };
    const doc = normalizeNote(
      note,
      ProviderId("obsidian:V"),
      SourceId("obsidian-notes:V"),
      "V",
      "/v",
    );
    expect(doc.metadata.extra?.status).toBe("draft");
    expect(doc.metadata.extra?.priority).toBe(1);
    // tags should not be in extra
    expect(doc.metadata.extra?.tags).toBeUndefined();
  });

  test("marks every doc self-authored via isSelf primitive", () => {
    const note: ParsedNote = {
      ...baseNote,
      frontmatter: null,
      tags: [],
      links: [],
    };
    const doc = normalizeNote(
      note,
      ProviderId("obsidian:V"),
      SourceId("obsidian-notes:V"),
      "V",
      "/v",
    );
    expect(doc.metadata.people).toEqual([{ role: "author", isSelf: true }]);
  });

  test("self mention precedes frontmatter and wikilink people", () => {
    const note: ParsedNote = {
      ...baseNote,
      frontmatter: { author: "Alice", attendees: ["Bob", "charlie@example.com"] },
      links: ["John Doe"],
    };
    const doc = normalizeNote(
      note,
      ProviderId("obsidian:V"),
      SourceId("obsidian-notes:V"),
      "V",
      "/v",
    );
    expect(doc.metadata.people).toEqual([
      { role: "author", isSelf: true },
      { role: "author", name: "Alice" },
      { role: "attendee", name: "Bob" },
      { role: "attendee", emails: ["charlie@example.com"] },
      { role: "mentioned", name: "John Doe" },
    ]);
  });
});

describe("extractPeople", () => {
  test("returns empty array for no frontmatter and no links", () => {
    expect(extractPeople(null, [])).toEqual([]);
  });

  test("extracts author from frontmatter (string value)", () => {
    const fm = { author: "Alice" };
    expect(extractPeople(fm, [])).toEqual([{ role: "author", name: "Alice" }]);
  });

  test("extracts authors from frontmatter (list value)", () => {
    const fm = { authors: ["Alice", "Bob"] };
    expect(extractPeople(fm, [])).toEqual([
      { role: "author", name: "Alice" },
      { role: "author", name: "Bob" },
    ]);
  });

  test("attendees role for attendees: key", () => {
    const fm = { attendees: ["Bob"] };
    expect(extractPeople(fm, [])).toEqual([{ role: "attendee", name: "Bob" }]);
  });

  test("recipient role for to: and cc: keys", () => {
    const fm = { to: "Alice", cc: ["Bob", "Carol"] };
    const people = extractPeople(fm, []);
    expect(people).toContainEqual({ role: "recipient", name: "Alice" });
    expect(people).toContainEqual({ role: "recipient", name: "Bob" });
    expect(people).toContainEqual({ role: "recipient", name: "Carol" });
  });

  test("mentioned role for people: and with: keys", () => {
    const fm = { people: ["Dana"], with: ["Eve"] };
    const people = extractPeople(fm, []);
    expect(people).toContainEqual({ role: "mentioned", name: "Dana" });
    expect(people).toContainEqual({ role: "mentioned", name: "Eve" });
  });

  test("author role for from: key", () => {
    const fm = { from: "Alice" };
    expect(extractPeople(fm, [])).toEqual([{ role: "author", name: "Alice" }]);
  });

  test("email-shaped values become emails (normalized)", () => {
    const fm = { attendees: ["Charlie@Example.com"] };
    expect(extractPeople(fm, [])).toEqual([{ role: "attendee", emails: ["charlie@example.com"] }]);
  });

  test("mixed names and emails in same list", () => {
    const fm = { attendees: ["Bob", "charlie@example.com"] };
    expect(extractPeople(fm, [])).toEqual([
      { role: "attendee", name: "Bob" },
      { role: "attendee", emails: ["charlie@example.com"] },
    ]);
  });

  test("extracts capitalized-name wikilinks as mentioned", () => {
    expect(extractPeople(null, ["John Doe"])).toEqual([{ role: "mentioned", name: "John Doe" }]);
  });

  test("accepts single-word capitalized names from wikilinks", () => {
    expect(extractPeople(null, ["Alice"])).toEqual([{ role: "mentioned", name: "Alice" }]);
  });

  test("skips non-name wikilinks", () => {
    const links = [
      "Project Alpha", // capitalized but a project — heuristic accepts; fallback is "doesn't resolve"
      "2025-01-15", // date — not capitalized letters
      "notes/meeting", // path — slash
      "alpha", // lowercase
      "todo list", // lowercase second word
    ];
    const people = extractPeople(null, links);
    // Project Alpha matches the heuristic (two capitalized words). The doc
    // says: names that aren't real people just don't resolve in the alias graph.
    expect(people).toEqual([{ role: "mentioned", name: "Project Alpha" }]);
  });

  test("dedupes name across frontmatter and wikilinks (frontmatter role wins)", () => {
    const fm = { author: "Alice" };
    const links = ["Alice"];
    expect(extractPeople(fm, links)).toEqual([{ role: "author", name: "Alice" }]);
  });

  test("dedupes case-insensitively", () => {
    const fm = { author: "Alice" };
    const links = ["alice"]; // wouldn't match the regex anyway
    const people = extractPeople(fm, links);
    expect(people).toEqual([{ role: "author", name: "Alice" }]);
  });

  test("dedupes the same email across multiple keys", () => {
    const fm = { to: "alice@example.com", cc: "ALICE@example.com" };
    const people = extractPeople(fm, []);
    expect(people).toEqual([{ role: "recipient", emails: ["alice@example.com"] }]);
  });

  test("handles missing/empty values gracefully", () => {
    expect(extractPeople({ author: "" }, [])).toEqual([]);
    expect(extractPeople({ author: null }, [])).toEqual([]);
    expect(extractPeople({ attendees: [] }, [])).toEqual([]);
  });

  test("ignores unknown frontmatter keys", () => {
    const fm = { reviewer: "Alice", related: ["Bob"] };
    expect(extractPeople(fm, [])).toEqual([]);
  });
});
