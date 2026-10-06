// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { calendar, OWNER_EMAIL } from "./shared.mjs";
import { id, pick, topics, eligiblePeople } from "./background-content.mjs";

export function addCalendars(state) {
  const { ctx, historical, put } = state;
  function events(count, prefix) {
    return Array.from({ length: count }, (_, i) => {
      const day = historical(i, count);
      const topic = topics[i % topics.length];
      const peer = pick(eligiblePeople(ctx, day), `${prefix}-peer-${i}`).id;
      return calendar(
        id(prefix, i),
        `${topic[0][0].toUpperCase() + topic[0].slice(1)} practice`,
        day,
        i % 3 === 0 ? "11:00" : "17:30",
        45 + (i % 4) * 15,
        `Reserved time to ${topic[1]}. Equipment: ordinary shared kit. ${i % 9 === 0 ? "Cancelled; this time was released rather than attended." : "Personal practice block; an invitation is not proof of attendance."}`,
        {
          location: i % 4 === 0 ? "Online" : "Personal time",
          calendarName: prefix === "apple-event" ? "Personal" : "Leisure",
          calendarId: `sb-${prefix}-calendar`,
          iCalUID: `${id(prefix, i)}@example.com`,
          attendees: ["self", peer],
          attendeeEmails: [OWNER_EMAIL, ctx.email(peer)],
          status: i % 9 === 0 ? "cancelled" : "confirmed",
        },
      );
    });
  }
  put("google-calendar", "events.json", events(700, "google-event"));
  put("apple-calendar", "events.json", events(180, "apple-event"));

  return events;
}
