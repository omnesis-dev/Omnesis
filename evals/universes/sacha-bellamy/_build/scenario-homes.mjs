// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mail, chat, calendar, drive, at } from "./shared.mjs";

export function addHomes({ ctx, add, fact }) {
  add("apple-notes", "notes.json", {
    externalId: "sb-owner-biography",
    title: "Personal background and household",
    body: "Sacha Bellamy. Born 18 February 1996 in France. Moved to London 1 September 2016 for a graduate software role. Software engineer at Harbour Lantern Software. Married Maya Reeves on 15 June 2024; she now uses Maya Bellamy. Interests: recreational running, cooking, cycling, photography and board games. Ten-week US placement from 1 July to 8 September 2019; maintained the London home throughout. Returned to London after the placement, retaining a small Bank of America USD account for occasional US trips.",
    folder: "Personal",
    createdAt: at("2024-06-16"),
    modifiedAt: at(ctx.day(-3)),
  });

  const homes = [
    ["sb-home-2016", "2016-09-01", "2018-07-13", "Flat 2, 14 Example Lane, London"],
    ["sb-home-2018", "2018-07-14", "2020-08-16", "Flat 5, 28 Sample Terrace, London"],
    ["sb-home-2020", "2020-08-17", "2023-04-30", "Flat 3, 42 Example Street, London"],
    ["sb-home-2023", "2023-03-01", null, "Flat 8, 66 Fictional Gardens, London"],
  ];
  for (const [id, start, end, address] of homes) {
    const content = `Residential tenancy agreement ${id}. Tenant: Sacha Bellamy${start >= "2020" ? " and Maya Reeves" : ""}. Property: ${address}. Term begins ${start}.${end ? ` Contract term ends ${end}.` : " Continuing periodic tenancy after initial term."} Rental dates are contractual terms; they do not certify the day the tenant occupied the property.`;
    add("google-drive", "files.json", drive(id, `${id}-tenancy.pdf`, content, start));
    add(
      "gmail",
      "messages.json",
      mail(
        `${id}-email`,
        `Signed tenancy: ${address}`,
        `Your agreement ${id} is attached. ${content}`,
        start,
        "p_landlord",
        {
          attachments: [
            {
              filename: `${id}-tenancy.pdf`,
              mimeType: "application/pdf",
              sizeBytes: 22000,
              extractedText: content,
            },
          ],
        },
      ),
    );
  }
  add(
    "whatsapp-messages",
    "messages.json",
    chat("sb-home-2016-occupied", "p_mover", "2016-09-01", [
      "Delivery completed at Flat 2, 14 Example Lane, London. All boxes are upstairs. Did everything arrive safely?",
      "Yes, thank you. I moved in today and am staying here tonight. The kettle was the first thing I unpacked.",
    ]),
    chat("sb-home-2018-occupied", "p_mover", "2018-07-14", [
      "The van is empty now at Flat 5, 28 Sample Terrace, London. Please let me know if anything was missed.",
      "Everything is here. I moved into Sample Terrace today; Example Lane is empty and the old keys have been returned.",
    ]),
    chat("sb-home-2020-occupied", "p_mover", "2020-08-17", [
      "Final delivery to Flat 3, 42 Example Street, London is complete. The bed frame is assembled as agreed.",
      "Thanks. Maya and I have moved in today and will sleep here tonight. We finished clearing Sample Terrace this morning.",
    ]),
  );
  add(
    "whatsapp-messages",
    "messages.json",
    chat("sb-move-initial", "p_mover", "2023-03-10", [
      "I have pencilled your move for 15 April. Keys available already?",
      "Yes, keys collected 1 March, but we are still living in Example Street while decorating.",
    ]),
    chat("sb-move-final", "p_mover", "2023-04-18", [
      "Confirmed correction: actual moving day is Saturday 22 April, not 15 April. Collection at 09:00 from Flat 3, 42 Example Street, London; unload at Flat 8, 66 Fictional Gardens, London.",
      "Agreed. This is when we will start sleeping at the new place. Old tenancy rent continues to 30 April.",
    ]),
    chat("sb-move-arrived", "p_maya", "2023-04-22", [
      "First night in Fictional Gardens! Finally moved in today.",
      "Yes, all the boxes made it.",
    ]),
  );
  add(
    "google-calendar",
    "events.json",
    calendar(
      "sb-move-calendar",
      "Moving day — final confirmed date",
      "2023-04-22",
      "08:00",
      480,
      "Kindred Cart Movers. Actual move from 42 Example Street to 66 Fictional Gardens. Earlier 15 April plan superseded.",
    ),
  );
  add(
    "gmail",
    "messages.json",
    mail(
      "sb-move-utility",
      "Utility handover reading — new occupancy",
      "Meter reading logged 22 April 2023. Sacha and Maya confirmed they moved into Fictional Gardens today.",
      "2023-04-22",
      "p_landlord",
    ),
  );
  fact(
    "F01",
    "Reconstruct my UK address history since September 2016. Resolve the overlapping tenancies and cite the actual move evidence.",
    {
      residences: homes.map(([id, start, end, address]) => ({
        address,
        from: id === "sb-home-2023" ? "2023-04-22" : start,
        to: id === "sb-home-2020" ? "2023-04-21" : end,
      })),
      actualMove: "2023-04-22",
      leaseStart: "2023-03-01",
    },
    [
      "sb-home-2016",
      "sb-home-2018",
      "sb-home-2020",
      "sb-home-2023",
      "sb-home-2016-occupied",
      "sb-home-2018-occupied",
      "sb-home-2020-occupied",
      "sb-move-final",
      "sb-move-calendar",
      "sb-move-arrived",
    ],
    ["Personal worksheet, not eligibility advice; leases alone do not establish occupancy."],
  );
  return homes;
}
