#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { format, resolveConfig } from "prettier";
import { context, REFERENCE_DAY, OWNER_EMAIL, WORK_EMAIL } from "./shared.mjs";
import { buildScenarios } from "./scenarios.mjs";
import { buildFinanceHealth } from "./finance-health.mjs";
import { buildExtras } from "./extras.mjs";
import { buildTravel } from "./travel.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PHONE_SOURCES = new Set([
  "apple-health",
  "core-location-visits",
  "photos",
  "activity-segments",
]);
const accounts = {
  "apple-calendar": "sacha.bellamy@icloud.example.com",
  "apple-call-log": "sacha.bellamy@icloud.example.com",
  "apple-contacts": "sacha.bellamy@icloud.example.com",
  "apple-imessage": "sacha.bellamy@icloud.example.com",
  "apple-notes": "sacha.bellamy@icloud.example.com",
  "apple-reminders": "sacha.bellamy@icloud.example.com",
  "apple-voicemail": "sacha.bellamy@icloud.example.com",
  "screen-time": "sacha.bellamy@icloud.example.com",
  "apple-health": "ios-sacha-bellamy",
  "core-location-visits": "ios-sacha-bellamy",
  photos: "ios-sacha-bellamy",
  "activity-segments": "ios-sacha-bellamy",
  gmail: OWNER_EMAIL,
  "google-calendar": OWNER_EMAIL,
  "google-contacts": OWNER_EMAIL,
  "google-drive": OWNER_EMAIL,
  "outlook-email": WORK_EMAIL,
  "outlook-calendar": WORK_EMAIL,
  onedrive: WORK_EMAIL,
  "whatsapp-messages": "+447700900100",
  "browser-history": "safari",
  "chrome-bookmarks": OWNER_EMAIL,
  coinbase: "bellamy-crypto",
  "enable-banking-accounts": "bellamy-eur",
  "lunchflow-accounts": "default",
  plaid: "plaid-bellamy-us",
  github: "fictional-sacha",
  "github-commits": "fictional-sacha",
  "granola-meetings": OWNER_EMAIL,
  "notion-pages": "user_sacha",
  "notion-databases": "user_sacha",
  "obsidian-notes": "Personal",
  things: "local",
  maildir: "mail-sacha-bellamy",
  "strava-activities": "8800100",
  "local-files": "files-sacha",
  imap: "imap-sacha",
  web: "web-sacha",
  codex: "codex-sacha",
  "claude-code": "claude-sacha",
  pi: "pi-sacha",
  openclaw: "openclaw-sacha",
  hermes: "hermes-sacha",
};

export function mergeSources(...sets) {
  const merged = {};
  for (const sources of sets)
    for (const [id, files] of Object.entries(sources)) {
      merged[id] ??= {};
      for (const [filename, data] of Object.entries(files)) {
        const previous = merged[id][filename];
        if (previous !== undefined && (!Array.isArray(previous) || !Array.isArray(data)))
          throw new Error(`Duplicate non-array fixture ${id}/${filename}`);
        merged[id][filename] = previous === undefined ? data : [...previous, ...data];
      }
    }
  return merged;
}

/** Build from original fictional authoring modules; never reads another universe or a live store. */
export async function buildUniverse({ asOf = REFERENCE_DAY, outDir = root, media = true } = {}) {
  const ctx = context(asOf);
  const { buildBackground } = await import("./background.mjs");
  const background = buildBackground(ctx);
  const scenarios = buildScenarios(ctx),
    finance = buildFinanceHealth(ctx);
  const travel = buildTravel(),
    extras = buildExtras(ctx);
  const sources = mergeSources(
    background.sources ?? background,
    scenarios.sources,
    finance.sources,
    extras.sources ?? extras,
    travel.sources,
  );
  scenarios.facts.find((f) => f.id === "A15").expected.additionalTrips = travel.trips;
  scenarios.facts
    .find((f) => f.id === "A15")
    .evidence.push(
      ...travel.trips.flatMap((t) => [`sb-trip-${t.id}-arrival`, `sb-trip-${t.id}-home`]),
      "sb-trip-cancelled-flight",
    );
  const facts = [...scenarios.facts, ...finance.facts].sort((a, b) => a.id.localeCompare(b.id));
  const manifest = {
    name: "sacha-bellamy",
    description:
      "A wholly fictional French London household: ten-year source history, everyday-life demonstrations and unrelated background. Live agents only.",
    cast: "cast.json",
    agentDemos: null,
    devices: [
      { id: "macbook", name: "Sacha demo laptop", kind: "collector" },
      { id: "iphone", name: "Sacha demo iPhone", kind: "ios" },
      { id: "browser", name: "Sacha demo browser", kind: "browser" },
    ],
    sources: Object.keys(sources)
      .sort()
      .map((descriptorId) => {
        if (!accounts[descriptorId]) throw new Error(`Missing source account for ${descriptorId}`);
        return {
          descriptorId,
          accountIds: [accounts[descriptorId]],
          device:
            descriptorId === "web"
              ? "browser"
              : PHONE_SOURCES.has(descriptorId)
                ? "iphone"
                : "macbook",
        };
      }),
  };
  const style = await resolveConfig(fileURLToPath(import.meta.url));
  const write = async (path, data) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, await format(JSON.stringify(data), { ...style, parser: "json" }));
  };
  await write(join(outDir, "universe.json"), manifest);
  await write(join(outDir, "cast.json"), ctx.cast);
  await write(join(outDir, "demo-facts.json"), {
    asOf,
    weekStart: ctx.monday,
    timeZone: "Europe/London",
    scenarios: facts,
  });
  const counts = {};
  for (const [id, files] of Object.entries(sources)) {
    counts[id] = {};
    for (const [filename, data] of Object.entries(files)) {
      await write(join(outDir, "sources", id, filename), data);
      counts[id][filename] = Array.isArray(data) ? data.length : "structured template";
    }
  }
  if (media) {
    const { generateMedia } = await import("./media.mjs");
    await generateMedia(outDir, scenarios.assets);
  }
  await write(join(outDir, "build-report.json"), {
    asOf,
    weekStart: ctx.monday,
    sourceCount: manifest.sources.length,
    scenarioCount: facts.length,
    fixtureCounts: counts,
    ...finance.counts,
  });
  return { manifest, facts, counts, outDir, asOf };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  let asOf = REFERENCE_DAY,
    outDir = root;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--as-of" && args[i + 1]) asOf = args[++i];
    else if (args[i] === "--out" && args[i + 1]) outDir = resolve(args[++i]);
    else throw new Error("Usage: build.mjs [--as-of YYYY-MM-DD] [--out DIRECTORY]");
  }
  const result = await buildUniverse({ asOf, outDir });
  process.stdout.write(
    `Built ${result.manifest.sources.length} sources and ${result.facts.length} demo concepts for ${asOf} in ${outDir}\n`,
  );
}
