// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { context } from "./shared.mjs";
import { buildScenarios } from "./scenarios.mjs";
import { buildTravel } from "./travel.mjs";

describe("Independent gift and travel evidence", () => {
  it("supports a previously received gift with a Gmail order and recipient acknowledgement", () => {
    const { sources, facts } = buildScenarios(context());
    const order = sources.gmail["messages.json"].find(
      (message) => message.externalId === "sb-sketching-stool-order",
    );
    const receipt = sources["apple-imessage"]["messages.json"].find(
      (message) => message.externalId === "sb-sketching-stool-received",
    );
    expect(order.fromEmail).toBe("orders@amazon.example.com");
    expect(order.from).toBe("p_gift_orders");
    expect(order.body).toContain("Delivered 22 June 2020");
    expect(order.body).toContain("Happy birthday Maya");
    expect(receipt.messages[0].from).toBe("p_maya");
    expect(receipt.messages[0].text).toContain("Took it out today");
    const gift = facts.find((fact) => fact.id === "F02");
    expect(gift.expected.gift).toBe("small practical darkroom printing workshop");
    expect(gift.evidence).toEqual(
      expect.arrayContaining([
        order.externalId,
        receipt.externalId,
        "sb-pottery-confirmed",
        "sb-theatre-receipt",
      ]),
    );
  });

  it("attributes actual journey confirmations to the traveller rather than the correspondent", () => {
    const { sources, trips } = buildTravel();
    for (const trip of trips) {
      const arrival = sources["whatsapp-messages"]["messages.json"].find(
        (message) => message.externalId === `sb-trip-${trip.id}-arrival`,
      );
      const home = sources["whatsapp-messages"]["messages.json"].find(
        (message) => message.externalId === `sb-trip-${trip.id}-home`,
      );
      expect(arrival.date).toBe(trip.from);
      expect(home.date).toBe(trip.to);
      expect(arrival.messages[0].from).toBe(trip.counterparty);
      expect(arrival.messages[0].text).toContain("Sacha?");
      expect(arrival.messages[1].from).toBe("self");
      expect(arrival.messages[1].text).toContain(`I arrived in ${trip.city}`);
      expect(home.messages[1].from).toBe("self");
      expect(home.messages[1].text).toContain("My return journey was today");
    }
  });

  it("hosts original binary demo evidence in Gmail without prewritten extraction", () => {
    const { sources } = buildScenarios(context());
    expect(sources.maildir).toBeUndefined();
    const parents = sources.gmail["messages.json"].filter((message) =>
      [
        "sb-real-scanned-receipt",
        "sb-audio-promise",
        "sb-symptom-voice",
        "sb-tenancy-scan",
        "sb-warranty-native-pdf",
      ].includes(message.externalId),
    );
    expect(parents).toHaveLength(5);
    for (const parent of parents) {
      expect(parent.fromEmail).toMatch(/@example\.com$/);
      expect(parent.toEmails).toEqual(["sacha.bellamy@example.com"]);
      for (const attachment of parent.attachments) {
        expect(attachment.assetPath).toMatch(/^assets\//);
        expect(attachment.extractedText).toBeUndefined();
      }
    }
  });
});
