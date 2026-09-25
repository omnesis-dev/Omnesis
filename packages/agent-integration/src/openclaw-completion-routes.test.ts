// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
      channel: "telegram",
      to: "FictionalRecipient",
      accountId: "fictional-account",
      threadId: "fictional-thread",
    });
    reopened.delete("native_fictional");
    expect(reopened.get("native_fictional")).toBeNull();
    reopened.close();
  });
});
