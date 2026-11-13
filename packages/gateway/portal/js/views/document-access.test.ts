// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
const api = vi.hoisted(() => ({ getDocumentAccess: vi.fn() }));
vi.mock("../api.js", () => api);
const router = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock("../lib/router.js", () => router);
// @ts-expect-error — Portal modules are JavaScript.
import { DocumentAccessView } from "./document-access.js";
// @ts-expect-error — Portal modules are JavaScript.
import { DocumentFilterDetails, filterDetailValue } from "../components/document-filter-details.js";
// @ts-expect-error — Portal modules are JavaScript.
import { parseRoute } from "../lib/router.js";

const audit = {
  documentId: "doc-invented",
  title: "Workshop planning — 14 March",
  sourceId: "whatsapp-messages:+1 (555) 010-0123",
  sourceName: "WhatsApp",
  sourceVersion: 1,
  notes: {
    answer: 'For Answer, "readable" means the document is within what Omnesis may use when answering that agent.',
    owner: "This page is for you, the owner. It is never available to an external agent.",
  },
  levels: [
    {
      id: "lvl-family",
      name: "Family helper",
      agents: [],
      answer: { readable: true, code: "readable", text: "Readable: this account is shared with all content" },
      direct: { readable: false, code: "permission-not-granted", text: "Direct is not granted on this level" },
    },
    {
      id: "lvl-research",
      name: "Research assistant",
      agents: [
        { id: "grt-aurora", name: "Aurora Planner", kind: "connection" },
        { id: "dev-kitchen", name: "Kitchen speaker", kind: "device" },
      ],
      answer: { readable: false, code: "hidden-by-item", text: "Hidden by: chat Workshop planning" },
      direct: { readable: false, code: "account-not-shared", text: "This account is not shared" },
    },
  ],
};
let host: HTMLElement;
beforeEach(() => {
  const dom = parseHTML("<html><body><div id='root'></div></body></html>");
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.document);
  host = dom.document.querySelector("#root") as unknown as HTMLElement;
  api.getDocumentAccess.mockReset();
  router.navigate.mockReset();
});
afterEach(() => {
  act(() => render(null, host));
  vi.unstubAllGlobals();
});
async function show(id = "doc-invented") {
  await act(async () => render(h(DocumentAccessView, { id }), host));
  await act(async () => {});
}
const text = (selector: string) =>
  [...host.querySelectorAll(selector)].map((element) => element.textContent?.trim());

describe("Who can read this?", () => {
  test("every level in the gateway's order, its agents, and both verdicts with the gateway's reason", async () => {
    api.getDocumentAccess.mockResolvedValue(audit);
    await show();
    expect(api.getDocumentAccess).toHaveBeenCalledWith("doc-invented", expect.any(AbortSignal));
    expect(host.querySelector("h1")?.textContent).toBe("Who can read this?");
    expect(host.querySelector(".doc-access-subject")?.textContent).toContain("Workshop planning — 14 March");
    expect(host.querySelector(".doc-access-subject")?.textContent).toContain("WhatsApp");
    expect(text(".doc-access-notes p")).toEqual([audit.notes.answer, audit.notes.owner]);
    expect(text(".doc-access-level h2")).toEqual(["Family helper", "Research assistant"]);
    const [family, research] = [...host.querySelectorAll(".doc-access-level")];
    expect(family!.querySelector(".access-level-empty")?.textContent).toBe("No connections");
    expect([...research!.querySelectorAll(".doc-access-agent")].map((agent) => agent.textContent?.trim())).toEqual([
      "Aurora Planner",
      "Kitchen speakerIntegration",
    ]);
    // Readable is said in words and marked, never by colour alone.
    const verdicts = (level: Element) =>
      [...level.querySelectorAll(".doc-access-verdict")].map((row) => [
        row.querySelector(".capability-pill")?.className,
        row.querySelector(".doc-access-mark")?.textContent?.trim(),
        row.querySelector("dd p")?.textContent,
      ]);
    expect(verdicts(family!)).toEqual([
      ["capability-pill capability-pill-answer", "Can read", "Readable: this account is shared with all content"],
      ["capability-pill capability-pill-direct is-off", "Can’t read", "Direct is not granted on this level"],
    ]);
    expect(verdicts(research!)).toEqual([
      ["capability-pill capability-pill-answer is-off", "Can’t read", "Hidden by: chat Workshop planning"],
      ["capability-pill capability-pill-direct is-off", "Can’t read", "This account is not shared"],
    ]);
  });

  test("loading, a missing document and an error each say so in plain words", async () => {
    let resolve!: (value: unknown) => void;
    api.getDocumentAccess.mockReturnValue(new Promise((done) => (resolve = done)));
    await show();
    expect(host.querySelector("h1")?.textContent).toBe("Who can read this?");
    expect(host.querySelector(".doc-access-loading")?.textContent).toBe("Loading…");
    await act(async () => resolve(audit));
    expect(host.querySelector(".doc-access-loading")).toBeNull();

    api.getDocumentAccess.mockRejectedValue(Object.assign(new Error("gone"), { status: 404 }));
    await show("doc-gone");
    expect(host.textContent).toContain("This document no longer exists.");

    api.getDocumentAccess.mockRejectedValueOnce(new Error("offline"));
    await show("doc-offline");
    expect(host.querySelector(".doc-access-error p")?.textContent).toBe("This page could not be loaded.");
    api.getDocumentAccess.mockResolvedValue(audit);
    const retry = [...host.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Try again")!;
    await act(async () => retry.click());
    await act(async () => {});
    expect(text(".doc-access-level h2")).toEqual(["Family helper", "Research assistant"]);
  });

  test("a gateway with no levels says that no agent can read anything", async () => {
    api.getDocumentAccess.mockResolvedValue({ ...audit, levels: [] });
    await show();
    expect(host.querySelector(".doc-access-empty")?.textContent).toBe(
      "No access levels yet. An agent can read nothing until you give it one.",
    );
  });

  test("back leads to the document", async () => {
    api.getDocumentAccess.mockResolvedValue(audit);
    await show("doc/with slash");
    const back = host.querySelector<HTMLAnchorElement>(".doc-back")!;
    expect(back.getAttribute("href")).toBe("/portal/doc/doc%2Fwith%20slash");
    await act(async () => back.dispatchEvent(new window.Event("click", { bubbles: true, cancelable: true })));
    expect(router.navigate).toHaveBeenCalledWith("/portal/doc/doc%2Fwith%20slash");
  });
});

describe("a document's filter details", () => {
  const details = {
    documentId: "doc-invented",
    sourceVersion: 2,
    fields: [
      { field: "extra.chatJid", noun: { one: "chat", many: "chats" }, state: "present", stateText: "", items: [{ id: "c1", label: "Workshop planning", listed: true }] },
      { field: "$people", noun: { one: "person", many: "people" }, state: "present", stateText: "", items: [{ id: "a", label: "Maya Reeves", listed: true }, { id: "b", label: "Jamie Lopez", listed: true }] },
      { field: "extra.labelIds", noun: { one: "label", many: "labels" }, state: "present", stateText: "", items: [] },
      { field: "extra.folderId", noun: { one: "folder", many: "folders" }, state: "too-old", stateText: "Too old to carry its folder. Resync Google Drive to add it.", items: [] },
      { field: "extra.projectFolder", noun: { one: "project folder", many: "project folders" }, state: "unknown", stateText: "Not recorded", items: [] },
    ],
  };

  test("each field by its noun with its items, none, or the gateway's sentence, then the source version", async () => {
    await act(async () => render(h(DocumentFilterDetails, { details }), host));
    const rows = [...host.querySelectorAll(".meta-row")].map((row) => [
      row.querySelector(".meta-key")?.textContent,
      row.querySelector(".meta-value")?.textContent,
    ]);
    expect(rows).toEqual([
      ["Chat", "Workshop planning"],
      ["People", "Maya Reeves, Jamie Lopez"],
      ["Labels", "None"],
      ["Folder", "Too old to carry its folder. Resync Google Drive to add it."],
      ["Project folder", "Not recorded"],
      ["Source version", "2"],
    ]);
    expect(filterDetailValue({ state: "unknown", stateText: "", items: [] })).toBe("Not recorded");
  });

  test("nothing is shown until the details arrive", async () => {
    await act(async () => render(h(DocumentFilterDetails, { details: null }), host));
    expect(host.innerHTML).toBe("");
  });
});

describe("routes", () => {
  test("a document's access page sits under the document, which keeps its own route", async () => {
    const actual = await vi.importActual<{ parseRoute: typeof parseRoute }>("../lib/router.js");
    const route = (pathname: string) => {
      vi.stubGlobal("location", { pathname, search: "" });
      return actual.parseRoute();
    };
    expect(route("/portal/doc/doc%2Fwith%20slash/access")).toEqual({ view: "document-access", id: "doc/with slash" });
    expect(route("/portal/doc/doc-invented/access/")).toEqual({ view: "document-access", id: "doc-invented" });
    expect(route("/portal/doc/doc-invented")).toEqual({ view: "document", id: "doc-invented" });
  });
});
