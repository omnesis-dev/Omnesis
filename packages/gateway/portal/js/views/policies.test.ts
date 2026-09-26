// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({
  createPrivacyPolicy: vi.fn(),
  deleteNamedPrivacyPolicy: vi.fn(),
  renameNamedPrivacyPolicy: vi.fn(),
  getPrivacyPolicyTemplates: vi.fn(),
  getAccessOverview: vi.fn(),
  forkPrivacyPolicy: vi.fn(),
  getNamedPrivacyPolicy: vi.fn(),
  getNamedPrivacyPolicyHistory: vi.fn(),
  getNamedPrivacyPolicyVersion: vi.fn(),
  listPrivacyPolicies: vi.fn(),
  restoreNamedPrivacyPolicy: vi.fn(),
  updateNamedPrivacyPolicy: vi.fn(),
}));
const router = vi.hoisted(() => ({ navigate: vi.fn(), replaceRoute: vi.fn() }));

vi.mock("../api.js", () => api);
vi.mock("../lib/router.js", () => router);
vi.mock("../lib/markdown.js", () => ({ renderMarkdown: (value: string) => `<p>${value}</p>` }));
vi.mock("../lib/json-editor.js", async () => {
  const { h } = await import("preact");
  return {
    TextEditor: ({ value, onChange, ariaLabel }: any) => h("textarea", {
      value,
      "aria-label": ariaLabel,
      onInput: (event: Event) => onChange((event.target as HTMLTextAreaElement).value),
    }),
  };
});

// @ts-expect-error — portal modules are plain JS without sibling declarations.
import { PoliciesView } from "./policies.js";

// linkedom has no focus model: `focus()` is a no-op and `activeElement` is
// undefined. Record which element focus reached and serve it back where the
// code under test looks for it.
function trackFocus(window: Window, document: Document): () => void {
  const proto = (window as unknown as { HTMLElement: { prototype: Record<string, unknown> } })
    .HTMLElement.prototype;
  const original = proto.focus;
  let active: Element | null = null;
  proto.focus = function focus(this: Element) { active = this; };
  Object.defineProperty(document, "activeElement", { configurable: true, get: () => active });
  return () => { proto.focus = original; };
}

describe("PoliciesView", () => {
  let host: HTMLElement;
  let originalDocument: typeof globalThis.document | undefined;
  let originalWindow: typeof globalThis.window | undefined;
  let restoreFocus: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    api.getAccessOverview.mockResolvedValue({ principals: [], oauth: null, policyFamilies: [] });
    originalDocument = globalThis.document;
    originalWindow = globalThis.window;
    const parsed = parseHTML("<html><body><main id='root'></main></body></html>");
    Object.assign(globalThis, { document: parsed.document, window: parsed.window });
    restoreFocus = trackFocus(parsed.window as unknown as Window, parsed.document as unknown as Document);
    host = parsed.document.querySelector("#root") as unknown as HTMLElement;
  });

  afterEach(() => {
    render(null, host);
    restoreFocus();
    if (originalDocument === undefined) delete (globalThis as { document?: unknown }).document;
    else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else globalThis.window = originalWindow;
  });

  const LONG_REVISION = "c".repeat(64);
  const policyOverview = {
    oauth: null,
    defaultPolicyFamilyId: "policy-a",
    policyFamilies: [
      { id: "policy-a", name: "Household", revision: LONG_REVISION },
      { id: "policy-b", name: "Work safe", revision: "r1" },
    ],
    principals: [{
      id: "principal-1",
      name: "Fictional research assistant",
      revokedAt: null,
      grants: [
        {
          id: "grant-1", name: "Research answers", revokedAt: null, expiresAt: null, credentials: [],
          rules: [{ capability: "answer", sources: { mode: "all", sourceIds: [] }, release: { mode: "reviewed", policyFamilyId: "policy-a" } }],
        },
        {
          id: "grant-2", name: "Calendar answers", revokedAt: null, expiresAt: null, credentials: [],
          rules: [{ capability: "answer", sources: { mode: "all", sourceIds: [] }, release: { mode: "reviewed", policyFamilyId: "policy-a" } }],
        },
        {
          // Revoked: governs nothing any more, so it must not be counted.
          id: "grant-3", name: "Old answers", revokedAt: 1, expiresAt: null, credentials: [],
          rules: [{ capability: "answer", sources: { mode: "all", sourceIds: [] }, release: { mode: "reviewed", policyFamilyId: "policy-b" } }],
        },
      ],
    }],
  };

  async function mount(props: Record<string, unknown> = {}) {
    await act(async () => { render(h(PoliciesView, props), host); await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });
  }

  function newPolicyButton() {
    return [...host.querySelectorAll("button")]
      .find((item) => item.textContent?.trim() === "New policy") as HTMLButtonElement;
  }

  test("lists the policies a level can name, counting the live connections each reviews", async () => {
    api.getAccessOverview.mockResolvedValue(policyOverview);
    await mount();

    // One heading for the tab, with the create action beside it.
    const headings = [...host.querySelectorAll("h2")];
    expect(headings).toHaveLength(1);
    expect(headings[0].textContent).toMatch(/policies/i);
    expect(host.textContent).toMatch(/reviewed answers/i);
    expect(newPolicyButton()).toBeDefined();

    const headers = [...host.querySelectorAll(".access-policy-table thead th")]
      .map((cell) => cell.textContent?.trim());
    expect(headers).toEqual(["Policy", "Revision", "Connections", "Integrations", "Actions"]);

    const rows = [...host.querySelectorAll(".access-policy-table tbody tr")];
    expect(rows.map((row) => row.querySelector("a")?.textContent)).toEqual(["Household", "Work safe"]);
    // The count comes from the connections in the overview, not from a field
    // the overview does not carry; revoked access no longer governs anything.
    const column = (name: string) => headers.indexOf(name);
    const connectionCounts = rows.map((row) =>
      row.querySelectorAll("td")[column("Connections")]?.querySelector(".access-policy-count")?.textContent?.trim());
    expect(connectionCounts).toEqual(["2", "0"]);
    expect(rows.map((row) => row.querySelectorAll("td")[column("Integrations")]?.querySelector(".access-policy-count")?.textContent?.trim()))
      .toEqual(["0", "0"]);
    // The count is a bare figure, so the header carries what it counts.
    expect(host.querySelectorAll(".access-policy-table thead th")[column("Connections")]
      ?.getAttribute("title")).toMatch(/blast radius/i);
    // A revision is a content hash: the column shows its head and keeps the
    // whole value where a reader matching it against a grant can find it.
    const revision = rows[0].querySelectorAll("td")[column("Revision")].querySelector("small");
    expect(revision?.textContent?.trim()).toBe(`${LONG_REVISION.slice(0, 12)}…`);
    expect(revision?.getAttribute("title")).toBe(LONG_REVISION);
    expect(rows[1].querySelectorAll("td")[column("Revision")].querySelector("small")?.textContent?.trim())
      .toBe("r1");

    const link = rows[0].querySelector("a") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/portal/settings/policies/policy-a");
    await act(async () => { link.dispatchEvent(new window.Event("click", { bubbles: true })); });
    expect(router.navigate).toHaveBeenCalledWith("/portal/settings/policies/policy-a");
  });

  test("marks the default policy", async () => {
    api.getAccessOverview.mockResolvedValue(policyOverview);
    await mount();

    const rows = [...host.querySelectorAll(".access-policy-table tbody tr")];
    // The pill shares the name's line.
    expect(rows[0].querySelector(".access-policy-name-line .portal-pill")?.textContent?.trim())
      .toBe("Default");
    expect(rows[1].querySelector(".portal-pill")).toBeNull();
  });

  test("marks no policy default when the overview names none, rather than guessing one", async () => {
    // A row whose id is missing reads as "" and must not match an absent
    // default: the Default marker says where a new grant starts, so a guess
    // here would be a false claim about a safety control.
    const { defaultPolicyFamilyId: _omitted, ...withoutDefault } = policyOverview;
    api.getAccessOverview.mockResolvedValue({
      ...withoutDefault,
      policyFamilies: [...policyOverview.policyFamilies, { name: "Nameless", revision: "r2" }],
    });
    await mount();

    const rows = [...host.querySelectorAll(".access-policy-table tbody tr")];
    expect(rows).toHaveLength(3);
    expect(host.querySelector(".access-policy-table")?.textContent).not.toContain("Default");
  });

  test("says a policy has no revision yet rather than showing an empty cell", async () => {
    api.getAccessOverview.mockResolvedValue({
      ...policyOverview,
      policyFamilies: [{ id: "policy-a", name: "Household" }],
    });
    await mount();

    const cells = host.querySelectorAll(".access-policy-table tbody td");
    expect(cells[1].textContent?.trim()).toBe("None yet");
    expect(cells[1].querySelector("small")?.getAttribute("title")).toBeNull();
  });

  test("says plainly when no policy exists, because a grant cannot review without one", async () => {
    await mount();
    expect(host.querySelector(".access-policy-table")).toBeNull();
    expect(host.querySelector(".access-policy-empty")?.textContent).toMatch(/cannot release reviewed answers/i);
  });

  test("makes no claim about policies when the overview did not load", async () => {
    api.getAccessOverview.mockRejectedValue({ status: 503, serverMessage: "Gateway unavailable." });
    await mount();
    // The page-level error already says what happened. Saying "no policy
    // exists" here would be a falsehood about a safety control.
    expect(host.querySelector(".access-error")?.textContent).toContain("Gateway unavailable.");
    expect(host.querySelector(".access-policy-empty")).toBeNull();
    expect(host.querySelector(".access-policy-table")).toBeNull();
    expect(newPolicyButton().disabled).toBe(true);
  });

  test("creates a policy from a template and opens the policy it created", async () => {
    api.getPrivacyPolicyTemplates.mockResolvedValue({
      templates: [{ id: "guarded", name: "Guarded", policy: "# Guarded\n" }],
    });
    api.createPrivacyPolicy.mockResolvedValue({ family: { id: "policy-new", name: "Team safe" } });
    await mount();

    // Templates are fetched when the dialog opens, not with the page.
    expect(api.getPrivacyPolicyTemplates).not.toHaveBeenCalled();
    await act(async () => { newPolicyButton().click(); });
    await act(async () => { await Promise.resolve(); });
    expect(api.getPrivacyPolicyTemplates).toHaveBeenCalledOnce();

    const dialog = host.querySelector("[role='dialog']")!;
    const confirm = [...dialog.querySelectorAll("button")]
      .find((item) => item.textContent?.trim() === "Create policy") as HTMLButtonElement;
    const name = dialog.querySelector("input") as HTMLInputElement;
    name.value = "Team safe";
    await act(async () => { name.dispatchEvent(new window.Event("input", { bubbles: true })); });
    // A name alone is not enough: a policy starts from a template.
    expect(confirm.disabled).toBe(true);
    const template = dialog.querySelector("select") as HTMLSelectElement;
    template.querySelector("option[value='guarded']")?.setAttribute("selected", "");
    await act(async () => { template.dispatchEvent(new window.Event("change", { bubbles: true })); });
    expect(confirm.disabled).toBe(false);
    await act(async () => { confirm.click(); });
    await act(async () => { await Promise.resolve(); });

    expect(api.createPrivacyPolicy).toHaveBeenCalledWith({ name: "Team safe", templateId: "guarded" });
    expect(router.navigate).toHaveBeenCalledWith("/portal/settings/policies/policy-new");
  });

  test("keeps a failed creation's reason inside the dialog, where the operator is looking", async () => {
    api.getPrivacyPolicyTemplates.mockResolvedValue({
      templates: [{ id: "guarded", name: "Guarded", policy: "# Guarded\n" }],
    });
    api.createPrivacyPolicy.mockRejectedValue({ status: 409, serverMessage: "A policy with that name exists." });
    await mount();
    await act(async () => { newPolicyButton().click(); });
    await act(async () => { await Promise.resolve(); });
    const dialog = host.querySelector("[role='dialog']")!;
    const name = dialog.querySelector("input") as HTMLInputElement;
    name.value = "Team safe";
    await act(async () => { name.dispatchEvent(new window.Event("input", { bubbles: true })); });
    const template = dialog.querySelector("select") as HTMLSelectElement;
    template.querySelector("option[value='guarded']")?.setAttribute("selected", "");
    await act(async () => { template.dispatchEvent(new window.Event("change", { bubbles: true })); });
    const confirm = [...dialog.querySelectorAll("button")]
      .find((item) => item.textContent?.trim() === "Create policy") as HTMLButtonElement;
    await act(async () => { confirm.click(); });
    await act(async () => { await Promise.resolve(); });

    expect(dialog.querySelector("[role='alert']")?.textContent).toContain("A policy with that name exists.");
    expect(router.navigate).not.toHaveBeenCalled();
    expect(confirm.disabled).toBe(false);
  });

  test("opens one policy on its own page, named after it, and re-reads the list on the way back", async () => {
    api.getAccessOverview.mockResolvedValue(policyOverview);
    api.getNamedPrivacyPolicy.mockResolvedValue({
      policy: "# Household\n", revision: LONG_REVISION, familyId: "policy-a", familyName: "Household", familyVersion: 2,
    });
    api.getPrivacyPolicyTemplates.mockResolvedValue({ templates: [] });
    api.listPrivacyPolicies.mockResolvedValue({ policyFamilies: policyOverview.policyFamilies });
    api.getNamedPrivacyPolicyHistory.mockResolvedValue({ versions: [], pageInfo: { hasMore: false } });
    await mount({ policyId: "policy-a" });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    expect(api.getNamedPrivacyPolicy).toHaveBeenCalledWith("policy-a");
    expect(host.querySelector(".access-editor-page h2")?.textContent).toMatch(/household/i);
    // One h2 for the page: the version history below it is a section under
    // the editor, not a heading of equal rank.
    expect(host.querySelectorAll("h2")).toHaveLength(1);
    expect(host.textContent).toContain("Version history");
    // The list is not on this page; the editor is.
    expect(host.querySelector(".access-policy-table")).toBeNull();
    expect(host.querySelector("textarea")).not.toBeNull();
    expect(api.getAccessOverview).toHaveBeenCalledOnce();

    const back = host.querySelector(".access-page-back") as HTMLButtonElement;
    expect(back.textContent).toMatch(/back to policies/i);
    await act(async () => { back.click(); });
    expect(router.replaceRoute).toHaveBeenCalledWith("/portal/settings/policies");
    // The editor saves and forks without telling the page, so returning
    // re-reads what the list shows.
    await act(async () => { render(h(PoliciesView, {}), host); await Promise.resolve(); });
    expect(api.getAccessOverview).toHaveBeenCalledTimes(2);
    expect(host.querySelector(".access-policy-table")).not.toBeNull();
    // Focus follows the reader back out of the editor onto the tab's heading,
    // so the next Tab starts at the list rather than at the top of the page.
    expect(document.activeElement).toBe(host.querySelector(".access-list-header h2"));
  });

  test("words a failed load for this page, which has no code to enter", async () => {
    api.getAccessOverview.mockRejectedValue({ status: 404 });
    await mount();

    const message = host.querySelector(".access-error")?.textContent ?? "";
    expect(message).toMatch(/policies could not be loaded/i);
    expect(message).not.toMatch(/code/i);
  });
});
