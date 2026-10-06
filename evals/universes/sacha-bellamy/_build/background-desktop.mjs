// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { addDays, at, jitter } from "./shared.mjs";
import { topics, id, pick } from "./background-content.mjs";

export function addDesktop(state) {
  const { last, historical, put } = state;
  const days = Array.from({ length: 180 }, (_, i) => addDays(last, i - 179));
  put("screen-time", "apps.json", {
    days,
    apps: [
      { bundleId: "com.example.editor", name: "Harbour Editor", weight: 2.8 },
      { bundleId: "com.apple.Safari", name: "Safari", weight: 1.2 },
      { bundleId: "com.example.reading", name: "Shelf Reader", weight: 0.4 },
      { bundleId: "com.example.chess", name: "Quiet Chess", weight: 0.18 },
      { bundleId: "com.apple.Preview", name: "Preview", weight: 0.3 },
      { bundleId: "com.example.music", name: "Home Radio", weight: 0.5 },
    ],
  });

  const visitDays = days.filter(
    (day) =>
      !(day >= "2025-05-01" && day <= "2025-05-08") &&
      !(day >= "2019-07-01" && day <= "2019-09-08"),
  );
  const places = [
    "Wren Corner Coffee",
    "Harbour Lantern Workspace",
    "Northstar Reading Room",
    "Fernbank Community Garden",
    "Elm Lantern Grocers",
    "Willowbank Fitness Room",
    "Brookside Shared Courtyard",
    "Cedar Table Cafe",
    "Small Lantern Library",
    "Rowan Cycle Workshop",
  ];
  const visits = Array.from({ length: 1500 }, (_, i) => {
    const dayIndex = Math.floor((i * visitDays.length) / 1500);
    const day = visitDays[dayIndex];
    const slot = i - Math.ceil((dayIndex * 1500) / visitDays.length);
    const startMinute = 9 * 60 + Math.max(0, slot) * 65;
    const arrivalTime = at(
      day,
      `${String(Math.floor(startMinute / 60)).padStart(2, "0")}:${String(startMinute % 60).padStart(2, "0")}`,
    );
    const weekend = [0, 6].includes(new Date(at(day)).getUTCDay());
    const placeIndex = (slot + jitter(`visit-${day}`, places.length)) % places.length;
    const placeName =
      weekend && places[placeIndex] === "Harbour Lantern Workspace"
        ? "Northstar Reading Room"
        : places[placeIndex];
    return {
      id: id("location", i),
      placeName,
      locality: "London",
      administrativeArea: "England",
      country: "United Kingdom",
      latitude: 51.5 + jitter(`latitude-${i}`, 120) / 10000,
      longitude: -0.14 + jitter(`longitude-${i}`, 160) / 10000,
      horizontalAccuracyM: 35 + jitter(`accuracy-${i}`, 65),
      arrivalTime,
      departureTime: new Date(
        Date.parse(arrivalTime) + (20 + jitter(`dwell-${i}`, 35)) * 60000,
      ).toISOString(),
    };
  });
  put("core-location-visits", "visits.json", visits);

  const domains = [
    "library.example.org",
    "recipes.example.org",
    "crafts.example.com",
    "chess.example.com",
    "cycling.example.org",
    "history.example.org",
  ];
  put("browser-history", "visits.json", {
    browser: "safari",
    profile: "Personal",
    days,
    domains: domains.map((domain, i) => ({
      domain,
      weight: 1 + (i % 4),
      transition: i % 2 ? "link" : "typed",
    })),
    pages: Object.fromEntries(
      domains.map((domain, i) => [
        domain,
        Array.from({ length: 18 }, (_, j) => ({
          path: `/guides/${topics[(i * 6 + j) % topics.length][0].replaceAll(" ", "-")}`,
          title: `Guide: ${topics[(i * 6 + j) % topics.length][0]}`,
          ...(j % 4 === 0
            ? { searchTerm: `how to ${topics[(i * 6 + j) % topics.length][1]}` }
            : {}),
        })),
      ]),
    ),
  });
  put(
    "chrome-bookmarks",
    "bookmarks.json",
    Array.from({ length: 160 }, (_, i) => ({
      externalId: id("bookmark", i),
      title: `${topics[i % topics.length][0]} reference`,
      url: `https://${domains[i % domains.length]}/reference/${i}`,
      folder: pick(["Home", "Hobbies", "Read later"], `bookmark-folder-${i}`),
      addedAt: at(historical(i, 160)),
    })),
  );
}
