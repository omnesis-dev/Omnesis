// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { context, londonAt } from "./shared.mjs";
import { buildScenarios } from "./scenarios.mjs";

function evening(asOf) {
  const result = buildScenarios(context(asOf));
  return { ...result, expected: result.facts.find((fact) => fact.id === "A16").expected };
}

describe("Evening plans from independent source evidence", () => {
  it.each([
    ["2027-01-13", "2027-01-13T20:00:00.000Z"],
    ["2027-07-13", "2027-07-13T19:00:00.000Z"],
    ["2027-03-28", "2027-03-28T19:00:00.000Z"],
    ["2027-10-31", "2027-10-31T20:00:00.000Z"],
    ["2028-02-29", "2028-02-29T20:00:00.000Z"],
  ])("places tonight on the exact load day %s with London wall time", (date, start) => {
    const result = evening(date);
    const event = result.sources["google-calendar"]["events.json"].find(
      (e) => e.externalId === "sb-evening-calendar",
    );
    expect(result.expected.date).toBe(date);
    expect(event.startTime).toBe(start);
    expect(event.endTime).toBe(new Date(Date.parse(start) + 120 * 60000).toISOString());
    const reservation = result.sources.gmail["messages.json"].find(
      (e) => e.externalId === "sb-evening-reservation",
    );
    expect(reservation.body).toContain(date);
    expect(reservation.body).toContain("20:00 Europe/London");
    const plan = result.sources["whatsapp-messages"]["messages.json"].find(
      (e) => e.externalId === "sb-evening-pub-plan",
    );
    expect(plan.messages[0].from).toBe("p_thomas");
    expect(plan.messages[0].text).toContain(date);
    expect(plan.messages[0].text).toContain("at 7pm");
    expect(
      Date.parse(londonAt(date, result.expected.showTime)) -
        Date.parse(londonAt(date, result.expected.meetingTime)),
    ).toBe(3600000);
  });

  it("requires actual PDF extraction for seats and the temporary departure base", () => {
    const result = evening("2027-07-13");
    const reservation = result.sources.gmail["messages.json"].find(
      (e) => e.externalId === "sb-evening-reservation",
    );
    const tenancy = result.sources.gmail["messages.json"].find(
      (e) => e.externalId === "sb-evening-shortlet",
    );
    for (const parent of [reservation, tenancy]) {
      expect(parent.attachments).toHaveLength(1);
      expect(parent.attachments[0].mimeType).toBe("application/pdf");
      expect(parent.attachments[0].assetPath).toMatch(/^assets\/evening-[a-z]+\.pdf$/);
      expect(parent.attachments[0].extractedText).toBeUndefined();
    }
    const nonPdf = JSON.stringify(result.sources);
    expect(nonPdf).not.toContain("Seat 12");
    expect(nonPdf).not.toContain("Seat 13");
    expect(nonPdf).not.toContain(result.expected.home);
    expect(result.assets.eveningTicket).toContain("Stalls, Row H, Seat 12");
    expect(result.assets.eveningTicket).toContain("Stalls, Row H, Seat 13");
    expect(result.assets.eveningTenancy).toContain(result.expected.home);
    expect(result.assets.eveningTenancy).toContain("2027-07-11 to 2027-07-18");
    expect(result.assets.eveningTenancy).toContain(
      "Main household tenancy continues independently",
    );
    expect(result.expected.followUpPrompt).toBe("What seats do we have?");
    expect(result.additionalPeople).toContainEqual(
      expect.objectContaining({ id: "p_thomas", name: "Thomas Ashford" }),
    );
    const history = result.facts.find((fact) => fact.id === "F01").expected.residences;
    expect(history.at(-1).address).toBe("Flat 8, 66 Fictional Gardens, London");
  });
});
