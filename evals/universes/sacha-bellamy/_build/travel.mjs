// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mail, chat, calendar, at } from "./shared.mjs";

/** Original fictional trip records spanning the household history, with one cancellation trap. */
export function buildTravel() {
  const trips = [
    {
      id: "lyon-2017",
      country: "France",
      city: "Lyon",
      from: "2017-12-20",
      to: "2017-12-29",
      purpose: "Visit parents for winter break",
      counterparty: "p_celine",
      latitude: 45.764,
      longitude: 4.8357,
    },
    {
      id: "paris-2018",
      country: "France",
      city: "Paris",
      from: "2018-08-09",
      to: "2018-08-13",
      purpose: "Short summer trip with Maya",
      counterparty: "p_maya",
      latitude: 48.8566,
      longitude: 2.3522,
    },
    {
      id: "placement-2019",
      country: "United States",
      city: "San Francisco",
      from: "2019-07-01",
      to: "2019-09-08",
      purpose: "Ten-week software placement; London residence retained",
      counterparty: "p_marc",
      latitude: 37.7749,
      longitude: -122.4194,
    },
    {
      id: "lyon-2022",
      country: "France",
      city: "Lyon",
      from: "2022-12-21",
      to: "2022-12-30",
      purpose: "Winter family visit with Maya",
      counterparty: "p_celine",
      latitude: 45.764,
      longitude: 4.8357,
    },
    {
      id: "porto-2024",
      country: "Portugal",
      city: "Porto",
      from: "2024-06-23",
      to: "2024-06-30",
      purpose: "Honeymoon after 15 June wedding",
      counterparty: "p_maya",
      latitude: 41.1579,
      longitude: -8.6291,
    },
  ];
  const messages = [],
    chats = [],
    events = [],
    visits = [];
  for (const trip of trips) {
    const prefix = `sb-trip-${trip.id}`;
    messages.push(
      mail(
        `${prefix}-outward`,
        `Outbound booking ${trip.id}`,
        `Passenger Sacha Bellamy. London to ${trip.city}; booked departure ${trip.from}. Return reservation separately confirmed. Purpose: ${trip.purpose}. This receipt establishes planned travel, not a measured border crossing.`,
        trip.from,
        "p_travel",
      ),
      mail(
        `${prefix}-return`,
        `Return booking ${trip.id}`,
        `Passenger Sacha Bellamy. ${trip.city} to London; booked return ${trip.to}. Reference ${trip.id}.`,
        trip.from,
        "p_travel",
      ),
    );
    chats.push(
      chat(`${prefix}-arrival`, trip.counterparty, trip.from, [
        `Just arrived in ${trip.city} today. ${trip.purpose}.`,
        "Glad you arrived safely.",
      ]),
      chat(`${prefix}-home`, trip.counterparty, trip.to, [
        "Back at the London flat now. The return journey was today.",
        "Good to hear you made it home.",
      ]),
    );
    events.push(
      calendar(
        `${prefix}-calendar`,
        trip.purpose,
        trip.from,
        "09:00",
        60,
        `Planned away until ${trip.to}. Calendar is an itinerary rather than proof of actual travel.`,
      ),
    );
    visits.push({
      id: `${prefix}-visit`,
      placeName: `${trip.city} public city centre`,
      subLocality: "",
      locality: trip.city,
      administrativeArea: trip.city,
      country: trip.country,
      latitude: trip.latitude,
      longitude: trip.longitude,
      horizontalAccuracyM: 70,
      arrivalTime: at(trip.from, "16:00"),
      departureTime: at(trip.from, "17:00"),
    });
  }
  messages.push(
    mail(
      "sb-trip-cancelled-flight",
      "Cancelled trip LANTERN-2408",
      "The proposed August 2024 flight to Stockholm has been cancelled. The reservation was voided before any charge; no journey will take place on this booking. Do not treat the old booking as an absence.",
      "2024-07-18",
      "p_travel",
    ),
    mail(
      "sb-trip-original-flight",
      "Original booking LANTERN-2408",
      "Original reservation: London to Stockholm 12 August 2024, return 18 August 2024.",
      "2024-07-01",
      "p_travel",
    ),
  );
  return {
    sources: {
      gmail: { "messages.json": messages },
      "whatsapp-messages": { "messages.json": chats },
      "google-calendar": { "events.json": events },
      "core-location-visits": { "visits.json": visits },
    },
    trips,
  };
}
