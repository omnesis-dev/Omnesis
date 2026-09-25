// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const extensionRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = dirname(extensionRoot);
const source = join(repositoryRoot, "assets", "brand", "omnesis-mark-blue.svg");
const output = join(extensionRoot, "public", "icons");
await mkdir(output, { recursive: true });

for (const size of [16, 32, 48, 128]) {
  const artwork = Math.round(size * 0.75);
  const padding = Math.floor((size - artwork) / 2);
  await sharp(source)
    .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .resize(artwork, artwork, { fit: "contain" })
    .extend({
      top: padding,
      bottom: size - artwork - padding,
      left: padding,
      right: size - artwork - padding,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png({ compressionLevel: 9, adaptiveFiltering: false })
    .toFile(join(output, `icon-${size}.png`));
}
