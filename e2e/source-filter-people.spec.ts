// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "@playwright/test";

const levelId = "00000000-0000-4000-8000-000000000082";
const sourceId = "fictional-mail:one";
const source = {
  id: sourceId,
  sourceType: "fictional-mail",
  displayName: "Fictional mail account",
  available: true,
  filterable: true,
};
const counted = { status: "ready", tooOld: 0, unmatched: 0, tooOldText: null, unmatchedText: null };
const person = (label: string, addresses: string[], count: number | null) => ({
  ref: {
    capability: "person",
    label,
    identifiers: addresses.map((value) => ({ type: "email", value })),
  },
  label,
  shortLabel: label,
  count,
});

test("people search rows keep a small counting spinner and show a person's addresses on hover and focus", async ({
  page,
}, testInfo) => {
  // The test runner creates this isolated directory; never fall back to an installed gateway.
  const configDir = process.env.OMNESIS_PORTAL_TEST_CONFIG_DIR;
  if (!configDir) throw new Error("An isolated portal test gateway is required.");
  const token = readFileSync(join(configDir, "token"), "utf8").trim();
  expect((await page.request.post("/portal/api/login", { data: { token } })).ok()).toBe(true);
  await page.route("**/admin/access", (route) =>
    route.fulfill({
      json: {
        principals: [],
        pendingAuthorizations: [],
        oauth: null,
        policies: [],
        sourceFilters: { enabled: true },
        sources: [source],
        levels: [
          {
            id: levelId,
            name: "Fictional research",
            revision: 1,
            connectionCount: 0,
            createdAt: 1,
            updatedAt: 1,
            rules: [
              {
                capability: "answer",
                sources: { mode: "all", sourceIds: [] },
                release: { mode: "unreviewed" },
                filterRevision: 1,
                scopePolicies: [],
              },
            ],
          },
        ],
      },
    }),
  );
  await page.route(/\/admin\/access\/source-filters\//, async (route) => {
    const url = new URL(route.request().url());
    const tail = url.pathname.split("/").at(-1);
    if (tail === "options") {
      await route.fulfill({
        json: {
          sourceId,
          field: "$people",
          // Counts the gateway has not worked out yet, asked for again later.
          retryAfterMs: 60_000,
          items: [
            person("Maya Reeves", ["maya@example.com", "m.reeves@example.org"], null),
            person("Jamie Lopez", ["jamie@example.io"], null),
            person("David Lin", ["david.lin@example.com"], 3),
          ],
        },
      });
      return;
    }
    if (tail === "preview") {
      await route.fulfill({
        json: {
          status: "ready",
          sourceId,
          total: 10,
          visible: 10,
          hidden: 0,
          tooOld: 0,
          unmatched: 0,
          tooOldText: null,
          unmatchedText: null,
          connected: true,
          items: [],
        },
      });
      return;
    }
    await route.fulfill({
      json: {
        sourceId,
        sourceType: source.sourceType,
        devices: [{ id: "dev-one", name: "Fictional laptop" }],
        showDeviceLevel: false,
        profile: "declared",
        profileText: null,
        connected: true,
        fields: [
          {
            field: "$people",
            capability: "person",
            noun: { one: "person", many: "people" },
            picker: "search",
            scope: "global",
            identifiers: ["email"],
            state: { status: "ready" },
            counts: counted,
          },
        ],
      },
    });
  });
  await page.goto(`/portal/settings/access/levels/${levelId}`);
  await page
    .locator(".guided-overview-decision")
    .filter({ has: page.getByRole("heading", { name: "Answer data", exact: true }) })
    .getByRole("button", { name: "Change", exact: true })
    .click();
  await expect(page.getByRole("searchbox", { name: "Find a source" })).toHaveAttribute(
    "placeholder",
    "Search sources",
  );
  await page
    .getByRole("button", { name: "Change Fictional mail account content", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Only matching content", { exact: false }).check();
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await dialog.getByRole("searchbox", { name: "Search people", exact: true }).focus();
  const rows = dialog.locator(".source-filter-options li");
  await expect(rows).toHaveCount(3);

  // A row still being counted shows a round spinner, never one stretched along the row.
  const spinner = rows.nth(0).locator(".source-filter-spinner");
  await expect(spinner).toBeVisible();
  // Layout size, which the rotation does not change.
  const size = await spinner.evaluate((el) => [
    (el as HTMLElement).offsetWidth,
    (el as HTMLElement).offsetHeight,
  ]);
  expect(size).toEqual([12, 12]);
  await expect(rows.nth(2)).toContainText("3 matching");

  const card = dialog.locator(".source-filter-person-card");
  await expect(card).toHaveCount(0);
  await rows.nth(0).hover();
  await expect(card).toBeVisible();
  await expect(card).toContainText("Maya Reeves");
  await expect(card).toContainText("Matched by any of these 2 addresses");
  await expect(card.locator("li")).toHaveText(["maya@example.com", "m.reeves@example.org"]);
  // Beside the list at this width, so it covers no row.
  const listBox = (await dialog.locator(".source-filter-options").boundingBox())!;
  const cardBox = (await card.boundingBox())!;
  expect(cardBox.x).toBeGreaterThanOrEqual(listBox.x + listBox.width);
  await page.screenshot({ path: testInfo.outputPath("people-card-hover.png") });

  await rows.nth(1).locator("input").focus();
  await expect(card).toContainText("Matched by this address");
  await expect(card.locator("li")).toHaveText(["jamie@example.io"]);
  await expect(rows.nth(1).locator("input")).toHaveAttribute("aria-describedby", /.+/);

  // A narrow window has no room beside the list: the card goes under its row.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.mouse.move(0, 0);
  await rows.nth(0).hover();
  await expect(card).toContainText("Maya Reeves");
  const rowBox = (await rows.nth(0).boundingBox())!;
  expect((await card.boundingBox())!.y).toBeGreaterThanOrEqual(rowBox.y + rowBox.height);
  await page.setViewportSize({ width: 1280, height: 720 });

  if (process.env.OMNESIS_GALLERY_DIR) {
    for (const scheme of ["light", "dark"] as const) {
      await page.evaluate((theme) => {
        localStorage.setItem("omnesis.theme", theme);
        document.documentElement.setAttribute("data-theme", theme);
      }, scheme);
      await page.mouse.move(0, 0);
      await rows.nth(0).hover();
      await expect(card).toContainText("Maya Reeves");
      await page.screenshot({
        path: join(
          process.env.OMNESIS_GALLERY_DIR,
          `gallery-filter-picker-people-card-${scheme}.png`,
        ),
      });
    }
  }
});
