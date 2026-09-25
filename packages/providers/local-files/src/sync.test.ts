// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  chmodSync,
  linkSync,
  renameSync,
  statSync,
  utimesSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { type SourceInstance } from "@omnesis/source-sdk";
import { fakeSourceHost } from "@omnesis/source-sdk/testing";
import { SourceId, ProviderId } from "@omnesis/types";
import definition from "./index.js";
import type { LocalFilesSyncCursor } from "./types.js";

const sourceId = SourceId("local-files:host");
const providerId = ProviderId("local-files:host");

function write(root: string, rel: string, content: string | Uint8Array): void {
  const full = join(root, rel);
  mkdirSync(full.substring(0, full.lastIndexOf("/")), { recursive: true });
  writeFileSync(full, content);
}

async function createInstance(root: string): Promise<SourceInstance> {
  return definition.create!({
    accountId: "host",
    sourceId,
    providerId,
    config: { roots: [root], exclude: [] },
  });
}

describe("local-files sync", () => {
  let tmpDir: string;
  let root: string;

  beforeEach(() => {
    // The scanner keys its file map by real path, so resolve the temp root
    // once: on macOS the temp directory is reached through a symlink.
    tmpDir = realpathSync(mkdtempSync(join(tmpdir(), "local-files-test-")));
    root = join(tmpDir, "Docs");
    mkdirSync(root, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test.skipIf((process.getuid?.() ?? 0) === 0)(
    "a known unreadable file retains its identity while sibling omissions reconcile",
    async () => {
      write(root, "held.txt", "A fictional retained file");
      write(root, "deleted.txt", "A fictional deleted file");
      const instance = await createInstance(root);
      const first = await instance.sync(null);
      const held = first.documents.find((doc) => doc.title === "held.txt")!.externalId;
      write(root, "held.txt", "An edited fictional file that temporarily cannot be read");
      chmodSync(join(root, "held.txt"), 0o000);
      rmSync(join(root, "deleted.txt"));
      try {
        let cursor = first.cursor;
        for (let cycle = 0; cycle < 3; cycle++) {
          const result = await instance.sync(cursor);
          expect(result.presentExternalIds).toEqual([held]);
          expect(result.documents).toEqual([]);
          cursor = result.cursor;
        }
      } finally {
        chmodSync(join(root, "held.txt"), 0o644);
      }
    },
  );

  test("indexes text files and skips the deny-list", async () => {
    write(root, "Insurance/quote.txt", "Harbor quote number 42, valid 30 days.");
    write(root, "notes.md", "# heading\nsome personal notes");
    write(root, "node_modules/lib/bundle.js", "console.log(1)");
    write(root, ".env", "SECRET=topsecretvalue");
    write(root, "shot.png", "fakepngbytes");
    write(root, "archive.zip", "fakezipbytes");
    write(root, ".DS_Store", "junk");
    const instance = await createInstance(root);
    const result = await instance.sync(null);
    const titles = result.documents.map((d) => d.title).sort();
    expect(titles).toEqual(["notes.md", "quote.txt"]);
    for (const doc of result.documents) {
      expect(doc.metadata.documentType).toBe("file");
      expect(doc.metadata.sourceUrl).toBeUndefined();
      expect(doc.extractedContentHash).toBeDefined();
    }
    expect(result.hasMore).toBe(false);
    expect(result.deletedExternalIds ?? []).toHaveLength(0);
  });

  test("a stored brace glob keeps excluding files after configuration parsing", async () => {
    write(root, "private.txt", "Fictional private note");
    write(root, "private.md", "Fictional private markdown");
    write(root, "public.txt", "Fictional public note");
    const parsed = definition.config!.parse({ roots: root, exclude: "private.{txt,md}" });
    if (!parsed.ok) throw new Error("expected valid stored configuration");
    expect(parsed.value.exclude).toEqual(["private.{txt,md}"]);
    const source = await definition.create!({
      accountId: "host",
      sourceId,
      providerId,
      config: parsed.value,
    });
    const result = await source.sync(null);
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0]?.content).toContain("Fictional public note");
  });

  test("prunes git repos, linked worktrees, and obsidian vaults", async () => {
    write(root, "keep.txt", "ordinary document that stays indexed here");
    write(root, "repo/.git/HEAD", "ref: refs/heads/main");
    write(root, "repo/README.md", "# working tree readme that must not index");
    write(root, "repo/notes.txt", "working tree notes that must not index");
    // A linked worktree (or submodule) carries a .git *file*, not a dir.
    write(root, "wt/.git", "gitdir: /elsewhere/main/.git/worktrees/wt");
    write(root, "wt/code.md", "worktree notes that must not index either");
    write(root, "vault/.obsidian/app.json", "{}");
    write(root, "vault/daily.md", "vault note that belongs to the obsidian source");
    const instance = await createInstance(root);
    const result = await instance.sync(null);
    expect(result.documents.map((d) => d.title)).toEqual(["keep.txt"]);
    expect(result.hasMore).toBe(false);
  });

  test("files under a new repo marker leave the snapshot on the next scan", async () => {
    write(root, "proj/a.txt", "first project file with indexable text");
    write(root, "proj/b.md", "# second project file with indexable text");
    // A file outside the folder that becomes a repo. Without it the expected
    // snapshot is empty, which is also what a source that had stopped
    // enumerating altogether would publish — and that reads to the gateway as
    // "delete the whole corpus". The survivor is what separates the two.
    write(root, "keep.txt", "a file outside the folder that becomes a repo");
    const instance = await createInstance(root);
    const first = await instance.sync(null);
    expect(first.documents).toHaveLength(3);

    // The folder becomes a repo after it was indexed. This source names no
    // tombstones: a file it stops walking is one it no longer vouches for,
    // and the gateway deletes it once the omission clears the absence gates.
    // Saying "gone" outright would be a claim the source cannot make — the
    // files are still on disk, they are simply no longer indexable.
    write(root, "proj/.git/HEAD", "ref: refs/heads/main");
    const second = await instance.sync(first.cursor as LocalFilesSyncCursor);
    expect(second.documents).toHaveLength(0);
    expect(second.deletedExternalIds ?? []).toHaveLength(0);
    // The read still covered the configured folder, so the omission is a
    // finding rather than a gap: the whole-source form, naming the survivor
    // and only the survivor.
    const survivor = first.documents.find((doc) => doc.title === "keep.txt")!.externalId;
    expect(second.presentExternalIds).toEqual([survivor]);
  });

  test("progress reports a running total across pages", async () => {
    for (let i = 0; i < 120; i++) {
      write(root, `f${i}.txt`, `paged file number ${i} with enough text to index`);
    }
    const instance = await createInstance(root);
    let cursor: LocalFilesSyncCursor | null = null;
    const seen: number[] = [];
    for (;;) {
      const result = await instance.sync(cursor);
      cursor = result.cursor as LocalFilesSyncCursor;
      seen.push(result.progress?.processed ?? -1);
      if (!result.hasMore) {
        // Only the first page (null cursor) reports "bootstrap"; later
        // pages report "incremental" while the totals stay cycle-pinned.
        expect(result.progress).toMatchObject({
          phase: "incremental",
          total: 120,
          processed: 120,
          percentComplete: 100,
        });
        expect(cursor.cycleProcessed).toBeUndefined();
        expect(cursor.cycleQueueTotal).toBeUndefined();
        break;
      }
      expect(cursor.cycleQueueTotal).toBe(120);
    }
    expect(seen).toEqual([50, 100, 120]);
  });

  test("progress counts emitted docs, so a cycle with skips ends below 100%", async () => {
    for (let i = 0; i < 60; i++) {
      write(root, `ok${i}.txt`, `indexable file number ${i} with enough text`);
    }
    // No extractor wired: every pdf records a terminal skip, draining the
    // queue without emitting.
    for (let i = 0; i < 60; i++) {
      write(root, `skip${i}.pdf`, Buffer.from("%PDF-1.4 fake"));
    }
    const instance = await createInstance(root);
    let cursor: LocalFilesSyncCursor | null = null;
    let total = 0;
    for (;;) {
      const result = await instance.sync(cursor);
      total += result.documents.length;
      cursor = result.cursor as LocalFilesSyncCursor;
      if (!result.hasMore) {
        expect(result.progress).toMatchObject({
          total: 120,
          processed: 60,
          percentComplete: 50,
        });
        break;
      }
    }
    expect(total).toBe(60);
  });

  test("create refuses a root that is a git repo", async () => {
    const repo = join(root, "proj");
    mkdirSync(join(repo, ".git"), { recursive: true });
    await expect(
      definition.create!({
        accountId: "host",
        sourceId,
        providerId,
        config: { roots: [repo], exclude: [] },
      }),
    ).rejects.toThrow(/git repository/);
  });

  test("binary files extract through the injected pipeline", async () => {
    write(root, "quote.pdf", Buffer.from("%PDF-1.4 fake"));
    const instance = await definition.create!({
      accountId: "host",
      sourceId,
      providerId,
      config: { roots: [root], exclude: [] },
      host: fakeSourceHost({
        extractAttachment: async () => ({ text: "Extracted PDF body text.", truncated: false }),
      }),
    });
    const result = await instance.sync(null);
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0]!.content).toContain("Extracted PDF body text.");
    expect(result.documents[0]!.metadata.extra).toMatchObject({ mimeType: "application/pdf" });
  });

  test("binary files are recorded skipped when no extractor is wired", async () => {
    write(root, "quote.pdf", Buffer.from("%PDF-1.4 fake"));
    write(root, "note.txt", "plain text still indexed");
    const instance = await createInstance(root);
    const first = await instance.sync(null);
    expect(first.documents.map((d) => d.title)).toEqual(["note.txt"]);
    const cursor = first.cursor as LocalFilesSyncCursor;
    expect(cursor.fileMap[join(root, "quote.pdf")]?.skipped).toBe("unextractable");
    // The skip leaves the queue: the next cycle attempts nothing new.
    const second = await instance.sync(cursor);
    expect(second.documents).toHaveLength(0);
    expect(second.hasMore).toBe(false);
  });

  test("terminal extraction failures drain instead of pinning the queue", async () => {
    write(root, "blank.pdf", Buffer.from("%PDF-1.4 fake"));
    write(root, "ok.txt", "indexable text in the same cycle here");
    const instance = await definition.create!({
      accountId: "host",
      sourceId,
      providerId,
      config: { roots: [root], exclude: [] },
      host: fakeSourceHost({ extractAttachment: async () => null }),
    });
    const first = await instance.sync(null);
    expect(first.documents.map((d) => d.title)).toEqual(["ok.txt"]);
    const cursor = first.cursor as LocalFilesSyncCursor;
    expect(cursor.fileMap[join(root, "blank.pdf")]?.skipped).toBe("unextractable");
    const second = await instance.sync(cursor);
    expect(second.hasMore).toBe(false);
    expect(second.deletedExternalIds ?? []).toHaveLength(0);
  });

  test("paged cycles terminate across many files", async () => {
    for (let i = 0; i < 120; i++) {
      write(root, `f${i}.txt`, `paged file number ${i} with enough text to index`);
    }
    const instance = await createInstance(root);
    let cursor: LocalFilesSyncCursor | null = null;
    let total = 0;
    let pages = 0;
    for (;;) {
      const result = await instance.sync(cursor);
      total += result.documents.length;
      pages += 1;
      cursor = result.cursor as LocalFilesSyncCursor;
      if (!result.hasMore) break;
      expect(pages).toBeLessThan(10);
    }
    expect(total).toBe(120);
  });

  test("rename keeps the stable externalId and emits no deletion", async () => {
    write(root, "a.txt", "move me please, same bytes stay");
    const instance = await createInstance(root);
    const first = await instance.sync(null);
    expect(first.documents).toHaveLength(1);
    const stableId = first.documents[0]!.externalId;
    const cursor = first.cursor as LocalFilesSyncCursor;

    write(root, "sub/b.txt", "move me please, same bytes stay");
    rmSync(join(root, "a.txt"));
    const second = await instance.sync(cursor);
    expect(second.documents).toHaveLength(1);
    expect(second.documents[0]!.externalId).toBe(stableId);
    expect(second.deletedExternalIds ?? []).toHaveLength(0);
  });

  test("a file saved by renaming a temporary copy over it keeps its identity", async () => {
    // Most editors save this way, so the path keeps its name but gains a new
    // inode. Minting a fresh id for it duplicated the document on every save
    // and left the old one to linger until its absence was confirmed.
    write(root, "budget.txt", "Quarterly budget draft for the harbour tier");
    const instance = await createInstance(root);
    const first = await instance.sync(null);
    const stableId = first.documents[0]!.externalId;
    const before = statSync(join(root, "budget.txt")).ino;

    write(root, ".budget.txt.swp", "Quarterly budget, revised after review");
    utimesSync(join(root, ".budget.txt.swp"), new Date(), new Date(Date.now() + 5_000));
    renameSync(join(root, ".budget.txt.swp"), join(root, "budget.txt"));
    expect(statSync(join(root, "budget.txt")).ino).not.toBe(before);

    const second = await instance.sync(first.cursor as LocalFilesSyncCursor);
    expect(second.documents.map((doc) => doc.externalId)).toEqual([stableId]);
    expect(second.documents[0]!.content).toContain("revised after review");
    expect(second.presentExternalIds).toEqual([stableId]);
  });

  test("a new file at a moved file's old path does not take its identity", async () => {
    write(root, "plan.txt", "The original plan, moved into the archive");
    const instance = await createInstance(root);
    const first = await instance.sync(null);
    const stableId = first.documents[0]!.externalId;

    mkdirSync(join(root, "archive"));
    renameSync(join(root, "plan.txt"), join(root, "archive", "plan.txt"));
    write(root, "plan.txt", "A brand new plan written in its place");
    utimesSync(join(root, "plan.txt"), new Date(), new Date(Date.now() + 5_000));

    const second = await instance.sync(first.cursor as LocalFilesSyncCursor);
    const byTitle = new Map(second.documents.map((doc) => [doc.content, doc.externalId]));
    const moved = [...byTitle].find(([content]) => content.includes("original plan"));
    const fresh = [...byTitle].find(([content]) => content.includes("brand new plan"));
    expect(moved?.[1]).toBe(stableId);
    expect(fresh?.[1]).not.toBe(stableId);
  });

  test("a complete scan leaves a deleted file out of the snapshot it publishes", async () => {
    write(root, "gone.txt", "here today, gone tomorrow, certainly");
    write(root, "stays.txt", "this one is still here on the second pass");
    const instance = await createInstance(root);
    const first = await instance.sync(null);
    const goneId = first.documents.find((d) => d.title === "gone.txt")!.externalId;
    const staysId = first.documents.find((d) => d.title === "stays.txt")!.externalId;
    const cursor = first.cursor as LocalFilesSyncCursor;

    rmSync(join(root, "gone.txt"));
    const second = await instance.sync(cursor);
    expect(second.documents).toHaveLength(0);
    // Absence, not a tombstone: the source says what it holds and the host
    // decides what that means for anything it stored and no longer sees.
    expect(second.presentExternalIds).toEqual([staysId]);
    expect(second.presentExternalIds).not.toContain(goneId);
    expect(second.deletedExternalIds ?? []).toHaveLength(0);
  });

  test("a folder that would not read in full vouches for nothing, and forgets nothing", async () => {
    write(root, "keep.txt", "this file is deleted while a scan is blind");
    write(root, "blocked/inner.txt", "unreadable directory makes the scan incomplete");
    const instance = await createInstance(root);
    const first = await instance.sync(null);
    expect(first.documents).toHaveLength(2);
    const cursor = first.cursor as LocalFilesSyncCursor;

    rmSync(join(root, "keep.txt"));
    chmodSync(join(root, "blocked"), 0o000);
    let blindCursor: LocalFilesSyncCursor;
    try {
      const second = await instance.sync(cursor);
      expect(second.presentExternalIds).toBeUndefined();
      expect(second.presentClaims).toBeUndefined();
      blindCursor = second.cursor as LocalFilesSyncCursor;
      expect(Object.keys(blindCursor.fileMap)).toContain(join(root, "keep.txt"));
    } finally {
      chmodSync(join(root, "blocked"), 0o755);
    }
    // Sight restored: the file that went missing while the source was blind
    // is left out of the snapshot it can finally publish.
    const third = await instance.sync(blindCursor!);
    expect(third.presentExternalIds).toHaveLength(1);
    expect(Object.keys((third.cursor as LocalFilesSyncCursor).fileMap)).not.toContain(
      join(root, "keep.txt"),
    );
  });

  test("one blind folder does not stop a healthy sibling vouching for itself", async () => {
    // The whole point of claiming folder by folder: an unmounted drive holding
    // one folder should not stop the source noticing a deletion in another.
    const healthy = join(tmpDir, "healthy");
    mkdirSync(healthy, { recursive: true });
    write(root, "blocked/inner.txt", "the folder this lives in goes dark");
    write(healthy, "gone.txt", "deleted while the sibling folder is dark");
    write(healthy, "stays.txt", "still here while the sibling folder is dark");
    const instance = await definition.create!({
      accountId: "host",
      sourceId,
      providerId,
      config: { roots: [root, healthy], exclude: [] },
    });
    const first = await instance.sync(null);
    expect(first.documents).toHaveLength(3);
    const staysId = first.documents.find((d) => d.title === "stays.txt")!.externalId;
    const cursor = first.cursor as LocalFilesSyncCursor;

    rmSync(join(healthy, "gone.txt"));
    chmodSync(join(root, "blocked"), 0o000);
    try {
      const second = await instance.sync(cursor);
      // No whole-source snapshot — one folder is unreadable — but the folder
      // that read cleanly still says exactly what it holds.
      expect(second.presentExternalIds).toBeUndefined();
      expect(second.presentClaims).toEqual([{ partition: healthy, ids: [staysId] }]);
      expect(second.issues).toEqual([expect.objectContaining({ code: "snapshot-withheld" })]);
      // And the dark folder's own files are still tracked, so nothing under
      // it is proposed for deletion.
      expect(Object.keys((second.cursor as LocalFilesSyncCursor).fileMap)).toContain(
        join(root, "blocked/inner.txt"),
      );
    } finally {
      chmodSync(join(root, "blocked"), 0o755);
    }
  });

  describe("a folder named in a spelling the disk does not use", () => {
    // Every file this source sees has been through `realpathSync`, and what
    // the operator typed has not. When the two drift apart nothing can be
    // attributed to a folder — and the failure is silent, so these pin it.
    const spellings: Array<[string, (root: string) => string]> = [
      ["with a trailing slash", (r) => `${r}/`],
      ["with a redundant segment", (r) => join(r, ".")],
      [
        "through a symlink to it",
        (r) => {
          const link = `${r}-link`;
          symlinkSync(r, link);
          return link;
        },
      ],
    ];

    for (const [label, spell] of spellings) {
      test(`${label} still attributes its files and vouches for them`, async () => {
        write(root, "note.txt", "a file in a folder spelled another way");
        const instance = await createInstance(spell(root));
        const page = await instance.sync(null);

        expect(page.documents).toHaveLength(1);
        expect(page.documents[0]!.partitionKey).toBeDefined();
        // The dangerous failure is not a wrong id but an empty snapshot: it
        // reads as "this source holds nothing", and everything stored for it
        // is then swept.
        expect(page.presentExternalIds).toEqual([page.documents[0]!.externalId]);
      });
    }
  });

  test("intentional root removal prunes state and keeps reconciling on later cycles", async () => {
    // The steady-state tick: nothing changed, so the page carries no
    // documents and no stray-document check can fire. If attribution silently
    // produced nothing, an unguarded snapshot would be `[]` — an instruction
    // to delete the whole corpus.
    write(root, "note.txt", "indexed once, then never touched again");
    const instance = await createInstance(root);
    const first = await instance.sync(null);
    expect(first.documents).toHaveLength(1);

    // A folder that is no longer configured: its tracked file is under no
    // folder this cycle can name.
    const elsewhere = join(tmpDir, "Elsewhere");
    mkdirSync(elsewhere, { recursive: true });
    write(elsewhere, "other.txt", "a file in the only folder still configured");
    const narrowed = await definition.create!({
      accountId: "host",
      sourceId,
      providerId,
      config: { roots: [elsewhere], exclude: [] },
    });
    const second = await narrowed.sync(first.cursor as LocalFilesSyncCursor);

    const surviving = second.documents[0]!.externalId;
    expect(second.presentExternalIds).toEqual([surviving]);
    expect((second.cursor as LocalFilesSyncCursor).fileMap[join(root, "note.txt")]).toBeUndefined();
    let cursor = second.cursor;
    for (let cycle = 0; cycle < 3; cycle++) {
      const page = await narrowed.sync(cursor as LocalFilesSyncCursor);
      expect(page.presentExternalIds).toEqual([surviving]);
      cursor = page.cursor;
    }
  });

  test("long roots use bounded stable partitions and legacy unchanged files are re-stamped", async () => {
    const deep = join(root, ...Array.from({ length: 4 }, (_, n) => `${n}-${"nested".repeat(12)}`));
    mkdirSync(deep, { recursive: true });
    write(deep, "note.txt", "A fictional note in a deep folder");
    const source = await createInstance(deep);
    const first = await source.sync(null);
    const partition = first.documents[0]!.partitionKey!;
    expect(deep.length).toBeGreaterThan(256);
    expect(partition.length).toBeLessThanOrEqual(256);
    const legacy = JSON.parse(JSON.stringify(first.cursor)) as LocalFilesSyncCursor;
    for (const entry of Object.values(legacy.fileMap)) delete entry.partitionKey;
    const restamped = await source.sync(legacy);
    expect(restamped.documents).toHaveLength(1);
    expect(restamped.documents[0]).toMatchObject({
      externalId: first.documents[0]!.externalId,
      partitionKey: partition,
    });
    expect((await source.sync(restamped.cursor)).documents).toEqual([]);
  });

  test("a configured missing mount keeps its cursor until it returns", async () => {
    write(root, "note.txt", "A note before the mount disappears");
    const first = await (await createInstance(root)).sync(null);
    const moved = join(tmpDir, "unmounted");
    const { renameSync } = await import("node:fs");
    renameSync(root, moved);
    const source = await createInstance(root);
    for (let cycle = 0; cycle < 3; cycle++) {
      const page = await source.sync(first.cursor);
      expect(page.presentExternalIds).toBeUndefined();
      expect((page.cursor as LocalFilesSyncCursor).fileMap).toEqual(
        (first.cursor as LocalFilesSyncCursor).fileMap,
      );
    }
    renameSync(moved, root);
    expect((await source.sync(first.cursor)).presentExternalIds).toEqual(first.presentExternalIds);
  });

  describe("a file that is present but was not read this cycle", () => {
    // Each of these used to leave the file out of the scan, which under a
    // snapshot is indistinguishable from the file having been deleted.
    test("an evicted iCloud file keeps the document it already has", async () => {
      write(root, "report.pdf", "%PDF-1.4 a report that gets evicted later");
      const instance = await definition.create!({
        accountId: "host",
        sourceId,
        providerId,
        config: { roots: [root], exclude: [] },
        host: fakeSourceHost({
          extractAttachment: async () => ({ text: "The report body text.", truncated: false }),
        }),
      });
      const first = await instance.sync(null);
      const reportId = first.documents[0]!.externalId;

      // macOS evicts by hiding the file and re-suffixing it.
      rmSync(join(root, "report.pdf"));
      write(root, ".report.pdf.icloud", "placeholder");
      const second = await instance.sync(first.cursor as LocalFilesSyncCursor);

      expect(second.presentExternalIds).toContain(reportId);
      expect(Object.keys((second.cursor as LocalFilesSyncCursor).fileMap)).toContain(
        join(root, "report.pdf"),
      );
    });

    test("a second hard link appearing does not evict the document", async () => {
      write(root, "note.txt", "one file that later gains a second name");
      const instance = await createInstance(root);
      const first = await instance.sync(null);
      const noteId = first.documents[0]!.externalId;

      linkSync(join(root, "note.txt"), join(root, "note-backup.txt"));
      const second = await instance.sync(first.cursor as LocalFilesSyncCursor);

      expect(second.presentExternalIds).toContain(noteId);
    });

    test("a file whose mtime falls outside the ingestion window is not gone", async () => {
      write(root, "old.txt", "restored from a backup with its old timestamp");
      const cutoff = new Date("2020-01-01T00:00:00Z").toISOString();
      const instance = await definition.create!({
        accountId: "host",
        sourceId,
        providerId,
        dataCutoff: cutoff,
        config: { roots: [root], exclude: [] },
      });
      const first = await instance.sync(null);
      const oldId = first.documents[0]!.externalId;

      // A restore that preserves the original timestamp puts the file behind
      // the window that governs what is worth reading.
      utimesSync(join(root, "old.txt"), new Date("2019-06-01"), new Date("2019-06-01"));
      const second = await instance.sync(first.cursor as LocalFilesSyncCursor);

      expect(second.documents).toHaveLength(0);
      expect(second.presentExternalIds).toContain(oldId);
    });
  });

  test("a file under two configured folders belongs to the innermost one", async () => {
    // Both folders contain it, and only one may claim it: a document vouched
    // for twice is vouched for by whichever claim is evaluated last, which is
    // not a decision either folder made.
    const inner = join(root, "Projects");
    mkdirSync(join(inner, "deep"), { recursive: true });
    write(inner, "deep/spec.txt", "a file only reachable below the nested folder");
    write(root, "top.txt", "a file directly in the outer folder");
    const instance = await definition.create!({
      accountId: "host",
      sourceId,
      providerId,
      config: { roots: [root, inner], exclude: [] },
    });
    const page = await instance.sync(null);

    const specId = page.documents.find((d) => d.title === "spec.txt")!.externalId;
    // The nested folder is the longest match, so the file belongs to it.
    expect(page.documents.find((d) => d.title === "spec.txt")!.partitionKey).toBe(inner);
    expect(page.presentExternalIds).toContain(specId);
  });

  test("every document names the folder it came from, so a claim can reach it", async () => {
    const other = join(tmpDir, "other");
    mkdirSync(other, { recursive: true });
    write(root, "here.txt", "a file in the first configured folder");
    write(other, "there.txt", "a file in the second configured folder");
    const instance = await definition.create!({
      accountId: "host",
      sourceId,
      providerId,
      config: { roots: [root, other], exclude: [] },
    });
    const page = await instance.sync(null);
    expect(page.documents.find((d) => d.title === "here.txt")!.partitionKey).toBe(root);
    expect(page.documents.find((d) => d.title === "there.txt")!.partitionKey).toBe(other);
  });

  test("symlinks escaping the root and hardlinks are refused", async () => {
    const outside = join(tmpDir, "outside.txt");
    writeFileSync(outside, "Outside text that must never be indexed here");
    symlinkSync(outside, join(root, "linked.txt"));
    linkSync(outside, join(root, "hard.txt"));
    write(root, "ok.txt", "inside text that is indexed normally here");
    const instance = await createInstance(root);
    const result = await instance.sync(null);
    expect(result.documents.map((d) => d.title)).toEqual(["ok.txt"]);
  });

  test("symlink aliases inside the root emit one document", async () => {
    write(root, "real.txt", "same bytes reachable twice in one page here");
    symlinkSync(join(root, "real.txt"), join(root, "alias.txt"));
    const instance = await createInstance(root);
    const result = await instance.sync(null);
    expect(result.documents).toHaveLength(1);
    const ids = result.documents.map((d) => d.externalId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("watch declarations cover the roots and allow-listed extensions", async () => {
    const instance = await createInstance(root);
    expect(instance.watchPaths).toEqual([root]);
    expect(instance.watchDirectoryPaths).toEqual([root]);
    expect(instance.watchFileExtensions).toContain(".pdf");
    expect(instance.watchFileExtensions).toContain(".txt");
    expect(instance.watchFileExtensions).not.toContain(".png");
  });

  test("descriptor carries the experimental partitioned contract", () => {
    expect(definition.id).toBe("local-files");
    expect(definition.experimental).toBe(true);
    expect(definition.multiDevice).toEqual({ mode: "partitioned" });
    expect(definition.singleInstance).toBe(true);
    expect(definition.supportedPlatforms).toEqual(["darwin", "linux"]);
    expect(definition.defaultSourcePrior).toBe(-0.15);
  });

  test("icon is a self-contained Lucide folders glyph", () => {
    expect(definition.icon?.sfSymbol).toBe("folder");
    const uri = definition.icon?.imageDataUri ?? "";
    expect(uri.startsWith("data:image/svg+xml;base64,")).toBe(true);
    const svg = Buffer.from(uri.split(",")[1]!, "base64").toString("utf-8");
    expect(svg).toContain('viewBox="0 0 24 24"');
    expect(svg).toContain("<path");
  });
});
