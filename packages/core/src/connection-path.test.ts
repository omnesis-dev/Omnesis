// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { expect, test } from "vitest";
import { parseConnectionPath } from "./connection-path.js";
import { isKnownEventType, parseEventPayload } from "./ws-messages.js";
test("connection path is advisory local or relay only, with a strict event body", () => {
  expect(isKnownEventType("connection.path")).toBe(true);
  for (const path of ["local", "relay"]) {
    expect(parseConnectionPath(path)).toBe(path);
    expect(parseEventPayload("connection.path", { path })).toEqual({ ok: true, value: { path } });
  }
  for (const value of [
    undefined,
    null,
    "reconnecting",
    "local,relay",
    ["local"],
    { path: "local" },
  ])
    expect(parseConnectionPath(value)).toBeUndefined();
  for (const payload of [
    null,
    { path: "reconnecting" },
    { path: "local", admin: true },
    { path: "relay", deviceId: "other-device" },
  ])
    expect(parseEventPayload("connection.path", payload).ok).toBe(false);
});
