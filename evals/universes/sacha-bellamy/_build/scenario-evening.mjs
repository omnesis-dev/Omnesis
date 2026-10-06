// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { addDays, at, calendar, londonAt, mail, OWNER_EMAIL } from "./shared.mjs";

/** A fictional friend used only in this scenario, leaving historical background unchanged. */
const eveningFriend = {
  id: "p_thomas",
  name: "Thomas Ashford",
  emails: ["thomas.ashford@example.com"],
  phones: ["+447700900180"],
  lids: ["800100080@lid"],
};

export function addEvening({ ctx, add, fact }) {
  const date = ctx.asOf,
    booked = addDays(date, -3),
    stayStart = addDays(date, -2),
    stayEnd = addDays(date, 5),
    show = "The Clockmaker's Map",
    venue = "Criterion Theatre, 218-223 Piccadilly, London",
    pub = "The Three Greyhounds, 25 Greek Street, London W1D 5DD",
    lodging = "Flat Example, Example House, Gower Street, Bloomsbury, London";
  const ticket = `FICTIONAL DEMONSTRATION TICKETS - NOT VALID FOR ADMISSION
Booking: DEMO-EVENING-2048
Customer: Sacha Bellamy
Performance: ${show}
Date: ${date}
Curtain: 20:00 Europe/London
Venue: ${venue}
Ticket 1: Stalls, Row H, Seat 12
Ticket 2: Stalls, Row H, Seat 13
These are invented tickets for an invented performance at a real public venue.`;
  const tenancy = `FICTIONAL DEMONSTRATION SHORT-LET AGREEMENT
Tenant: Sacha Bellamy
Property: ${lodging}
Term: ${stayStart} to ${stayEnd}, inclusive.
This temporary flat is the tenant's place of residence during the stated term.
Entrance for route planning: the public junction of Gower Street and Chenies Street, London.
Main household tenancy continues independently; this is a short London stay.
The flat and building name are invented. The public street and locality identify an approximate route origin, not an actual private dwelling.`;
  add(
    "gmail",
    "messages.json",
    mail(
      "sb-evening-reservation",
      `Booking confirmed: ${show}`,
      `Your booking DEMO-EVENING-2048 is confirmed for ${date} at 20:00 Europe/London at ${venue}. Two tickets are attached. This is a synthetic reservation for an invented performance, not an actual theatre listing.`,
      booked,
      "p_merchant",
      {
        fromEmail: "tickets@stage-lantern.example.com",
        attachments: [
          {
            filename: "evening-tickets.pdf",
            mimeType: "application/pdf",
            assetPath: "assets/evening-tickets.pdf",
          },
        ],
      },
    ),
    mail(
      "sb-evening-shortlet",
      "Signed short-let agreement for your London stay",
      "Your signed agreement is attached. It covers your temporary London accommodation; retain it for your records.",
      booked,
      "p_landlord",
      {
        attachments: [
          {
            filename: "evening-shortlet.pdf",
            mimeType: "application/pdf",
            assetPath: "assets/evening-shortlet.pdf",
          },
        ],
      },
    ),
  );
  add(
    "google-calendar",
    "events.json",
    calendar(
      "sb-evening-calendar",
      show,
      date,
      "20:00",
      120,
      "Two-person theatre booking DEMO-EVENING-2048. Tickets are in the reservation email. Synthetic demonstration event for an invented performance.",
      {
        location: venue,
        attendees: ["self", eveningFriend.id],
        attendeeEmails: [OWNER_EMAIL, eveningFriend.emails[0]],
        createdAt: at(booked),
        updatedAt: at(booked),
      },
    ),
  );
  add("whatsapp-messages", "messages.json", {
    externalId: "sb-evening-pub-plan",
    chatId: "chat-p_thomas",
    chatTitle: eveningFriend.name,
    date: addDays(date, -1),
    counterparty: eveningFriend.id,
    messages: [
      {
        from: eveningFriend.id,
        at: londonAt(addDays(date, -1), "17:00"),
        text: `Shall we meet at ${pub} tomorrow, ${date}, at 7pm? A drink before our 8pm show at the Criterion.`,
      },
      {
        from: "self",
        at: londonAt(addDays(date, -1), "17:05"),
        text: "Yes, see you there at seven. I'll be coming from the short-let flat where I'm staying this week.",
      },
    ],
  });
  add("google-contacts", "contacts.json", {
    externalId: "sb-evening-thomas-contact",
    personRef: eveningFriend.id,
    givenName: "Thomas",
    familyName: "Ashford",
    createdAt: at(booked),
    modifiedAt: at(booked),
  });
  fact(
    "A16",
    "What time should I leave home tonight?",
    {
      date,
      show,
      showTime: "20:00",
      venue,
      pub,
      meetingTime: "19:00",
      home: lodging,
      seats: ["Stalls, Row H, Seat 12", "Stalls, Row H, Seat 13"],
      followUpPrompt: "What seats do we have?",
    },
    ["sb-evening-reservation", "sb-evening-calendar", "sb-evening-pub-plan", "sb-evening-shortlet"],
    [
      "Resolve tonight to the London day when loading the universe; dates remain fixed until a fresh load.",
      "The earlier pub plan changes the arrival target to 19:00; the show starts at 20:00.",
      "A real route lookup must supply travel duration. The fictional short-let has only a public street/locality route origin; state that approximation.",
      "Seat numbers exist only in the actual ticket PDF. The short-let address exists only in the actual tenancy PDF.",
    ],
  );
  return { ticket, tenancy, friend: eveningFriend };
}
