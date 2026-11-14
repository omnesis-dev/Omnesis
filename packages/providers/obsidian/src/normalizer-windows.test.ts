// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test, vi } from "vitest";
import { ProviderId, SourceId } from "@omnesis/types";

vi.mock("node:path", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:path")>()),
  sep: "\\",
}));

import { normalizeNote } from "./normalizer.js";

test("Windows nested notes use Obsidian's slash-based paths in links", () => {
  const document = normalizeNote(
    {
      relativePath: "Projects\\Alpha\\kickoff.md",
      title: "kickoff",
      content: "A fictional project kickoff.",
      rawContent: "A fictional project kickoff.",
      frontmatter: null,
      tags: [],
      links: [],
      ctime: Date.UTC(2026, 0, 2),
      mtime: Date.UTC(2026, 0, 2),
      stableId: "inode:42",
    },
    ProviderId("obsidian:ExampleVault"),
    SourceId("obsidian-notes:ExampleVault"),
    "ExampleVault",
    "C:\\Notes\\ExampleVault",
  );
  expect(document.externalId).toBe("inode:42");
  expect(document.metadata.extra?.relativePath).toBe("Projects/Alpha/kickoff.md");
  expect(document.metadata.extra?.linkKeys).toEqual(["Projects/Alpha/kickoff"]);
  expect(new URL(document.metadata.sourceUrl!).searchParams.get("file")).toBe(
    "Projects/Alpha/kickoff",
  );
});
