// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { telegramStateSpec } from "./state.js";

describe("telegramStateSpec", () => {
  it("reads a current cursor and one without an archive identity", () => {
    expect(
      telegramStateSpec.decode({ phase: "incremental", committedSeq: 42, storeId: "store-1" }),
    ).toEqual({ phase: "incremental", committedSeq: 42, storeId: "store-1" });
    expect(telegramStateSpec.decode({ phase: "bootstrap", committedSeq: 0 })).toEqual({
      phase: "bootstrap",
      committedSeq: 0,
    });
  });

  it.each([
    null,
    "cursor",
    [],
    { phase: "walking", committedSeq: 1 },
    { phase: "incremental", committedSeq: -1 },
    { phase: "incremental", committedSeq: 1.5 },
    { phase: "incremental", committedSeq: 1, storeId: "" },
    { phase: "incremental", committedSeq: 1, storeId: 7 },
  ])("refuses %j", (value) => {
    expect(telegramStateSpec.decode(value)).toBeNull();
  });

  it("rebuilds from the archive rather than stopping when the cursor is unreadable", () => {
    expect(telegramStateSpec.onUnreadable).toBe("rebootstrap");
  });
});
