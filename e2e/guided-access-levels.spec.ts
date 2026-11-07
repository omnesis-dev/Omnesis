// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { scopeContracts as whatsappContracts } from "@omnesis/provider-whatsapp/scope-contracts";
import { scopeContracts } from "@omnesis/provider-google/src/scope-contracts";

// Real provider declarations, independently invented account and content data.
const levelId = "00000000-0000-4000-8000-000000000093";
const policyId = "00000000-0000-4000-8000-000000000094";
const baseSources = [
  {
    id: "gmail:owner@example.com",
    sourceType: "gmail",
    displayName: "Gmail",
    available: true,
    scopes: scopeContracts.gmail,
    scopeReadiness: [
      { kind: "participant", ready: true },
      { kind: "label", ready: true },
    ],
  },
  {
    id: "google-drive:owner@example.com",
    sourceType: "google-drive",
    displayName: "Google Drive",
    available: true,
    scopes: scopeContracts["google-drive"],
    scopeReadiness: [{ kind: "folder", ready: true }],
  },
];
const savedPolicy = {
  sourceId: baseSources[0]!.id,
  audience: { accessLevel: levelId, capability: "answer" },
  rules: [{ action: "share", match: [{ kind: "label", id: "planning" }] }],
  otherwise: "hide",
};
const answer = {
  capability: "answer",
  sources: { mode: "allowlist", sourceIds: baseSources.map((source) => source.id) },
  release: { mode: "reviewed", policyFamilyId: policyId },
  filterRevision: 3,
  scopePolicies: [savedPolicy],
};
const direct = {
  capability: "direct",
  sources: { mode: "allowlist", sourceIds: baseSources.map((source) => source.id) },
  filterRevision: 5,
  scopePolicies: [],
};
const nameFor = (ref: {
  kind: string;
  id?: string;
  label?: string;
  identifiers?: Array<{ value: string }>;
}) =>
  ref.id?.match(/-item-(\d+)$/)
    ? `${ref.kind === "folder" ? "Folder" : "Label"} ${String(Number(ref.id.match(/-item-(\d+)$/)![1]) + 1).padStart(2, "0")} — Independently invented catalogue entry`
    : ref.kind === "label"
      ? "Planning"
      : ref.kind === "folder"
        ? "Comet notes"
        : ref.label || ref.identifiers?.map((item) => item.value).join(" or ") || "Maya Reeves";
async function assertPrimaryContrast(page: Page) {
  const dialog = page.getByRole("dialog");
  const scope = (await dialog.count()) ? dialog : page;
  const button = scope
    .locator(
      ".guided-task-footer .btn-primary:enabled, .guided-filter-footer .btn-primary:enabled, .confirm-modal-actions .btn-primary:enabled",
    )
    .last();
  if (!(await button.count())) return;
  const check = async () => {
    const ratio = await button.evaluate((element) => {
      const luminance = (color: string) => {
        const channels = color
          .match(/\d+/g)!
          .slice(0, 3)
          .map(Number)
          .map((channel) => {
            const value = channel / 255;
            return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
          });
        return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
      };
      const style = getComputedStyle(element),
        a = luminance(style.color),
        b = luminance(style.backgroundColor);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    });
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  };
  await check();
  await button.hover();
  await check();
  await button.focus();
  await check();
  await page.mouse.down();
  await check();
  // Measure :active without activating the action or its backdrop.
  await page.evaluate(() =>
    document.addEventListener(
      "click",
      (event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
      },
      { capture: true, once: true },
    ),
  );
  await page.mouse.up();
  await page.mouse.move(0, 0);
}
async function assertInputAffordance(page: Page) {
  const ratios = await page
    .locator(
      '.guided-level-flow input:enabled:not([type="checkbox"]):not([type="radio"]), .guided-level-flow select:enabled, .guided-filter-editor input:enabled:not([type="checkbox"]):not([type="radio"]), .guided-filter-editor select:enabled',
    )
    .evaluateAll((elements) => {
      const luminance = (color: string) => {
        const values = color
          .match(/[\d.]+/g)!
          .slice(0, 3)
          .map(Number)
          .map((channel) => {
            const value = channel / 255;
            return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
          });
        return values[0]! * 0.2126 + values[1]! * 0.7152 + values[2]! * 0.0722;
      };
      return elements
        .filter((element) => (element as HTMLElement).offsetParent !== null)
        .map((element) => {
          let background = getComputedStyle(element).backgroundColor;
          let parent = element.parentElement;
          while ((background === "transparent" || background === "rgba(0, 0, 0, 0)") && parent) {
            background = getComputedStyle(parent).backgroundColor;
            parent = parent.parentElement;
          }
          const border = luminance(getComputedStyle(element).borderTopColor),
            surface = luminance(background);
          return (Math.max(border, surface) + 0.05) / (Math.min(border, surface) + 0.05);
        });
    });
  for (const ratio of ratios) expect(ratio).toBeGreaterThanOrEqual(3);
}
async function capture(
  page: Page,
  testInfo: { outputPath: (name: string) => string },
  name: string,
  captureScale = 1,
) {
  const root = process.env.OMNESIS_ACCESS_FLOW_CAPTURE_DIR;
  if (root) mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = root ? join(root, name + ".png") : testInfo.outputPath(name + ".png");
  if (captureScale === 1) await page.screenshot({ path });
  else {
    const session = await page.context().newCDPSession(page);
    try {
      const { cssVisualViewport: viewport } = await session.send("Page.getLayoutMetrics");
      const result = await session.send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: false,
        clip: {
          x: viewport.pageX,
          y: viewport.pageY,
          width: viewport.clientWidth,
          height: viewport.clientHeight,
          scale: captureScale,
        },
      });
      writeFileSync(path, Buffer.from(result.data, "base64"));
    } finally {
      await session.detach();
    }
  }
  await assertPrimaryContrast(page);
  await assertInputAffordance(page);
  if (root) chmodSync(path, 0o600);
  return path;
}
for (const theme of ["dark", "light"])
  for (const width of [1440, 390])
    test(`guided create and targeted edit preserve exact permissions at ${width}px in ${theme}`, async ({
      page,
    }, testInfo) => {
      const sources = [...baseSources];
      let longCatalogue = false;
      let previews = "ready",
        options = "ready",
        filtersEnabled = true;
      const iconFile = process.env.OMNESIS_ACCESS_FLOW_ICON_FILE;
      const fixtureIcons = iconFile
        ? (JSON.parse(readFileSync(iconFile, "utf8")) as Record<string, string>)
        : {};
      for (const source of sources)
        Object.assign(source, { icon: fixtureIcons[source.sourceType] });
      await page.addInitScript((theme) => localStorage.setItem("omnesis.theme", theme), theme);
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1080 });
      const configDir = process.env.OMNESIS_PORTAL_TEST_CONFIG_DIR;
      if (!configDir) throw new Error("An isolated Portal test gateway is required.");
      const token = readFileSync(join(configDir, "token"), "utf8").trim();
      expect((await page.request.post("/portal/api/login", { data: { token } })).ok()).toBe(true);
      let levels = [
        {
          id: levelId,
          name: "Research assistant",
          revision: 1,
          connectionCount: 0,
          createdAt: 1,
          updatedAt: 1,
          rules: [answer, direct],
        },
      ];
      let active = 0,
        maximum = 0,
        conflict = true;
      const writes: Array<Record<string, unknown>> = [];
      let holdWrite = false,
        releaseWrite: (() => void) | undefined;
      const overview = () => ({
        principals: [],
        pendingAuthorizations: [],
        pendingRequests: [],
        oauth: null,
        policies: [],
        policyFamilies: [{ id: policyId, name: "Project policy", isDefault: true }],
        defaultPolicyFamilyId: policyId,
        sourceFilters: { enabled: filtersEnabled },
        sources,
        levels,
      });
      await page.route("**/admin/access", (route) => route.fulfill({ json: overview() }));
      await page.route("**/admin/access/source-filters/*/options?*", async (route) => {
        if (options === "error") {
          await route.fulfill({
            status: 503,
            json: { error: "Options are temporarily unavailable." },
          });
          return;
        }
        const url = new URL(route.request().url()),
          kind = url.searchParams.get("kind"),
          parent = url.searchParams.get("parentId");
        const sourceId = decodeURIComponent(url.pathname.split("/").at(-2)!);
        const participant = sources
          .find((source) => source.id === sourceId)!
          .scopes.items.find((item) => item.kind === "participant");
        const phoneOnly =
          participant && "identifiers" in participant && !participant.identifiers.includes("email");
        const ref =
          kind === "participant"
            ? {
                kind,
                label: "Maya Reeves",
                identifiers: [
                  phoneOnly
                    ? { type: "phone", value: "+15550100144" }
                    : { type: "email", value: "maya@example.com" },
                ],
              }
            : { kind, id: kind === "label" ? "planning" : parent ? "folder-child" : "folder-root" };
        const items =
          longCatalogue && kind !== "participant"
            ? Array.from({ length: 65 }, (_, index) => ({
                ref: { kind, id: `${parent || kind}-item-${index}` },
                label: `${kind === "folder" ? "Folder" : "Label"} ${String(index + 1).padStart(2, "0")} — Independently invented catalogue entry`,
                count: 6,
                hasChildren: kind === "folder" && !parent,
              }))
            : [
                {
                  ref,
                  label:
                    kind === "folder"
                      ? parent
                        ? "Comet notes"
                        : "Dawn archive"
                      : kind === "label"
                        ? "Planning"
                        : "Maya Reeves",
                  count: 6,
                  hasChildren: kind === "folder" && !parent,
                },
              ];
        const cursor = url.searchParams.get("cursor");
        const offset = cursor ? Number(Buffer.from(cursor, "base64url").toString()) : 0;
        await route.fulfill({
          json: {
            sourceId,
            scopes: sources.find((source) => source.id === sourceId)!.scopes,
            readiness: sources.find((source) => source.id === sourceId)!.scopeReadiness,
            items: items.slice(offset, offset + 50),
            nextCursor:
              offset + 50 < items.length
                ? Buffer.from(String(offset + 50)).toString("base64url")
                : undefined,
          },
        });
      });
      await page.route("**/admin/access/source-filters/*/preview", async (route) => {
        if (previews === "error") {
          await route.fulfill({
            status: 503,
            json: { error: "Filter previews are busy. Try again shortly." },
          });
          return;
        }
        active++;
        maximum = Math.max(maximum, active);
        if (active > 4) {
          active--;
          await route.fulfill({
            status: 503,
            json: { error: "Filter previews are busy. Try again shortly." },
          });
          return;
        }
        const body = route.request().postDataJSON(),
          sourceId = decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-2)!);
        await new Promise((resolve) => setTimeout(resolve, 25));
        const only = body.policy.rules[0].action === "share";
        active--;
        await route.fulfill({
          json: {
            sourceId,
            total: 20,
            visible: only ? 6 : 12,
            hidden: only ? 14 : 8,
            unknown: 2,
            readiness: sources
              .find((source) => source.id === sourceId)!
              .scopeReadiness.map((item) => ({ ...item, ready: previews !== "preparing" })),
            items: body.policy.rules.flatMap(
              (rule: { match: Array<{ kind: string; id?: string }> }) =>
                rule.match.map((ref) => ({
                  ref,
                  label:
                    previews === "missing" && ref.kind !== "participant" ? ref.id : nameFor(ref),
                  count: previews === "missing" && ref.kind !== "participant" ? 0 : 6,
                  missing: previews === "missing" && ref.kind !== "participant",
                })),
            ),
            samples: [
              {
                documentId: "invented-sample",
                title: "Project outline",
                visible: true,
                unknown: false,
              },
            ],
          },
        });
      });
      await page.route("**/admin/access/levels", async (route) => {
        const body = route.request().postDataJSON();
        writes.push(body);
        levels.push({
          id: "00000000-0000-4000-8000-000000000095",
          name: body.name,
          revision: 1,
          connectionCount: 0,
          createdAt: 2,
          updatedAt: 2,
          rules: body.rules,
        });
        await route.fulfill({ json: { level: levels.at(-1) } });
      });
      await page.route(`**/admin/access/levels/${levelId}`, async (route) => {
        const body = route.request().postDataJSON();
        writes.push(body);
        if (conflict) {
          conflict = false;
          levels = levels.map((level) =>
            level.id === levelId ? { ...level, revision: 2 } : level,
          );
          await route.fulfill({ status: 409, json: { error: "stale-revision" } });
          return;
        }
        if (holdWrite)
          await new Promise<void>((resolve) => {
            releaseWrite = resolve;
          });
        levels = levels.map((level) =>
          level.id === levelId
            ? { ...level, rules: body.rules, revision: level.revision + 1 }
            : level,
        );
        await route.fulfill({ json: { level: levels.find((level) => level.id === levelId) } });
      });
      const shot = (name: string) => capture(page, testInfo, `${theme}-${width}-${name}`);
      const forward = () => page.getByRole("button", { name: "Continue", exact: true }).click();
      const sourceRow = (name: string) =>
        page.locator(".guided-source-row").filter({ has: page.getByText(name, { exact: true }) });
      const modal = () => page.getByRole("dialog");
      const pickMatches = async () => {
        if (await modal().getByLabel("All content", { exact: false }).isChecked())
          await modal().getByLabel("Only matching content", { exact: false }).check();
        await modal().getByRole("button", { name: "Continue", exact: true }).click();
      };
      await page.goto("/portal/settings/access");
      await expect(
        page.getByRole("heading", { name: "Agent access", exact: true }),
      ).toBeInViewport();
      await shot("00-access-entry");
      await page.getByRole("button", { name: "New access level", exact: true }).click();
      await expect(
        page.getByRole("heading", { name: "What may this connection do?", exact: true }),
      ).toBeInViewport();
      await expect(
        page.getByRole("heading", { name: "What may this connection do?", exact: true }),
      ).toBeFocused();
      await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeInViewport();
      await expect(page.getByLabel("Access level name", { exact: true })).toHaveCount(0);
      await shot("supplement-00-answer-only-permissions");
      await page
        .locator(".access-capability-preset")
        .filter({ has: page.getByText("Direct", { exact: true }) })
        .locator("input")
        .check();
      await shot("new-01-permissions");
      await forward();
      await expect(
        page.getByRole("heading", { name: "Which data may Answer use?", exact: true }),
      ).toBeInViewport();
      await sourceRow("Gmail").getByRole("checkbox").check();
      await sourceRow("Google Drive").getByRole("checkbox").check();
      await shot("new-02-answer-data");
      await sourceRow("Gmail")
        .getByRole("button", { name: "Change Gmail content", exact: true })
        .click();
      await shot("filter-01-mode");
      await expect(modal().getByLabel("All content", { exact: false })).toBeChecked();
      await modal().getByRole("button", { name: "Continue", exact: true }).click();
      await shot("filter-01b-unfiltered-all-review");
      await modal().getByRole("button", { name: "Share all content", exact: true }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(sourceRow("Gmail")).toContainText("All content");
      await sourceRow("Gmail")
        .getByRole("button", { name: "Change Gmail content", exact: true })
        .click();
      await pickMatches();
      await modal().getByRole("button", { name: "labels", exact: true }).click();
      await modal()
        .getByRole("checkbox", { name: /Planning/ })
        .check();
      await shot("filter-02-label-picker");
      await modal().getByRole("button", { name: "Review filter", exact: true }).click();
      await expect(
        modal().getByRole("button", { name: "Apply filter", exact: true }),
      ).toBeEnabled();
      await shot("filter-03-label-review");
      await modal().getByRole("button", { name: "Back", exact: true }).click();
      await expect(modal().getByRole("checkbox", { name: /Planning/ })).toBeChecked();
      await modal().getByRole("button", { name: "Review filter", exact: true }).click();
      await modal().getByRole("button", { name: "Apply filter", exact: true }).click();
      await sourceRow("Google Drive")
        .getByRole("button", { name: "Change Google Drive content", exact: true })
        .click();
      await modal().getByLabel("Everything except matches", { exact: false }).check();
      await pickMatches();
      await modal().getByRole("button", { name: "Open Dawn archive", exact: true }).click();
      await modal()
        .getByRole("checkbox", { name: /Comet notes/ })
        .check();
      await shot("filter-04-folder-picker");
      await modal().getByRole("button", { name: "Review filter", exact: true }).click();
      await expect(
        modal().getByRole("button", { name: "Apply filter", exact: true }),
      ).toBeEnabled();
      await shot("filter-05-except-review");
      await modal().getByRole("button", { name: "Apply filter", exact: true }).click();
      await forward();
      await expect(
        page.getByRole("heading", { name: "What may Direct read?", exact: true }),
      ).toBeInViewport();
      await shot("new-03-direct-choice");
      await page.getByLabel("Choose Direct data separately", { exact: false }).check();
      await forward();
      await shot("new-04-direct-data");
      await sourceRow("Google Drive")
        .getByRole("button", { name: "Change Google Drive content", exact: true })
        .click();
      await modal().getByLabel("All content", { exact: false }).check();
      await modal().getByRole("button", { name: "Continue", exact: true }).click();
      await shot("filter-06-all-content-expansion");
      await modal().getByRole("button", { name: "Share all content", exact: true }).click();
      await forward();
      await expect(
        page.getByRole("heading", { name: "What about new sources?", exact: true }),
      ).toBeInViewport();
      await shot("new-05-future");
      await forward();
      await expect(
        page.getByRole("heading", { name: "How should answers be released?", exact: true }),
      ).toBeInViewport();
      await shot("new-06-release");
      await forward();
      await page.getByLabel("Access level name", { exact: true }).fill("Project assistant");
      await shot("new-07-review");
      const reviewChange = (title: string) =>
        page
          .locator(".guided-review-decision")
          .filter({ has: page.getByRole("heading", { name: title, exact: true }) })
          .getByRole("button", { name: "Change", exact: true });
      await reviewChange("Answer release").click();
      await forward();
      await expect(
        page.getByRole("heading", { name: "Ready to create this access level?", exact: true }),
      ).toBeVisible();
      await reviewChange("Answer data").click();
      await sourceRow("Google Drive")
        .getByRole("button", { name: "Change Google Drive content", exact: true })
        .click();
      await modal().getByLabel("Only matching content", { exact: false }).check();
      await pickMatches();
      await modal().getByRole("button", { name: "Review filter", exact: true }).click();
      await expect(
        modal().getByRole("button", { name: "Apply filter", exact: true }),
      ).toBeEnabled();
      await modal().getByRole("button", { name: "Apply filter", exact: true }).click();
      await forward();
      await expect(
        page.getByRole("heading", { name: "Ready to create this access level?", exact: true }),
      ).toBeVisible();
      await page.locator(".guided-decision-body").evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await shot("new-07b-review-bottom");
      await page.getByRole("button", { name: "Create access level", exact: true }).click();
      await expect(page.locator(".access-notice")).toBeInViewport();
      await expect(page.locator(".access-notice")).toContainText("Project assistant");
      await shot("new-08-success");
      const created = writes[0] as {
        rules: Array<{ capability: string; scopePolicies?: unknown[] }>;
      };
      expect(
        created.rules.find((rule) => rule.capability === "answer")!.scopePolicies,
      ).toHaveLength(2);
      expect(
        created.rules.find((rule) => rule.capability === "direct")!.scopePolicies,
      ).toHaveLength(1);
      await expect(page.getByText(/restricted content/).first()).toBeVisible();
      await page.goto(`/portal/settings/access/levels/${levelId}`);
      await expect(
        page.getByRole("heading", { name: "What would you like to change?", exact: true }),
      ).toBeInViewport();
      await shot("edit-01-overview");
      await page.locator(".guided-decision-body").evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await shot("edit-01b-overview-bottom");
      const change = async (title: string) =>
        page
          .locator(".guided-overview-decision")
          .filter({ has: page.getByRole("heading", { name: title, exact: true }) })
          .getByRole("button", { name: "Change", exact: true })
          .click();
      await change("Answer data");
      await shot("edit-02-targeted-data");
      await sourceRow("Gmail")
        .getByRole("button", { name: "Change Gmail content", exact: true })
        .click();
      await modal().getByLabel("Everything except matches", { exact: false }).check();
      await pickMatches();
      await modal().getByRole("button", { name: "Review filter", exact: true }).click();
      await expect(
        modal().getByRole("button", { name: "Apply filter", exact: true }),
      ).toBeEnabled();
      await modal().getByRole("button", { name: "Apply filter", exact: true }).click();
      await page.getByRole("button", { name: "Done", exact: true }).click();
      await page.getByRole("button", { name: "Review changes", exact: true }).click();
      await expect(page.locator(".guided-review-decision")).toHaveCount(1);
      await expect(page.locator(".guided-account-delta")).toHaveCount(1);
      await expect(page.locator(".guided-account-delta")).toContainText(
        "Everything except label: Planning",
      );
      await expect(page.locator(".guided-account-delta")).not.toContainText("Google Drive");
      await shot("edit-03-data-delta");
      await page.getByRole("button", { name: "Save changes", exact: true }).click();
      await expect(page.getByRole("alert")).toContainText("Your draft is retained");
      await expect(page.getByRole("alert")).toBeInViewport();
      await shot("edit-04-conflict");
      await expect(page.locator(".guided-task-footer")).not.toContainText("Reload latest");
      if (width === 390) {
        await page.setViewportSize({ width: width / 2, height: 422 });
        const recovery = page.getByRole("button", {
          name: "Reload latest and discard draft",
          exact: true,
        });
        await recovery.scrollIntoViewIfNeeded();
        await expect(recovery).toBeInViewport();
        expect(
          await page
            .locator("html")
            .evaluate((element) => element.scrollWidth <= element.clientWidth),
        ).toBe(true);
        const saveBounds = await page
          .getByRole("button", { name: "Save changes", exact: true })
          .boundingBox();
        expect(saveBounds).not.toBeNull();
        expect(saveBounds!.x).toBeGreaterThanOrEqual(0);
        expect(saveBounds!.x + saveBounds!.width).toBeLessThanOrEqual(width / 2);
        const zoomPath = await capture(
          page,
          testInfo,
          `${theme}-${width}-edit-04b-conflict-200percent`,
          2,
        );
        const zoomPng = readFileSync(zoomPath);
        expect(zoomPng.readUInt32BE(16)).toBe(width);
        expect(zoomPng.readUInt32BE(20)).toBe(844);
        await expect(
          page.getByRole("button", { name: "Save changes", exact: true }),
        ).toBeInViewport({ ratio: 1 });
        await page.setViewportSize({ width, height: 844 });
      }
      await page
        .getByRole("button", { name: "Reload latest and discard draft", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: "What would you like to change?", exact: true }),
      ).toBeVisible();
      await change("Answer release");
      await page.getByLabel("Release answers automatically", { exact: false }).check();
      await page.getByRole("button", { name: "Done", exact: true }).click();
      await page.getByRole("button", { name: "Review changes", exact: true }).click();
      await expect(page.locator(".guided-review-decision")).toHaveCount(1);
      await expect(page.locator(".guided-review-decision")).toContainText("Answer release");
      await shot("edit-05-release-delta");
      holdWrite = true;
      await page.getByRole("button", { name: "Save changes", exact: true }).click();
      await expect.poll(() => Boolean(releaseWrite)).toBe(true);
      await expect(page.locator(".guided-review-decision button")).toBeDisabled();
      await expect(page.getByRole("button", { name: "Back", exact: true })).toBeDisabled();
      await expect(page.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
      await shot("edit-05b-saving");
      holdWrite = false;
      releaseWrite!();
      await expect(page.locator(".access-notice")).toBeInViewport();
      await shot("edit-06-success");
      const last = writes.at(-1)!;
      expect(last.expectedRevision).toBe(2);
      expect(last.expectedFilterRevisions).toEqual({ answer: 3, direct: 5 });
      longCatalogue = true;
      sources.push(
        ...Array.from({ length: 10 }, (_, index) => ({
          ...baseSources[0]!,
          id: `gmail:account-${index + 1}@example.org`,
        })),
      );
      await page.goto("/portal/settings/access/levels/new");
      await forward();
      await expect(page.getByRole("searchbox", { name: "Find an account" })).toBeVisible();
      await page.getByRole("button", { name: "Select all", exact: true }).click();
      const account = page
        .locator(".guided-source-row")
        .filter({ has: page.getByText("account-10@example.org", { exact: true }) });
      await account.getByRole("button", { name: "Change Gmail content", exact: true }).click();
      await expect(modal()).toHaveAccessibleName(/account-10@example.org/);
      await shot("stress-01-second-account-mode");
      await modal().getByRole("button", { name: "Close", exact: true }).focus();
      await page.keyboard.press("Shift+Tab");
      await expect(modal().getByRole("button", { name: "Continue", exact: true })).toBeFocused();
      await pickMatches();
      await modal().getByRole("button", { name: "labels", exact: true }).click();
      const search = modal().getByRole("searchbox");
      await search.fill("invented");
      await expect(modal().locator(".source-filter-options li")).toHaveCount(50);
      await modal().getByRole("button", { name: "Load more", exact: true }).click();
      await expect(modal().locator(".source-filter-options li")).toHaveCount(65);
      const results = modal().locator(".source-filter-options input");
      for (let index = 40; index < 60; index++) await results.nth(index).check();
      const lastSelection = results.nth(59);
      await lastSelection.scrollIntoViewIfNeeded();
      const offset = await modal()
        .locator(".filter-task-scroll")
        .evaluate((element) => element.scrollTop);
      expect(offset).toBeGreaterThan(500);
      await shot("stress-02-long-picker");
      await modal().getByRole("button", { name: "Review filter", exact: true }).click();
      await expect(
        modal().getByRole("button", { name: "Apply filter", exact: true }),
      ).toBeEnabled();
      await shot("stress-03-large-review");
      await modal().getByRole("button", { name: "Back", exact: true }).click();
      await expect(search).toHaveValue("invented");
      await expect
        .poll(() =>
          modal()
            .locator(".filter-task-scroll")
            .evaluate((element) => element.scrollTop),
        )
        .toBeCloseTo(offset, 0);
      await expect(lastSelection).toBeChecked();
      await modal().getByRole("button", { name: "participant", exact: true }).click();
      await modal().getByRole("button", { name: "labels", exact: true }).click();
      await expect(search).toHaveValue("invented");
      await expect(modal().locator(".source-filter-options li")).toHaveCount(65);
      await expect
        .poll(() =>
          modal()
            .locator(".filter-task-scroll")
            .evaluate((element) => element.scrollTop),
        )
        .toBeCloseTo(offset, 0);
      await search.fill("catalogue");
      await expect(modal().locator(".source-filter-options li")).toHaveCount(50);
      await expect
        .poll(() =>
          modal()
            .locator(".filter-task-scroll")
            .evaluate((element) => element.scrollTop),
        )
        .toBe(0);
      await search.fill("invented");
      await expect
        .poll(() =>
          modal()
            .locator(".filter-task-scroll")
            .evaluate((element) => element.scrollTop),
        )
        .toBeCloseTo(offset, 0);
      await modal().getByRole("button", { name: "Review filter", exact: true }).click();
      await modal().getByRole("button", { name: "Apply filter", exact: true }).click();
      await expect(account.locator(".guided-readable-boundary")).toContainText("and 18 more");
      await expect(account.locator(".guided-readable-boundary")).toContainText("Label 41");
      await account.scrollIntoViewIfNeeded();
      await expect(account.getByText(/and 18 more/)).toBeInViewport({ ratio: 1 });
      await shot("stress-04-large-boundary-card");
      // The tree uses the same exact-context restoration as the search picker.
      const driveRow = sourceRow("Google Drive");
      await driveRow
        .getByRole("button", { name: "Change Google Drive content", exact: true })
        .click();
      await pickMatches();
      await expect(modal().locator(".source-filter-options li")).toHaveCount(50);
      await modal().getByRole("button", { name: "Load more", exact: true }).click();
      await expect(modal().locator(".source-filter-options li")).toHaveCount(65);
      await modal()
        .getByRole("button", { name: /Open Folder 60/ })
        .click();
      await expect(modal().locator(".source-filter-options li")).toHaveCount(50);
      await modal().getByRole("button", { name: "Load more", exact: true }).click();
      await expect(modal().locator(".source-filter-options li")).toHaveCount(65);
      await modal().locator(".source-filter-options input").nth(59).check();
      const folderOffset = await modal()
        .locator(".filter-task-scroll")
        .evaluate((element) => element.scrollTop);
      await modal().getByRole("button", { name: "Review filter", exact: true }).click();
      await modal().getByRole("button", { name: "Back", exact: true }).click();
      await expect(modal().getByRole("navigation", { name: "Folder path" })).toContainText(
        "Folder 60",
      );
      await expect
        .poll(() =>
          modal()
            .locator(".filter-task-scroll")
            .evaluate((element) => element.scrollTop),
        )
        .toBeCloseTo(folderOffset, 0);
      await shot("stress-05-folder-return");
      await page.keyboard.press("Escape");
      await expect(
        driveRow.getByRole("button", { name: "Change Google Drive content", exact: true }),
      ).toBeFocused();
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(
        page.getByRole("dialog", { name: "Discard this draft?", exact: true }),
      ).toBeVisible();
      await shot("stress-06-discard-confirmation");
      await page.getByRole("button", { name: "Keep editing", exact: true }).click();
      await expect(account.locator(".guided-readable-boundary")).toContainText("and 18 more");
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await page.getByRole("button", { name: "Discard draft", exact: true }).click();
      longCatalogue = false;
      sources.push({
        id: "whatsapp-messages:+15550100142",
        sourceType: "whatsapp-messages",
        displayName: "WhatsApp",
        icon: fixtureIcons["whatsapp-messages"],
        available: true,
        scopes: whatsappContracts["whatsapp-messages"],
        scopeReadiness: [
          { kind: "conversation", ready: true },
          { kind: "participant", ready: true },
        ],
      } as (typeof sources)[number]);
      await page.goto("/portal/settings/access/levels/new");
      const permission = (name: string) =>
        page
          .locator(".access-capability-preset")
          .filter({ has: page.getByText(name, { exact: true }) })
          .locator("input");
      await permission("Answer").uncheck();
      await permission("Direct").check();
      await shot("supplement-01-direct-only-permissions");
      await forward();
      await sourceRow("WhatsApp").getByRole("checkbox").check();
      await sourceRow("WhatsApp")
        .getByRole("button", { name: "Change WhatsApp content", exact: true })
        .click();
      await pickMatches();
      await modal().locator(".source-filter-options input").check();
      await shot("supplement-02-whatsapp-conversation");
      await modal().getByRole("button", { name: "participant", exact: true }).click();
      await modal().getByText("Add an exact identifier", { exact: true }).click();
      await modal()
        .getByRole("textbox", { name: "Exact identifier", exact: true })
        .fill("+15550100143");
      await modal().getByRole("button", { name: "Add identifier", exact: true }).click();
      await expect(modal().getByText("Loading source options…", { exact: true })).toHaveCount(0);
      await shot("supplement-03-whatsapp-phone");
      await modal().getByRole("button", { name: "Review filter", exact: true }).click();
      await expect(
        modal().getByRole("button", { name: "Apply filter", exact: true }),
      ).toBeEnabled();
      await modal().getByRole("button", { name: "Apply filter", exact: true }).click();
      await shot("supplement-04a-direct-only-data");
      await forward();
      await shot("supplement-04-direct-only-future");
      await forward();
      await expect(
        page.getByRole("heading", { name: "Ready to create this access level?", exact: true }),
      ).toBeVisible();
      await shot("supplement-05-direct-only-review");
      await reviewChange("Permissions").click();
      await permission("Direct").uncheck();
      await permission("Notes").check();
      await shot("supplement-06a-notes-only-permissions");
      await forward();
      await shot("supplement-06-notes-only-review");
      await reviewChange("Permissions").click();
      await permission("Notes").uncheck();
      await permission("Answer").check();
      await forward();
      const gmail = sourceRow("Gmail").filter({
        has: page.getByText("owner@example.com", { exact: true }),
      });
      await gmail.getByRole("checkbox").check();
      await gmail.getByRole("button", { name: "Change Gmail content", exact: true }).click();
      await pickMatches();
      await modal().getByText("Add an exact identifier", { exact: true }).click();
      await modal()
        .getByRole("textbox", { name: "Exact identifier", exact: true })
        .fill("reviewer@example.org");
      await modal().getByRole("button", { name: "Add identifier", exact: true }).click();
      await modal()
        .getByRole("combobox", { name: "Identifier type", exact: true })
        .selectOption("domain");
      await modal()
        .getByRole("textbox", { name: "Exact identifier", exact: true })
        .fill("example.io");
      await modal().getByRole("button", { name: "Add identifier", exact: true }).click();
      await shot("supplement-07-gmail-email-domain");
      options = "error";
      await modal().getByRole("button", { name: "labels", exact: true }).click();
      await expect(
        modal().getByRole("button", { name: "Retry options", exact: true }),
      ).toBeVisible();
      await shot("supplement-08-options-unavailable");
      options = "ready";
      await modal().getByRole("button", { name: "Retry options", exact: true }).click();
      previews = "error";
      await modal().getByRole("button", { name: "Review filter", exact: true }).click();
      await expect(
        modal().getByRole("button", { name: "Apply filter", exact: true }),
      ).toBeDisabled();
      await expect(modal().getByRole("button", { name: /Retry/ })).toBeVisible();
      await shot("supplement-09-preview-unavailable");
      previews = "preparing";
      await modal().getByRole("button", { name: /Retry/ }).click();
      await expect(
        modal().getByRole("button", { name: "Apply filter", exact: true }),
      ).toBeDisabled();
      await expect(modal().getByText("Waiting for source metadata.").first()).toBeVisible();
      await shot("supplement-10-preparing");
      await modal().getByRole("button", { name: "Back", exact: true }).click();
      await modal()
        .getByRole("checkbox", { name: /Planning/ })
        .check();
      previews = "missing";
      await modal().getByRole("button", { name: "Review filter", exact: true }).click();
      await expect(
        modal()
          .getByText(/Missing — decision retained/)
          .first(),
      ).toBeVisible();
      await shot("supplement-11-missing");
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await page.getByRole("button", { name: "Discard draft", exact: true }).click();
      previews = "ready";
      filtersEnabled = false;
      await page.goto(`/portal/settings/access/levels/${levelId}`);
      await change("Answer data");
      await sourceRow("Gmail")
        .filter({ has: page.getByText("owner@example.com", { exact: true }) })
        .getByRole("button", { name: "Inspect Gmail content", exact: true })
        .click();
      await expect(modal().getByText(/requires experimental mode/)).toBeVisible();
      await shot("supplement-12-read-only");
      await page.keyboard.press("Escape");
      filtersEnabled = true;
      await page.goto(`/portal/settings/access/levels/${levelId}`);
      await change("Permissions");
      await shot("supplement-13-edit-permissions");
      await permission("Notes").check();
      await page.getByRole("button", { name: "Done", exact: true }).click();
      await page.getByRole("button", { name: "Review changes", exact: true }).click();
      await shot("supplement-13b-edit-permissions-delta");
      await page.getByRole("button", { name: "Back", exact: true }).click();
      await change("New sources");
      await shot("supplement-14-edit-future");
      await page.getByLabel("Allow new sources automatically", { exact: false }).first().check();
      await page.getByRole("button", { name: "Done", exact: true }).click();
      await page.getByRole("button", { name: "Review changes", exact: true }).click();
      await shot("supplement-14b-edit-future-delta");
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await page.getByRole("button", { name: "Discard draft", exact: true }).click();
      await page.goto("/portal/settings/access/levels/new");
      await permission("Direct").check();
      await forward();
      const linkedGmail = () =>
        sourceRow("Gmail").filter({ has: page.getByText("owner@example.com", { exact: true }) });
      await linkedGmail().getByRole("checkbox").check();
      await linkedGmail()
        .getByRole("button", { name: "Change Gmail content", exact: true })
        .click();
      await pickMatches();
      await modal().getByRole("button", { name: "labels", exact: true }).click();
      await modal()
        .getByRole("checkbox", { name: /Planning/ })
        .check();
      await modal().getByRole("button", { name: "Review filter", exact: true }).click();
      await expect(
        modal().getByRole("button", { name: "Apply filter", exact: true }),
      ).toBeEnabled();
      await modal().getByRole("button", { name: "Apply filter", exact: true }).click();
      await forward();
      await forward();
      await forward();
      await forward();
      await reviewChange("Direct data").click();
      await expect(
        page.getByRole("heading", { name: "What may Direct read?", exact: true }),
      ).toBeVisible();
      await shot("supplement-15-linked-direct-correction");
      await page.getByLabel("Choose Direct data separately", { exact: false }).check();
      await forward();
      await shot("supplement-16-independent-direct-data");
      await linkedGmail()
        .getByRole("button", { name: "Change Gmail content", exact: true })
        .click();
      await pickMatches();
      await modal().getByText("Add an exact identifier", { exact: true }).click();
      await modal()
        .getByRole("textbox", { name: "Exact identifier", exact: true })
        .fill("independent@example.org");
      await modal().getByRole("button", { name: "Add identifier", exact: true }).click();
      await modal().getByRole("button", { name: "Review filter", exact: true }).click();
      await expect(
        modal().getByRole("button", { name: "Apply filter", exact: true }),
      ).toBeEnabled();
      await shot("supplement-17-independent-direct-filter");
      await modal().getByRole("button", { name: "Apply filter", exact: true }).click();
      await forward();
      await expect(
        page.getByRole("heading", { name: "Ready to create this access level?", exact: true }),
      ).toBeVisible();
      await page.getByLabel("Access level name", { exact: true }).fill("Independent boundaries");
      await shot("supplement-18-linked-correction-review");
      await page.getByRole("button", { name: "Create access level", exact: true }).click();
      await expect(page.locator(".access-notice")).toContainText("Independent boundaries");
      const independent = writes.at(-1)! as {
        rules: Array<{
          capability: string;
          scopePolicies: Array<{ rules: Array<{ match: unknown[] }> }>;
        }>;
      };
      expect(
        independent.rules.find((rule) => rule.capability === "answer")!.scopePolicies[0]!.rules[0]!
          .match,
      ).toEqual([{ kind: "label", id: "planning" }]);
      expect(
        independent.rules.find((rule) => rule.capability === "direct")!.scopePolicies[0]!.rules[0]!
          .match,
      ).toEqual(
        expect.arrayContaining([
          { kind: "label", id: "planning" },
          {
            kind: "participant",
            label: "independent@example.org",
            identifiers: [{ type: "email", value: "independent@example.org" }],
          },
        ]),
      );
      const missingId = "00000000-0000-4000-8000-000000000096";
      levels.push({
        ...levels[0]!,
        id: missingId,
        name: "Retained account boundary",
        rules: [
          {
            ...answer,
            sources: { mode: "allowlist", sourceIds: ["gmail:missing@example.org"] },
            scopePolicies: [],
          },
        ],
      });
      await page.goto(`/portal/settings/access/levels/${missingId}`);
      await expect(page.locator(".guided-edit-overview")).toContainText("1 account selected");
      await shot("supplement-19-unavailable-account-overview");
      await change("Answer data");
      const missingAccount = page
        .locator(".guided-source-row")
        .filter({ has: page.getByText("missing@example.org", { exact: true }) });
      await expect(missingAccount.getByRole("checkbox")).toBeChecked();
      await expect(missingAccount).toContainText("All content");
      await shot("supplement-20-unavailable-unfiltered-account");
      await page.getByRole("button", { name: "Back", exact: true }).click();
      await change("Permissions");
      await permission("Notes").check();
      await page.getByRole("button", { name: "Done", exact: true }).click();
      await page.getByRole("button", { name: "Review changes", exact: true }).click();
      await page.locator(".guided-unchanged > summary").click();
      await page.getByText("missing@example.org", { exact: true }).scrollIntoViewIfNeeded();
      await shot("supplement-21-unavailable-account-review");
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await page.getByRole("button", { name: "Discard draft", exact: true }).click();
      // Create genuine app-owned history destinations before editing the draft.
      await page.getByRole("button", { name: "New access level", exact: true }).click();
      await page.evaluate(async (path) => {
        const modulePath = "/portal/js/lib/router.js";
        const router = await import(modulePath);
        router.navigate(path);
      }, `/portal/settings/access/levels/${levelId}`);
      await expect(
        page.getByRole("heading", { name: "What would you like to change?", exact: true }),
      ).toBeVisible();
      await page.goBack();
      await expect(
        page.getByRole("heading", { name: "What may this connection do?", exact: true }),
      ).toBeVisible();
      await forward();
      await linkedGmail().getByRole("checkbox").check();
      await page.evaluate(() =>
        history.replaceState(
          { ...history.state, fixtureState: "preserved" },
          "",
          location.pathname + "?draft=retained#selection",
        ),
      );
      const draftUrl = page.url();
      const traverse = async (direction: "back" | "forward", accept: boolean) => {
        await Promise.all([
          page.waitForEvent("dialog").then(async (dialog) => {
            expect(dialog.message()).toContain("unsaved access-level changes");
            if (accept) await dialog.accept();
            else await dialog.dismiss();
          }),
          direction === "back" ? page.goBack() : page.goForward(),
        ]);
      };
      await traverse("forward", false);
      await expect(page).toHaveURL(draftUrl);
      await expect(linkedGmail().getByRole("checkbox")).toBeChecked();
      expect(await page.evaluate(() => history.state.fixtureState)).toBe("preserved");
      await shot("supplement-22-forward-decline-retained-draft");
      await traverse("forward", true);
      await expect(
        page.getByRole("heading", { name: "What would you like to change?", exact: true }),
      ).toBeVisible();
      await page.goBack();
      await expect(
        page.getByRole("heading", { name: "What may this connection do?", exact: true }),
      ).toBeVisible();
      await forward();
      await linkedGmail().getByRole("checkbox").check();
      await traverse("back", false);
      await expect(page).toHaveURL(draftUrl);
      await expect(linkedGmail().getByRole("checkbox")).toBeChecked();
      await shot("supplement-23-back-decline-retained-draft");
      await traverse("back", true);
      await expect(page.getByRole("heading", { name: "Agent access", exact: true })).toBeVisible();
      expect(maximum).toBeLessThanOrEqual(2);
      expect(
        await page
          .locator("html")
          .evaluate((element) => element.scrollWidth <= element.clientWidth),
      ).toBe(true);
    });
