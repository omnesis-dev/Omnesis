// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mail, chat, at } from "./shared.mjs";

export function addFranceTrip({ add, fact }) {
  const trip = {
    start: "2025-05-01",
    end: "2025-05-08",
    carStart: "2025-05-02",
    carEnd: "2025-05-06",
  };
  add(
    "gmail",
    "messages.json",
    mail(
      "sb-france-outward",
      "Rail confirmation FR-250501",
      "Sacha Bellamy and Maya Bellamy: London to Paris, 1 May 2025, departing 07:30. Connecting train to Saint-Malo booked separately.",
      "2025-04-02",
    ),
    mail(
      "sb-france-return",
      "Rail confirmation FR-250508",
      "Paris to London, 8 May 2025, departing 16:00. Two named passengers: Sacha and Maya Bellamy.",
      "2025-04-02",
    ),
    mail(
      "sb-france-car",
      "Rental confirmation CAR-250502",
      "Collection in Saint-Malo 2 May 2025 at 10:00; return Rennes 6 May 2025 at 10:00. Four-day rental, not the length of the whole France trip.",
      "2025-04-03",
    ),
    mail(
      "sb-france-hotel-cancelled",
      "Cancelled duplicate room — refund",
      "Booking STAY-OLD cancelled 15 April 2025. £90 refund to Lantern Current posted 18 April. This is not a second stay.",
      "2025-04-15",
    ),
    mail(
      "sb-france-hotel-final",
      "Final stay STAY-250501",
      "Saint-Malo, 1–4 May, £240 booked GBP. Rennes, 4–7 May, £210 booked GBP. Final night near Paris, 7–8 May, £80 booked GBP.",
      "2025-04-16",
    ),
  );
  const visit = (id, placeName, locality, arrivalTime, departureTime, latitude, longitude) => ({
    id,
    placeName,
    subLocality: "",
    locality,
    administrativeArea: "Brittany",
    country: "France",
    latitude,
    longitude,
    horizontalAccuracyM: 35,
    arrivalTime,
    departureTime,
  });
  add(
    "core-location-visits",
    "visits.json",
    visit(
      "sb-visit-saint-malo",
      "Saint-Malo old town",
      "Saint-Malo",
      at("2025-05-03", "10:10"),
      at("2025-05-03", "15:20"),
      48.6493,
      -2.0257,
    ),
    visit(
      "sb-visit-rennes",
      "Rennes city centre",
      "Rennes",
      at("2025-05-05", "11:00"),
      at("2025-05-05", "16:30"),
      48.1113,
      -1.68,
    ),
  );
  add(
    "whatsapp-messages",
    "messages.json",
    chat("sb-trip-arrived", "p_maya", "2025-05-01", [
      "We are in France now — just arrived off the train.",
      "Eight days away, then back to London on the eighth.",
    ]),
    chat("sb-trip-home", "p_maya", "2025-05-08", [
      "Back home in London now, kettle on.",
      "The four-day car hire was just the middle of the trip.",
    ]),
    chat("sb-trip-settlement", "p_maya", "2025-05-12", [
      "Agreed: you paid the shared travel/card costs. I have transferred £565 towards half. Cash snacks were separate, so do not guess their cost.",
      "Thanks — transfer received, reference FRANCE-SPLIT.",
    ]),
  );
  fact(
    "F03",
    "Where was I on 3 May 2025, and how long was my whole France trip compared with the car rental?",
    { place: "Saint-Malo, Brittany, France", ...trip, tripDays: 8, carDays: 4 },
    [
      "sb-visit-saint-malo",
      "sb-france-outward",
      "sb-france-return",
      "sb-france-car",
      "sb-trip-arrived",
      "sb-trip-home",
    ],
    [
      "Measured visit proves presence at the visit interval; tickets are planned travel, corroborated by arrival/home messages.",
    ],
  );
  fact(
    "F07",
    "How much did the France trip cost me after the cancelled-room refund and Maya’s reimbursement? Show the arithmetic, currencies and cash uncertainty. Cite the underlying transaction rows using their actual transaction table and row keys, alongside the coverage note.",
    {
      sharedNetGBP: 1130,
      paidBeforeRefundGBP: 1220,
      refundGBP: 90,
      mayaPaidGBP: 565,
      sachaNetGBP: 565,
      cash: "untracked",
    },
    ["sb-france-hotel-final", "sb-france-hotel-cancelled", "sb-trip-settlement", "sb-txn-trip-*"],
    ["No invented currency conversion; exclude internal transfers; unknown cash remains unknown."],
  );
  return trip;
}
