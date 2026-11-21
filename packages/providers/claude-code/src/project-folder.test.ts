// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The project folder a session of this source is filed under: the working
 * directory of the first entry of the conversation, whatever came later.
 * Every session and path is invented.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { collectFilterList } from "@omnesis/source-sdk";
import { ProviderId, SourceId } from "@omnesis/types";
import source from "./index.js";

const SOURCE_ID = SourceId("claude-code:local");
const PROVIDER_ID = ProviderId("claude-code:local");
const SESSION = "claude-session-1";
const FIELD = "extra.projectFolder";

function at(day: number, minute: number): string {
  return new Date(2026, 2, day, 10, minute).toISOString();
}

function node(type: string, uuid: string, parentUuid: string | null, timestamp: string) {
  return { type, uuid, parentUuid, sessionId: SESSION, timestamp, isSidechain: false };
}

function user(
  uuid: string,
  parentUuid: string | null,
  timestamp: string,
  cwd: string | undefined,
  text = `Invented prompt ${uuid}`,
) {
  return {
    ...node("user", uuid, parentUuid, timestamp),
    ...(cwd === undefined ? {} : { cwd }),
    userType: "external",
    message: { role: "user", content: text },
  };
}

function assistant(
  uuid: string,
  parentUuid: string,
  timestamp: string,
  cwd: string | undefined,
  text = `Invented answer ${uuid}`,
) {
  return {
    ...node("assistant", uuid, parentUuid, timestamp),
    ...(cwd === undefined ? {} : { cwd }),
    message: {
      id: `msg-${uuid}`,
      role: "assistant",
      model: "claude-fictional",
      stop_reason: "end_turn",
      content: [{ type: "text", text }],
    },
  };
}

describe("Claude Code project folder", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  async function syncRows(rows: unknown[]) {
    const root = mkdtempSync(join(tmpdir(), "omnesis-claude-folder-"));
    roots.push(root);
    writeFileSync(
      join(root, `${SESSION}.jsonl`),
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    );
    const instance = await source.create!({
      accountId: "local",
      sourceId: SOURCE_ID,
      providerId: PROVIDER_ID,
      config: { sessionsPath: root },
    });
    const result = await instance.sync(null);
    const listed = await collectFilterList(instance.filterLists![FIELD]!, {
      signal: new AbortController().signal,
    });
    return { result, ids: listed.map((item) => item.id) };
  }

  const folders = (documents: Array<{ metadata: { extra?: Record<string, unknown> } }>) =>
    documents.map((document) =>
      document.metadata.extra && "projectFolder" in document.metadata.extra
        ? document.metadata.extra.projectFolder
        : "absent",
    );

  test("declares the field from version 2 and says what a resync costs", () => {
    expect(source.contract?.outputRevision).toBe(2);
    expect(source.multiDevice?.mode).toBe("partitioned");
    const field = source.documentEventProfile?.metadataFields?.find((f) => f.path === FIELD);
    expect(field).toMatchObject({
      type: "string",
      filter: {
        capability: "tree",
        minVersion: 2,
        scope: "device",
        noun: { one: "project folder", many: "project folders" },
        picker: "tree",
        inside: { one: "project folder", many: "project folders" },
      },
    });
    expect(source.resyncCost).toMatch(/Claude Code session files are read again/);
    expect(source.resyncCost).toMatch(/nothing is downloaded/);
  });

  test("a session that moves elsewhere stays filed under the folder it started in", async () => {
    const { result, ids } = await syncRows([
      user("u1", null, at(1, 0), "/srv/work/atlas-api"),
      assistant("a1", "u1", at(1, 1), "/srv/work/atlas-api"),
      user("u2", "a1", at(2, 0), "/srv/personal/garden-notes"),
      assistant("a2", "u2", at(2, 1), "/srv/personal/garden-notes"),
    ]);

    expect(result.documents).toHaveLength(2);
    expect(folders(result.documents)).toEqual(["/srv/work/atlas-api", "/srv/work/atlas-api"]);
    // The last directory keeps its own field.
    expect(result.documents.map((doc) => doc.metadata.extra?.cwd)).toEqual([
      "/srv/personal/garden-notes",
      "/srv/personal/garden-notes",
    ]);
    expect(ids).toEqual(["/srv", "/srv/work", "/srv/work/atlas-api"]);
  });

  test("a session that starts in a subfolder stays under that subfolder", async () => {
    const { result } = await syncRows([
      user("u1", null, at(1, 0), "/srv/work/atlas-api/docs"),
      assistant("a1", "u1", at(1, 1), "/srv/work/atlas-api"),
    ]);
    expect(folders(result.documents)).toEqual(["/srv/work/atlas-api/docs"]);
  });

  test("the first entry that records a directory decides, when earlier ones record none", async () => {
    const { result } = await syncRows([
      user("u1", null, at(1, 0), undefined),
      assistant("a1", "u1", at(1, 1), "/srv/work/billing"),
      user("u2", "a1", at(1, 2), "/srv/workshop/bench"),
      assistant("a2", "u2", at(1, 3), "/srv/workshop/bench"),
    ]);
    expect(folders(result.documents)).toEqual(["/srv/work/billing"]);
  });

  test("a compacted session is filed under where it started before the compaction", async () => {
    const { result } = await syncRows([
      user("d1u", null, at(1, 0), "/srv/work/atlas-api"),
      assistant("d1a", "d1u", at(1, 1), "/srv/work/atlas-api"),
      {
        ...node("system", "d2b", null, at(2, 0)),
        cwd: "/srv/personal/garden-notes",
        subtype: "compact_boundary",
        content: "Conversation compacted",
        logicalParentUuid: "d1a",
      },
      user("d2u", "d2b", at(2, 1), "/srv/personal/garden-notes"),
      assistant("d2a", "d2u", at(2, 2), "/srv/personal/garden-notes"),
      { type: "last-prompt", sessionId: SESSION, leafUuid: "d2a" },
    ]);

    expect(result.documents).toHaveLength(2);
    expect(folders(result.documents)).toEqual(["/srv/work/atlas-api", "/srv/work/atlas-api"]);
  });

  test("an abandoned branch does not decide the folder of the conversation kept", async () => {
    // Written first in the file, but not on the path from the first entry to
    // the entry the session ends on.
    const { result } = await syncRows([
      user("u1", null, at(1, 0), "/srv/work/atlas-api"),
      assistant("x1", "u1", at(1, 1), "/srv/workshop/bench", "Abandoned invented answer"),
      assistant("a1", "u1", at(1, 2), "/srv/work/atlas-api"),
      { type: "last-prompt", sessionId: SESSION, leafUuid: "a1" },
    ]);
    expect(folders(result.documents)).toEqual(["/srv/work/atlas-api"]);
  });

  test("a session whose entries record no directory carries no folder at all", async () => {
    const { result, ids } = await syncRows([
      user("u1", null, at(1, 0), undefined),
      assistant("a1", "u1", at(1, 1), undefined),
    ]);
    expect(result.documents).toHaveLength(1);
    expect(folders(result.documents)).toEqual(["absent"]);
    expect(ids).toEqual([]);
  });
});
