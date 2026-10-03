// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { calendar, at } from "./shared.mjs";

export function addDiaryTasks({ day, add, fact }) {
  add(
    "google-calendar",
    "events.json",
    calendar(
      "sb-gp-appointment",
      "GP appointment — bring symptom timeline",
      day(9),
      "09:00",
      20,
      "Owner requested factual symptom timeline, no diagnosis.",
      { location: "Cedar Practice, 20 Example Close" },
    ),
  );
  add("apple-notes", "notes.json", {
    externalId: "sb-symptom-onset",
    title: "Symptom diary — GP preparation",
    body: `Recorded on ${day(-15)}: waking during the night and feeling tired in the morning. No diagnosis. On ${day(-8)}: another restless night after late running-club session. On ${day(-1)}: appointment booked; want to discuss the timeline. These are my observations, not a clinician's assessment.`,
    folder: "Health",
    createdAt: at(day(-15)),
    modifiedAt: at(day(-1)),
  });
  fact(
    "A12",
    "Prepare a factual timeline for my GP appointment next week using recorded symptoms, voice notes and measured sleep. Summarize total asleep time for the two 14-night windows before and after the running-club timetable change. Keep each night’s stages together across midnight, anchored to London bedtime; exclude awake/in-bed and partial-day totals. State the final covered sleep night and other gaps. Avoid diagnosis.",
    {
      appointment: day(9),
      symptoms: ["waking during night", "morning tiredness"],
      noDiagnosis: true,
    },
    ["sb-gp-appointment", "sb-symptom-onset", "apple-health"],
    ["No treatment advice; measured association is not cause."],
  );
  add(
    "things",
    "tasks.json",
    {
      externalId: "sb-task-gp",
      title: "Print factual symptom timeline for GP",
      notes: "Use recorded facts and show missing days.",
      createdAt: at(day(-1)),
      modifiedAt: at(day(-1)),
      scheduledAt: day(8),
      deadline: at(day(9), "08:00"),
      project: "Personal admin",
      tags: ["health"],
      status: "open",
    },
    {
      externalId: "sb-task-complete",
      title: "Buy party wrapping paper",
      notes: "Already bought; no repeat purchase.",
      createdAt: at(day(-10)),
      modifiedAt: at(day(-2)),
      scheduledAt: day(-3),
      deadline: at(day(10)),
      project: "Personal admin",
      tags: ["party"],
      status: "done",
    },
  );
  fact(
    "A13",
    "What personal tasks, appointments and message-only promises do I have next week? Exclude completed tasks.",
    {
      weekStart: day(7),
      weekEnd: day(13),
      include: ["lantern pickup", "GP preparation and appointment", "Saturday setup promise"],
      exclude: ["buy party wrapping paper"],
    },
    [
      "sb-reminder-lantern",
      "sb-task-gp",
      "sb-task-complete",
      "sb-gp-appointment",
      "sb-party-final",
    ],
  );
}
