// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { chromium, type Browser } from "playwright";
import { StartupManager } from "./manager.js";
import { renderStartupPage, startupPageCsp } from "./page.js";

const browserAvailable = existsSync(chromium.executablePath());
if (!browserAvailable && process.env.CI) {
  throw new Error("startup-page-layout.e2e: Chromium is required in CI");
}

const layouts = [
  { name: "desktop-dark", width: 1366, height: 768, colorScheme: "dark" },
  { name: "mobile-light", width: 390, height: 640, colorScheme: "light" },
  { name: "landscape-dark", width: 844, height: 390, colorScheme: "dark" },
  { name: "narrow-light", width: 320, height: 568, colorScheme: "light" },
  { name: "zoomed-light", width: 341, height: 192, colorScheme: "light" },
] as const;

/** The renderer and CSP are production code; every response stays in the browser fixture. */
describe.skipIf(!browserAvailable)("startup page viewport layout", () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch();
  }, 45_000);

  afterAll(async () => {
    await browser?.close();
  });

  test.each(layouts)(
    "keeps the heading visible and scrolls the steps in $name",
    async ({ name, width, height, colorScheme }) => {
      let now = Date.now() - 20_000;
      const manager = new StartupManager({ now: () => now, bootId: "layout-fixture" });
      for (const id of ["launcher", "ownership", "tls", "runtime", "configuration"] as const) {
        manager.start(id);
        now += 120;
        manager.succeed(id);
      }
      manager.start("storage");
      let commits = 0;
      const context = await browser.newContext({
        viewport: { width, height },
        colorScheme,
        reducedMotion: "reduce",
      });
      try {
        await context.route("**/*", async (route) => {
          const url = new URL(route.request().url());
          if (url.origin !== "https://startup.example.org") return route.abort();
          if (url.pathname === "/.well-known/omnesis-startup") {
            commits++;
            manager.migration({
              phase: "committed",
              current: commits,
              completed: commits,
              total: 1_000,
            });
            return route.fulfill({ json: manager.snapshot() });
          }
          if (route.request().resourceType() === "document") {
            return route.fulfill({
              contentType: "text/html",
              headers: { "content-security-policy": startupPageCsp() },
              body: renderStartupPage(),
            });
          }
          return route.abort();
        });
        const page = await context.newPage();
        await page.goto(
          "https://startup.example.org/portal/settings/models?token=fictional#details",
          {
            waitUntil: "domcontentloaded",
          },
        );
        await page.locator("#startup-steps li[data-state=running] .step-detail").waitFor();
        const layout = await page.evaluate(() => {
          const rect = (selector: string) => {
            const box = document.querySelector(selector)!.getBoundingClientRect();
            return { top: box.top, bottom: box.bottom, left: box.left, right: box.right };
          };
          const mark = document.querySelector(".brand-mark")!.getBoundingClientRect();
          const word = document.querySelector(".wordmark")!.getBoundingClientRect();
          const status = document.querySelector("li[data-state=succeeded] .step-status")!;
          const label = document.createRange();
          label.selectNodeContents(status.firstChild!);
          const labelBox = label.getBoundingClientRect();
          const elapsed = status.querySelector("small")!.getBoundingClientRect();
          const list = document.getElementById("startup-steps")!;
          return {
            documentWidth: Math.max(
              document.documentElement.scrollWidth,
              document.body.scrollWidth,
            ),
            documentHeight: Math.max(
              document.documentElement.scrollHeight,
              document.body.scrollHeight,
            ),
            card: rect(".card"),
            heading: rect("#startup-title"),
            brand: {
              markRight: mark.right,
              wordLeft: word.left,
              centerDifference: Math.abs(mark.top + mark.height / 2 - word.top - word.height / 2),
              sizeRatio:
                mark.height /
                Number.parseFloat(getComputedStyle(document.querySelector(".wordmark")!).fontSize),
            },
            statusLinesOverlap:
              Math.min(labelBox.bottom, elapsed.bottom) > Math.max(labelBox.top, elapsed.top),
            duration: status.querySelector("small")!.textContent,
            steps: list.children.length,
            listHeight: list.clientHeight,
            scrollable: list.scrollHeight > list.clientHeight + 1,
          };
        });
        expect(layout.documentWidth).toBeLessThanOrEqual(width + 1);
        expect(layout.documentHeight).toBeLessThanOrEqual(height + 1);
        for (const bounds of [layout.card, layout.heading]) {
          expect(bounds.top).toBeGreaterThanOrEqual(0);
          expect(bounds.left).toBeGreaterThanOrEqual(0);
          expect(bounds.bottom).toBeLessThanOrEqual(height + 1);
          expect(bounds.right).toBeLessThanOrEqual(width + 1);
        }
        expect(layout.brand.markRight).toBeLessThanOrEqual(layout.brand.wordLeft + 1);
        expect(layout.brand.centerDifference).toBeLessThanOrEqual(4);
        expect(layout.brand.sizeRatio).toBeGreaterThan(0.6);
        expect(layout.brand.sizeRatio).toBeLessThan(1.3);
        expect(layout.statusLinesOverlap).toBe(true);
        expect(layout.duration).toBe("0s");
        expect(layout.steps).toBe(15);
        expect(layout.listHeight).toBeGreaterThanOrEqual(32);
        await page.screenshot({ path: join(tmpdir(), `omnesis-startup-layout-${name}.png`) });

        const list = page.locator("#startup-steps");
        if (height < 700) expect(layout.scrollable).toBe(true);
        if (layout.scrollable) {
          await list.hover();
          await page.mouse.wheel(0, 160);
          await expect.poll(() => list.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
          const scrollTop = await list.evaluate((node) => node.scrollTop);
          const detail = page.locator("li[data-state=running] .step-detail");
          const previousDetail = await detail.textContent();
          await expect
            .poll(() => detail.textContent(), { timeout: 10_000 })
            .not.toBe(previousDetail);
          expect(await list.evaluate((node) => node.scrollTop)).toBeCloseTo(scrollTop, 0);
          expect(await page.evaluate(() => window.scrollY)).toBe(0);
          const heading = await page.locator("#startup-title").boundingBox();
          expect(heading?.y).toBeCloseTo(layout.heading.top, 0);
          await list.focus();
          await page.keyboard.press("End");
          await expect
            .poll(() =>
              list.evaluate((node) => node.scrollTop + node.clientHeight >= node.scrollHeight - 1),
            )
            .toBe(true);
        }
        const lastStep = await list.locator("li").last().boundingBox();
        const scrollArea = await list.boundingBox();
        expect(lastStep).not.toBeNull();
        expect(scrollArea).not.toBeNull();
        expect(lastStep!.y + lastStep!.height).toBeLessThanOrEqual(
          scrollArea!.y + scrollArea!.height + 1,
        );
        expect(await page.evaluate(() => window.scrollY)).toBe(0);
      } finally {
        await context.close();
      }
    },
    30_000,
  );
});
