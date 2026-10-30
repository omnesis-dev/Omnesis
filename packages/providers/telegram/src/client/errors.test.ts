// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { isAppCredentialRejected, mapRpcError } from "./errors.js";
import { REVOCATION_REASONS } from "./types.js";

describe("mapRpcError", () => {
  it.each(REVOCATION_REASONS)("%s means the session is gone", (text) => {
    const err = mapRpcError({ code: 401, text });
    expect(err.code).toBe("revoked");
    expect(err.detail?.reason).toBe(text);
  });

  it.each([
    [{ code: 420, text: "FLOOD_WAIT_%d", seconds: 37 }, 37],
    [{ code: 420, text: "FLOOD_WAIT_120" }, 120],
    [{ code: 420, text: "FLOOD_PREMIUM_WAIT_%d", seconds: 5 }, 5],
    [{ code: 420, text: "SLOWMODE_WAIT_%d", seconds: 9 }, 9],
    [{ code: 400, text: "SLOWMODE_WAIT_11" }, 11],
  ])("%j is a flood wait of %is", (fields, seconds) => {
    const err = mapRpcError(fields);
    expect(err.code).toBe("flood-wait");
    expect(err.detail?.seconds).toBe(seconds);
  });

  it.each([
    ["FILE_REFERENCE_EXPIRED", "file-reference-expired"],
    ["FILE_REFERENCE_%d_EXPIRED", "file-reference-expired"],
    ["FILE_REFERENCE_INVALID", "file-reference-expired"],
    ["MSG_ID_INVALID", "not-found"],
    ["PEER_ID_INVALID", "not-found"],
    ["CHANNEL_PRIVATE", "forbidden"],
    ["CHAT_FORBIDDEN", "forbidden"],
    ["API_ID_INVALID", "forbidden"],
    ["API_ID_PUBLISHED_FLOOD", "forbidden"],
  ])("%s → %s", (text, code) => {
    expect(mapRpcError({ code: 400, text }).code).toBe(code);
  });

  it.each([
    [{ code: 420, text: "TAKEOUT_INIT_DELAY_%d", seconds: 86_400 }, 86_400],
    [{ code: 420, text: "TAKEOUT_INIT_DELAY_3600" }, 3600],
  ])("%j is a held-back data export of %is, not a flood wait", (fields, seconds) => {
    const err = mapRpcError(fields);
    expect(err.code).toBe("takeout");
    expect(err.detail?.seconds).toBe(seconds);
  });

  it.each(["TAKEOUT_INVALID", "TAKEOUT_REQUIRED"])("%s ends the data export session", (text) => {
    const err = mapRpcError({ code: 400, text });
    expect(err.code).toBe("takeout");
    expect(err.detail?.seconds).toBeUndefined();
  });

  it("treats server errors as network and anything else as unknown, keeping the RPC text", () => {
    expect(mapRpcError({ code: 500, text: "RPC_CALL_FAIL" }).code).toBe("network");
    expect(mapRpcError({ code: -503, text: "Timeout" }).code).toBe("network");
    const unknown = mapRpcError({ code: 400, text: "SOMETHING_NEW" });
    expect(unknown.code).toBe("unknown");
    expect(unknown.detail?.rpc).toBe("SOMETHING_NEW");
    expect(mapRpcError({ code: 403, text: "RIGHT_FORBIDDEN" }).code).toBe("forbidden");
  });

  it("recognises a refused app credential", () => {
    expect(isAppCredentialRejected("API_ID_INVALID")).toBe(true);
    expect(isAppCredentialRejected("API_ID_PUBLISHED_FLOOD")).toBe(true);
    expect(isAppCredentialRejected("PEER_ID_INVALID")).toBe(false);
    expect(isAppCredentialRejected(undefined)).toBe(false);
  });
});
