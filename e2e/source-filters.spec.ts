// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "@playwright/test";

const levelId = "00000000-0000-4000-8000-000000000081";
const sourceId = "fictional-chat:one";
const policy = {
  sourceId,
  audience: { accessLevel: levelId, capability: "answer" },
  rules: [{ action: "share", match: [{ kind: "conversation", id: "fictional-room" }] }],
  otherwise: "hide",
};
const readiness = ["conversation", "participant", "label", "folder"].map((kind) => ({
  kind,
  ready: true,
}));
const source = {
  id: sourceId,
  sourceType: "fictional-chat",
  displayName: "Fictional project account",
  available: true,
  scopes: {
    items: [
      {
        kind: "conversation",
        noun: { one: "room", many: "Rooms" },
        picker: "search",
        link: "fixed",
      },
      { kind: "participant", identifiers: ["email", "phone"], link: "changes" },
      { kind: "label", noun: { one: "label", many: "Labels" }, picker: "search", link: "changes" },
      { kind: "folder", noun: { one: "folder", many: "Folders" }, picker: "tree", link: "changes" },
    ],
  },
  scopeReadiness: readiness,
};

test("owner reviews mixed source filters, copies independently and keeps a stale draft", async ({
  page,
}, testInfo) => {
  // The test runner creates this isolated directory; never fall back to an installed gateway.
  const configDir = process.env.OMNESIS_PORTAL_TEST_CONFIG_DIR;
  if (!configDir) throw new Error("An isolated portal test gateway is required.");
  const token = readFileSync(join(configDir, "token"), "utf8").trim();
  const login = await page.request.post("/portal/api/login", { data: { token } });
  expect(login.ok()).toBe(true);
  let revision = 1;
  let submitted: Record<string, unknown> | null = null;
  const overview = () => ({
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
        revision,
        connectionCount: 0,
        createdAt: 1,
        updatedAt: 1,
        rules: [
          {
            capability: "answer",
            sources: { mode: "all", sourceIds: [] },
            release: { mode: "unreviewed" },
            filterRevision: 7,
            scopePolicies: [policy],
          },
          {
            capability: "direct",
            sources: { mode: "all", sourceIds: [] },
            filterRevision: 4,
            scopePolicies: [],
          },
        ],
      },
    ],
  });
  await page.route("**/admin/access", (route) => route.fulfill({ json: overview() }));
  await page.route("**/admin/access/source-filters/*/options?*", async (route) => {
    const url = new URL(route.request().url()),
      kind = url.searchParams.get("kind"),
      parent = url.searchParams.get("parentId");
    const ref =
      kind === "participant"
        ? {
            kind,
            label: "Fictional person",
            identifiers: [{ type: "email", value: "person@example.com" }],
          }
        : {
            kind,
            id: kind === "folder" ? (parent ? "folder-child" : "folder-root") : "fictional-room",
          };
    await route.fulfill({
      json: {
        sourceId,
        sourceType: source.sourceType,
        scopes: source.scopes,
        readiness,
        items: [
          {
            ref,
            label:
              kind === "folder"
                ? parent
                  ? "Fictional leaf"
                  : "Fictional root"
                : "Fictional project room",
            count: 4,
            hasChildren: kind === "folder" && !parent,
          },
        ],
      },
    });
  });
  await page.route("**/admin/access/source-filters/*/preview", async (route) => {
    const body = route.request().postDataJSON();
    await route.fulfill({
      json: {
        sourceId,
        total: 10,
        visible: 6,
        hidden: 4,
        unknown: 1,
        readiness,
        items: body.policy.rules.flatMap(
          (rule: { match: Array<{ kind: string; id?: string; label?: string }> }) =>
            rule.match.map((ref) => ({
              ref,
              label:
                ref.label || (ref.kind === "folder" ? "Fictional leaf" : "Fictional project room"),
              count: 4,
            })),
        ),
        samples: [
          {
            documentId: "fictional-visible",
            title: "Fictional visible sample",
            visible: true,
            unknown: false,
          },
          {
            documentId: "fictional-unknown",
            title: "Fictional unknown sample",
            visible: false,
            unknown: true,
          },
        ],
      },
    });
  });
  await page.route(`**/admin/access/levels/${levelId}`, async (route) => {
    submitted = route.request().postDataJSON();
    revision = 2;
    await route.fulfill({ status: 409, json: { error: "stale-revision" } });
  });
  await page.goto(`/portal/settings/access/levels/${levelId}`);
  await expect(page.getByRole("heading", { name: "Edit Fictional research" })).toBeVisible();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Edit filter", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Fictional project room", { exact: true }).first()).toBeVisible();
  await expect(dialog.locator(".source-filter-counts")).toContainText("6 visible");
  await expect(dialog).toContainText("Unknown records are included in hidden");
  await dialog.getByLabel("Everything except matching records").check();
  await dialog.getByRole("button", { name: "participant", exact: true }).click();
  await dialog.getByLabel("Exact identifier").fill("person@example.com");
  await dialog.getByRole("button", { name: "Add identifier", exact: true }).click();
  await dialog.getByRole("button", { name: "Folders", exact: true }).click();
  await expect(dialog).toContainText("Choosing a folder includes all of its descendants");
  await dialog.getByRole("button", { name: "Open Fictional root", exact: true }).click();
  await dialog.getByRole("checkbox", { name: /Fictional leaf/ }).check();
  await expect(dialog.getByRole("heading", { name: "Selected items (3)" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Use this filter", exact: true })).toBeEnabled();
  await dialog.locator(".modal-body").evaluate((body) => {
    body.scrollTop = 0;
  });
  await page.screenshot({ path: testInfo.outputPath("source-filter-dark.png") });
  await page.evaluate(() => (document.documentElement.dataset.theme = "light"));
  await page.screenshot({ path: testInfo.outputPath("source-filter-light.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.locator("html").evaluate((root) => root.scrollWidth <= root.clientWidth)).toBe(
    true,
  );
  const bounds = await dialog.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath("source-filter-mobile.png") });
  await expect(dialog.getByRole("button", { name: "Use this filter", exact: true })).toBeEnabled();
  await dialog
    .getByRole("button", { name: "Use this filter", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("source-filter-mobile-actions.png") });
  await page.setViewportSize({ width: 1280, height: 900 });
  await dialog.getByRole("button", { name: "Use this filter", exact: true }).click();
  await page
    .getByRole("button", { name: "Copy Answer filters to Direct once", exact: true })
    .click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.locator(".source-policy-summary")).toHaveCount(3);
  await expect(page.locator(".source-policy-summary").last()).toContainText("person@example.com");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByText(/Your draft is retained/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Save changes", exact: true })).toBeDisabled();
  expect(submitted).toMatchObject({
    expectedRevision: 1,
    expectedFilterRevisions: { answer: 7, direct: 4 },
  });
  const rules = (
    submitted as unknown as {
      rules: Array<{
        capability: string;
        filterRevision: number;
        scopePolicies: Array<{
          audience: { accessLevel: string; capability: string };
          otherwise: string;
          rules: Array<{ match: unknown[] }>;
        }>;
      }>;
    }
  ).rules;
  expect(rules.find((rule) => rule.capability === "direct")).toMatchObject({
    filterRevision: 4,
    scopePolicies: [
      {
        audience: { accessLevel: levelId, capability: "direct" },
        otherwise: "share",
        rules: [{ match: expect.any(Array) }],
      },
    ],
  });
  expect(
    rules.find((rule) => rule.capability === "direct")?.scopePolicies[0]?.rules[0]?.match,
  ).toHaveLength(3);
  await page.getByRole("button", { name: "Reload latest and discard draft", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Choose permissions", exact: true }),
  ).toBeVisible();
});
