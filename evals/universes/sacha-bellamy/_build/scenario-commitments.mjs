// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { email, OWNER_EMAIL, chat, calendar, at, londonAt } from "./shared.mjs";

export function addCommitments({ day, add, fact }) {
  add(
    "google-calendar",
    "events.json",
    calendar(
      "sb-party-stale",
      "Daniel birthday party",
      day(12),
      "19:00",
      180,
      "Original plan: guests at 19:00 at 18 Sample Walk. See organiser for final arrangements.",
      { location: "18 Sample Walk, London" },
    ),
  );
  add(
    "whatsapp-messages",
    "messages.json",
    chat(
      "sb-party-final",
      "p_nora",
      day(-2),
      [
        `Update for Daniel's party on ${day(12)}: venue changed to Example Hall, 88 Sample Road, London. Guests arrive at 18:15, surprise at 18:30. The calendar's 19:00 and old venue are out of date.`,
        "Got it, I will aim to arrive before 18:15.",
        `Also confirming your help setting up at 10:00 on Saturday ${day(12)}. We moved setup from the previous Saturday; thank you for lending a hand.`,
        "Yes, I promised to help set up on that confirmed date. Please keep the morning slot for me.",
      ],
      {
        chatId: "sb-party-group",
        chatTitle: "Daniel birthday organisers",
        participants: ["self", "p_nora", "p_priya", "p_elliot"],
      },
    ),
  );
  add("apple-notes", "notes.json", {
    externalId: "sb-home-current-note",
    title: "Household contact details",
    body: "Sacha and Maya Bellamy. Current home: Flat 8, 66 Fictional Gardens, London. Moved here 22 April 2023. Household emergency contacts are private.",
    folder: "Household",
    createdAt: at("2023-04-22"),
    modifiedAt: at(day(-10)),
  });
  fact(
    "A11",
    "What are the final guest arrival time and address for Daniel's party next week, and which details supersede the calendar?",
    {
      date: day(12),
      guestArrival: "18:15",
      surprise: "18:30",
      venue: "Example Hall, 88 Sample Road, London",
    },
    ["sb-party-final", "sb-party-stale", "sb-home-current-note"],
    [
      "Departure needs external route tool; fictional street addresses cannot produce a truthful live Maps route. Use a clearly disclosed route fixture or public venue mapping for recording.",
    ],
  );
  fact(
    "F09",
    "Can Maya and I take a weekend away next week, or have I promised that weekend to someone?",
    {
      commitment: "Help Nora set up Daniel birthday party",
      date: day(12),
      time: "10:00",
      latestCorrection: true,
    },
    ["sb-party-final"],
    ["Calendar gap does not prove availability; explicit confirmed promise is evidence."],
  );

  const audioText = `Quick note to myself. I promised Nora I would collect the paper lantern lights from Willow Kiln Studio on Tuesday ${day(8)} at five thirty in the afternoon. They are for Daniel's party. Not Wednesday: Amber closes early that day. I should take the blue canvas bag.`;
  add("gmail", "messages.json", {
    externalId: "sb-audio-promise",
    threadId: "sb-audio-promise@example.com",
    from: "self",
    fromEmail: email("self"),
    to: ["self"],
    toEmails: [OWNER_EMAIL],
    subject: "Voice memo after talking to Nora",
    body: "Attached is my recorded voice memo. The recording contains the details; this mail body does not repeat them.",
    sentAt: at(day(-4), "16:00"),
    labels: ["INBOX"],

    attachments: [
      {
        filename: "lantern-promise.wav",
        mimeType: "audio/wav",
        assetPath: "assets/lantern-promise.wav",
      },
    ],
  });
  add(
    "whatsapp-messages",
    "messages.json",
    chat("sb-lantern-confirmation", "p_nora", day(-1), [
      `Amber has your lantern pickup pencilled in for ${day(8)}. Could you check the time from your voice note?`,
      "Yes, I saved the voice note after we spoke.",
    ]),
  );
  add("apple-reminders", "reminders.json", {
    externalId: "sb-reminder-lantern",
    title: "Collect party lanterns for Nora",
    list: "Personal",
    dueAt: londonAt(day(8), "17:30"),
    completed: false,
    createdAt: at(day(-3)),
  });
  fact(
    "F05",
    "What exactly did I promise Nora in the voice memo last week? Give the date, time, collection place and what to bring. Express all times in Europe/London local time, converting UTC timestamps before comparing them.",
    {
      date: day(8),
      localTime: "17:30",
      place: "Willow Kiln Studio",
      item: "paper lantern lights",
      bring: "blue canvas bag",
      correction: "Tuesday, not Wednesday",
    },
    ["sb-audio-promise", "sb-lantern-confirmation", "sb-reminder-lantern"],
    [
      "Audio must be genuinely transcribed; UTC task time must agree with London daylight-saving offset.",
    ],
  );
  return audioText;
}
