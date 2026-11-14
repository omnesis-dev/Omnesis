// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "@playwright/test";

const levelId = "00000000-0000-4000-8000-000000000081";
const sourceId = "fictional-chat:one";
const room = { capability: "membership", field: "extra.roomId", id: "fictional-room" };
const policy = {
  sourceId,
  audience: { accessLevel: levelId, capability: "answer" },
  rules: [{ action: "share", match: [room] }],
  otherwise: "hide",
};
const source = {
  id: sourceId,
  sourceType: "fictional-chat",
  displayName: "Fictional project account",
  available: true,
  filterable: true,
};
const noun = (one: string, many: string) => ({ one, many });
const counted = { status: "ready", tooOld: 0, unmatched: 0, tooOldText: null, unmatchedText: null };
/** The account's fields; the label field waits for a resync until the owner starts one. */
const editor = (labels: Record<string, unknown>) => ({
  sourceId,
  sourceType: source.sourceType,
  devices: [{ id: "dev-one", name: "Fictional laptop" }],
  showDeviceLevel: false,
  profile: "declared",
  profileText: null,
  connected: true,
  // The account's one resync sentence, for every field that waits on it: here only labels.
  ...(labels.status === "needs-resync" || labels.status === "resyncing"
    ? {
        resync: {
          state: labels.status,
          fields: ["extra.labelIds"],
          text: labels.text,
          ...(labels.status === "resyncing"
            ? { processed: labels.processed, total: labels.total }
            : {}),
        },
      }
    : {}),
  // The labels field's counts are still being taken.
  retryAfterMs: 1500,
  fields: [
    {
      field: "extra.roomId",
      capability: "membership",
      noun: noun("room", "rooms"),
      picker: "search",
      scope: "global",
      state: { status: "ready" },
      counts: counted,
    },
    {
      field: "$people",
      capability: "person",
      noun: noun("person", "people"),
      picker: "search",
      scope: "global",
      identifiers: ["email", "phone"],
      state: { status: "ready" },
      counts: counted,
    },
    {
      field: "extra.labelIds",
      capability: "membership",
      noun: noun("label", "labels"),
      picker: "tree",
      scope: "global",
      levels: [noun("label", "labels")],
      insideText: "Includes the labels inside.",
      state: labels,
      counts: { status: "pending" },
    },
    {
      field: "extra.folder",
      capability: "tree",
      noun: noun("folder", "folders"),
      picker: "tree",
      scope: "global",
      levels: [noun("folder", "folders")],
      insideText: "Includes the folders inside.",
      state: { status: "ready" },
      counts: counted,
    },
  ],
});

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
            // A filtered rule leaves its filtered accounts out of `sources`, for clients that
            // do not apply filters, and carries the real selection in `scopeSources`.
            sources: { mode: "denylist", sourceIds: [sourceId] },
            scopeSources: { mode: "all", sourceIds: [] },
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
  const resyncs: unknown[] = [];
  let labels: Record<string, unknown> = {
    status: "needs-resync",
    cost: "This reads about 900 messages a day.",
    text: "Label filters need Fictional project account to be resynced. Search keeps working meanwhile. This reads about 900 messages a day.",
  };
  await page.route(`**/admin/sources/${encodeURIComponent(sourceId)}/resync`, async (route) => {
    resyncs.push(route.request().postDataJSON());
    labels = {
      status: "resyncing",
      processed: 212,
      total: 900,
      text: "Resyncing Fictional project account: 212 of about 900.",
    };
    await route.fulfill({ json: { ok: true, mode: "in-place", scope: "source", deviceIds: [] } });
  });
  await page.route(/\/admin\/access\/source-filters\//, async (route) => {
    const url = new URL(route.request().url());
    const tail = url.pathname.split("/").at(-1);
    if (tail === "identifiers") {
      const { type, value } = route.request().postDataJSON();
      await route.fulfill({
        json: value.includes("@")
          ? { identifier: { type, value: value.trim().toLowerCase() } }
          : { error: "Enter a valid email address." },
      });
      return;
    }
    if (tail === "preview") {
      const body = route.request().postDataJSON();
      await route.fulfill({
        json: {
          status: "ready",
          sourceId,
          total: 10,
          visible: 6,
          hidden: 4,
          tooOld: 2,
          unmatched: 1,
          tooOldText:
            "2 older items could not be resynced and stay hidden from agents using this filter.",
          unmatchedText: "1 record can’t be matched to a room and stays hidden.",
          connected: true,
          items: body.policy.rules.flatMap(
            (rule: { match: Array<{ field?: string; label?: string }> }) =>
              rule.match.map((ref) => ({
                ref,
                label:
                  ref.label ||
                  (ref.field === "extra.folder"
                    ? "Fictional root/Fictional leaf"
                    : "Fictional project room"),
                count: 4,
              })),
          ),
        },
      });
      return;
    }
    if (tail === "options") {
      const field = url.searchParams.get("field"),
        parent = url.searchParams.get("parentId");
      const folder = (id: string, label: string, extra = {}) => ({
        ref: { capability: "tree", field: "extra.folder", id },
        label,
        shortLabel: label.split("/").at(-1),
        count: 4,
        ...extra,
      });
      await route.fulfill({
        json: {
          sourceId,
          field,
          items:
            field === "extra.folder"
              ? parent
                ? [
                    folder("folder-child", "Fictional root/Fictional leaf", {
                      parentId: "folder-root",
                      depth: 1,
                    }),
                    folder("folder-empty", "Fictional root/Empty", {
                      parentId: "folder-root",
                      depth: 1,
                      count: 0,
                    }),
                  ]
                : [folder("folder-root", "Fictional root", { hasChildren: true, depth: 0 })]
              : field === "$people"
                ? [
                    {
                      ref: {
                        capability: "person",
                        label: "Fictional person",
                        identifiers: [{ type: "email", value: "person@example.com" }],
                      },
                      label: "Fictional person",
                      shortLabel: "Fictional person",
                      count: 4,
                    },
                  ]
                : [
                    {
                      ref: room,
                      label: "Fictional project room",
                      shortLabel: "Fictional project room",
                      count: 4,
                    },
                  ],
        },
      });
      return;
    }
    await route.fulfill({ json: editor(labels) });
  });
  await page.route(`**/admin/access/levels/${levelId}`, async (route) => {
    submitted = route.request().postDataJSON();
    revision = 2;
    await route.fulfill({ status: 409, json: { error: "stale-revision" } });
  });
  await page.goto(`/portal/settings/access/levels/${levelId}`);
  await expect(page.getByRole("heading", { name: "Edit Fictional research" })).toBeVisible();
  await page
    .locator(".guided-overview-decision")
    .filter({ has: page.getByRole("heading", { name: "Answer data", exact: true }) })
    .getByRole("button", { name: "Change", exact: true })
    .click();
  await expect(page.locator(".guided-source-row")).toContainText("Share matching content · 1 item");
  await page
    .getByRole("button", { name: "Change Fictional project account content", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Everything except matching content", { exact: false }).check();
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  // Labels wait for a resync; the owner starts it from here and watches it run.
  const labelState = dialog.locator('.source-filter-field-state[aria-label="Labels"]');
  await expect(labelState).toContainText(
    "Label filters need Fictional project account to be resynced.",
  );
  await expect(dialog.getByRole("searchbox", { name: "Search labels", exact: true })).toHaveCount(
    0,
  );
  await labelState
    .getByRole("button", { name: "Resync Fictional project account", exact: true })
    .click();
  await expect(labelState).toContainText("Resyncing Fictional project account: 212 of about 900.", {
    timeout: 15_000,
  });
  await expect(labelState.locator("progress")).toHaveAttribute("value", "212");
  expect(resyncs).toEqual([{ mode: "in-place" }]);
  // A typed address goes through the gateway: refused with its sentence, then added in its spelling.
  await dialog.getByLabel("Value", { exact: true }).fill("not an address");
  await dialog.getByRole("button", { name: "Add", exact: true }).click();
  await expect(dialog.locator(".source-filter-exact [role=alert]")).toHaveText(
    "Enter a valid email address.",
  );
  await dialog.getByLabel("Value", { exact: true }).fill(" Person@Example.com ");
  await dialog.getByRole("button", { name: "Add", exact: true }).click();
  await expect(dialog.locator(".compact-filter-table")).toContainText("person@example.com");
  await dialog.getByRole("searchbox", { name: "Search folders", exact: true }).focus();
  await expect(dialog).toContainText("Includes the folders inside.");
  await dialog.getByRole("button", { name: "Open Fictional root", exact: true }).click();
  // Inside a folder rows show their own name; an empty folder is listed with 0.
  await expect(dialog.locator(".source-filter-options li label")).toHaveText([
    "Fictional leaf4 matching",
    "Empty0 matching",
  ]);
  await dialog.getByRole("checkbox", { name: /Fictional leaf/ }).check();
  await dialog.locator(".modal-title").click();
  await expect(dialog.locator(".filter-selection-heading")).toContainText("3 selected");
  // The table shows the full name.
  await expect(dialog.locator(".compact-filter-table")).toContainText(
    "Fictional root/Fictional leaf",
  );
  await expect(dialog.locator(".source-filter-counts")).toContainText("6 shared");
  await expect(dialog.locator(".source-filter-unchecked p")).toHaveText([
    "2 older items could not be resynced and stay hidden from agents using this filter.",
    "1 record can’t be matched to a room and stays hidden.",
  ]);
  const mode = dialog.locator(".filter-task-context .access-pill");
  await expect(mode).toHaveText("Hide matching content");
  await expect(mode).toHaveAccessibleDescription(
    "All content which does not match the criteria in the table below will be shared.",
  );
  await expect(dialog.locator("details, .source-filter-samples")).toHaveCount(0);
  await expect(dialog.locator(".compact-filter-table tbody tr")).toHaveCount(3);
  await expect(dialog.getByRole("button", { name: "Apply filter", exact: true })).toBeEnabled();
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
  await expect(dialog.getByRole("button", { name: "Apply filter", exact: true })).toBeEnabled();
  await dialog.getByRole("button", { name: "Apply filter", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("source-filter-mobile-actions.png") });
  await page.setViewportSize({ width: 1280, height: 900 });
  await dialog.getByRole("button", { name: "Apply filter", exact: true }).click();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  // Direct data has one way in, and opens on Direct's own list with the link to Answer above it.
  const directData = page
    .locator(".guided-overview-decision")
    .filter({ has: page.getByRole("heading", { name: "Direct data", exact: true }) });
  await expect(directData.getByRole("button")).toHaveText(["Change"]);
  await directData.getByRole("button", { name: "Change", exact: true }).click();
  await page
    .getByRole("button", { name: "Use same sources and filters as Answer", exact: true })
    .click();
  await expect(page.getByText("Uses the same sources and filters as Answer.")).toBeVisible();
  await expect(page.locator(".guided-source-list.is-frozen input[type=checkbox]")).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Choose different sources", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("button", { name: "Review changes", exact: true }).click();
  await expect(page.locator(".guided-review-decision")).toHaveCount(2);
  await expect(page.locator(".guided-account-delta").last()).toContainText("person@example.com");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByText(/Your changes are kept/)).toBeVisible();
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
  await page
    .getByRole("button", { name: "Load the latest version and discard my changes", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "What would you like to change?", exact: true }),
  ).toBeVisible();
});
