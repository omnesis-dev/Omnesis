// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Require actual native recognition before enabling the full unit integration case.
import assert from "node:assert/strict";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { TesseractOcr, tesseractAvailable } from "../../packages/gateway/src/ocr/tesseract-ocr.ts";

assert.equal(process.platform, "win32");
assert.ok(process.env.RUNNER_TEMP);
assert.ok(process.env.GITHUB_ENV);
const root = join(process.env.RUNNER_TEMP, "invented OCR inputs 雪");
await mkdir(root, { recursive: true });
const image = join(root, "printed sample.png");
await sharp(
  Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="1500" height="220"><rect width="1500" height="220" fill="white"/><text x="40" y="135" font-family="Arial" font-size="64" fill="black">FICTIONAL SAMPLE TEXT 314159</text></svg>',
  ),
)
  .png()
  .toFile(image);
assert.equal(await tesseractAvailable(), true);
const ocr = new TesseractOcr({ timeoutMs: 15_000 });
try {
  const result = await ocr.recognize(new Uint8Array(await readFile(image)), "image/png", {
    language: "en",
  });
  assert.match(result.text, /\bFICTIONAL\s+SAMPLE\s+TEXT\s+314159\b/iu);
} finally {
  await ocr.dispose();
}
await appendFile(process.env.GITHUB_ENV, `OMNESIS_OCR_TEST_TESSERACT_IMAGE=${image}\n`);
process.stdout.write(
  `${JSON.stringify({ nativeOCRPassed: true, availabilityPassed: true, unicodeFixturePath: true })}\n`,
);
