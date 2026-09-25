// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { messageWithTimeout } from "./message-timeout.js";

describe("messageWithTimeout", () => {
  it("releases a content-side lookup whose worker never responds", async () => {
    await expect(messageWithTimeout(new Promise(() => undefined), 5)).rejects.toThrow(/timed out/i);
  });

  it("passes through a prompt acknowledgement", async () => {
    await expect(messageWithTimeout(Promise.resolve({ ok: true }), 50)).resolves.toEqual({
      ok: true,
    });
  });
});
