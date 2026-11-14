// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect, type Page } from "@playwright/test";

// Invented document, people and access levels throughout.
const documentId = "doc-invented-workshop";
const sourceId = "fictional-chat:+1 (555) 010-0123";
const document = {
  id: documentId,
  source_id: sourceId,
  title: "Workshop planning — 14 March",
  content: "Room is booked for Thursday.",
  metadata: JSON.stringify({ documentType: "chat-day" }),
  source_created_at: Date.now() - 86_400_000,
};
const details = {
  documentId,
  sourceVersion: 1,
  fields: [
    {
      field: "extra.chatJid",
      noun: { one: "chat", many: "chats" },
      state: "present",
      stateText: "",
      items: [{ id: "workshop-planning", label: "Workshop planning", listed: true }],
    },
    {
      field: "$people",
      noun: { one: "person", many: "people" },
      state: "present",
      stateText: "",
      items: [
        { id: "+15550100142", label: "Maya Reeves", listed: true },
        { id: "+15550100187", label: "Jamie Lopez", listed: true },
      ],
    },
  ],
};
const audit = {
  documentId,
  title: document.title,
  sourceId,
  sourceName: "Fictional chat",
  sourceVersion: 1,
  notes: {
    answer:
      "“Can read” under Answer means Omnesis may use this document when answering that agent. Whether an answer is then released is decided by the privacy policy’s review.",
    owner: "This page is for you, the owner. It is never available to an external agent.",
  },
  levels: [
    {
      id: "lvl-family",
      name: "Family helper",
      agents: [],
      answer: {
        readable: true,
        code: "readable",
        text: "This account is shared with all content",
      },
      direct: {
        readable: false,
        code: "permission-not-granted",
        text: "Direct is not granted on this level",
      },
    },
    {
      id: "lvl-research",
      name: "Research assistant",
      agents: [
        { id: "grt-aurora", name: "Aurora Planner", kind: "connection" },
        { id: "dev-kitchen", name: "Kitchen speaker", kind: "device" },
      ],
      answer: {
        readable: false,
        code: "hidden-by-item",
        text: "Hidden by: chat Workshop planning",
      },
      direct: { readable: false, code: "account-not-shared", text: "This account is not shared" },
    },
  ],
};

async function signIn(page: Page) {
  const configDir = process.env.OMNESIS_PORTAL_TEST_CONFIG_DIR;
  if (!configDir) throw new Error("An isolated portal test gateway is required.");
  const token = readFileSync(join(configDir, "token"), "utf8").trim();
  expect((await page.request.post("/portal/api/login", { data: { token } })).ok()).toBe(true);
}
async function serveDocument(page: Page, withDetails: boolean, served = details) {
  for (const [path, body] of [
    ["", document],
    ["/people", { people: [] }],
    ["/attachments", { attachments: [] }],
    ["/dates", { dates: [] }],
    ["/refs/inbound", { items: [] }],
    ["/refs/outbound", { items: [] }],
    ["/near-dupes", { edges: [] }],
    ["/annotations", { annotations: [] }],
  ] as const)
    await page.route(
      new RegExp(`/documents/${documentId}${path.replace("/", "\\/")}(\\?.*)?$`),
      (route) => route.fulfill({ json: body }),
    );
  await page.route(`**/admin/documents/${documentId}/filter-details`, (route) =>
    withDetails
      ? route.fulfill({ json: served })
      : route.fulfill({ status: 404, json: { error: "Not found" } }),
  );
}

test("a document shows its filter details and opens who can read it", async ({ page }) => {
  await signIn(page);
  await serveDocument(page, true);
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(`**/admin/documents/${documentId}/access`, async (route) => {
    await held;
    await route.fulfill({ json: audit });
  });
  await page.goto(`/portal/doc/${documentId}`);
  const panel = page.getByRole("region", { name: "Filter details" });
  await expect(panel).toContainText("ChatWorkshop planning");
  await expect(panel).toContainText("PeopleMaya Reeves, Jamie Lopez");
  await expect(panel).toContainText("Source version1");
  await page.getByRole("link", { name: "Who can read this?" }).click();
  await expect(page).toHaveURL(new RegExp(`/portal/doc/${documentId}/access$`));
  await expect(page.getByRole("heading", { name: "Who can read this?", level: 1 })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("Checking each access level…");
  release();
  await expect(page.getByRole("heading", { name: "Research assistant" })).toBeVisible();
  await expect(page.locator(".doc-access-level h2")).toHaveText([
    "Family helper",
    "Research assistant",
  ]);
  const research = page.getByRole("region", { name: "Research assistant" });
  await expect(
    research.getByRole("list", { name: "Agents using Research assistant" }),
  ).toContainText("Aurora Planner");
  await expect(research).toContainText("Kitchen speakerIntegration");
  await expect(research.locator(".doc-access-verdict").first()).toContainText(
    "Can’t readHidden by: chat Workshop planning",
  );
  const family = page.getByRole("region", { name: "Family helper" });
  await expect(family).toContainText("No connections");
  await expect(family.locator(".doc-access-verdict").first()).toContainText("Can read");
  // Readable never relies on colour alone, and grey text stays legible.
  const contrast = await page
    .locator(".doc-access-verdict dd p")
    .first()
    .evaluate((element) => {
      const parse = (value: string) =>
        value
          .match(/\d+(\.\d+)?/g)!
          .slice(0, 3)
          .map(Number);
      const luminance = ([r, g, b]: number[]) =>
        [r, g, b]
          .map((channel) => channel / 255)
          .map((channel) =>
            channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
          )
          .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index]!, 0);
      let node: Element | null = element;
      let background = "rgba(0, 0, 0, 0)";
      while (node && /rgba\(.*, 0\)$/.test(background)) {
        background = getComputedStyle(node).backgroundColor;
        node = node.parentElement;
      }
      const [front, back] = [
        luminance(parse(getComputedStyle(element).color)),
        luminance(parse(background)),
      ];
      return (Math.max(front, back) + 0.05) / (Math.min(front, back) + 0.05);
    });
  expect(contrast).toBeGreaterThanOrEqual(4.5);
  await page.getByRole("link", { name: "← Back to document" }).click();
  await expect(page).toHaveURL(new RegExp(`/portal/doc/${documentId}$`));
});

test("a gateway without filter details shows the document without them or the entry point", async ({
  page,
}) => {
  await signIn(page);
  await serveDocument(page, false);
  await page.goto(`/portal/doc/${documentId}`);
  await expect(page.getByRole("heading", { name: "Workshop planning — 14 March" })).toBeVisible();
  await expect(page.getByText("Metadata", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Filter details" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Who can read this?" })).toHaveCount(0);
});

test("a source no filter can use shows no filter details but still opens who can read it", async ({
  page,
}) => {
  await signIn(page);
  await serveDocument(page, true, { ...details, fields: [] });
  await page.goto(`/portal/doc/${documentId}`);
  await expect(page.getByRole("link", { name: "Who can read this?" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Filter details" })).toHaveCount(0);
  await expect(page.getByText("Source version")).toHaveCount(0);
});

test("the access page of a document that is gone says so", async ({ page }) => {
  await signIn(page);
  await page.route(`**/admin/documents/missing-doc/access`, (route) =>
    route.fulfill({ status: 404, json: { error: "Document not found" } }),
  );
  await page.goto("/portal/doc/missing-doc/access");
  await expect(page.getByRole("alert")).toHaveText("This document no longer exists.");
});
