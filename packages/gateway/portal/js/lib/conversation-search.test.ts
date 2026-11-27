// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";

import {
  conversationListPath,
  normalizeConversationQuery,
  orderSidebarConversations,
} from "./conversation-search.js";

describe("conversationListPath", () => {
  test("pages the plain list by cursor", () => {
    expect(conversationListPath({ limit: 50, cursor: null, query: "" })).toBe(
      "/agent/conversations?limit=50",
    );
    expect(conversationListPath({ limit: 50, cursor: "c1", query: "" })).toBe(
      "/agent/conversations?limit=50&cursor=c1",
    );
  });

  test("a query asks for matches, which come in one page", () => {
    expect(conversationListPath({ limit: 50, cursor: "c1", query: "Q4 budget" })).toBe(
      "/agent/conversations?limit=50&q=Q4+budget",
    );
  });
});

describe("normalizeConversationQuery", () => {
  test("trims, and bounds the length the gateway accepts", () => {
    expect(normalizeConversationQuery("  marathon  ")).toBe("marathon");
    expect(normalizeConversationQuery("   ")).toBe("");
    expect(normalizeConversationQuery(undefined)).toBe("");
    expect(normalizeConversationQuery("a".repeat(250))).toHaveLength(200);
  });
});

describe("orderSidebarConversations", () => {
  const rows = [
    { id: "a", pinned: false },
    { id: "b", pinned: true },
    { id: "c", pinned: false },
  ];

  test("the plain list puts pinned rows first, otherwise in order", () => {
    expect(orderSidebarConversations(rows, "").map((r) => r.id)).toEqual(["b", "a", "c"]);
  });

  test("search results keep the gateway's relevance order", () => {
    expect(orderSidebarConversations(rows, "budget").map((r) => r.id)).toEqual(["a", "b", "c"]);
  });
});
