// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, describe, expect, test, vi } from "vitest";
// @ts-expect-error — portal is plain JS without sibling declarations.
import {
  getDocumentAnnotations,
  getDocumentNearDupes,
  getPersonAnnotations,
} from "./api.js";

afterEach(() => vi.unstubAllGlobals());

function unavailable() {
  return new Response("temporarily unavailable", { status: 503 });
}

describe("optional paged API wrappers", () => {
  test.each([
    ["document annotations", () => getDocumentAnnotations("doc_1", { limit: 20 })],
    ["person annotations", () => getPersonAnnotations("person_1", { limit: 20 })],
    ["near duplicates", () => getDocumentNearDupes("doc_1", { limit: 20 })],
  ])("keeps the initial optional %s load non-fatal", async (_label, call) => {
    vi.stubGlobal("fetch", vi.fn(async () => unavailable()));
    await expect(call()).resolves.toBeTruthy();
  });

  test.each([
    [
      "document annotations",
      () => getDocumentAnnotations("doc_1", { limit: 20, cursor: "next/page" }),
    ],
    [
      "person annotations",
      () => getPersonAnnotations("person_1", { limit: 20, cursor: "next/page" }),
    ],
    [
      "near duplicates",
      () => getDocumentNearDupes("doc_1", { limit: 20, cursor: "next/page" }),
    ],
  ])("surfaces a failed %s continuation so the footer can retry", async (_label, call) => {
    vi.stubGlobal("fetch", vi.fn(async () => unavailable()));
    await expect(call()).rejects.toMatchObject({ status: 503 });
  });
});
