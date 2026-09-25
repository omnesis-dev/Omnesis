// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// This tab renders a report it does not compute — the gateway runs the
// shared evaluator and hands over `{ ok, summary, checks }`. What the view
// owns is how that report is grouped and summarised, so that is what these
// tests pin: the section grouping, the per-section roll-up, and the one-line
// verdict. Fixture data is fictional per the repo's privacy rule.

import { describe, it, expect } from "vitest";

// @ts-expect-error — portal is plain JS, no .d.ts ships alongside.
const { groupBySection, statusMeta, worstStatus, verdictText } = await import("./doctor.js");

const check = (section: string, id: string, status: string) => ({
  section,
  id,
  status,
  message: `${id} message`,
});

describe("groupBySection", () => {
  it("keeps sections in the order the evaluator emitted them", () => {
    const grouped = groupBySection([
      check("Gateway", "gateway.reachable", "pass"),
      check("Security", "security.keyring", "warn"),
      check("Gateway", "gateway.product-version", "pass"),
    ]);
    expect(grouped.map(([section]: [string]) => section)).toEqual(["Gateway", "Security"]);
    // A later check rejoins its section rather than opening a second one.
    expect(grouped[0][1]).toHaveLength(2);
  });

  it("returns nothing for an empty report rather than an empty group", () => {
    expect(groupBySection([])).toEqual([]);
  });
});

describe("worstStatus", () => {
  it("lets a single failure outrank any number of warnings", () => {
    expect(
      worstStatus([
        check("Security", "a", "warn"),
        check("Security", "b", "fail"),
        check("Security", "c", "warn"),
      ]),
    ).toBe("fail");
  });

  it("reports warn when nothing failed", () => {
    expect(worstStatus([check("Models", "a", "pass"), check("Models", "b", "warn")])).toBe("warn");
  });

  it("reports pass only when everything passed", () => {
    expect(worstStatus([check("Index", "a", "pass")])).toBe("pass");
  });

  it("excludes N/A checks from fail and warning roll-ups", () => {
    expect(
      worstStatus([
        check("Host", "host.service", "not-applicable"),
        check("Host", "host.storage", "pass"),
      ]),
    ).toBe("pass");
    expect(worstStatus([check("Host", "host.service", "not-applicable")])).toBe(
      "not-applicable",
    );
  });

  it("renders a neutral em dash and N/A label", () => {
    expect(statusMeta("not-applicable")).toMatchObject({ glyph: "—", label: "N/A" });
  });
});

describe("verdictText", () => {
  it("leads with failures, and mentions warnings alongside them", () => {
    expect(verdictText({ ok: false, summary: { errors: 2, warnings: 3 } })).toBe(
      "2 failing checks, 3 warnings",
    );
  });

  // A failing report must never be phrased as healthy, even with no warnings.
  it("still leads with the failure when there are no warnings", () => {
    expect(verdictText({ ok: false, summary: { errors: 1, warnings: 0 } })).toBe("1 failing check");
  });

  it("says so plainly when nothing failed and nothing warned", () => {
    expect(verdictText({ ok: true, summary: { errors: 0, warnings: 0 } })).toBe(
      "Everything looks healthy",
    );
  });

  it("does not claim health while warnings stand", () => {
    expect(verdictText({ ok: true, summary: { errors: 0, warnings: 1 } })).toBe(
      "No failures, 1 warning",
    );
  });

  it("does not call an all-N/A report healthy", () => {
    expect(
      verdictText({
        ok: true,
        summary: { errors: 0, warnings: 0 },
        checks: [check("Host", "host.service", "not-applicable")],
      }),
    ).toBe("No applicable checks");
  });
});
