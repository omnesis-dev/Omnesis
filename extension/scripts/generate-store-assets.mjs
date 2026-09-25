// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import sharp from "sharp";
import { STORE_ASSET_INPUTS_FILE, storeAssetInputsDigest } from "./store-package-contract.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = join(root, "store", "assets");
await mkdir(output, { recursive: true });

const css = await readFile(join(root, "public", "ui.css"), "utf8");
const icon = (await readFile(join(root, "public", "icons", "icon-128.png"))).toString("base64");
// The screenshot is a render of the options page; the digest of its inputs is
// committed beside it so a test can tell when the page changed after the last
// render and the artwork must be regenerated.
await writeFile(join(output, STORE_ASSET_INPUTS_FILE), `${await storeAssetInputsDigest(root)}\n`);
const options = (await readFile(join(root, "public", "options.html"), "utf8"))
  .replace('<link rel="stylesheet" href="ui.css" />', `<style>${css}</style>`)
  .replace('src="icons/icon-128.png"', `src="data:image/png;base64,${icon}"`)
  .replace(/<script type="module" src="options\.js"><\/script>/u, "");

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
  });
  await page.setContent(options);
  await page.screenshot({ path: join(output, "pairing-and-controls-1280x800.png") });

  const tile = await browser.newPage({
    viewport: { width: 440, height: 280 },
    deviceScaleFactor: 1,
  });
  await tile.setContent(`<!doctype html><style>
    *{box-sizing:border-box}body{margin:0;width:440px;height:280px;display:grid;place-items:center;background:radial-gradient(circle at 28% 15%,#263a58,#0d1117 62%);color:#e6edf3;font:16px system-ui,-apple-system,sans-serif}.wrap{text-align:center}.icon{width:96px;height:96px;filter:drop-shadow(0 14px 30px #0008)}h1{font-size:27px;letter-spacing:-.03em;margin:14px 0 4px}p{color:#a8b3c0;margin:0;font-size:14px}
  </style><div class="wrap"><img class="icon" src="data:image/png;base64,${icon}" alt=""><h1>Omnesis Browser Capture</h1><p>Your reading, in your private index.</p></div>`);
  await tile.screenshot({ path: join(output, "small-promo-tile-440x280.png") });

  // The marquee tile is the wide format the store's featured shelf uses. Chrome
  // rejects an alpha channel here, so the render is flattened onto the tile's
  // own background rather than saved straight from the screenshot.
  const marquee = await browser.newPage({
    viewport: { width: 1400, height: 560 },
    deviceScaleFactor: 1,
  });
  await marquee.setContent(`<!doctype html><style>
    *{box-sizing:border-box}
    body{margin:0;width:1400px;height:560px;background:radial-gradient(circle at 22% 18%,#263a58,#0d1117 62%);color:#e6edf3;font:16px system-ui,-apple-system,sans-serif;display:grid;grid-template-columns:1fr 1fr;align-items:center}
    .copy{padding-left:104px}
    .icon{width:112px;height:112px;filter:drop-shadow(0 16px 34px #0009)}
    h1{font-size:58px;line-height:1.06;letter-spacing:-.035em;margin:26px 0 16px;max-width:15ch}
    p{color:#a8b3c0;margin:0;font-size:24px;line-height:1.4;max-width:24ch}
    .stack{position:relative;height:560px}
    .card{position:absolute;left:60px;width:400px;height:132px;border-radius:16px;background:#131c2b;border:1px solid #24344b;padding:20px 22px;box-shadow:0 22px 50px #0006}
    .card:nth-child(1){top:112px;transform:rotate(-4deg);opacity:.45}
    .card:nth-child(2){top:214px;left:104px;transform:rotate(-1deg);opacity:.72}
    .card:nth-child(3){top:316px;left:148px;transform:rotate(2deg)}
    .t{height:13px;width:58%;border-radius:999px;background:#4a6c99}
    .line{height:9px;border-radius:999px;background:#2b3b52;margin-top:14px}
  </style>
  <div class="copy">
    <img class="icon" src="data:image/png;base64,${icon}" alt="">
    <h1>Omnesis Browser Capture</h1>
    <p>Your reading, in your own private index.</p>
  </div>
  <div class="stack">
    <div class="card"><div class="t"></div><div class="line" style="width:88%"></div><div class="line" style="width:64%"></div></div>
    <div class="card"><div class="t"></div><div class="line" style="width:92%"></div><div class="line" style="width:57%"></div></div>
    <div class="card"><div class="t"></div><div class="line" style="width:80%"></div><div class="line" style="width:70%"></div></div>
  </div>`);
  const marqueeShot = await marquee.screenshot();
  await sharp(marqueeShot)
    .flatten({ background: "#0d1117" })
    .png({ compressionLevel: 9 })
    .toFile(join(output, "marquee-promo-tile-1400x560.png"));
} finally {
  await browser.close();
}
