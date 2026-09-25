// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Per-variant validation of the NDJSON wire shape emitted by
 * `auth-subprocess.ts` and consumed in `source-ws-handlers.ts`. The
 * earlier discriminator-only check let `{type:"url"}` (no `url` field)
 * pass through and forwarded `{flowId, type:"url"}` to the gateway,
 * which broke the portal's "open this URL" affordance. The validator
 * now rejects per-variant shape mismatches.
 */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  isAuthSubprocessEvent,
  parseAuthSubprocessEvent,
  parseAuthSubprocessInbound,
} from "./auth-subprocess-protocol.js";

describe("parseAuthSubprocessEvent", () => {
  test.each(["redirect", "code", "qr", "fields", "widget", "wait"])(
    "shared %s fixture survives subprocess validation",
    (kind) => {
      const { flowId: _flowId, ...event } = JSON.parse(
        readFileSync(
          new URL(`../../../wire-fixtures/auth-challenge-${kind}.json`, import.meta.url),
          "utf8",
        ),
      );
      expect(parseAuthSubprocessEvent(event)).toEqual(event);
    },
  );
  test("accepts an elsewhere redirect and refuses unknown transports", () => {
    const event = {
      type: "challenge",
      id: "c1",
      expectsAnswer: false,
      challenge: {
        kind: "redirect",
        title: "Connect",
        url: "https://example.org/connect",
        via: "elsewhere",
      },
    };
    expect(parseAuthSubprocessEvent(event)).toEqual(event);
    expect(
      parseAuthSubprocessEvent({ ...event, challenge: { ...event.challenge, via: "unexpected" } }),
    ).toBeNull();
  });
  test("accepts a well-formed url event", () => {
    expect(
      parseAuthSubprocessEvent({
        type: "url",
        url: "https://accounts.google.com/o/oauth2/...",
      }),
    ).toMatchObject({ type: "url" });
  });

  test("rejects url event missing url", () => {
    expect(parseAuthSubprocessEvent({ type: "url" })).toBeNull();
    expect(parseAuthSubprocessEvent({ type: "url", url: "" })).toBeNull();
  });

  test("accepts qr and rejects empty data", () => {
    expect(parseAuthSubprocessEvent({ type: "qr", data: "OTPQR..." })).toMatchObject({
      type: "qr",
    });
    expect(parseAuthSubprocessEvent({ type: "qr" })).toBeNull();
    expect(parseAuthSubprocessEvent({ type: "qr", data: "" })).toBeNull();
  });

  test("accepts complete with a non-empty accountIds array and rejects bad shapes", () => {
    expect(
      parseAuthSubprocessEvent({ type: "complete", accountIds: ["user@example.com"] }),
    ).toMatchObject({ type: "complete", accountIds: ["user@example.com"] });
    // A multi-institution single session resolves several accounts.
    expect(
      parseAuthSubprocessEvent({ type: "complete", accountIds: ["item-1", "item-2"] }),
    ).toMatchObject({ type: "complete", accountIds: ["item-1", "item-2"] });
    // Missing / empty array / empty-string member are all rejected, as is
    // the retired scalar `accountId` shape.
    expect(parseAuthSubprocessEvent({ type: "complete" })).toBeNull();
    expect(parseAuthSubprocessEvent({ type: "complete", accountIds: [] })).toBeNull();
    expect(parseAuthSubprocessEvent({ type: "complete", accountIds: [""] })).toBeNull();
    expect(
      parseAuthSubprocessEvent({ type: "complete", accountId: "user@example.com" }),
    ).toBeNull();
  });

  test("accepts a well-formed widget event and rejects bad shapes", () => {
    expect(
      parseAuthSubprocessEvent({
        type: "widget",
        kind: "snaptrade-connect",
        payload: { link_token: "link-sandbox-abc" },
      }),
    ).toMatchObject({
      type: "widget",
      kind: "snaptrade-connect",
      payload: { link_token: "link-sandbox-abc" },
    });
    // An empty payload object is allowed (some widgets carry no string config).
    expect(
      parseAuthSubprocessEvent({ type: "widget", kind: "snaptrade-connect", payload: {} }),
    ).toMatchObject({ type: "widget", kind: "snaptrade-connect" });
    expect(parseAuthSubprocessEvent({ type: "widget", payload: {} })).toBeNull();
    expect(parseAuthSubprocessEvent({ type: "widget", kind: "" })).toBeNull();
    // Non-string payload values are rejected (the wire carries only strings).
    expect(
      parseAuthSubprocessEvent({ type: "widget", kind: "snaptrade-connect", payload: { n: 1 } }),
    ).toBeNull();
  });

  test("accepts error with optional code/fileKey/providerName", () => {
    expect(parseAuthSubprocessEvent({ type: "error", error: "bang" })).toMatchObject({
      type: "error",
      error: "bang",
    });
    expect(
      parseAuthSubprocessEvent({
        type: "error",
        error: "missing creds",
        code: "missing-credentials",
        fileKey: "google-oauth-credentials",
        providerName: "Google",
      }),
    ).toMatchObject({ code: "missing-credentials" });
  });

  test("rejects error with an invalid AuthErrorCode", () => {
    expect(
      parseAuthSubprocessEvent({
        type: "error",
        error: "x",
        code: "not_a_known_code",
      }),
    ).toBeNull();
  });

  test("accepts the four canonical AuthErrorCode values", () => {
    // The enumerated codes the consumer surfaces are
    // missing-credentials (existing) + user-cancelled / timeout / unknown
    // (new in this chunk). The parser must accept each one round-tripping
    // verbatim — assertNever in `cli/src/auth-flow.ts:handleAuthErrorCode`
    // would compile-error the day a new code is added but a switch arm
    // isn't, so this test pins the enumeration as the source of truth.
    for (const code of ["missing-credentials", "user-cancelled", "timeout", "unknown"]) {
      expect(parseAuthSubprocessEvent({ type: "error", error: "x", code })).toMatchObject({
        type: "error",
        code,
      });
    }
  });

  test("rejects unknown discriminator", () => {
    expect(parseAuthSubprocessEvent({ type: "wat", url: "x" })).toBeNull();
    expect(parseAuthSubprocessEvent({ type: 42 })).toBeNull();
    expect(parseAuthSubprocessEvent({})).toBeNull();
    expect(parseAuthSubprocessEvent("not an object")).toBeNull();
    expect(parseAuthSubprocessEvent(null)).toBeNull();
  });

  test("isAuthSubprocessEvent: back-compat boolean predicate matches parser", () => {
    expect(isAuthSubprocessEvent({ type: "url", url: "x" })).toBe(true);
    expect(isAuthSubprocessEvent({ type: "url" })).toBe(false);
    expect(isAuthSubprocessEvent(null)).toBe(false);
  });
});

describe("parseAuthSubprocessInbound", () => {
  test("accepts a well-formed init message", () => {
    expect(parseAuthSubprocessInbound({ type: "init", flowId: "flow-1" })).toEqual({
      type: "init",
      flowId: "flow-1",
    });
  });

  test("rejects init missing or empty flowId", () => {
    expect(parseAuthSubprocessInbound({ type: "init" })).toBeNull();
    expect(parseAuthSubprocessInbound({ type: "init", flowId: "" })).toBeNull();
  });

  test("accepts init carrying a re-auth accountId", () => {
    expect(
      parseAuthSubprocessInbound({
        type: "init",
        flowId: "flow-1",
        accountId: "maya@example.com",
      }),
    ).toEqual({ type: "init", flowId: "flow-1", accountId: "maya@example.com" });
  });

  test("rejects init with an empty accountId (writer normalises '' to absent)", () => {
    expect(
      parseAuthSubprocessInbound({ type: "init", flowId: "flow-1", accountId: "" }),
    ).toBeNull();
  });

  test("accepts init carrying the gateway publicBaseUrl", () => {
    expect(
      parseAuthSubprocessInbound({
        type: "init",
        flowId: "flow-1",
        publicBaseUrl: "https://gw.example.com:7600",
      }),
    ).toEqual({
      type: "init",
      flowId: "flow-1",
      publicBaseUrl: "https://gw.example.com:7600",
    });
  });

  test("rejects init with a non-URL publicBaseUrl", () => {
    expect(
      parseAuthSubprocessInbound({
        type: "init",
        flowId: "flow-1",
        publicBaseUrl: "not-a-url",
      }),
    ).toBeNull();
  });

  test("accepts a well-formed code message", () => {
    expect(parseAuthSubprocessInbound({ type: "code", code: "abc123" })).toEqual({
      type: "code",
      code: "abc123",
    });
  });

  test("rejects code missing or empty code", () => {
    expect(parseAuthSubprocessInbound({ type: "code" })).toBeNull();
    expect(parseAuthSubprocessInbound({ type: "code", code: "" })).toBeNull();
  });

  test("accepts a widget-result message with optional metadata", () => {
    expect(
      parseAuthSubprocessInbound({ type: "widget-result", token: "public-sandbox-x" }),
    ).toEqual({
      type: "widget-result",
      token: "public-sandbox-x",
    });
    expect(
      parseAuthSubprocessInbound({
        type: "widget-result",
        token: "public-sandbox-x",
        metadata: { institution: "Example Bank", accounts: 2 },
      }),
    ).toEqual({
      type: "widget-result",
      token: "public-sandbox-x",
      metadata: { institution: "Example Bank", accounts: 2 },
    });
  });

  test("rejects widget-result missing or empty token", () => {
    expect(parseAuthSubprocessInbound({ type: "widget-result" })).toBeNull();
    expect(parseAuthSubprocessInbound({ type: "widget-result", token: "" })).toBeNull();
  });

  test("rejects unknown discriminator / non-objects", () => {
    expect(parseAuthSubprocessInbound({ type: "url", url: "x" })).toBeNull();
    expect(parseAuthSubprocessInbound({})).toBeNull();
    expect(parseAuthSubprocessInbound("nope")).toBeNull();
    expect(parseAuthSubprocessInbound(null)).toBeNull();
  });
});

describe("init credentials", () => {
  test("are accepted alongside the rest of the init fields", () => {
    expect(
      parseAuthSubprocessInbound({
        type: "init",
        flowId: "flow-1",
        accountId: "maya.reeves@example.com",
        credentials: { api_key: "gk_live_supersecret" },
        publicBaseUrl: "https://gateway.example.com",
      }),
    ).toMatchObject({
      type: "init",
      flowId: "flow-1",
      accountId: "maya.reeves@example.com",
      credentials: { api_key: "gk_live_supersecret" },
    });
  });

  test("a non-string value is rejected rather than coerced", () => {
    expect(
      parseAuthSubprocessInbound({
        type: "init",
        flowId: "flow-1",
        credentials: { api_key: 12345 },
      }),
    ).toBeNull();
  });
});
