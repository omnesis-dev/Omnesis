// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { Hono } from "hono";
import { describe, expect, test, vi } from "vitest";
import { SCOPE_ADMIN, SCOPE_READ, type DeviceId, type Scope, type TokenId } from "@omnesis/types";
import { HttpError, errorResponse } from "../errors.js";
import { strictRoute } from "../scope.js";
import { mountAgentRoutes } from "./agent.js";
import type { ConversationReader } from "../../agent/conversation-reader.js";
import type { ConversationRecord } from "../../agent/conversation-store.js";
import type { DailyBriefDetailReader } from "../../agent/daily-brief-detail.js";
import type { AppEnv } from "./types.js";

const BRIEF_THREAD: ConversationRecord = {
  id: "conv_brief",
  callerId: "brain:morning-brief",
  model: "m",
  backend: "b",
  createdAt: "2026-10-13T06:00:00.000Z",
  updatedAt: "2026-10-14T06:02:40.055Z",
  title: "Morning brief",
  pinned: true,
  origin: {
    kind: "daily_brief",
    runId: "run_2",
    briefs: [
      { day: "2026-10-13", messageIndex: 0, messageId: "mb_old" },
      {
        day: "2026-10-14",
        messageIndex: 2,
        messageId: "mb_new",
        sentAt: "2026-10-14T06:02:40.055Z",
      },
    ],
  },
  messages: [
    { role: "assistant", parts: [{ kind: "text", text: "Yesterday's brief." }] },
    { role: "user", parts: [{ kind: "text", text: "Thanks." }] },
    { role: "assistant", parts: [{ kind: "text", text: "Today's brief." }] },
  ],
};

const PLAIN: ConversationRecord = {
  ...BRIEF_THREAD,
  id: "conv_plain",
  title: "A chat",
  pinned: false,
  origin: undefined,
};

function reader(): ConversationReader {
  const records = new Map([BRIEF_THREAD, PLAIN].map((r) => [r.id, r]));
  return {
    listConversationPage: () =>
      Promise.resolve({ conversations: [], pageInfo: { hasMore: false } }) as never,
    loadConversation: (id) => Promise.resolve(records.get(id) ?? null),
    listConversationMessages: () => Promise.resolve(null),
  };
}

const ITEM = {
  rank: 1,
  observationId: "obs_offer",
  summary: "The loan offer expires on Friday.",
  sources: [
    {
      id: "doc_offer",
      title: "Loan offer letter",
      sourceType: "gmail",
      createdAt: "2026-10-05T09:00:00.000Z",
    },
  ],
  tasks: [{ id: "loop_boiler", title: "Book the boiler engineer", state: "open" }],
};

function buildApp(
  detail: DailyBriefDetailReader | undefined,
  scopes: Scope[] = [SCOPE_ADMIN] as Scope[],
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.onError((err, c) => {
    if (err instanceof HttpError) return errorResponse(c, err);
    throw err;
  });
  app.use("*", async (c, next) => {
    c.set("auth", {
      authMethod: "bearer",
      deviceId: "test-device" as DeviceId,
      tokenId: "tokenA" as TokenId,
      scopes,
    });
    await next();
  });
  mountAgentRoutes(strictRoute(app), {
    agentService: undefined,
    conversationReader: reader(),
    disabledReason: "no model",
    ...(detail ? { dailyBriefDetail: detail } : {}),
  });
  return app;
}

describe("GET /agent/conversations/:id/briefs/:day", () => {
  test("serves the day's ranked items with the recorded send time", async () => {
    const detail = vi.fn<DailyBriefDetailReader>(() => ({
      sentAt: "2026-10-14T06:02:41.000Z",
      items: [ITEM],
    }));
    const res = await buildApp(detail).request("/agent/conversations/conv_brief/briefs/2026-10-14");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      day: "2026-10-14",
      messageId: "mb_new",
      sentAt: "2026-10-14T06:02:41.000Z",
      items: [ITEM],
    });
    expect(detail).toHaveBeenCalledWith({ day: "2026-10-14", messageId: "mb_new" });
  });

  test("falls back to the reference's send time, and omits one neither records", async () => {
    const detail: DailyBriefDetailReader = () => ({ sentAt: null, items: [] });
    const app = buildApp(detail);
    const today = await app.request("/agent/conversations/conv_brief/briefs/2026-10-14");
    expect(await today.json()).toEqual({
      day: "2026-10-14",
      messageId: "mb_new",
      sentAt: "2026-10-14T06:02:40.055Z",
      items: [],
    });
    const older = await app.request("/agent/conversations/conv_brief/briefs/2026-10-13");
    expect(await older.json()).toEqual({ day: "2026-10-13", messageId: "mb_old", items: [] });
  });

  test("reads as based on nothing where no Brain supplies the detail", async () => {
    const res = await buildApp(undefined).request(
      "/agent/conversations/conv_brief/briefs/2026-10-14",
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ messageId: "mb_new", items: [] });
  });

  test("404s for a day with no brief, another conversation, or an unknown one", async () => {
    const app = buildApp(() => ({ sentAt: null, items: [ITEM] }));
    for (const path of [
      "/agent/conversations/conv_brief/briefs/2026-10-12",
      "/agent/conversations/conv_plain/briefs/2026-10-14",
      "/agent/conversations/conv_missing/briefs/2026-10-14",
    ]) {
      const res = await app.request(path);
      expect(res.status, path).toBe(404);
      expect(await res.json(), path).toMatchObject({ error: expect.any(String) });
    }
  });

  test("400s on a malformed day", async () => {
    const app = buildApp(() => ({ sentAt: null, items: [] }));
    for (const day of ["today", "2026-10-1", "2026-02-30", "2026-13-01"]) {
      const res = await app.request(`/agent/conversations/conv_brief/briefs/${day}`);
      expect(res.status, day).toBe(400);
    }
  });

  test("needs the same admin scope as reading the conversation", async () => {
    const res = await buildApp(() => ({ sentAt: null, items: [] }), [
      SCOPE_READ,
    ] as Scope[]).request("/agent/conversations/conv_brief/briefs/2026-10-14");
    expect(res.status).toBe(403);
  });
});
