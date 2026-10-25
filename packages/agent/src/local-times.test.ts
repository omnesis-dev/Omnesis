// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";

import {
  annotateLocalTimes,
  instantSafeEnd,
  withoutCutInstantAtEnd,
  stripLocalTimeAnnotations,
  stripLocalTimeAnnotationsDeep,
} from "./local-times.js";

const LONDON = "Europe/London";

describe("annotateLocalTimes", () => {
  it("names the local time of a UTC instant", () => {
    expect(
      annotateLocalTimes("**When:** 2026-10-18T17:28:00Z → 2026-10-18T18:26:00Z", LONDON),
    ).toBe(
      "**When:** 2026-10-18T17:28:00Z (18:28 Sun 18 Oct, Europe/London) → " +
        "2026-10-18T18:26:00Z (19:26 Sun 18 Oct, Europe/London)",
    );
  });

  it("converts an instant stored with another zone's offset", () => {
    expect(annotateLocalTimes("Starts 2026-10-18T09:15:00-07:00.", LONDON)).toBe(
      "Starts 2026-10-18T09:15:00-07:00 (17:15 Sun 18 Oct, Europe/London).",
    );
    expect(annotateLocalTimes("2026-10-18T09:15+02:00", "Asia/Tokyo")).toBe(
      "2026-10-18T09:15+02:00 (16:15 Sun 18 Oct, Asia/Tokyo)",
    );
  });

  it("reads the offset on the instant's own side of a daylight-saving change", () => {
    // London leaves BST at 01:00 UTC on 25 October 2026.
    expect(annotateLocalTimes("2026-10-25T00:30:00Z", LONDON)).toBe(
      "2026-10-25T00:30:00Z (01:30 Sun 25 Oct, Europe/London)",
    );
    expect(annotateLocalTimes("2026-10-25T01:30:00Z", LONDON)).toBe(
      "2026-10-25T01:30:00Z (01:30 Sun 25 Oct, Europe/London)",
    );
  });

  it("moves the local date when the zone crosses midnight", () => {
    expect(annotateLocalTimes("2026-10-18T23:30:00.000Z", "Asia/Tokyo")).toBe(
      "2026-10-18T23:30:00.000Z (08:30 Mon 19 Oct, Asia/Tokyo)",
    );
  });

  it("uses the zone it is given", () => {
    const text = "2026-08-02T18:40:00Z";
    expect(annotateLocalTimes(text, "America/Los_Angeles")).toBe(
      "2026-08-02T18:40:00Z (11:40 Sun 2 Aug, America/Los_Angeles)",
    );
    expect(annotateLocalTimes(text, "UTC")).toBe("2026-08-02T18:40:00Z (18:40 Sun 2 Aug, UTC)");
  });

  it("leaves values that name no instant alone", () => {
    for (const text of [
      "Due 2026-10-18",
      "allDay start 2026-10-18T00:00:00 with no offset",
      "18:28",
      "no timestamps here",
    ]) {
      expect(annotateLocalTimes(text, LONDON)).toBe(text);
    }
  });

  it("leaves instants inside URLs, paths and identifiers alone", () => {
    for (const text of [
      "https://calendar.example.com/event?start=2026-10-18T17:28:00Z&end=2026-10-18T18:26:00Z",
      "https://example.org/archive/2026-10-18T17:28:00Z",
      "see https://example.org/x#2026-10-18T17:28:00Z",
      "run-2026-10-18T17:28:00Z-a1b2",
      "backups/2026-10-18T17:28:00Z.tar",
      "ref:2026-10-18T17:28:00Z",
    ]) {
      expect(annotateLocalTimes(text, LONDON)).toBe(text);
    }
  });

  it("never annotates an instant twice", () => {
    const once = annotateLocalTimes("Leaves 2026-10-18T17:28:00Z.", LONDON);
    expect(annotateLocalTimes(once, LONDON)).toBe(once);
    expect(annotateLocalTimes(once, "Asia/Tokyo")).toBe(once);
  });

  it("is undone exactly by stripLocalTimeAnnotations", () => {
    const stored = "When: 2026-10-18T17:28:00Z → 2026-10-18T18:26:00+01:00 (by train)";
    const annotated = annotateLocalTimes(stored, LONDON);
    expect(annotated).not.toBe(stored);
    expect(stripLocalTimeAnnotations(annotated)).toBe(stored);
    // Parentheses that are not an annotation of an instant stay.
    expect(stripLocalTimeAnnotations("at noon (18:28 Sun 18 Oct, Europe/London)")).toBe(
      "at noon (18:28 Sun 18 Oct, Europe/London)",
    );
  });

  it("accepts compact offsets and comma fractions", () => {
    expect(annotateLocalTimes("2026-10-18T09:15:00-0700", LONDON)).toBe(
      "2026-10-18T09:15:00-0700 (17:15 Sun 18 Oct, Europe/London)",
    );
    expect(annotateLocalTimes("2026-10-18T17:28:00,5Z", LONDON)).toBe(
      "2026-10-18T17:28:00,5Z (18:28 Sun 18 Oct, Europe/London)",
    );
  });

  it("leaves an impossible calendar date alone rather than rolling it over", () => {
    expect(annotateLocalTimes("2026-02-30T10:00:00Z", LONDON)).toBe("2026-02-30T10:00:00Z");
  });

  it("round-trips in every zone the runtime knows", () => {
    const stored = "a 2026-01-15T08:05:00Z b 2026-07-04T23:59:59.999+05:30 c 2026-10-25T01:30:00Z";
    for (const zone of Intl.supportedValuesOf("timeZone")) {
      const annotated = annotateLocalTimes(stored, zone);
      expect(annotated).not.toBe(stored);
      expect(annotateLocalTimes(annotated, zone)).toBe(annotated);
      expect(stripLocalTimeAnnotations(annotated)).toBe(stored);
    }
  });
});

describe("stripLocalTimeAnnotationsDeep", () => {
  it("restores every string in a JSON-shaped value and leaves other values alone", () => {
    const stored = {
      q: "at 2026-10-18T17:28:00Z",
      list: ["2026-10-18T17:28:00Z", 3, null],
      ok: true,
    };
    const annotated = JSON.parse(
      JSON.stringify(stored, (_key, value: unknown) =>
        typeof value === "string" ? annotateLocalTimes(value, LONDON) : value,
      ),
    );
    expect(annotated).not.toEqual(stored);
    expect(stripLocalTimeAnnotationsDeep(annotated)).toEqual(stored);
  });
});

describe("instantSafeEnd", () => {
  const text = "Doors open 2026-10-18T17:28:00.000+01:00 at the hall";
  const at = text.indexOf("2026");
  const after = at + "2026-10-18T17:28:00.000+01:00".length;

  it("moves a cut inside an instant to just before it", () => {
    for (const end of [at + 1, at + 16, after - 1]) expect(instantSafeEnd(text, 0, end)).toBe(at);
  });

  it("leaves a cut outside any instant, at its edges, or past the text where it is", () => {
    for (const end of [at - 3, at, after, after + 4, text.length + 10]) {
      expect(instantSafeEnd(text, 0, end)).toBe(end);
    }
  });

  it("keeps the cut when the slice starts on the instant and cannot hold it", () => {
    expect(instantSafeEnd(text, at, at + 10)).toBe(at + 10);
  });
});

describe("withoutCutInstantAtEnd", () => {
  it("drops a date and time a cut left without its offset", () => {
    expect(withoutCutInstantAtEnd("Doors open 2026-10-18T17:28")).toBe("Doors open ");
    expect(withoutCutInstantAtEnd("Doors open 2026-10-18T17:28:0")).toBe("Doors open ");
  });

  it("keeps a whole instant, a date, and text that does not end on one", () => {
    for (const text of [
      "Doors 2026-10-18T17:28:00Z",
      "Due 2026-10-18",
      "At 2026-10-18T17:28 sharp",
    ]) {
      expect(withoutCutInstantAtEnd(text)).toBe(text);
    }
  });
});

describe("offset bounds", () => {
  it("does not read a clock range as an instant with an impossible offset", () => {
    expect(annotateLocalTimes("Slot 2026-10-18T17:28-18:30 booked", LONDON)).toBe(
      "Slot 2026-10-18T17:28-18:30 booked",
    );
  });
});
