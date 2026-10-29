// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test } from "vitest";

import { OpenClawCompletionRoutes } from "./openclaw-completion-routes.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("OpenClawCompletionRoutes", () => {
  test("persists an opaque callback handle with the exact trusted channel route", () => {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-openclaw-completion-routes-"));
    tempDirs.push(dir);
    const first = new OpenClawCompletionRoutes(join(dir, "routes.sqlite"));
    first.put({
      nativeConversationId: "native_fictional",
      taskId: "task_fictional",
      sessionKey: "agent:main:telegram:dm:fictional",
      sessionId: "fictional-era",
      channel: "telegram",
      to: "FictionalRecipient",
      accountId: "fictional-account",
      threadId: "fictional-thread",
    });
    first.close();

    const reopened = new OpenClawCompletionRoutes(join(dir, "routes.sqlite"));
    expect(reopened.get("native_fictional")).toEqual({
      nativeConversationId: "native_fictional",
      taskId: "task_fictional",
      sessionKey: "agent:main:telegram:dm:fictional",
      sessionId: "fictional-era",
      channel: "telegram",
      to: "FictionalRecipient",
      accountId: "fictional-account",
      threadId: "fictional-thread",
    });
    reopened.delete("native_fictional");
    expect(reopened.get("native_fictional")).toBeNull();
    reopened.close();
  });
  test("upgrades a channel-only store without inventing a native session", () => {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-openclaw-legacy-routes-"));
    tempDirs.push(dir);
    const path = join(dir, "routes.sqlite");
    const legacy = new DatabaseSync(path);
    legacy.exec(`CREATE TABLE openclaw_answer_completion_routes (
      native_conversation_id TEXT PRIMARY KEY, task_id TEXT NOT NULL,
      channel TEXT NOT NULL, destination TEXT NOT NULL, account_id TEXT,
      thread_id_json TEXT, created_at INTEGER NOT NULL
    ) STRICT`);
    legacy
      .prepare("INSERT INTO openclaw_answer_completion_routes VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(
        "native_legacy",
        "task_legacy",
        "telegram",
        "fictional-recipient",
        null,
        null,
        Date.now(),
      );
    legacy.close();
    const routes = new OpenClawCompletionRoutes(path);
    expect(routes.get("native_legacy")).toEqual({
      nativeConversationId: "native_legacy",
      taskId: "task_legacy",
      channel: "telegram",
      to: "fictional-recipient",
    });
    routes.put({
      ...routes.get("native_legacy")!,
      sessionKey: "agent:main:telegram:dm:fictional",
      sessionId: "fictional-era",
    });
    routes.close();
    const reopened = new OpenClawCompletionRoutes(path);
    expect(reopened.get("native_legacy")).toMatchObject({
      sessionKey: "agent:main:telegram:dm:fictional",
      sessionId: "fictional-era",
    });
    reopened.close();
  });
});
