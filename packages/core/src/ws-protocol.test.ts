// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import {
  WsCorrelationId,
  newCorrelationId,
  isWsCommand,
  isWsResponse,
  isWsEvent,
  isWsEnvelope,
  makeCommand,
  makeResponseOk,
  makeResponseErr,
  makeEvent,
} from "./ws-protocol.js";

describe("WsCorrelationId", () => {
  test("constructor returns plain string", () => {
    const id = WsCorrelationId("abc");
    expect(id).toBe("abc");
  });

  test("newCorrelationId returns a UUID-shaped string", () => {
    const id = newCorrelationId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  test("newCorrelationId returns unique values", () => {
    const a = newCorrelationId();
    const b = newCorrelationId();
    expect(a).not.toBe(b);
  });
});

describe("makeCommand", () => {
  test("builds a well-formed command", () => {
    const cmd = makeCommand("source.add", { sourceType: "gmail" });
    expect(cmd.kind).toBe("command");
    expect(cmd.type).toBe("source.add");
    expect(cmd.payload).toEqual({ sourceType: "gmail" });
    expect(typeof cmd.id).toBe("string");
  });

  test("each command gets a fresh correlation id", () => {
    const a = makeCommand("noop", null);
    const b = makeCommand("noop", null);
    expect(a.id).not.toBe(b.id);
  });
});

describe("makeResponseOk / makeResponseErr", () => {
  test("ok response carries result", () => {
    const id = newCorrelationId();
    const r = makeResponseOk(id, { count: 3 });
    expect(r.ok).toBe(true);
    expect(r.correlationId).toBe(id);
    expect(r.result).toEqual({ count: 3 });
  });

  test("err response carries code + message", () => {
    const id = newCorrelationId();
    const r = makeResponseErr(id, "not_found", "source missing");
    expect(r.ok).toBe(false);
    expect(r.correlationId).toBe(id);
    expect(r.error.code).toBe("not_found");
    expect(r.error.message).toBe("source missing");
  });
});

describe("makeEvent", () => {
  test("builds a well-formed event", () => {
    const e = makeEvent("sync.status", { sourceId: "gmail:a@b.com", state: "syncing" });
    expect(e.kind).toBe("event");
    expect(e.type).toBe("sync.status");
    expect(e.payload).toEqual({ sourceId: "gmail:a@b.com", state: "syncing" });
  });
});

describe("type guards", () => {
  test("isWsCommand distinguishes commands", () => {
    const cmd = makeCommand("x", {});
    expect(isWsCommand(cmd)).toBe(true);
    expect(isWsCommand(makeEvent("x", {}))).toBe(false);
    expect(isWsCommand(makeResponseOk(newCorrelationId(), {}))).toBe(false);
  });

  test("isWsResponse distinguishes responses", () => {
    const ok = makeResponseOk(newCorrelationId(), {});
    const err = makeResponseErr(newCorrelationId(), "x", "y");
    expect(isWsResponse(ok)).toBe(true);
    expect(isWsResponse(err)).toBe(true);
    expect(isWsResponse(makeCommand("x", {}))).toBe(false);
    expect(isWsResponse(makeEvent("x", {}))).toBe(false);
  });

  test("isWsEvent distinguishes events", () => {
    expect(isWsEvent(makeEvent("x", {}))).toBe(true);
    expect(isWsEvent(makeCommand("x", {}))).toBe(false);
  });

  test("isWsEnvelope accepts all three shapes", () => {
    expect(isWsEnvelope(makeCommand("x", {}))).toBe(true);
    expect(isWsEnvelope(makeEvent("x", {}))).toBe(true);
    expect(isWsEnvelope(makeResponseOk(newCorrelationId(), {}))).toBe(true);
  });

  test("rejects non-envelopes", () => {
    expect(isWsEnvelope(null)).toBe(false);
    expect(isWsEnvelope(undefined)).toBe(false);
    expect(isWsEnvelope("string")).toBe(false);
    expect(isWsEnvelope(42)).toBe(false);
    expect(isWsEnvelope([])).toBe(false);
    expect(isWsEnvelope({})).toBe(false);
    expect(isWsEnvelope({ kind: "command" })).toBe(false);
    expect(isWsEnvelope({ kind: "command", id: 1, type: "x" })).toBe(false);
    expect(isWsEnvelope({ kind: "response", correlationId: "c", ok: "nope" })).toBe(false);
  });

  test("rejects err response missing error fields", () => {
    expect(isWsResponse({ kind: "response", correlationId: "c", ok: false })).toBe(false);
    expect(isWsResponse({ kind: "response", correlationId: "c", ok: false, error: {} })).toBe(
      false,
    );
  });
});

describe("JSON round-trip", () => {
  test("command survives serialize/parse", () => {
    const cmd = makeCommand("source.add", { type: "gmail", accountId: "a@b.com" });
    const parsed = JSON.parse(JSON.stringify(cmd));
    expect(isWsCommand(parsed)).toBe(true);
    expect(parsed).toEqual(cmd);
  });

  test("event survives serialize/parse", () => {
    const e = makeEvent("sync.status", { sourceId: "s", processed: 10, total: 100 });
    const parsed = JSON.parse(JSON.stringify(e));
    expect(isWsEvent(parsed)).toBe(true);
    expect(parsed).toEqual(e);
  });

  test("ok response survives serialize/parse", () => {
    const r = makeResponseOk(newCorrelationId(), { ok: "sure" });
    const parsed = JSON.parse(JSON.stringify(r));
    expect(isWsResponse(parsed)).toBe(true);
    expect(parsed).toEqual(r);
  });

  test("err response survives serialize/parse", () => {
    const r = makeResponseErr(newCorrelationId(), "e", "m");
    const parsed = JSON.parse(JSON.stringify(r));
    expect(isWsResponse(parsed)).toBe(true);
    expect(parsed).toEqual(r);
  });
});
