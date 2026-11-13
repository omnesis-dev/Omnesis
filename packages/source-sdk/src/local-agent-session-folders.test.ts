// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The project folder a coding session is filed under, and the list of project
 * folders its source publishes. All sessions and paths are invented.
 */

import { mkdtempSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ProviderId, SourceId, type FilterListItem } from "@omnesis/types";
import { collectFilterList } from "./filter-lists.js";
import {
  createLocalAgentSessionDocumentEventProfile,
  createLocalAgentSessionSource,
  LOCAL_AGENT_SESSION_PROJECT_FOLDER_FIELD,
  type LocalAgentSessionAdapter,
  type LocalAgentSessionCursor,
  type ParsedLocalAgentSession,
} from "./local-agent-sessions.js";
import { validateDocumentEventProfile } from "./structured-source.js";
import type { SourceInstance } from "./define-source.js";

const PROVIDER = ProviderId("fictional-agent:local");
const SOURCE = SourceId("fictional-agent:local");
const DAY_MS = 24 * 60 * 60 * 1000;
const FIRST_DAY = new Date(2026, 2, 1, 10, 0).getTime();

interface SessionFile {
  id: string;
  startCwd?: string;
  cwd?: string;
  /** How many local days the session has a message on. */
  days?: number;
}

describe("the project folder of a coding session", () => {
  let root: string;
  let parse: ReturnType<typeof vi.fn<LocalAgentSessionAdapter["parseSession"]>>;
  let instance: SourceInstance<LocalAgentSessionCursor>;

  const write = (name: string, session: SessionFile): void => {
    writeFileSync(join(root, `${name}.jsonl`), `${JSON.stringify(session)}\n`);
  };

  const list = async (): Promise<Record<string, [string, string | null]>> => {
    const producer = instance.filterLists![LOCAL_AGENT_SESSION_PROJECT_FOLDER_FIELD]!;
    const items: FilterListItem[] = await collectFilterList(producer, {
      signal: new AbortController().signal,
    });
    return Object.fromEntries(items.map((item) => [item.id, [item.label, item.parentId ?? null]]));
  };

  /** Run sync pages until the cycle ends; returns every document it emitted. */
  const cycle = async (cursor: LocalAgentSessionCursor | null) => {
    const documents = [];
    let hasMore = true;
    while (hasMore) {
      const page = await instance.sync(cursor);
      documents.push(...page.documents);
      cursor = page.cursor;
      hasMore = page.hasMore;
    }
    return { documents, cursor: cursor! };
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "local-agent-folders-"));
    parse = vi.fn<LocalAgentSessionAdapter["parseSession"]>(
      async (filePath): Promise<ParsedLocalAgentSession> => {
        const session = JSON.parse(readFileSync(filePath, "utf8")) as SessionFile;
        return {
          id: session.id,
          cwd: session.cwd ?? session.startCwd,
          startCwd: session.startCwd,
          messages: Array.from({ length: session.days ?? 1 }, (_, day) => ({
            role: "user" as const,
            text: `Invented prompt ${day} of ${session.id}`,
            atMs: FIRST_DAY + day * DAY_MS,
          })),
          complete: true,
        };
      },
    );
    instance = createLocalAgentSessionSource({
      providerId: PROVIDER,
      sourceId: SOURCE,
      homeDirectory: "/home/maya",
      adapter: {
        harnessId: "fictional-agent",
        agentName: "Nova",
        roots: [{ path: root }],
        fileExtensions: [".jsonl"],
        parserVersion: 1,
        parseSession: parse,
      },
    });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("the profile declares it as a per-device tree a filter can match on", () => {
    const profile = createLocalAgentSessionDocumentEventProfile({
      harnessId: "fictional-agent",
      agentName: "Nova",
      projectFolderSince: 2,
    });
    expect(() =>
      validateDocumentEventProfile(profile, "fictional sessions", {
        outputRevision: 2,
        partitioned: true,
      }),
    ).not.toThrow();
    // A source that has not raised its version, or is not one stream per device, is refused.
    expect(() =>
      validateDocumentEventProfile(profile, "fictional sessions", {
        outputRevision: 1,
        partitioned: true,
      }),
    ).toThrow(/minVersion 2 is above/);
    expect(() =>
      validateDocumentEventProfile(profile, "fictional sessions", {
        outputRevision: 2,
        partitioned: false,
      }),
    ).toThrow(/scope 'device'/);

    const fields = profile.metadataFields ?? [];
    expect(fields.find((field) => field.path === "extra.projectFolder")).toMatchObject({
      type: "string",
      filter: {
        capability: "tree",
        minVersion: 2,
        scope: "device",
        noun: { one: "project folder", many: "project folders" },
        levels: [{ one: "project folder", many: "project folders" }],
        picker: "tree",
        inside: { one: "project folder", many: "project folders" },
      },
    });
    // The field holding the last directory is still declared, and is not a filter.
    const cwd = fields.find((field) => field.path === "extra.cwd");
    expect(cwd).toMatchObject({ type: "string" });
    expect(cwd?.filter).toBeUndefined();
    expect(fields.filter((field) => field.filter !== undefined)).toHaveLength(1);
  });

  test("every day of a session carries the folder it started in, not where it ended", async () => {
    write("roaming", {
      id: "roaming",
      startCwd: "/home/maya/work/atlas-api/",
      cwd: "/home/maya/personal/garden-notes",
      days: 3,
    });
    const { documents } = await cycle(null);

    expect(documents).toHaveLength(3);
    for (const document of documents) {
      expect(document.metadata.extra).toMatchObject({
        projectFolder: "/home/maya/work/atlas-api",
        // The last directory keeps its field and its meaning.
        cwd: "/home/maya/personal/garden-notes",
        project: "garden-notes",
      });
    }
  });

  test("a session whose file recorded no usable directory writes nothing", async () => {
    write("none", { id: "none" });
    write("relative", { id: "relative", startCwd: "work/atlas-api" });
    write("known", { id: "known", startCwd: "/srv/builds/atlas" });
    const { documents } = await cycle(null);

    const folderOf = (id: string): unknown => {
      const extra = documents.find((document) => document.metadata.extra?.chatId === id)!.metadata
        .extra as Record<string, unknown>;
      return "projectFolder" in extra ? extra.projectFolder : "absent";
    };
    // Absent, not null and not an empty value: the field says "not known".
    expect(folderOf("none")).toBe("absent");
    expect(folderOf("relative")).toBe("absent");
    expect(folderOf("known")).toBe("/srv/builds/atlas");
    // Sessions with no folder add nothing to the list.
    expect(await list()).toEqual({
      "/srv": ["/srv", null],
      "/srv/builds": ["/srv/builds", "/srv"],
      "/srv/builds/atlas": ["/srv/builds/atlas", "/srv/builds"],
    });
  });

  test("the list holds each session's folder and the folders above it", async () => {
    write("atlas", { id: "atlas", startCwd: "/home/maya/work/atlas-api" });
    write("docs", { id: "docs", startCwd: "/home/maya/work/atlas-api/docs" });
    write("garden", { id: "garden", startCwd: "/home/maya/personal/garden-notes" });
    write("bench", { id: "bench", startCwd: "/home/maya/workshop/bench" });
    write("build", { id: "build", startCwd: "/srv/builds/atlas" });
    await cycle(null);

    expect(await list()).toEqual({
      "/home/maya": ["~", null],
      "/home/maya/work": ["~/work", "/home/maya"],
      "/home/maya/work/atlas-api": ["~/work/atlas-api", "/home/maya/work"],
      "/home/maya/work/atlas-api/docs": ["~/work/atlas-api/docs", "/home/maya/work/atlas-api"],
      "/home/maya/personal": ["~/personal", "/home/maya"],
      "/home/maya/personal/garden-notes": ["~/personal/garden-notes", "/home/maya/personal"],
      // Not under ~/work: ancestry is by whole path segments.
      "/home/maya/workshop": ["~/workshop", "/home/maya"],
      "/home/maya/workshop/bench": ["~/workshop/bench", "/home/maya/workshop"],
      "/srv": ["/srv", null],
      "/srv/builds": ["/srv/builds", "/srv"],
      "/srv/builds/atlas": ["/srv/builds/atlas", "/srv/builds"],
    });
  });

  test("listing reads no session file and does not grow with a session's days", async () => {
    write("short", { id: "short", startCwd: "/srv/work/atlas-api", days: 1 });
    await cycle(null);
    const short = await list();
    rmSync(join(root, "short.jsonl"));

    write("long", { id: "long", startCwd: "/srv/work/atlas-api", days: 400 });
    const { documents } = await cycle(null);
    expect(documents).toHaveLength(400);
    const parsed = parse.mock.calls.length;

    expect(await list()).toEqual(short);
    expect(await list()).toEqual(short);
    expect(parse).toHaveBeenCalledTimes(parsed);
  });

  test("a sync that re-reads nothing still lists every folder, from the cursor alone", async () => {
    write("atlas", { id: "atlas", startCwd: "/srv/work/atlas-api" });
    write("garden", { id: "garden", startCwd: "/srv/personal/garden-notes" });
    const first = await cycle(null);
    const listed = await list();
    const parsed = parse.mock.calls.length;

    // A collector that restarted: a new instance, the stored cursor, no file changed.
    instance = createLocalAgentSessionSource({
      providerId: PROVIDER,
      sourceId: SOURCE,
      homeDirectory: "/home/maya",
      adapter: {
        harnessId: "fictional-agent",
        agentName: "Nova",
        roots: [{ path: root }],
        fileExtensions: [".jsonl"],
        parserVersion: 1,
        parseSession: parse,
      },
    });
    await expect(list()).rejects.toThrow(/no session has been read yet/);
    const second = await cycle(first.cursor);

    expect(second.documents).toEqual([]);
    expect(parse).toHaveBeenCalledTimes(parsed);
    expect(await list()).toEqual(listed);
  });

  test("a sync from an empty cursor re-emits every session though no file changed", async () => {
    write("atlas", { id: "atlas", startCwd: "/srv/work/atlas-api", days: 2 });
    write("garden", { id: "garden", startCwd: "/srv/personal/garden-notes" });
    const first = await cycle(null);
    expect(first.documents).toHaveLength(3);

    const unchanged = await cycle(first.cursor);
    expect(unchanged.documents).toEqual([]);

    const again = await cycle(null);
    expect(again.documents.map((document) => document.externalId).sort()).toEqual(
      first.documents.map((document) => document.externalId).sort(),
    );
    expect(again.documents.every((document) => document.metadata.extra?.projectFolder)).toBe(true);
  });

  test("a cursor written before sessions carried a folder lists nothing until they are read again", async () => {
    write("atlas", { id: "atlas", startCwd: "/srv/work/atlas-api" });
    const first = await cycle(null);
    // The same cursor as an earlier build left it: no folder on any file.
    const older: LocalAgentSessionCursor = {
      ...first.cursor,
      files: Object.fromEntries(
        Object.entries(first.cursor.files).map(([key, { projectFolder: _folder, ...state }]) => [
          key,
          state,
        ]),
      ),
    };

    // An ordinary sync does not go back over sessions that did not change.
    const ordinary = await cycle(older);
    expect(ordinary.documents).toEqual([]);
    expect(await list()).toEqual({});

    const resynced = await cycle(null);
    expect(resynced.documents).toHaveLength(1);
    expect(Object.keys(await list())).toContain("/srv/work/atlas-api");
  });

  test("a session file that changes keeps the folder it started in", async () => {
    write("atlas", { id: "atlas", startCwd: "/srv/work/atlas-api" });
    const first = await cycle(null);
    write("atlas", {
      id: "atlas",
      startCwd: "/srv/work/atlas-api",
      cwd: "/srv/personal/garden-notes",
      days: 2,
    });
    const later = new Date(Date.now() + 5000);
    utimesSync(join(root, "atlas.jsonl"), later, later);
    const second = await cycle(first.cursor);

    expect(second.documents).toHaveLength(2);
    expect(second.documents.map((document) => document.metadata.extra?.projectFolder)).toEqual([
      "/srv/work/atlas-api",
      "/srv/work/atlas-api",
    ]);
    expect(Object.keys(await list())).not.toContain("/srv/personal/garden-notes");
  });

  test("a deleted session takes its folder out of the list", async () => {
    write("atlas", { id: "atlas", startCwd: "/srv/work/atlas-api" });
    write("garden", { id: "garden", startCwd: "/srv/personal/garden-notes" });
    const first = await cycle(null);
    unlinkSync(join(root, "garden.jsonl"));
    await cycle(first.cursor);

    expect(await list()).toEqual({
      "/srv": ["/srv", null],
      "/srv/work": ["/srv/work", "/srv"],
      "/srv/work/atlas-api": ["/srv/work/atlas-api", "/srv/work"],
    });
  });

  test("while a cycle still has files to read, no list is produced", async () => {
    for (let index = 0; index < 12; index++) {
      write(`s${index}`, { id: `s${index}`, startCwd: `/srv/work/project-${index}` });
    }
    const page = await instance.sync(null);
    expect(page.hasMore).toBe(true);
    // A part of the list would read as the rest no longer existing.
    await expect(list()).rejects.toThrow(/still being read/);

    await cycle(page.cursor);
    expect(Object.keys(await list())).toHaveLength(14);
  });
});
