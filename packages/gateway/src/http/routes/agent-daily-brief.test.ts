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
import type { BriefItemReactor } from "../../brain/observations/brief-reactions.js";
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
  reactor?: BriefItemReactor,
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
    ...(reactor ? { briefItemReaction: reactor } : {}),
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

describe("PUT /agent/conversations/:id/briefs/:day/items/:observationId/reaction", () => {
  const PATH = "/agent/conversations/conv_brief/briefs/2026-10-14/items/obs_offer/reaction";
  const put = (app: Hono<AppEnv>, body: unknown, path = PATH) =>
    app.request(path, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  test("hands the reaction to the reactor with the day's message and answers its view", async () => {
    const reactor = vi.fn<BriefItemReactor>(async (input) => ({
      ok: true,
      reaction: {
        observationId: input.observationId,
        reaction: input.reaction,
        ...(input.note ? { note: input.note } : {}),
        ...(input.noteId ? { noteId: input.noteId } : {}),
        at: "2026-10-14T08:00:00.000Z",
      },
    }));
    const app = buildApp(undefined, undefined, reactor);
    const res = await put(app, {
      reaction: "factual_error",
      note: "  The offer expires Monday.  ",
      noteId: "11111111-1111-4111-8111-111111111111",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      observationId: "obs_offer",
      reaction: "factual_error",
      note: "The offer expires Monday.",
      noteId: "11111111-1111-4111-8111-111111111111",
      at: "2026-10-14T08:00:00.000Z",
    });
    expect(reactor).toHaveBeenCalledWith({
      day: "2026-10-14",
      messageId: "mb_new",
      observationId: "obs_offer",
      reaction: "factual_error",
      note: "The offer expires Monday.",
      noteId: "11111111-1111-4111-8111-111111111111",
    });

    const cleared = await put(app, { reaction: null });
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toEqual({
      observationId: "obs_offer",
      reaction: null,
      at: "2026-10-14T08:00:00.000Z",
    });
    expect(reactor).toHaveBeenLastCalledWith({
      day: "2026-10-14",
      messageId: "mb_new",
      observationId: "obs_offer",
      reaction: null,
    });
  });

  test("404s for a day with no brief, another conversation, or an unknown one", async () => {
    const reactor = vi.fn<BriefItemReactor>();
    const app = buildApp(undefined, undefined, reactor);
    for (const path of [
      "/agent/conversations/conv_brief/briefs/2026-10-12/items/obs_offer/reaction",
      "/agent/conversations/conv_plain/briefs/2026-10-14/items/obs_offer/reaction",
      "/agent/conversations/conv_missing/briefs/2026-10-14/items/obs_offer/reaction",
    ]) {
      const res = await put(app, { reaction: "up" }, path);
      expect(res.status, path).toBe(404);
    }
    expect(reactor).not.toHaveBeenCalled();
  });

  test("the reactor's refusals map to 404 and 503", async () => {
    const reactor = vi
      .fn<BriefItemReactor>()
      .mockResolvedValueOnce({ ok: false, reason: "not_an_item", message: "not an item" })
      .mockResolvedValueOnce({ ok: false, reason: "notes_unavailable", message: "no notes" });
    const app = buildApp(undefined, undefined, reactor);
    const missing = await put(app, { reaction: "up" });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: "not an item" });
    const unavailable = await put(app, { reaction: "factual_error", note: "wrong day" });
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({ error: "no notes" });
  });

  test("400s on a body that is not a reaction", async () => {
    const reactor = vi.fn<BriefItemReactor>();
    const app = buildApp(undefined, undefined, reactor);
    for (const body of [
      {},
      { reaction: "down" },
      { reaction: "up", note: "   " },
      { reaction: "up", note: "x".repeat(2001) },
      { reaction: "up", noteId: "not-a-uuid" },
      { reaction: "up", extra: true },
    ]) {
      const res = await put(app, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(reactor).not.toHaveBeenCalled();
  });

  test("needs the admin scope", async () => {
    const reactor = vi.fn<BriefItemReactor>();
    const res = await put(buildApp(undefined, [SCOPE_READ] as Scope[], reactor), {
      reaction: "up",
    });
    expect(res.status).toBe(403);
    expect(reactor).not.toHaveBeenCalled();
  });

  test("does not exist where no Brain supplies the reactor", async () => {
    const res = await put(buildApp(undefined), { reaction: "up" });
    expect(res.status).toBe(404);
  });
});
