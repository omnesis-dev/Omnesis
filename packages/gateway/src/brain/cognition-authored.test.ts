// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The cognition-authored registry: the predicate the reactive plane gates on,
 * the SQL fragment corpus scans exclude with, and the subset the retrieval
 * layer hides. Findable and reactable are independent axes, so the tests pin
 * both — including the case that matters most, an entry that is unreactable
 * while staying fully searchable.
 */

import { describe, expect, test } from "vitest";

import { HIDDEN_SEARCH_SOURCES, hiddenSourceIdsToExclude } from "../search/hidden-sources.js";
import { OMNESIS_CHAT_SOURCE_ID } from "../sources/omnesis-chat/source-meta.js";
import {
  COGNITION_AUTHORED_SOURCES,
  cognitionAuthoredDocumentTypes,
  cognitionAuthoredSqlExclusion,
  isCognitionAuthoredDocument,
} from "./cognition-authored.js";
import { OPEN_LOOP_DOCUMENT_TYPE, OPEN_LOOP_SOURCE_ID } from "./open-loop-source/source-meta.js";

describe("isCognitionAuthoredDocument", () => {
  test("recognises the open-loop mirror by source id", () => {
    expect(isCognitionAuthoredDocument(OPEN_LOOP_SOURCE_ID, "email")).toBe(true);
  });

  test("recognises the mirror by its exclusive document type alone", () => {
    expect(isCognitionAuthoredDocument("some-other-source", OPEN_LOOP_DOCUMENT_TYPE)).toBe(true);
  });

  test("recognises the agent transcript source", () => {
    expect(isCognitionAuthoredDocument(OMNESIS_CHAT_SOURCE_ID, "conversation")).toBe(true);
  });

  test("a shared document type does NOT make an ordinary source cognition-authored", () => {
    // The load-bearing case. The agent transcript's type is `conversation`,
    // which every messaging source also emits. Were that type registered, the
    // reactive plane would silently stop reacting to the operator's real
    // messages — the exact opposite of what this registry is for.
    expect(isCognitionAuthoredDocument("whatsapp-messages:+15550100123", "conversation")).toBe(
      false,
    );
    expect(isCognitionAuthoredDocument("apple-imessage:someone@example.com", "conversation")).toBe(
      false,
    );
  });

  test("ordinary corpus documents are not cognition-authored", () => {
    expect(isCognitionAuthoredDocument("gmail:someone@example.com", "email")).toBe(false);
    expect(isCognitionAuthoredDocument("omnesis-notes", "note")).toBe(false);
  });

  test("null and undefined identity fields are not cognition-authored", () => {
    expect(isCognitionAuthoredDocument(null, null)).toBe(false);
    expect(isCognitionAuthoredDocument(undefined)).toBe(false);
  });
});

describe("cognitionAuthoredSqlExclusion", () => {
  test("covers every registered source, including those with no exclusive type", () => {
    const { sql, params } = cognitionAuthoredSqlExclusion();
    expect(params).toEqual([...new Set(COGNITION_AUTHORED_SOURCES.map((s) => s.sourceId))]);
    expect(params).toContain(OMNESIS_CHAT_SOURCE_ID);
    expect(sql).toBe(`source_id NOT IN (${params.map(() => "?").join(", ")})`);
  });

  test("honours a caller-supplied column name", () => {
    expect(cognitionAuthoredSqlExclusion("d.source_id").sql.startsWith("d.source_id NOT IN")).toBe(
      true,
    );
  });
});

describe("cognitionAuthoredDocumentTypes", () => {
  test("lists exclusive types only — never a type an ordinary source shares", () => {
    const types = cognitionAuthoredDocumentTypes();
    expect(types).toContain(OPEN_LOOP_DOCUMENT_TYPE);
    // A type-only deny-list must not be able to drop real conversations.
    expect(types).not.toContain("conversation");
  });

  test("covers every exclusive type in the registry", () => {
    expect(cognitionAuthoredDocumentTypes().sort()).toEqual(
      [...new Set(COGNITION_AUTHORED_SOURCES.flatMap((s) => s.exclusiveDocumentTypes))].sort(),
    );
  });
});

describe("registry", () => {
  test("holds the concrete identities", () => {
    // Asserted by value, not by shape: were the ids ever to evaluate as
    // undefined (a circular import, a renamed constant), every gate would
    // degrade silently to "nothing is cognition-authored" and still pass.
    expect(COGNITION_AUTHORED_SOURCES).toEqual([
      { sourceId: "open-loops", exclusiveDocumentTypes: ["open-loop"], hiddenFromSearch: true },
      { sourceId: "omnesis-chat", exclusiveDocumentTypes: [], hiddenFromSearch: false },
    ]);
  });

  test("is frozen", () => {
    expect(Object.isFrozen(COGNITION_AUTHORED_SOURCES)).toBe(true);
    expect(COGNITION_AUTHORED_SOURCES.every((m) => Object.isFrozen(m))).toBe(true);
  });

  test("a hidden source declares an exclusive type to carry its bypass", () => {
    for (const entry of COGNITION_AUTHORED_SOURCES) {
      // Without one, nothing but an explicit source-id filter could ever
      // reach a hidden source — `open_loop_search` filters by type.
      if (entry.hiddenFromSearch) expect(entry.exclusiveDocumentTypes.length).toBeGreaterThan(0);
    }
  });
});

describe("retrieval is a subset of the reactive policy", () => {
  test("the mirror is hidden from search", () => {
    expect(HIDDEN_SEARCH_SOURCES.map((s) => s.sourceId)).toContain(OPEN_LOOP_SOURCE_ID);
    expect(hiddenSourceIdsToExclude({})).toContain(OPEN_LOOP_SOURCE_ID);
  });

  test("the agent transcript is unreactable but still findable", () => {
    // The whole reason the two axes are separate: gating a source out of the
    // reactive plane must not make the operator's own conversations
    // unsearchable.
    expect(isCognitionAuthoredDocument(OMNESIS_CHAT_SOURCE_ID)).toBe(true);
    expect(HIDDEN_SEARCH_SOURCES.map((s) => s.sourceId)).not.toContain(OMNESIS_CHAT_SOURCE_ID);
    expect(hiddenSourceIdsToExclude({})).not.toContain(OMNESIS_CHAT_SOURCE_ID);
  });

  test("the hidden list carries the mirror's bypass key", () => {
    const mirror = HIDDEN_SEARCH_SOURCES.find((s) => s.sourceId === OPEN_LOOP_SOURCE_ID);
    expect(mirror?.documentTypes).toEqual([OPEN_LOOP_DOCUMENT_TYPE]);
    // Naming the type bypasses hiding — this is what `open_loop_search` rides on.
    expect(hiddenSourceIdsToExclude({ documentTypes: [OPEN_LOOP_DOCUMENT_TYPE] })).not.toContain(
      OPEN_LOOP_SOURCE_ID,
    );
  });
});
