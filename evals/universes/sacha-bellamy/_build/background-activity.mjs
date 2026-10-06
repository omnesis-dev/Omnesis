// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { addDays, at, hash, SELF, OWNER_EMAIL } from "./shared.mjs";
import { dayAt, id, topics, pick, eligiblePeople, contentFor } from "./background-content.mjs";

export function addActivity(state) {
  const { ctx, last, put } = state;
  // Recreational activity history ends before the near-term health narratives.
  const activities = Array.from({ length: 200 }, (_, i) => {
    const day = dayAt(i, 200, "2020-09-01", addDays(ctx.asOf, -120));
    const cycling = i % 5 === 0;
    const distance = cycling ? 14000 + (i % 8) * 1200 : 4200 + (i % 11) * 480;
    const numeric = 990000 + i;
    return {
      externalId: id("strava", i),
      id: numeric,
      name: cycling ? "Easy local cycle" : "Relaxed recreational run",
      sportType: cycling ? "Ride" : "Run",
      distanceMeters: distance,
      movingTimeSeconds: Math.round(distance * (cycling ? 0.23 : 0.38)),
      totalElevationGainMeters: 12 + (i % 17) * 3,
      startTime: at(day, "07:30"),
      averageHeartRate: cycling ? 119 + (i % 15) : 133 + (i % 17),
      maxHeartRate: cycling ? 147 + (i % 8) : 164 + (i % 9),
      description: `Steady pace, familiar loop. ${pick(["Dry path", "A breezy section", "A little mud near the turn", "Quiet early start", "Stopped briefly to retie a lace"], `run-${i}`)}. No race target.`,
    };
  });
  put("strava-activities", "activities.json", activities);
  put(
    "strava-activities",
    "zones.json",
    activities.flatMap((a) =>
      Array.from({ length: 4 }, (_, bucketIndex) => ({
        activityId: a.id,
        zoneType: "heartrate",
        bucketIndex,
        minValue: 90 + bucketIndex * 20,
        maxValue: 109 + bucketIndex * 20,
        timeSeconds: Math.round(a.movingTimeSeconds * [0.2, 0.45, 0.3, 0.05][bucketIndex]),
      })),
    ),
  );

  put(
    "granola-meetings",
    "meetings.json",
    Array.from({ length: 100 }, (_, i) => {
      const day = dayAt(i, 100, "2023-09-01", last);
      const topic = topics[i % topics.length];
      const peer = pick(eligiblePeople(ctx, day), `granola-${i}`);
      const c = contentFor(40000 + i, day);
      const key = `not_${hash(`granola-${i}`).slice(0, 14)}`;
      return {
        id: key,
        object: "note",
        title: `${topic[0]} discussion`,
        created_at: at(day, "14:00"),
        updated_at: at(day, "15:00"),
        web_url: `https://notes.example.com/${key}`,
        summary_text: `Discussed how to ${topic[1]}. ${topic[3]}. Agreed to ${topic[4]}.`,
        summary_markdown: null,
        owner: { name: ctx.person(SELF).name, email: OWNER_EMAIL },
        attendees: [{ name: peer.name, email: peer.emails[0] }],
        calendar_event: {
          id: id("club-meeting", i),
          title: `${topic[0]} discussion`,
          start_time: at(day, "14:00"),
          end_time: at(day, "14:30"),
        },
        folder_membership: [{ id: "club-notes", name: "Leisure group" }],
        transcript: c.messages.slice(0, 6).map((text, j) => ({
          speaker: {
            source: j % 2 ? "microphone" : "speaker",
            diarization_label: j % 2 ? "Sacha" : peer.name,
          },
          text,
          start_time: at(day, `14:${String(j * 2).padStart(2, "0")}`),
          end_time: at(day, `14:${String(j * 2 + 1).padStart(2, "0")}`),
        })),
      };
    }),
  );
}
