// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The project folder a Codex session is filed under: the working directory
 * recorded when the session started. Every session and path is invented.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { collectFilterList } from "@omnesis/source-sdk";
import { ProviderId, SourceId } from "@omnesis/types";
import source from "./index.js";

const SOURCE_ID = SourceId("codex:local");
const PROVIDER_ID = ProviderId("codex:local");
const FIELD = "extra.projectFolder";

function iso(minute: number): string {
  return new Date(2026, 2, 3, 10, minute).toISOString();
}

function line(type: string, minute: number, payload: Record<string, unknown>) {
  return { type, timestamp: iso(minute), payload };
}

function meta(cwd: string | undefined) {
  return line("session_meta", 0, {
    id: "codex-session-1",
    session_id: "codex-session-1",
    timestamp: iso(0),
    ...(cwd === undefined ? {} : { cwd }),
    source: "cli",
    model_provider: "openai",
  });
}

function turn(minute: number, cwd: string | undefined, text: string) {
  return [
    line("turn_context", minute, { ...(cwd === undefined ? {} : { cwd }), model: "gpt-fictional" }),
    line("event_msg", minute, { type: "user_message", message: `Invented prompt: ${text}` }),
    line("response_item", minute, {
      type: "message",
      role: "assistant",
      phase: "final_answer",
      content: [{ type: "output_text", text: `Invented answer: ${text}` }],
    }),
  ];
}

describe("Codex project folder", () => {
  let codexHome: string | undefined;

  afterEach(() => {
    if (codexHome) rmSync(codexHome, { recursive: true, force: true });
    codexHome = undefined;
  });

  async function syncRows(rows: Record<string, unknown>[]) {
    codexHome = mkdtempSync(join(tmpdir(), "codex-folder-"));
    const directory = join(codexHome, "sessions", "2026", "03", "03");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "rollout-codex-session-1.jsonl"),
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    );
    const instance = await source.create!({
      accountId: "local",
      sourceId: SOURCE_ID,
      providerId: PROVIDER_ID,
      config: { codexHome },
    });
    const result = await instance.sync(null);
    const listed = await collectFilterList(instance.filterLists![FIELD]!, {
      signal: new AbortController().signal,
    });
    expect(result.documents).toHaveLength(1);
    const extra = result.documents[0]!.metadata.extra as Record<string, unknown>;
    return {
      folder: "projectFolder" in extra ? extra.projectFolder : "absent",
      cwd: extra.cwd,
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
    expect(source.resyncCost).toMatch(/Codex session files are read again/);
  });

  test("the directory of the session start decides, whatever later turns record", async () => {
    const session = await syncRows([
      meta("/srv/work/billing"),
      ...turn(1, "/srv/work/billing", "rounding"),
      ...turn(2, "/srv/work/billing/api", "retries"),
      ...turn(3, "/srv/personal/garden-notes", "watering"),
    ]);
    expect(session.folder).toBe("/srv/work/billing");
    expect(session.cwd).toBe("/srv/personal/garden-notes");
    expect(session.ids).toEqual(["/srv", "/srv/work", "/srv/work/billing"]);
  });

  test("the start directory wins even when the very first turn already differs", async () => {
    const session = await syncRows([
      meta("/srv/work/atlas-api"),
      ...turn(1, "/srv/workshop/bench", "labels"),
    ]);
    expect(session.folder).toBe("/srv/work/atlas-api");
  });

  test("a session whose start recorded no directory takes its first turn's", async () => {
    const session = await syncRows([
      meta(undefined),
      ...turn(1, "/srv/work/atlas-api", "cursor"),
      ...turn(2, "/srv/personal/garden-notes", "watering"),
    ]);
    expect(session.folder).toBe("/srv/work/atlas-api");
    expect(session.cwd).toBe("/srv/personal/garden-notes");
  });

  test("a session that never recorded a directory carries no folder at all", async () => {
    const session = await syncRows([meta(undefined), ...turn(1, undefined, "cursor")]);
    expect(session.folder).toBe("absent");
    expect(session.ids).toEqual([]);
  });
});
