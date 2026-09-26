// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ navigate: vi.fn() }));

const api = vi.hoisted(() => ({
  createPrivacyPolicy: vi.fn(),
  deleteNamedPrivacyPolicy: vi.fn(),
  getPrivacyPolicyTemplates: vi.fn(),
}));

vi.mock("../../api.js", () => api);
vi.mock("../../lib/router.js", () => router);

// @ts-expect-error — portal modules are intentionally plain JavaScript.
import { PolicyLibrary } from "./policy-library.js";

const DEFAULT_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_ID = "00000000-0000-4000-8000-000000000002";

const overview = {
  defaultPolicyFamilyId: DEFAULT_ID,
  policyFamilies: [
    { id: DEFAULT_ID, name: "Default policy", revision: "c".repeat(64) },
    { id: OTHER_ID, name: "Reviewer policy", deletionBlockedReason: null, revision: "d".repeat(64) },
  ],
  principals: [],
};

function rowFor(name: string): HTMLTableRowElement {
  const match = [...document.querySelectorAll<HTMLTableRowElement>("tr.access-policy-row")]
    .find((candidate) => candidate.textContent?.includes(name));
  if (!match) throw new Error(`Missing row: ${name}`);
  return match;
}

describe("PolicyLibrary", () => {
  let host: HTMLDivElement;
  let originalDocument: typeof globalThis.document | undefined;
  let originalWindow: typeof globalThis.window | undefined;

  beforeEach(async () => {
    originalDocument = globalThis.document;
    originalWindow = globalThis.window;
    vi.resetAllMocks();
    const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
    Object.assign(globalThis, { document: parsed.document, window: parsed.window });
    host = parsed.document.querySelector("#root") as unknown as HTMLDivElement;
    api.getPrivacyPolicyTemplates.mockResolvedValue({ templates: [] });
    await act(async () => {
      render(h(PolicyLibrary, { overview, overviewReady: true, loading: false }), host);
    });
  });

  afterEach(() => {
    act(() => render(null, host));
    if (originalDocument === undefined) delete (globalThis as { document?: unknown }).document;
    else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else globalThis.window = originalWindow;
  });

  it("opens the policy from bare cell space, not only from its name", () => {
    // Dispatched on the cell itself: Preact never receives a bubbled event
    // under this DOM implementation, so this asserts the cell is wired, and
    // the guard's own behaviour is covered in table-row-click.test.ts.
    const revisionCell = rowFor("Reviewer policy").querySelectorAll("td")[1];
    act(() => { revisionCell.dispatchEvent(new window.Event("click", { bubbles: true })); });
    expect(router.navigate).toHaveBeenCalledTimes(1);
    expect(router.navigate.mock.calls[0][0]).toContain(OTHER_ID);
  });

  it("opens from the grant-count cell too", () => {
    const countCell = rowFor("Default policy").querySelectorAll("td")[2];
    act(() => { countCell.dispatchEvent(new window.Event("click", { bubbles: true })); });
    expect(router.navigate).toHaveBeenCalledTimes(1);
    expect(router.navigate.mock.calls[0][0]).toContain(DEFAULT_ID);
  });

  it("keeps the Default pill on the name's own line", () => {
    const line = rowFor("Default policy").querySelector(".access-policy-name-line");
    if (!line) throw new Error("Missing name line");
    // Sibling of the name inside one inline row, so the two share a line.
    expect(line.querySelector("a.portal-table-name")).not.toBeNull();
    expect(line.querySelector(".portal-pill")?.textContent).toBe("Default");
    expect(rowFor("Default policy").querySelector(".portal-table-sub")).toBeNull();
  });

  it("marks only the default policy", () => {
    expect(rowFor("Reviewer policy").querySelector(".portal-pill")).toBeNull();
  });
  it("disables deletion of the default policy with an explanation", () => {
    const button = rowFor("Default policy").querySelector("button");
    expect(button?.hasAttribute("disabled")).toBe(true);
    expect(button?.getAttribute("title")).toMatch(/default policy/i);
  });

  it("disables referenced policies using the server's reason, even with no live connections", async () => {
    await act(async () => render(h(PolicyLibrary, {
      overview: { ...overview, policyFamilies: [{ id: OTHER_ID, name: "Reviewer policy", deletionBlockedReason: "Used by a revoked connection." }] },
      overviewReady: true, loading: false,
    }), host));
    const button = rowFor("Reviewer policy").querySelector("button");
    expect(button?.hasAttribute("disabled")).toBe(true);
    expect(button?.getAttribute("title")).toBe("Used by a revoked connection.");
  });

  it("disables deletion when the gateway has not verified usage", async () => {
    await act(async () => render(h(PolicyLibrary, {
      overview: { ...overview, policyFamilies: [{ id: OTHER_ID, name: "Reviewer policy" }] },
      overviewReady: true, loading: false,
    }), host));
    const button = rowFor("Reviewer policy").querySelector("button");
    expect(button?.hasAttribute("disabled")).toBe(true);
    expect(button?.getAttribute("title")).toMatch(/usage could not be verified/i);
  });

  it("cancels confirmation without deleting", async () => {
    await act(async () => rowFor("Reviewer policy").querySelector("button")?.dispatchEvent(new window.Event("click", { bubbles: true })));
    const cancel = host.querySelector('[role="dialog"] .btn-ghost');
    expect(cancel).not.toBeNull();
    await act(async () => cancel?.dispatchEvent(new window.Event("click", { bubbles: true })));
    expect(api.deleteNamedPrivacyPolicy).not.toHaveBeenCalled();
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  });

  it("admits only one deletion while a request is pending", async () => {
    let complete!: () => void;
    api.deleteNamedPrivacyPolicy.mockImplementation(() => new Promise<void>((resolve) => { complete = resolve; }));
    const onRefresh = vi.fn();
    await act(async () => render(h(PolicyLibrary, { overview, overviewReady: true, loading: false, onRefresh }), host));
    await act(async () => rowFor("Reviewer policy").querySelector("button")?.dispatchEvent(new window.Event("click", { bubbles: true })));
    const confirm = [...host.querySelectorAll("button")].find((button) => button.textContent === "Delete policy");
    expect(confirm).not.toBeUndefined();
    await act(async () => {
      confirm?.dispatchEvent(new window.Event("click", { bubbles: true }));
      confirm?.dispatchEvent(new window.Event("click", { bubbles: true }));
    });
    expect(api.deleteNamedPrivacyPolicy).toHaveBeenCalledExactlyOnceWith(OTHER_ID);
    expect(onRefresh).not.toHaveBeenCalled();
    expect(confirm?.hasAttribute("disabled")).toBe(true);
    await act(async () => complete());
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  });

  it("requires confirmation, deletes the selected policy and refreshes the list", async () => {
    const onRefresh = vi.fn();
    api.deleteNamedPrivacyPolicy.mockResolvedValue({ ok: true });
    await act(async () => render(h(PolicyLibrary, { overview, overviewReady: true, loading: false, onRefresh }), host));
    await act(async () => rowFor("Reviewer policy").querySelector("button")?.dispatchEvent(new window.Event("click", { bubbles: true })));
    expect(api.deleteNamedPrivacyPolicy).not.toHaveBeenCalled();
    const confirm = [...host.querySelectorAll("button")].find((button) => button.textContent === "Delete policy");
    await act(async () => confirm?.dispatchEvent(new window.Event("click", { bubbles: true })));
    expect(api.deleteNamedPrivacyPolicy).toHaveBeenCalledExactlyOnceWith(OTHER_ID);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(router.navigate).not.toHaveBeenCalled();
  });

  it("shows a server rejection and refreshes stale usage", async () => {
    const onRefresh = vi.fn();
    api.deleteNamedPrivacyPolicy.mockRejectedValue({ serverMessage: "This policy is now in use." });
    await act(async () => render(h(PolicyLibrary, { overview, overviewReady: true, loading: false, onRefresh }), host));
    await act(async () => rowFor("Reviewer policy").querySelector("button")?.dispatchEvent(new window.Event("click", { bubbles: true })));
    const confirm = [...host.querySelectorAll("button")].find((button) => button.textContent === "Delete policy");
    await act(async () => confirm?.dispatchEvent(new window.Event("click", { bubbles: true })));
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("This policy is now in use.");
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

});
