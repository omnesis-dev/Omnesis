// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, describe, expect, test, vi } from "vitest";
// @ts-expect-error — portal is plain JS without sibling declarations.
import { deleteNoteEntry } from "./api.js";

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
