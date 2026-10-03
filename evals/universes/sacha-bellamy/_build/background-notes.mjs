// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { addDays, at, drive } from "./shared.mjs";
import { contentFor, id, topics, pick } from "./background-content.mjs";

export function addNotes(state) {
  const { historical, put } = state;
  const files = Array.from({ length: 500 }, (_, i) => {
    const day = historical(i, 500);
    const c = contentFor(30000 + i, day);
    return drive(
      id("drive", i),
      `${c.topic[0].replaceAll(" ", "-")}-${day}-${i}.txt`,
      `Working notes: ${c.topic[0]}\n\n${c.body}\n\nMaterials: ${c.quantity} reusable parts; cloth, pencil and measuring tape.\nRevision ${1 + (i % 4)}; earlier versions remain in the folder for comparison.`,
      day,
    );
  });
  put("google-drive", "files.json", files);
  const notes = (n, prefix) =>
    Array.from({ length: n }, (_, i) => {
      const day = historical(i, n);
      const c = contentFor(34000 + i, day);
      return {
        externalId: id(prefix, i),
        title: `${c.topic[0]} — ${day}`,
        body: `${c.body}\n\nRemember: ${c.topic[4]}. Keep the small experiment separate from the next one.`,
        folder: pick(["Home", "Hobbies", "Reading", "Weekend projects"], `folder-${i}`),
        createdAt: at(day),
        modifiedAt: at(day),
      };
    });
  put("apple-notes", "notes.json", notes(200, "apple-note"));
  put(
    "obsidian-notes",
    "notes.json",
    notes(300, "obsidian").map((n, i) => ({
      ...n,
      path: `Journal/${n.createdAt.slice(0, 4)}/${n.title}.md`,
      tags: [topics[i % topics.length][0].replaceAll(" ", "-"), "journal"],
    })),
  );
  put(
    "notion-pages",
    "pages.json",
    notes(100, "notion").map((n, i) => ({
      ...n,
      author: i % 3 ? "self" : "p_maya",
      tags: ["household", topics[i % topics.length][0].replaceAll(" ", "-")],
      ...(n.createdAt < "2018-05-01" ? { author: "self" } : {}),
    })),
  );

  put(
    "apple-reminders",
    "reminders.json",
    Array.from({ length: 200 }, (_, i) => {
      const day = historical(i, 200);
      const topic = topics[i % topics.length];
      return {
        externalId: id("reminder", i),
        title: topic[1][0].toUpperCase() + topic[1].slice(1),
        list: pick(["Home jobs", "Hobby box", "Library errands"], `rem-list-${i}`),
        dueAt: at(day, "16:00"),
        completed: i % 10 !== 0,
        createdAt: at(addDays(day, -4)),
      };
    }),
  );
  put(
    "things",
    "tasks.json",
    Array.from({ length: 200 }, (_, i) => {
      const day = historical(i, 200);
      const topic = topics[(i + 7) % topics.length];
      return {
        externalId: id("things", i),
        title: topic[1],
        notes: `${topic[3]}; next time ${topic[4]}.`,
        createdAt: at(addDays(day, -3)),
        modifiedAt: at(day),
        deadline: at(day, "17:00"),
        scheduledAt: at(day, "12:00"),
        project: pick(["Home upkeep", "Leisure experiments", "Reading group"], `project-${i}`),
        tags: [topic[0]],
        status: i % 13 === 0 ? "cancelled" : i % 11 === 0 ? "open" : "done",
      };
    }),
  );
  const dbRows = Array.from({ length: 120 }, (_, i) => {
    const day = historical(i, 120);
    const topic = topics[i % topics.length];
    return {
      id: id("household-row", i),
      createdAt: at(day),
      modifiedAt: at(day),
      Name: `${topic[0]} materials`,
      Category: pick(["Kitchen", "Crafts", "Reading", "Shared equipment"], `category-${i}`),
      Condition: pick(["Good", "Needs cleaning", "Repaired", "Stored"], `condition-${i}`),
      Quantity: 1 + (i % 6),
      Notes: topic[4],
    };
  });
  put("notion-databases", "databases.json", [
    {
      dbId: "sacha_household_materials",
      name: "Household materials",
      description: "Small ordinary supplies and shared hobby equipment",
      schemaProperties: [
        { name: "Name", type: "VARCHAR", description: "Label" },
        { name: "Category", type: "VARCHAR", description: "Storage category" },
        { name: "Condition", type: "VARCHAR", description: "Last recorded condition" },
        { name: "Quantity", type: "DOUBLE", description: "Count" },
        { name: "Notes", type: "VARCHAR", description: "Handling notes" },
      ],
      rows: dbRows,
    },
  ]);

  return files;
}
