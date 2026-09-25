// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  isStateEnvelope,
  withVersionedState,
  type SourceInstance,
  type StateOutcome,
} from "@omnesis/source-sdk";
import { SourceId, ProviderId, SyncError } from "@omnesis/types";
import { obsidianStateSpec } from "./state.js";
import definition from "./index.js";

// chmod 0o000 only denies a read for a non-root process; a build running as
// root (some CI/container setups) would read straight through it.
const canDenyReads = (process.getuid?.() ?? 0) !== 0;

function createVault(tmpDir: string): string {
  const vaultPath = join(tmpDir, "TestVault");
  mkdirSync(vaultPath, { recursive: true });
  mkdirSync(join(vaultPath, ".obsidian"), { recursive: true });
  return vaultPath;
}

function writeNote(vaultPath: string, relativePath: string, content: string, mtime?: Date): void {
  const fullPath = join(vaultPath, relativePath);
  const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(fullPath, content);
  if (mtime) {
    utimesSync(fullPath, mtime, mtime);
  }
}

describe("ObsidianNotesSource", () => {
  let tmpDir: string;
  let vaultPath: string;
  let instance: SourceInstance;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "obsidian-test-"));
    vaultPath = createVault(tmpDir);
    instance = await definition.create!({
      accountId: "TestVault",
      sourceId: SourceId("obsidian-notes:TestVault"),
      providerId: ProviderId("obsidian:TestVault"),
      config: { vaultPath, exclude: [] },
    });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("resolves same-named vaults to distinct ids and retains an existing vault id", async () => {
    const other = createVault(join(tmpDir, "other"));
    const first = await definition.resolveAccountId!({ vaultPath }, []);
    const second = await definition.resolveAccountId!({ vaultPath: other }, []);
    expect(first).not.toBe(second);
    expect(
      await definition.resolveAccountId!({ vaultPath }, [
        { accountId: "TestVault", params: { vaultPath } },
      ]),
    ).toBe("TestVault");
    expect(
      await definition.resolveAccountId!({ vaultPath: other }, [
        { accountId: "TestVault", params: { vaultPath } },
      ]),
    ).toBe(second);
  });

  test("resolved id is valid for long vault names with spaces", async () => {
    const named = join(tmpDir, "A vault " + "x".repeat(130));
    mkdirSync(named, { recursive: true });
    const id = await definition.resolveAccountId!({ vaultPath: named }, []);
    expect(id).toMatch(/^A-vault-x+-[a-f0-9]{32}$/);
    expect(id.length).toBeLessThan(256);
  });

  test("relative and absolute spellings reuse the same vault identity", async () => {
    const relativePath = relative(process.cwd(), vaultPath);
    const id = await definition.resolveAccountId!({ vaultPath: relativePath }, []);
    expect(
      await definition.resolveAccountId!({ vaultPath }, [
        { accountId: id, params: { vaultPath: relativePath } },
      ]),
    ).toBe(id);
  });

  test("watchPaths includes vault path and limits recursive events to Markdown", () => {
    expect(instance.watchPaths).toHaveLength(1);
    expect(instance.watchPaths![0]).toBe(vaultPath);
    expect(instance.watchDirectoryPaths).toEqual([vaultPath]);
    expect(instance.watchFileExtensions).toEqual([".md"]);
  });

  test("returns empty result for empty vault", async () => {
    const result = await instance.sync(null);
    expect(result.documents).toHaveLength(0);
    expect(result.deletedExternalIds).toHaveLength(0);
    expect(result.hasMore).toBe(false);
  });

  test("skips symlinks and hard links to files outside the selected vault", async () => {
    const outsideFile = join(tmpDir, "outside.md");
    const outsideDir = join(tmpDir, "outside-notes");
    writeFileSync(outsideFile, "Outside private note");
    mkdirSync(outsideDir);
    writeFileSync(join(outsideDir, "nested.md"), "Outside nested note");
    symlinkSync(outsideFile, join(vaultPath, "linked-file.md"));
    linkSync(outsideFile, join(vaultPath, "hard-linked-file.md"));
    symlinkSync(outsideDir, join(vaultPath, "linked-directory"));

    const result = await instance.sync(null);

    expect(result.documents).toEqual([]);
  });

  test("bootstrap: reads all .md files", async () => {
    writeNote(vaultPath, "note1.md", "# Note 1\n\nContent one");
    writeNote(vaultPath, "note2.md", "# Note 2\n\nContent two");
    writeNote(vaultPath, "subfolder/note3.md", "# Note 3\n\nContent three");

    const result = await instance.sync(null);
    expect(result.documents).toHaveLength(3);
    expect(result.hasMore).toBe(false);

    // Identity is now stableId (inode-shaped fallback when no
    // frontmatter.id is set), not the path. Verify the path via
    // metadata.extra.relativePath instead.
    const paths = result.documents.map((d) => d.metadata.extra!.relativePath as string).sort();
    expect(paths).toEqual(["note1.md", "note2.md", "subfolder/note3.md"]);
    for (const d of result.documents) {
      expect(d.externalId).toMatch(/^inode:\d+$/);
    }
  });

  test("bootstrap: produces correct document fields", async () => {
    writeNote(
      vaultPath,
      "Projects/alpha.md",
      "---\ntags:\n  - project\ndate: 2025-01-15\n---\n# Alpha Project\n\nSome content with #idea tag\n\nSee [[Beta Project]]",
    );

    const result = await instance.sync(null);
    expect(result.documents).toHaveLength(1);

    const doc = result.documents[0];
    expect(doc.title).toBe("alpha");
    expect(doc.externalId).toMatch(/^inode:\d+$/);
    expect(doc.metadata.extra!.relativePath).toBe("Projects/alpha.md");
    expect(doc.metadata.documentType).toBe("note");
    expect(doc.metadata.tags).toContain("project");
    expect(doc.metadata.tags).toContain("idea");
    expect(doc.metadata.sourceUrl).toContain("obsidian://open");
    expect(doc.metadata.extra?.links).toEqual(["Beta Project"]);
    expect(doc.sourceCreatedAt).toContain("2025-01-15");
  });

  test("skips .obsidian directory", async () => {
    writeNote(vaultPath, "real-note.md", "Content");
    writeNote(vaultPath, ".obsidian/workspace.md", "Not a note");

    const result = await instance.sync(null);
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].metadata.extra!.relativePath).toBe("real-note.md");
  });

  test("skips .trash directory", async () => {
    writeNote(vaultPath, "real-note.md", "Content");
    writeNote(vaultPath, ".trash/deleted.md", "Deleted note");

    const result = await instance.sync(null);
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].metadata.extra!.relativePath).toBe("real-note.md");
  });

  test("a note in a folder declares its vault path as a link key", async () => {
    // `[[projects/roadmap]]` is how Obsidian links a note whose bare name is
    // ambiguous. The external id is an inode and the title is `roadmap`, so
    // without the path declared nothing in the corpus answers to that link.
    writeNote(vaultPath, "projects/roadmap.md", "# Roadmap");

    const result = await instance.sync(null);

    expect(result.documents[0]!.metadata.extra?.linkKeys).toEqual(["projects/roadmap"]);
  });

  test("a frontmatter property of the same name cannot displace the declared path", async () => {
    // Frontmatter is spread into `extra`; a note that happens to carry a
    // `linkKeys` property must not become reachable by names it never had.
    writeNote(vaultPath, "projects/roadmap.md", "---\nlinkKeys: [somewhere-else]\n---\n# Roadmap");

    const result = await instance.sync(null);

    expect(result.documents[0]!.metadata.extra?.linkKeys).toEqual(["projects/roadmap"]);
  });

  test("a note emitted under an older render is re-emitted once, then left alone", async () => {
    // A vault indexed before notes declared their path would otherwise keep
    // its old documents until each note happened to be edited — which for
    // most notes is never — and their folder links would stay unresolved.
    writeNote(vaultPath, "projects/roadmap.md", "# Roadmap");
    const first = await instance.sync(null);
    const beforeRenderVersion = structuredClone(first.cursor) as {
      fileMap: Record<string, { renderVersion?: number }>;
    };
    for (const state of Object.values(beforeRenderVersion.fileMap)) delete state.renderVersion;

    const upgraded = await instance.sync(beforeRenderVersion);
    expect(upgraded.documents).toHaveLength(1);
    expect(upgraded.documents[0]!.externalId).toBe(first.documents[0]!.externalId);
    expect(upgraded.documents[0]!.metadata.extra?.linkKeys).toEqual(["projects/roadmap"]);

    const settled = await instance.sync(upgraded.cursor);
    expect(settled.documents).toHaveLength(0);
  });

  test("incremental: skips unchanged files", async () => {
    writeNote(vaultPath, "unchanged.md", "Original content");

    const r1 = await instance.sync(null);
    expect(r1.documents).toHaveLength(1);

    // Sync again — file hasn't changed
    const r2 = await instance.sync(r1.cursor);
    expect(r2.documents).toHaveLength(0);
    expect(r2.hasMore).toBe(false);
  });

  test("incremental: detects changed files", async () => {
    writeNote(vaultPath, "note.md", "Original content");

    const r1 = await instance.sync(null);
    expect(r1.documents).toHaveLength(1);

    // Modify the file — change mtime and content
    const future = new Date(Date.now() + 10000);
    writeNote(vaultPath, "note.md", "Updated content", future);

    const r2 = await instance.sync(r1.cursor);
    expect(r2.documents).toHaveLength(1);
    expect(r2.documents[0].content).toBe("Updated content");
  });

  test("incremental: detects new files", async () => {
    writeNote(vaultPath, "existing.md", "Existing");

    const r1 = await instance.sync(null);
    expect(r1.documents).toHaveLength(1);

    // Add a new file
    writeNote(vaultPath, "new-note.md", "New content");

    const r2 = await instance.sync(r1.cursor);
    expect(r2.documents).toHaveLength(1);
    expect(r2.documents[0].metadata.extra!.relativePath).toBe("new-note.md");
  });

  test("incremental: detects deleted files", async () => {
    writeNote(vaultPath, "will-delete.md", "Delete me");
    writeNote(vaultPath, "will-keep.md", "Keep me");

    const r1 = await instance.sync(null);
    expect(r1.documents).toHaveLength(2);

    // Capture the stable identity assigned to the file we'll remove —
    // deletion is now reported by stableId, not path.
    const willDeleteDoc = r1.documents.find(
      (d) => d.metadata.extra?.relativePath === "will-delete.md",
    )!;
    expect(willDeleteDoc).toBeDefined();
    const willDeleteStableId = willDeleteDoc.externalId;

    // Delete one file
    rmSync(join(vaultPath, "will-delete.md"));

    const r2 = await instance.sync(r1.cursor);
    expect(r2.deletedExternalIds).toContain(willDeleteStableId);
    expect(r2.deletedExternalIds).not.toContain("will-delete.md");
  });

  test("a permanent unreadable link retains its notes while sibling deletions and renames continue", async () => {
    writeNote(vaultPath, "moving.md", "A note to rename");
    writeNote(vaultPath, "gone.md", "A note to delete");
    const first = await instance.sync(null);
    const moving = first.documents.find(
      (d) => d.metadata.extra?.relativePath === "moving.md",
    )!.externalId;
    const gone = first.documents.find(
      (d) => d.metadata.extra?.relativePath === "gone.md",
    )!.externalId;
    symlinkSync(join(vaultPath, "missing"), join(vaultPath, "unreadable"));
    renameSync(join(vaultPath, "moving.md"), join(vaultPath, "renamed.md"));
    rmSync(join(vaultPath, "gone.md"));
    const second = await instance.sync(first.cursor);
    expect(second.documents[0]?.externalId).toBe(moving);
    expect(second.deletedExternalIds).toEqual([gone]);
    expect(first.issues).toEqual([]);
    expect(second.issues).toEqual([expect.objectContaining({ code: "snapshot-withheld" })]);
    writeNote(vaultPath, "later.md", "Another fictional note");
    const third = await instance.sync(second.cursor);
    const later = third.documents[0]!.externalId;
    rmSync(join(vaultPath, "later.md"));
    const fourth = await instance.sync(third.cursor);
    expect(fourth.deletedExternalIds).toEqual([later]);
    expect(fourth.issues).toEqual([expect.objectContaining({ code: "snapshot-withheld" })]);
    rmSync(join(vaultPath, "unreadable"));
    expect((await instance.sync(fourth.cursor)).issues).toEqual([]);
  });

  test("deletions remain pending while a multi-page cycle discovers renames", async () => {
    writeNote(vaultPath, "deleted.md", "A note to delete");
    const first = await instance.sync(null);
    for (let n = 0; n < 201; n++) writeNote(vaultPath, `new-${n}.md`, `Fictional note ${n}`);
    // Allocate the new notes before deleting the old one so inode reuse cannot
    // make an unrelated creation look like a rename.
    rmSync(join(vaultPath, "deleted.md"));
    const page = await instance.sync(first.cursor);
    expect(page.hasMore).toBe(true);
    expect(page.deletedExternalIds).toEqual([]);
    expect(page.issues).toBeUndefined();
    const final = await instance.sync(page.cursor);
    expect(final.hasMore).toBe(false);
    expect(final.issues).toEqual([]);
    expect(final.deletedExternalIds).toEqual([first.documents[0]!.externalId]);
  });

  test.skipIf(!canDenyReads)(
    "a subfolder that will not open withholds deletions instead of tombstoning what is under it",
    async () => {
      writeNote(vaultPath, "Archive/old.md", "An archived note");
      writeNote(vaultPath, "Archive/older.md", "Another archived note");
      writeNote(vaultPath, "top.md", "A note at the vault root");

      const r1 = await instance.sync(null);
      expect(r1.documents).toHaveLength(3);
      const archived = r1.documents
        .filter((d) => String(d.metadata.extra?.relativePath).startsWith("Archive/"))
        .map((d) => d.externalId);
      expect(archived).toHaveLength(2);

      // The folder stops opening — a permission change, a submount dropping.
      // Its notes are now absent from the walk, which is exactly what a
      // genuine deletion looks like.
      const archiveDir = join(vaultPath, "Archive");
      chmodSync(archiveDir, 0o000);
      try {
        const r2 = await instance.sync(r1.cursor);
        // Nothing is tombstoned: a tombstone deletes on the spot, with no
        // corroboration and no deadline, so an unreadable folder must not
        // produce one.
        expect(r2.deletedExternalIds ?? []).toEqual([]);
        for (const id of archived) expect(r2.deletedExternalIds ?? []).not.toContain(id);
      } finally {
        chmodSync(archiveDir, 0o755);
      }
    },
  );

  test.skipIf(!canDenyReads)(
    "the notes survive the outage and deletion detection resumes once the vault reads cleanly",
    async () => {
      writeNote(vaultPath, "Archive/old.md", "An archived note");
      writeNote(vaultPath, "top.md", "A note at the vault root");

      const r1 = await instance.sync(null);
      const archivedId = r1.documents.find(
        (d) => d.metadata.extra?.relativePath === "Archive/old.md",
      )!.externalId;

      const archiveDir = join(vaultPath, "Archive");
      chmodSync(archiveDir, 0o000);
      let r2;
      try {
        r2 = await instance.sync(r1.cursor);
        expect(r2.deletedExternalIds ?? []).toEqual([]);
      } finally {
        chmodSync(archiveDir, 0o755);
      }

      // The note was there all along, so a clean walk reports no deletion —
      // withholding cost a cycle of detection, not the note.
      const r3 = await instance.sync(r2.cursor);
      expect(r3.deletedExternalIds ?? []).not.toContain(archivedId);

      // And a genuine deletion is still detected on the next clean walk.
      rmSync(join(vaultPath, "Archive", "old.md"));
      const r4 = await instance.sync(r3.cursor);
      expect(r4.deletedExternalIds).toContain(archivedId);
    },
  );

  test("a symlinked folder whose target vanishes withholds deletions too", async () => {
    // The submount case, which is the one the guard was written for and the
    // one it did not cover: the link is still in the directory listing, so the
    // walk never calls readdir on it and never reached the point that records
    // a gap. Everything behind it is simply absent, which is exactly what a
    // deletion looks like.
    writeNote(vaultPath, "Real/away.md", "A note behind a link");
    writeNote(vaultPath, "top.md", "A note at the vault root");
    symlinkSync(join(vaultPath, "Real"), join(vaultPath, "Linked"));

    const r1 = await instance.sync(null);
    const away = r1.documents.find((d) =>
      String(d.metadata.extra?.relativePath).endsWith("away.md"),
    );
    expect(away).toBeDefined();

    // The target goes away: its note is genuinely deleted, and the link now
    // dangles. The walk cannot tell those apart from what it can see, so it
    // reports neither until it can read the vault whole.
    rmSync(join(vaultPath, "Real"), { recursive: true, force: true });

    const r2 = await instance.sync(r1.cursor);
    expect(r2.deletedExternalIds ?? []).toEqual([]);

    // Once the dangling link is gone the walk is complete again, and the
    // deletion it was holding back is reported.
    rmSync(join(vaultPath, "Linked"), { force: true });
    const r3 = await instance.sync(r2.cursor);
    expect(r3.deletedExternalIds).toContain(away!.externalId);
  });

  test("handles notes without frontmatter", async () => {
    writeNote(vaultPath, "simple.md", "# Simple Note\n\nJust plain markdown.");

    const result = await instance.sync(null);
    expect(result.documents).toHaveLength(1);

    const doc = result.documents[0];
    expect(doc.title).toBe("simple");
    expect(doc.content).toBe("# Simple Note\n\nJust plain markdown.");
    expect(doc.metadata.tags).toBeUndefined();
  });

  test("bootstrap progress reporting", async () => {
    writeNote(vaultPath, "note1.md", "Content 1");
    writeNote(vaultPath, "note2.md", "Content 2");
    writeNote(vaultPath, "note3.md", "Content 3");

    const result = await instance.sync(null);
    expect(result.progress).toBeDefined();
    expect(result.progress!.phase).toBe("bootstrap");
    expect(result.progress!.total).toBe(3);
    expect(result.progress!.percentComplete).toBe(100);
  });

  test("incremental progress reporting", async () => {
    writeNote(vaultPath, "note.md", "Content");

    const r1 = await instance.sync(null);

    // Wait so the new file gets a strictly later mtime than the one we
    // just synced — Obsidian's per-file mtime drives the queue.
    await new Promise((r) => setTimeout(r, 10));
    writeNote(vaultPath, "note2.md", "More content");

    const r2 = await instance.sync(r1.cursor);
    // One file changed → queue size 1 → progress emitted.
    expect(r2.progress).toBeDefined();
    expect(r2.progress!.phase).toBe("incremental");
    expect(r2.progress!.total).toBe(1);

    // No-op incremental (nothing changed since r2's cursor) → no
    // progress, consistent with "show progress only when there's work".
    const r3 = await instance.sync(r2.cursor);
    expect(r3.progress).toBeUndefined();
  });

  test("custom exclude patterns", async () => {
    const excludeInstance = await definition.create!({
      accountId: "TestVault",
      sourceId: SourceId("obsidian-notes:TestVault"),
      providerId: ProviderId("obsidian:TestVault"),
      config: { vaultPath, exclude: ["templates/**"] },
    });

    writeNote(vaultPath, "real-note.md", "Content");
    writeNote(vaultPath, "templates/daily.md", "Template content");

    const result = await excludeInstance.sync(null);
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].metadata.extra!.relativePath).toBe("real-note.md");
  });

  test("ignores non-md files", async () => {
    writeNote(vaultPath, "note.md", "Markdown");
    writeFileSync(join(vaultPath, "image.png"), "binary-data");
    writeFileSync(join(vaultPath, "data.json"), '{"key": "value"}');

    const result = await instance.sync(null);
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].metadata.extra!.relativePath).toBe("note.md");
  });

  // ── Stable identity ─────────────────────────────────────────────────────

  test("stable identity: rename keeps the same externalId (no edit)", async () => {
    writeNote(vaultPath, "original.md", "# Stable\n\nUnchanged content.");
    const r1 = await instance.sync(null);
    expect(r1.documents).toHaveLength(1);
    const originalStableId = r1.documents[0]!.externalId;

    // Rename without editing — same content, same size, same inode.
    const { renameSync } = await import("node:fs");
    renameSync(join(vaultPath, "original.md"), join(vaultPath, "moved.md"));

    const r2 = await instance.sync(r1.cursor);
    // The renamed note may or may not need re-emit (mtime usually
    // unchanged on rename), but the externalId — when it does emit —
    // must match the original. Either way, no deletion of the
    // original stableId should be reported.
    if (r2.documents.length > 0) {
      expect(r2.documents[0]!.externalId).toBe(originalStableId);
      expect(r2.documents[0]!.metadata.extra!.relativePath).toBe("moved.md");
    }
    expect(r2.deletedExternalIds).not.toContain(originalStableId);
  });

  test("stable identity: rename + edit (different content hash) keeps the same externalId via inode", async () => {
    writeNote(vaultPath, "before.md", "Original content");
    const r1 = await instance.sync(null);
    const originalStableId = r1.documents[0]!.externalId;

    // Rename and edit. Same inode, different content hash.
    const { renameSync } = await import("node:fs");
    renameSync(join(vaultPath, "before.md"), join(vaultPath, "after.md"));
    const future = new Date(Date.now() + 10000);
    writeFileSync(join(vaultPath, "after.md"), "Edited content");
    utimesSync(join(vaultPath, "after.md"), future, future);

    const r2 = await instance.sync(r1.cursor);
    expect(r2.documents).toHaveLength(1);
    expect(r2.documents[0]!.externalId).toBe(originalStableId);
    expect(r2.documents[0]!.metadata.extra!.relativePath).toBe("after.md");
    expect(r2.deletedExternalIds).not.toContain(originalStableId);
  });

  test("stable identity: frontmatter id wins over inode", async () => {
    writeNote(vaultPath, "with-id.md", "---\nid: 0123abcd-uuid\n---\n# Pinned identity");

    const r1 = await instance.sync(null);
    expect(r1.documents).toHaveLength(1);
    expect(r1.documents[0]!.externalId).toBe("0123abcd-uuid");

    // Move the file — externalId stays pinned because frontmatter.id is set.
    const { renameSync } = await import("node:fs");
    mkdirSync(join(vaultPath, "subfolder"), { recursive: true });
    renameSync(join(vaultPath, "with-id.md"), join(vaultPath, "subfolder/elsewhere.md"));
    const future = new Date(Date.now() + 10000);
    utimesSync(join(vaultPath, "subfolder/elsewhere.md"), future, future);

    const r2 = await instance.sync(r1.cursor);
    expect(r2.documents).toHaveLength(1);
    expect(r2.documents[0]!.externalId).toBe("0123abcd-uuid");
    expect(r2.documents[0]!.metadata.extra!.relativePath).toBe("subfolder/elsewhere.md");
    expect(r2.deletedExternalIds).not.toContain("0123abcd-uuid");
  });

  test.skipIf(!canDenyReads)(
    "legacy re-key retains old IDs until unreadable replacements recover",
    async () => {
      writeNote(vaultPath, "held.md", "A fictional held note");
      chmodSync(join(vaultPath, "held.md"), 0o000);
      const versioned = withVersionedState(instance, obsidianStateSpec, {
        sourceId: "obsidian-notes:vault",
      });
      let cursor: Parameters<typeof instance.sync>[0] = { fileMap: { "held.md": { mtime: 0 } } };
      try {
        for (let cycle = 0; cycle < 3; cycle++) {
          const result = await versioned.sync(cursor);
          expect(result.deletedExternalIds).toEqual([]);
          expect(result.documents).toEqual([]);
          cursor = result.cursor;
        }
      } finally {
        chmodSync(join(vaultPath, "held.md"), 0o644);
      }
      const recovered = await versioned.sync(cursor);
      expect(recovered.documents).toHaveLength(1);
      expect(recovered.deletedExternalIds).toEqual(["held.md"]);
    },
  );

  test("stable identity: a legacy v1 cursor re-keys through the declared migration", async () => {
    writeNote(vaultPath, "alpha.md", "Alpha content");
    writeNote(vaultPath, "beta.md", "Beta content");

    // What was on disk before the upgrade: paths as both map key and
    // externalId, with no envelope and no version stamp.
    const legacyCursor = {
      fileMap: {
        "alpha.md": { mtime: 0, contentHash: "stale-hash-alpha" },
        "beta.md": { mtime: 0, contentHash: "stale-hash-beta" },
        "gone.md": { mtime: 0, contentHash: "stale-hash-gone" },
      },
    };

    // Driven through the host decorator rather than by calling `sync`
    // directly, because the migration is the host's to run — calling `sync`
    // with a legacy value would test a path production never takes.
    const outcomes: StateOutcome[] = [];
    const versioned = withVersionedState(instance, obsidianStateSpec, {
      sourceId: "obsidian-notes:vault",
      onResolve: (outcome) => outcomes.push(outcome),
    });

    const result = await versioned.sync(
      legacyCursor as unknown as Parameters<typeof instance.sync>[0],
    );

    // The resolution is a migration, not a fresh start. The difference is the
    // whole point: a fresh start would re-emit the notes without ever naming
    // the old path-shaped ids, leaving them in the corpus forever.
    expect(outcomes[0]?.kind).toBe("migrated");

    // Both current files re-emit with new stable identities.
    expect(result.documents).toHaveLength(2);
    for (const d of result.documents) {
      expect(d.externalId).toMatch(/^inode:\d+$/);
    }
    // All three legacy externalIds (path-shaped) appear in deletions.
    expect(result.deletedExternalIds).toContain("alpha.md");
    expect(result.deletedExternalIds).toContain("beta.md");
    expect(result.deletedExternalIds).toContain("gone.md");

    // And the bookmark it writes back is an envelope stamped with the current
    // version, so the next run resumes instead of migrating again.
    expect(isStateEnvelope(result.cursor)).toBe(true);
    const second = await versioned.sync(result.cursor);
    expect(outcomes[1]?.kind).toBe("resume");
    expect(second.deletedExternalIds ?? []).toHaveLength(0);
  });
});

describe("ObsidianNotesSource — a vault root that will not read", () => {
  let tmpDir: string;
  let vaultPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "obsidian-denied-"));
    vaultPath = createVault(tmpDir);
    writeNote(vaultPath, "note.md", "# Note\n\nbody");
  });

  afterEach(() => {
    chmodSync(vaultPath, 0o755);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test.skipIf(!canDenyReads)(
    "raises a typed error instead of reporting an empty vault",
    async () => {
      const instance = await definition.create!({
        accountId: "TestVault",
        sourceId: SourceId("obsidian-notes:TestVault"),
        providerId: ProviderId("obsidian:TestVault"),
        config: { vaultPath, exclude: [] },
      });
      const first = await instance.sync(null);
      expect(first.documents).toHaveLength(1);

      chmodSync(vaultPath, 0o000);
      const denied = await definition.create!({
        accountId: "TestVault",
        sourceId: SourceId("obsidian-notes:TestVault"),
        providerId: ProviderId("obsidian:TestVault"),
        config: { vaultPath, exclude: [] },
      });

      const failure = await denied.sync(first.cursor).then(
        () => null,
        (err: unknown) => err,
      );

      // Not an empty sync — an empty sync here would report every
      // previously-known note as deleted, which is exactly what a root read
      // failure must not be mistaken for.
      expect(failure).toBeInstanceOf(SyncError);
      expect((failure as SyncError).kind).toBe("permission");
      expect((failure as SyncError).scope).toBe("source");
    },
  );
});
