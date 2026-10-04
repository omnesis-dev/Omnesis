// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import source from "./index.js";

describe("openclaw source identity", () => {
  test("advertises the bundled agent mark without a gateway or remote URL", () => {
    const uri = source.icon?.imageDataUri;
    expect(uri).toMatch(/^data:image\/svg[+]xml;base64,/);
    const original = readFileSync(
      new URL("../../../gateway/portal/img/agents/openclaw.svg", import.meta.url),
    );
    expect(Buffer.from(uri!.split(",")[1], "base64")).toEqual(original);
    expect(source.icon?.url).toBeUndefined();
    expect(source.icon?.sfSymbol).toBeTruthy();
  });
});
