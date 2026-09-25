// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The collector and the substrate it feeds are drawn on both the landing page
 * and the Brain page, from one template in render-arch-substrate.mjs. Editing
 * the template without re-rendering would leave the two pages disagreeing
 * about the same diagram, which is exactly the drift the generator exists to
 * prevent — so the pages are asserted to match what it would emit today:
 *
 *   node scripts/render-arch-substrate.mjs
 */

import { expect, test } from "vitest";
import { SOURCE_ICONS, TARGETS, renderFile } from "./render-arch-substrate.mjs";

const EXPECTED_SOURCE_ICONS = [
  ["gmail", "gmail"],
  ["outlook email", "outlook email"],
  ["whatsapp", "whatsapp"],
  ["apple imessage", "apple imessage"],
  ["apple notes", "apple notes"],
  ["apple reminders", "apple reminders"],
  ["notion", "notion"],
  ["obsidian", "obsidian"],
  ["things 3", "things 3"],
  ["granola", "granola"],
  ["pi sessions", "pi sessions"],
  ["claude code sessions", "claude code sessions"],
  ["codex sessions", "codex sessions"],
  ["github", "github"],
  ["google calendar", "google calendar"],
  ["outlook calendar", "outlook calendar"],
  ["apple calendar", "apple calendar"],
  ["google contacts", "google contacts"],
  ["apple contacts", "apple contacts"],
  ["google drive", "google drive"],
  ["onedrive", "onedrive"],
  ["chrome bookmarks", "chrome bookmarks"],
  ["browser history", "browser history"],
  ["web pages", "web pages"],
  ["apple health", "apple health"],
  ["health connect", "health connect"],
  ["photos & screenshots", "photos & screenshots"],
  ["activity segments", "activity segments"],
  ["location visits", "location visits"],
  ["app usage", "app usage"],
  ["call log", "call log"],
  ["apple voicemail", "apple voicemail"],
  ["screen time", "screen time"],
  ["strava", "strava"],
  ["coinbase", "coinbase"],
  ["enable banking", "enable banking"],
  ["lunch flow", "lunch flow"],
  ["omnesis chat", "omnesis chat"],
  ["openclaw", "openclaw (via plugin)"],
  ["hermes", "hermes (via plugin)"],
];

test.each(TARGETS)("%s carries a freshly rendered arch-substrate block", async (target) => {
  const { before, after } = await renderFile(target);
  expect(before).toBe(after);
});

test("both pages label the shared substrate box for their own audience", async () => {
  const labels = await Promise.all(
    TARGETS.map(async (target) => {
      const { before } = await renderFile(target);
      return before.match(/<!-- arch-substrate:start (.+?) -->/)[1];
    }),
  );
  // The landing page names the component, the Brain page names what it holds.
  expect(labels).toEqual(["Gateway", "Context substrate"]);
});

test("the collector grid renders every source family with an accessible native tooltip", async () => {
  const actualCatalog = SOURCE_ICONS.map(({ label, tooltip = label }) => [
    label.toLowerCase(),
    tooltip.toLowerCase(),
  ]);
  expect(actualCatalog).toEqual(EXPECTED_SOURCE_ICONS);
  expect(new Set(SOURCE_ICONS.map(({ label }) => label)).size).toBe(SOURCE_ICONS.length);
  const expectedTooltips = EXPECTED_SOURCE_ICONS.map(([, tooltip]) => tooltip);

  for (const target of TARGETS) {
    const { before } = await renderFile(target);
    const grid = before.match(/<div class="src-grid">([\s\S]*?)<\/div>/)?.[1];
    expect(grid).toBeDefined();

    const titles = [...grid.matchAll(/ title="([^"]+)"/g)].map((match) => match[1]);
    const altLabels = [...grid.matchAll(/ alt="([^"]+)"/g)].map((match) => match[1]);
    expect(titles.map((title) => title.toLowerCase())).toEqual(
      expectedTooltips.map((tooltip) => tooltip.replaceAll("&", "&amp;")),
    );
    expect(altLabels).toEqual(titles);
  }
});
