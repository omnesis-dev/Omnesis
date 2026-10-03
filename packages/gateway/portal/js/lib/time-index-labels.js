// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Labels, icons, colours and help text for time index entries: their origin
// (source record, date mention, agent interpretation) and their kind. Every
// portal view that shows a time index entry reads them from here.

/** How each origin is labelled on a row and headed in its detail. */
export const ORIGIN_LABELS = {
  projection: {
    row: "Source record",
    heading: "Source record",
    icon: "▱",
    description:
      "Taken from a structured date field supplied by this source",
  },
  mention: {
    row: "Date mention",
    heading: "Date written in a document",
    icon: "❝",
    description:
      "Date mention detected in the document by Omnesis’ parser",
  },
  annotation: {
    row: "Agent interpretation",
    heading: "Agent interpretation",
    icon: "✦",
    description:
      "A dated fact recorded by the Omnesis Brain",
  },
};

export const CALENDAR_KINDS = {
  visit: {
    activity: true,
    label: "Visit",
    icon: "●",
    color: "#38bdf8",
    description: "A visit to a place or a period of presence.",
  },
  calendar_event: {
    label: "Calendar",
    icon: "▣",
    color: "#60a5fa",
    description: "A calendar entry using an older classification.",
  },
  event: {
    label: "Event",
    icon: "◆",
    color: "#818cf8",
    description:
      "A general dated occurrence or plan. For a date mention, this is an unclassified date, not a confirmed event.",
  },
  deadline: {
    label: "Deadline",
    icon: "⚑",
    color: "#f87171",
    moment: true,
    description:
      "A date by which something is due. A date mention may only contain deadline phrasing.",
  },
  reminder: {
    label: "Reminder",
    icon: "●",
    color: "#fbbf24",
    moment: true,
    description: "A dated reminder.",
  },
  expiry: {
    label: "Expires",
    icon: "⌛",
    color: "#fb923c",
    moment: true,
    description: "When something ends or ceases to be valid.",
  },
  appointment: {
    label: "Appointment",
    icon: "◉",
    color: "#34d399",
    description: "A timed booking or scheduled engagement.",
  },
  episode: {
    activity: true,
    label: "Activity",
    icon: "↺",
    color: "#a78bfa",
    description: "A dated episode or activity, not the time this entry was processed.",
  },
  episodic: {
    activity: true,
    label: "Activity",
    icon: "↺",
    color: "#a78bfa",
    description: "A dated episode or activity, not the time this entry was processed.",
  },
};
export const MOMENT_KINDS = new Set(
  Object.keys(CALENDAR_KINDS).filter((kind) => CALENDAR_KINDS[kind].moment),
);

export function kindMeta(kind) {
  return (
    CALENDAR_KINDS[kind] ?? {
      label: kind || "Unclassified",
      icon: "○",
      color: "#94a3b8",
    }
  );
}
