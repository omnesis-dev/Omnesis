// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import { hashText } from "./content-hash.js";

describe("hashText", () => {
  it("is stable: same text → same hash", async () => {
    const a = await hashText("the quick brown fox");
    const b = await hashText("the quick brown fox");
    expect(a).toBe(b);
  });

  it("is sensitive: changed text → different hash", async () => {
    const a = await hashText("revenue summary: northern region up 12 percent");
    const b = await hashText("revenue summary: northern region up 13 percent");
    expect(a).not.toBe(b);
  });

  it("matches the gateway's node:crypto SHA-256 hex (upsert-comparison parity)", async () => {
    // The gateway computes `contentHash` with node:crypto SHA-256 hex
    // (`@omnesis/core` computeContentHash). The extension uses Web Crypto. They
    // MUST agree, or the gateway would never treat an unchanged page as a no-op
    // upsert. This pins that equivalence.
    const text = "an invented page body about a fictional quarterly review";
    const web = await hashText(text);
    const node = createHash("sha256").update(text).digest("hex");
    expect(web).toBe(node);
  });

  it("returns lowercase hex of length 64", async () => {
    const h = await hashText("anything");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});
