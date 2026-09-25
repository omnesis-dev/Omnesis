// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { SyncError } from "@omnesis/types";
import { mapImapError } from "./client.js";

describe("mapImapError", () => {
  it("maps credential rejection without exposing server text", () => {
    const error = Object.assign(new Error("LOGIN failed for account@example.com"), {
      authenticationFailed: true,
    });

    const mapped = mapImapError(error);

    expect(mapped).toBeInstanceOf(SyncError);
    expect(mapped).toMatchObject({
      kind: "auth",
      message: "IMAP credentials were rejected",
      scope: "connection",
    });
    expect(mapped.message).not.toContain("account@example.com");
  });

  it("maps connection failures and preserves unknown errors", () => {
    const network = mapImapError(Object.assign(new Error("reset"), { code: "ECONNRESET" }));
    expect(network).toMatchObject({ kind: "network", message: "IMAP server is unreachable" });

    const unknown = new Error("mailbox unavailable");
    expect(mapImapError(unknown)).toBe(unknown);
  });
});
