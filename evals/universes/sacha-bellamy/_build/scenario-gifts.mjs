// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mail, chat } from "./shared.mjs";

export function addGifts({ day, add, fact }) {
  const wishes = [
    [
      "sb-wish-sketching-stool",
      "2020-06-14",
      "A little folding stool would make sketching outdoors so much nicer. I keep sitting on wet grass.",
    ],
    ["sb-wish-ceramics", "2019-11-09", "I would love to try a pottery wheel class one day."],
    [
      "sb-wish-theatre",
      "2020-02-18",
      "An intimate theatre evening would be such a lovely birthday treat.",
    ],
    [
      "sb-wish-darkroom",
      "2021-09-12",
      "One thing I have always wanted: a darkroom printing workshop, making a real black-and-white print from a film negative. Not another digital photo course.",
    ],
    ["sb-wish-balloons", "2022-05-16", "A balloon flight looked exciting in that article."],
    [
      "sb-wish-correction",
      "2024-09-08",
      "I no longer fancy heights at all. Please no balloon or climbing gifts. Darkroom printing is still on my list; I want a small practical workshop, not camera equipment.",
    ],
    [
      "sb-wish-current",
      day(-18),
      "Still have the old film negatives. One day I would like to print one myself in a darkroom.",
    ],
  ];
  for (const [id, date, text] of wishes)
    add(
      "whatsapp-messages",
      "messages.json",
      chat(id, "p_maya", date, [text, "Noted — that does sound like your kind of thing."]),
    );
  add(
    "gmail",
    "messages.json",
    mail(
      "sb-sketching-stool-order",
      "Amazon order EXAMPLE-731-2048 delivered",
      "Order EXAMPLE-731-2048: one Meadowfold portable sketching stool, £32. Delivered 22 June 2020 to Sacha Bellamy. Gift message: Happy birthday Maya — for your outdoor sketching trips.",
      "2020-06-22",
      "p_gift_orders",
      { fromEmail: "orders@amazon.example.com" },
    ),
  );
  add(
    "apple-imessage",
    "messages.json",
    chat("sb-sketching-stool-received", "p_maya", "2020-06-24", [
      "Thank you for the folding sketching stool! Took it out today and my trousers finally stayed dry.",
      "Glad your birthday present got its first outing already.",
    ]),
  );
  add(
    "gmail",
    "messages.json",
    mail(
      "sb-pottery-confirmed",
      "Wheel class booking WK-220716",
      "Two attendees: Sacha Bellamy and Maya Reeves. Wheel class 16 July 2022, Willow Kiln Studio. Paid £120.",
      "2022-06-12",
      "p_ceramics",
    ),
  );
  add(
    "whatsapp-messages",
    "messages.json",
    chat("sb-pottery-attended", "p_maya", "2022-07-16", [
      "Loved making the wonky bowl today! Thanks for the pottery birthday present.",
      "It was lovely to finally do the wheel class together.",
    ]),
  );
  add(
    "gmail",
    "messages.json",
    mail(
      "sb-theatre-receipt",
      "Two theatre tickets — The Lantern Room",
      "Order LR-230908. Two tickets for 8 September 2023, 19:30. Paid £68.",
      "2023-08-20",
    ),
  );
  add(
    "apple-imessage",
    "messages.json",
    chat("sb-theatre-attended", "p_maya", "2023-09-09", [
      "That tiny theatre last night was exactly what I hoped for.",
      "Really glad we went.",
    ]),
  );
  fact(
    "F02",
    "Find a birthday experience Maya has wanted for years that our indexed history does not show us already doing. Check later preferences and completed experiences.",
    {
      gift: "small practical darkroom printing workshop",
      exclude: [
        "portable sketching stool received 2020-06-24",
        "pottery wheel class attended 2022-07-16",
        "intimate theatre attended 2023-09-08",
        "balloon/climbing gifts rejected",
      ],
    },
    wishes
      .map(([id]) => id)
      .concat([
        "sb-sketching-stool-order",
        "sb-sketching-stool-received",
        "sb-pottery-confirmed",
        "sb-pottery-attended",
        "sb-theatre-receipt",
        "sb-theatre-attended",
      ]),
    [
      "Absence of a completion record is not proof it never happened; current availability requires external research.",
    ],
  );
}
