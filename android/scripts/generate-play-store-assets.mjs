// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const androidDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = join(androidDir, "store-listing", "en-US");
const logoXml = readFileSync(
  join(androidDir, "app", "src", "main", "res", "drawable", "omnesis_logo.xml"),
  "utf8",
);
const pathData = logoXml.match(/android:pathData="([^"]+)"/)?.[1];
if (!pathData) throw new Error("Could not read the Omnesis logo path");

const tempDir = join(outputDir, ".generated-source");
rmSync(tempDir, { recursive: true, force: true });
mkdirSync(tempDir, { recursive: true });

const iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 1000 1000">
  <rect width="1000" height="1000" fill="#1f6feb"/>
  <g transform="translate(180 180) scale(.64)"><path fill="#ffffff" fill-rule="evenodd" d="${pathData}"/></g>
</svg>`;
const featureSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="500" viewBox="0 0 1024 500">
  <rect width="1024" height="500" fill="#0d1117"/>
  <circle cx="180" cy="250" r="128" fill="#1f6feb"/>
  <g transform="translate(98 168) scale(.164)"><path fill="#ffffff" fill-rule="evenodd" d="${pathData}"/></g>
  <text x="350" y="230" fill="#f0f6fc" font-family="DejaVu Sans, sans-serif" font-size="78" font-weight="700">Omnesis</text>
  <text x="354" y="300" fill="#8b949e" font-family="DejaVu Sans, sans-serif" font-size="34">Search your digital life.</text>
</svg>`;

const iconSource = join(tempDir, "icon.svg");
const featureSource = join(tempDir, "feature-graphic.svg");
writeFileSync(iconSource, iconSvg);
writeFileSync(featureSource, featureSvg);

const goldenDir = join(androidDir, "app", "src", "test", "roborazzi");
const screenshots = [
  ["onboarding_dark.png", "01-onboarding.png", "#0d1117"],
  ["search_results_light.png", "02-search.png", "#ffffff"],
  ["agent_transcript_light.png", "03-agent.png", "#ffffff"],
  ["people_content_light.png", "04-people.png", "#ffffff"],
  ["settings_connected_dark.png", "05-settings.png", "#0d1117"],
];

function renderAssets(targetDir) {
  const targetScreenshotsDir = join(targetDir, "phone-screenshots");
  mkdirSync(targetScreenshotsDir, { recursive: true });
  execFileSync("convert", [
    "-background", "none", iconSource, "-strip", "-depth", "8",
    `PNG32:${join(targetDir, "icon.png")}`,
  ]);
  execFileSync("convert", [
    "-background", "#0d1117", featureSource, "-alpha", "off", "-strip", "-depth", "8",
    `PNG24:${join(targetDir, "feature-graphic.png")}`,
  ]);
  for (const [source, output, background] of screenshots) {
    execFileSync("convert", [
      join(goldenDir, source),
      "-background", background,
      "-gravity", "center",
      "-extent", "1337x2673",
      "-alpha", "off",
      "-strip",
      "-depth", "8",
      `PNG24:${join(targetScreenshotsDir, output)}`,
    ]);
  }
}

renderAssets(outputDir);

function imageProperties(path) {
  const raw = execFileSync("identify", ["-format", "%w %h %[channels] %z", path], {
    encoding: "utf8",
  }).trim();
  const [width, height, channels, depth] = raw.split(/\s+/u);
  return { width: Number(width), height: Number(height), channels, depth: Number(depth) };
}

const iconOutput = join(outputDir, "icon.png");
const featureOutput = join(outputDir, "feature-graphic.png");
const screenshotsDir = join(outputDir, "phone-screenshots");
const icon = imageProperties(iconOutput);
if (icon.width !== 512 || icon.height !== 512 || icon.depth !== 8 || !icon.channels.includes("a")) {
  throw new Error(`Invalid Play icon properties: ${JSON.stringify(icon)}`);
}
const feature = imageProperties(featureOutput);
if (feature.width !== 1024 || feature.height !== 500 || feature.depth !== 8 || feature.channels.includes("a")) {
  throw new Error(`Invalid Play feature graphic properties: ${JSON.stringify(feature)}`);
}
for (const [, output] of screenshots) {
  const path = join(screenshotsDir, output);
  const screenshot = imageProperties(path);
  const longest = Math.max(screenshot.width, screenshot.height);
  const shortest = Math.min(screenshot.width, screenshot.height);
  if (screenshot.depth !== 8 || screenshot.channels.includes("a") || longest > shortest * 2) {
    throw new Error(`Invalid Play screenshot properties for ${output}: ${JSON.stringify(screenshot)}`);
  }
}

function fileDigest(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const verificationDir = join(tempDir, "verification-output");
renderAssets(verificationDir);
const relativeAssets = [
  "icon.png",
  "feature-graphic.png",
  ...screenshots.map(([, output]) => join("phone-screenshots", output)),
];
for (const relative of relativeAssets) {
  const generated = fileDigest(join(outputDir, relative));
  const verification = fileDigest(join(verificationDir, relative));
  if (generated !== verification) {
    throw new Error(`Play asset generation is not byte-reproducible: ${relative}`);
  }
}

rmSync(tempDir, { recursive: true, force: true });

process.stdout.write(`Generated, validated, and reproducibility-checked Google Play assets in ${outputDir}\n`);
