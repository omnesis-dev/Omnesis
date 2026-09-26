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
  renameNamedPrivacyPolicy: vi.fn(),
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

async function policyMenuItem(name: string, action: string): Promise<HTMLButtonElement> {
  const trigger = rowFor(name).querySelector(".row-action-trigger") as HTMLButtonElement;
  trigger.getBoundingClientRect = () => ({ top: 0, bottom: 20, right: 20 } as DOMRect);
  await act(async () => { trigger.dispatchEvent(new window.Event("click", { bubbles: true })); });
  const item = [...rowFor(name).querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    .find((button) => button.textContent?.trim().startsWith(action));
  if (!item) throw new Error(`Missing policy action: ${action}`);
  return item;
}

async function choosePolicyAction(name: string, action: string) {
  const item = await policyMenuItem(name, action);
  await act(async () => { item.dispatchEvent(new window.Event("click", { bubbles: true })); });
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

  it("opens from bare space in the Used by cell too", () => {
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

  it("lists linked integration devices and MCP connections with the audit icons", async () => {
    const rules = [{ capability: "answer", sources: { mode: "all", sourceIds: [] }, release: { mode: "reviewed", policyFamilyId: OTHER_ID } }];
    const grant = { id: "grant-live", rules, revokedAt: null, expiresAt: null, credentials: [] };
    await act(async () => render(h(PolicyLibrary, {
      overview: { ...overview,
        levels: [{ id: "level-review", name: "Review access", rules, devices: [{ id: "device-phone", name: "Phone integration", kind: "android" }] }],
        principals: [
          { id: "mcp-level", name: "Level reviewer", revokedAt: null, grants: [{ ...grant, levelId: "level-review" }] },
          { id: "mcp-direct", name: "Direct reviewer", revokedAt: null, grants: [{ ...grant, id: "grant-direct" }] },
          { id: "mcp-revoked", name: "Removed reviewer", revokedAt: 1, grants: [grant] },
          { id: "mcp-expired", name: "Expired reviewer", revokedAt: null, grants: [{ ...grant, expiresAt: 1 }] },
        ],
      }, overviewReady: true, loading: false,
    }), host));
    const row = rowFor("Reviewer policy");
    const connections = [...row.querySelectorAll('li[title="MCP connection"] a')];
    expect(connections.map((link) => link.textContent)).toEqual(["Level reviewer", "Direct reviewer"]);
    expect(connections.map((link) => link.getAttribute("href"))).toEqual([
      "/portal/settings/access?connection=mcp-level", "/portal/settings/access?connection=mcp-direct",
    ]);
    expect(connections.every((link) => link.querySelector(".privacy-glyph--external"))).toBe(true);
    const device = row.querySelector('li[title="Integration device"] a')!;
    expect(device.textContent).toBe("Phone integration");
    expect(device.getAttribute("href")).toBe("/portal/settings/devices?device=device-phone");
    expect(device.querySelector(".access-device-icon")).not.toBeNull();
    expect(row.querySelectorAll(".access-policy-users li")).toHaveLength(3);
    expect(row.querySelector(".access-policy-count")).toBeNull();
    await act(async () => { connections[0].dispatchEvent(new window.Event("click", { bubbles: true, cancelable: true })); });
    expect(router.navigate).toHaveBeenCalledWith("/portal/settings/access?connection=mcp-level");
    router.navigate.mockClear();
    const modified = new window.Event("click", { bubbles: true, cancelable: true });
    Object.defineProperty(modified, "ctrlKey", { value: true });
    await act(async () => { device.dispatchEvent(modified); });
    expect(router.navigate).not.toHaveBeenCalled();
    expect(modified.defaultPrevented).toBe(false);
    await act(async () => { device.dispatchEvent(new window.Event("click", { bubbles: true, cancelable: true })); });
    expect(router.navigate).toHaveBeenCalledWith("/portal/settings/devices?device=device-phone");
  });

  it("shows an access-level link when no callers use the level yet", async () => {
    const rules = [{ capability: "answer", sources: { mode: "all", sourceIds: [] }, release: { mode: "reviewed", policyFamilyId: OTHER_ID } }];
    await act(async () => render(h(PolicyLibrary, {
      overview: { ...overview, levels: [{ id: "level-review", name: "Review access", rules, devices: [] }] },
      overviewReady: true, loading: false,
    }), host));
    const usage = rowFor("Reviewer policy").querySelector(".access-policy-usage")!;
    const link = usage.querySelector("a")!;
    expect(link.textContent).toBe("Review access");
    expect(link.getAttribute("href")).toBe("/portal/settings/access/levels/level-review");
    expect(usage.textContent).not.toContain("Unused");
    await act(async () => { link.dispatchEvent(new window.Event("click", { bubbles: true, cancelable: true })); });
    expect(router.navigate).toHaveBeenCalledWith("/portal/settings/access/levels/level-review");
  });

  it("labels a policy with other saved references without claiming it is unused", async () => {
    await act(async () => render(h(PolicyLibrary, {
      overview: { ...overview, policyFamilies: [{ id: OTHER_ID, name: "Reviewer policy", deletionBlockedReason: "Referenced by saved settings." }] },
      overviewReady: true, loading: false,
    }), host));
    expect(rowFor("Reviewer policy").querySelector(".access-policy-usage")?.textContent).toBe("No active callers");
  });

  it("marks only the default policy", () => {
    expect(rowFor("Reviewer policy").querySelector(".portal-pill")).toBeNull();
  });
  it("disables deletion of the default policy with an explanation", async () => {
    const button = await policyMenuItem("Default policy", "Delete");
    expect(button?.getAttribute("aria-disabled")).toBe("true");
    expect(button?.getAttribute("title")).toMatch(/default policy/i);
    expect(button?.textContent).toBe("Delete");
    expect(button?.querySelector(".row-action-item-hint")).toBeNull();
    expect(button?.getAttribute("aria-label")).toMatch(/default policy/i);
  });

  it("disables referenced policies using the server's reason, even with no live connections", async () => {
    await act(async () => render(h(PolicyLibrary, {
      overview: { ...overview, policyFamilies: [{ id: OTHER_ID, name: "Reviewer policy", deletionBlockedReason: "Used by a revoked connection." }] },
      overviewReady: true, loading: false,
    }), host));
    const button = await policyMenuItem("Reviewer policy", "Delete");
    expect(button?.getAttribute("aria-disabled")).toBe("true");
    expect(button?.getAttribute("title")).toBe("Used by a revoked connection.");
  });

  it("disables deletion when the gateway has not verified usage", async () => {
    await act(async () => render(h(PolicyLibrary, {
      overview: { ...overview, policyFamilies: [{ id: OTHER_ID, name: "Reviewer policy" }] },
      overviewReady: true, loading: false,
    }), host));
    const button = await policyMenuItem("Reviewer policy", "Delete");
    expect(button?.getAttribute("aria-disabled")).toBe("true");
    expect(button?.getAttribute("title")).toMatch(/usage could not be verified/i);
  });

  it("cancels confirmation without deleting", async () => {
    await choosePolicyAction("Reviewer policy", "Delete");
    const cancel = host.querySelector('[role="dialog"] .btn-ghost');
    expect(cancel).not.toBeNull();
    await act(async () => { cancel?.dispatchEvent(new window.Event("click", { bubbles: true })); });
    expect(api.deleteNamedPrivacyPolicy).not.toHaveBeenCalled();
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  });

  it("admits only one deletion while a request is pending", async () => {
    let complete!: () => void;
    api.deleteNamedPrivacyPolicy.mockImplementation(() => new Promise<void>((resolve) => { complete = resolve; }));
    const onRefresh = vi.fn();
    await act(async () => render(h(PolicyLibrary, { overview, overviewReady: true, loading: false, onRefresh }), host));
    await choosePolicyAction("Reviewer policy", "Delete");
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
    await choosePolicyAction("Reviewer policy", "Delete");
    expect(api.deleteNamedPrivacyPolicy).not.toHaveBeenCalled();
    const confirm = [...host.querySelectorAll("button")].find((button) => button.textContent === "Delete policy");
    await act(async () => { confirm?.dispatchEvent(new window.Event("click", { bubbles: true })); });
    expect(api.deleteNamedPrivacyPolicy).toHaveBeenCalledExactlyOnceWith(OTHER_ID);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(router.navigate).not.toHaveBeenCalled();
  });

  it("shows a server rejection and refreshes stale usage", async () => {
    const onRefresh = vi.fn();
    api.deleteNamedPrivacyPolicy.mockRejectedValue({ serverMessage: "This policy is now in use." });
    await act(async () => render(h(PolicyLibrary, { overview, overviewReady: true, loading: false, onRefresh }), host));
    await choosePolicyAction("Reviewer policy", "Delete");
    const confirm = [...host.querySelectorAll("button")].find((button) => button.textContent === "Delete policy");
    await act(async () => { confirm?.dispatchEvent(new window.Event("click", { bubbles: true })); });
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("This policy is now in use.");
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("renames a default policy and refreshes without deleting or navigating", async () => {
    const onRefresh = vi.fn();
    api.renameNamedPrivacyPolicy.mockResolvedValue({ familyName: "Shared review" });
    await act(async () => render(h(PolicyLibrary, { overview, overviewReady: true, loading: false, onRefresh }), host));
    await choosePolicyAction("Default policy", "Rename");
    const input = host.querySelector("input") as HTMLInputElement;
    expect(input.value).toBe("Default policy");
    input.value = "  Shared review  ";
    await act(async () => { input.dispatchEvent(new window.Event("input", { bubbles: true })); });
    await act(async () => { host.querySelector("form")?.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); });
    expect(api.renameNamedPrivacyPolicy).toHaveBeenCalledExactlyOnceWith(DEFAULT_ID, "Shared review");
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(api.deleteNamedPrivacyPolicy).not.toHaveBeenCalled();
    expect(router.navigate).not.toHaveBeenCalled();
  });

  it("cancels a rename without saving", async () => {
    await choosePolicyAction("Reviewer policy", "Rename");
    const cancel = [...host.querySelectorAll('[role="dialog"] button')].find((button) => button.textContent === "Cancel");
    expect(cancel).not.toBeUndefined();
    await act(async () => { cancel?.dispatchEvent(new window.Event("click", { bubbles: true })); });
    expect(api.renameNamedPrivacyPolicy).not.toHaveBeenCalled();
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  });

  it.each(["", "   ", "Reviewer policy", " Reviewer policy ", "a".repeat(121)])(
    "does not submit an invalid or unchanged name: %s", async (name) => {
      await choosePolicyAction("Reviewer policy", "Rename");
      const input = host.querySelector("input") as HTMLInputElement;
      input.value = name;
      await act(async () => { input.dispatchEvent(new window.Event("input", { bubbles: true })); });
      expect(host.querySelector('button[type="submit"]')?.hasAttribute("disabled")).toBe(true);
      await act(async () => { host.querySelector("form")?.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); });
      expect(api.renameNamedPrivacyPolicy).not.toHaveBeenCalled();
      expect(host.querySelector("form")).not.toBeNull();
    },
  );

  it("allows renaming an in-use policy and admits only one pending request", async () => {
    let complete!: () => void;
    api.renameNamedPrivacyPolicy.mockImplementation(() => new Promise<void>((resolve) => { complete = resolve; }));
    const onRefresh = vi.fn();
    await act(async () => render(h(PolicyLibrary, {
      overview: { ...overview, policyFamilies: [{ id: OTHER_ID, name: "Reviewer policy", deletionBlockedReason: "Used by an access level." }] },
      overviewReady: true, loading: false, onRefresh,
    }), host));
    const rename = await policyMenuItem("Reviewer policy", "Rename");
    expect(rename?.hasAttribute("disabled")).toBe(false);
    await act(async () => { rename?.dispatchEvent(new window.Event("click", { bubbles: true })); });
    const input = host.querySelector("input") as HTMLInputElement;
    input.value = "Shared review";
    await act(async () => { input.dispatchEvent(new window.Event("input", { bubbles: true })); });
    const form = host.querySelector("form");
    await act(async () => {
      form?.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
      form?.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(api.renameNamedPrivacyPolicy).toHaveBeenCalledExactlyOnceWith(OTHER_ID, "Shared review");
    expect(onRefresh).not.toHaveBeenCalled();
    expect(input.hasAttribute("disabled")).toBe(true);
    expect(host.querySelector('button[type="submit"]')?.hasAttribute("disabled")).toBe(true);
    await act(async () => complete());
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  });

  it("keeps a rejected rename open with the server explanation", async () => {
    api.renameNamedPrivacyPolicy.mockRejectedValue({ serverMessage: "A policy with this name already exists." });
    await choosePolicyAction("Reviewer policy", "Rename");
    const input = host.querySelector("input") as HTMLInputElement;
    input.value = "Default policy";
    await act(async () => { input.dispatchEvent(new window.Event("input", { bubbles: true })); });
    await act(async () => { host.querySelector("form")?.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); });
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("A policy with this name already exists.");
    expect(input.value).toBe("Default policy");
    expect(host.querySelector("form")).not.toBeNull();
  });

});
