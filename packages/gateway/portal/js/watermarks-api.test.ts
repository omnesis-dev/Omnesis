// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, describe, expect, test, vi } from "vitest";
// @ts-expect-error — portal is plain JS without sibling declarations.
import { getSourceWatermark } from "./api.js";

afterEach(() => vi.unstubAllGlobals());

describe("source watermark API wrapper", () => {
  test("requests the source-scoped coverage record", async () => {
    const response = { items: [] };
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify(response), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(getSourceWatermark("mail:example account")).resolves.toEqual(response);
    expect(fetchMock).toHaveBeenCalledWith(
      "/admin/watermarks?sourceId=mail%3Aexample+account",
      expect.objectContaining({ method: "GET" }),
    );
  });
});
