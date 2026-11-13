// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The project folder a Pi session is filed under: the working directory in
 * the session file's header. Every session and path is invented.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { collectFilterList } from "@omnesis/source-sdk";
import { ProviderId, SourceId } from "@omnesis/types";
import source from "./index.js";

const SOURCE_ID = SourceId("pi:local");
const PROVIDER_ID = ProviderId("pi:local");
const FIELD = "extra.projectFolder";
const AT = new Date(2026, 2, 4, 10, 0);

describe("Pi project folder", () => {
  let root: string | undefined;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  async function syncHeader(cwd: string) {
    root = mkdtempSync(join(tmpdir(), "pi-folder-"));
    const rows = [
      { type: "session", version: 3, id: "pi-session-1", timestamp: AT.toISOString(), cwd },
      {
        type: "message",
        id: "u1",
        parentId: null,
        timestamp: AT.toISOString(),
        message: {
          role: "user",
          content: [{ type: "text", text: "Invented prompt about the watering log" }],
          timestamp: AT.getTime(),
        },
      },
    ];
    writeFileSync(
      join(root, "pi-session.jsonl"),
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
    expect(result.documents).toHaveLength(1);
    const extra = result.documents[0]!.metadata.extra as Record<string, unknown>;
    return {
      folder: "projectFolder" in extra ? extra.projectFolder : "absent",
      ids: listed.map((item) => item.id),
    };
  }

  test("declares the field from version 2 and says what a resync costs", () => {
    expect(source.contract?.outputRevision).toBe(2);
    expect(source.multiDevice?.mode).toBe("partitioned");
    const field = source.documentEventProfile?.metadataFields?.find((f) => f.path === FIELD);
    expect(field).toMatchObject({
      type: "string",
      filter: { capability: "tree", minVersion: 2, scope: "device", picker: "tree" },
    });
    expect(source.resyncCost).toMatch(/Pi session files are read again/);
  });

  test("a session is filed under the directory in its header", async () => {
    const session = await syncHeader("/srv/personal/garden-notes/");
    expect(session.folder).toBe("/srv/personal/garden-notes");
    expect(session.ids).toEqual(["/srv", "/srv/personal", "/srv/personal/garden-notes"]);
  });

  test("a header whose directory is not an absolute path gives no folder at all", async () => {
    const session = await syncHeader("");
    expect(session.folder).toBe("absent");
    expect(session.ids).toEqual([]);
  });
});
