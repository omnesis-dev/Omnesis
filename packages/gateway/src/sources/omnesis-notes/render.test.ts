// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";

import { dayKeyFor, localHourMinute, DAY_KEY_RE } from "./day.js";
import { renderNotesDay } from "./render.js";
import type { NoteEntry } from "./storage.js";
import type { NoteCaptureContext } from "@omnesis/types";

/**
 * Build an ISO instant from LOCAL wall-clock components so expectations
 * hold in any test-runner timezone (`dayKeyFor` / `localHourMinute` are
 * gateway-local by design).
 */
function localIso(y: number, m: number, d: number, hh: number, mm: number): string {
  return new Date(y, m - 1, d, hh, mm).toISOString();
}

function captureContext(principalName: string): NoteCaptureContext {
  return {
    principalId: "prn_fictional",
    principalName,
    grantId: "grant_fictional",
    grantRevision: 1,
    credentialId: "cred_fictional",
    oauthClientId: "client_fictional",
    requestId: "req_fictional",
  };
}

function entry(overrides: Partial<NoteEntry>): NoteEntry {
  const capturedAt = overrides.capturedAt ?? localIso(2026, 6, 15, 9, 30);
  return {
    id: "e-1",
    day: "2026-06-15",
    capturedAt,
    updatedAt: capturedAt,
    text: "Remember to renew the passport",
    surface: null,
    deviceId: null,
    latitude: null,
    longitude: null,
    placeName: null,
    capturedTimeZoneId: null,
    capturedUtcOffsetSeconds: null,
    receivedAt: null,
    ...overrides,
  };
}

describe("dayKeyFor / localHourMinute", () => {
  test("returns the local calendar day of the instant", () => {
    expect(dayKeyFor(localIso(2026, 6, 15, 9, 30))).toBe("2026-06-15");
    expect(dayKeyFor(localIso(2026, 1, 2, 0, 5))).toBe("2026-01-02");
  });

  test("a late-evening local capture stays on its local day", () => {
    expect(dayKeyFor(localIso(2026, 6, 15, 23, 30))).toBe("2026-06-15");
  });

  test("day keys match the HTTP shape guard", () => {
    expect(DAY_KEY_RE.test(dayKeyFor(localIso(2026, 6, 15, 12, 0)))).toBe(true);
  });

  test("throws on unparsable input", () => {
    expect(() => dayKeyFor("not-a-date")).toThrow(/unparsable/);
    expect(() => localHourMinute("not-a-date")).toThrow(/unparsable/);
  });

  test("localHourMinute zero-pads", () => {
    expect(localHourMinute(localIso(2026, 6, 15, 8, 5))).toBe("08:05");
  });

  test("an observed capture offset freezes the phone's local day and time", () => {
    const instant = "2026-08-14T23:30:00.000Z";
    expect(dayKeyFor(instant, 7_200)).toBe("2026-08-15");
    expect(localHourMinute(instant, 7_200)).toBe("01:30");
    expect(dayKeyFor(instant, -18_000)).toBe("2026-08-14");
    expect(localHourMinute(instant, -18_000)).toBe("18:30");
  });
});

describe("renderNotesDay", () => {
  test("title carries the day; each entry renders a local-time section", () => {
    const rendered = renderNotesDay("2026-06-15", [
      entry({ id: "a", capturedAt: localIso(2026, 6, 15, 9, 15), text: "Buy oat milk" }),
      entry({
        id: "b",
        capturedAt: localIso(2026, 6, 15, 14, 2),
        text: "Call Maya Reeves about the venue contract",
      }),
    ]);
    expect(rendered.title).toBe("Notes — 2026-06-15");
    expect(rendered.body).toBe(
      "## 09:15\n\nBuy oat milk\n\n## 14:02\n\nCall Maya Reeves about the venue contract",
    );
  });

  test("appends the surface suffix when the capture surface is known", () => {
    const rendered = renderNotesDay("2026-06-15", [
      entry({ capturedAt: localIso(2026, 6, 15, 9, 15), surface: "ios-siri", text: "Note" }),
    ]);
    expect(rendered.body).toBe("## 09:15 · ios-siri\n\nNote");
  });

  test("renders entry time using its capture offset rather than the gateway zone", () => {
    const rendered = renderNotesDay("2026-08-15", [
      entry({
        capturedAt: "2026-08-14T23:30:00.000Z",
        capturedUtcOffsetSeconds: 7_200,
        text: "Late travel note",
      }),
    ]);
    expect(rendered.body).toBe("## 01:30\n\nLate travel note");
  });

  test("appends the place suffix after the surface for a geotagged note", () => {
    const rendered = renderNotesDay("2026-06-15", [
      entry({
        capturedAt: localIso(2026, 6, 15, 9, 15),
        surface: "ios-siri",
        placeName: "Paris",
        text: "Note",
      }),
    ]);
    expect(rendered.body).toBe("## 09:15 · ios-siri · Paris\n\nNote");
  });

  test("names the capturing principal after the surface, whitespace collapsed", () => {
    const rendered = renderNotesDay("2026-06-15", [
      entry({
        capturedAt: localIso(2026, 6, 15, 9, 15),
        surface: "mcp",
        captureContext: captureContext("  Aurora\n planner "),
        placeName: "Lisbon",
        text: "Note",
      }),
    ]);
    expect(rendered.body).toBe("## 09:15 · mcp · Aurora planner · Lisbon\n\nNote");
  });

  test("place suffix renders without a surface too", () => {
    const rendered = renderNotesDay("2026-06-15", [
      entry({ capturedAt: localIso(2026, 6, 15, 9, 15), placeName: "London", text: "Note" }),
    ]);
    expect(rendered.body).toBe("## 09:15 · London\n\nNote");
  });

  test("deterministic: same entries render byte-identical output", () => {
    const entries = [
      entry({ id: "a", capturedAt: localIso(2026, 6, 15, 9, 15), surface: "cli" }),
      entry({ id: "b", capturedAt: localIso(2026, 6, 15, 10, 0) }),
    ];
    expect(renderNotesDay("2026-06-15", entries)).toEqual(renderNotesDay("2026-06-15", entries));
  });

  test("zero entries render an empty body (the upserter deletes instead)", () => {
    const rendered = renderNotesDay("2026-06-15", []);
    expect(rendered.body).toBe("");
    expect(rendered.title).toBe("Notes — 2026-06-15");
  });
});
