// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, describe, expect, test, vi } from "vitest";
// @ts-expect-error — portal is plain JS without sibling declarations.
import { deleteNoteEntry, getNotesProvenance, getCalendarItem } from "./api.js";

afterEach(() => vi.unstubAllGlobals());

describe("note entry delete", () => {
  test("a 204 resolves instead of throwing on the empty body", async () => {
    // The route answers 204 with an empty body. res.json() throws on the
    // empty stream, which used to turn a successful delete into a reported
    // failure ("Couldn't delete the note") while the note was gone.
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(deleteNoteEntry("note-1")).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      "/notes/note-1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});


describe("note reference reads", () => {
  test("passes the note day and calendar timezone to the provenance endpoint", async () => {
    const fetchMock = vi.fn(async () => Response.json({ mentions: [], annotations: [], loops: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await getNotesProvenance("2026-09-11", "America/New_York");
    expect(fetchMock).toHaveBeenCalledWith(
      "/notes/provenance?day=2026-09-11&timeZone=America%2FNew_York",
      expect.objectContaining({ method: "GET" }),
    );
  });

  test("calendar deep links read a temporal item by its encoded id", async () => {
    const fetchMock = vi.fn(async () => Response.json({ item: {} }));
    vi.stubGlobal("fetch", fetchMock);
    await getCalendarItem("dm_example/1", "UTC");
    expect(fetchMock).toHaveBeenCalledWith(
      "/temporal/items/dm_example%2F1?timeZone=UTC",
      expect.objectContaining({ method: "GET" }),
    );
  });
});
