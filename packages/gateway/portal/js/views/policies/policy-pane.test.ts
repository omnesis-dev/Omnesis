// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ navigate: vi.fn() }));

const api = vi.hoisted(() => ({
  forkPrivacyPolicy: vi.fn(),
  getAccessOverview: vi.fn(),
  getNamedPrivacyPolicy: vi.fn(),
  getNamedPrivacyPolicyHistory: vi.fn(),
  getNamedPrivacyPolicyVersion: vi.fn(),
  listPrivacyPolicies: vi.fn(),
  restoreNamedPrivacyPolicy: vi.fn(),
  updateNamedPrivacyPolicy: vi.fn(),
}));

vi.mock("../../api.js", () => api);
vi.mock("../../lib/router.js", () => router);
vi.mock("../../lib/markdown.js", () => ({ renderMarkdown: (value: string) => `<p>${value}</p>` }));
vi.mock("../../lib/json-editor.js", async () => {
  const { h } = await import("preact");
  return {
    TextEditor: ({ value, onChange, ariaLabel, wrap }: any) => h("textarea", {
      value,
      "aria-label": ariaLabel,
      "data-wrap": wrap ? "true" : "false",
      onInput: (event: Event) => onChange((event.target as HTMLTextAreaElement).value),
    }),
  };
});

// @ts-expect-error — portal modules are intentionally plain JavaScript.
import { ForkPolicyButton,
  affectedPolicyAccess,
  PrivacyPolicyHistory,
  PrivacyPolicyPane,
  serializePolicyDraft,
} from "./policy.js";

const DEFAULT_ID = "00000000-0000-4000-8000-000000000001";

const current = {
  policy: "# Current\n\nKeep summaries private.\n",
  revision: "a".repeat(64),
  generation: 3,
  digest: "b".repeat(64),
  updatedAt: 1_700_000_000_000,
};

function button(label: string): HTMLButtonElement {
  const match = [...document.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent?.trim() === label);
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

/** The icon-only "view this version" action, found by its accessible name. */
function viewButton(): HTMLButtonElement {
  const match = [...document.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.getAttribute("aria-label")?.startsWith("View version"));
  if (!match) throw new Error("Missing view-version button");
  return match;
}

async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

describe("PrivacyPolicyPane", () => {
  let host: HTMLDivElement;
  let originalDocument: typeof globalThis.document | undefined;
  let originalWindow: typeof globalThis.window | undefined;
  let originalSessionStorage: typeof globalThis.sessionStorage | undefined;

  beforeEach(() => {
    originalDocument = globalThis.document;
    originalWindow = globalThis.window;
    originalSessionStorage = globalThis.sessionStorage;
    vi.clearAllMocks();
    const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
    Object.assign(globalThis, { document: parsed.document, window: parsed.window });
    Object.assign(globalThis, { sessionStorage: storage() });
    host = parsed.document.querySelector("#root") as unknown as HTMLDivElement;
    api.getNamedPrivacyPolicy.mockResolvedValue({ ...current, familyId: DEFAULT_ID, familyName: "Default policy" });
    api.getNamedPrivacyPolicyHistory.mockResolvedValue({
      versions: [],
      pageInfo: { hasMore: false, limit: 25 },
    });
    api.getAccessOverview.mockResolvedValue({ principals: [] });
    api.listPrivacyPolicies.mockResolvedValue({
      policyFamilies: [{ id: DEFAULT_ID, name: "Default policy" }],
    });
  });

  afterEach(() => {
    act(() => render(null, host));
    if (originalDocument === undefined) delete (globalThis as { document?: unknown }).document;
    else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else globalThis.window = originalWindow;
    if (originalSessionStorage === undefined) delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
    else globalThis.sessionStorage = originalSessionStorage;
  });

  it("wraps the policy's lines: it is prose, and a long line must not widen the page", async () => {
    await act(async () => { render(h(PrivacyPolicyPane, { policyId: DEFAULT_ID }), host); });
    await settle();
    expect(host.querySelector("textarea")?.getAttribute("data-wrap")).toBe("true");
  });

  it("does not interpret credential clauses outside the editable Markdown", async () => {
    api.getNamedPrivacyPolicy.mockResolvedValue({
      ...current,
      policy:
        "# Current\n\n- **Credential release**: Approval is required for every request; a prior approval never applies to a later release.\n",
    });
    await act(async () => { render(h(PrivacyPolicyPane, { policyId: DEFAULT_ID }), host); });
    await settle();

    expect(host.textContent).not.toContain("Credentials require one-time approval");

    const editor = host.querySelector("textarea") as HTMLTextAreaElement;
    editor.value += "\nA change.\n";
    await act(async () => { editor.dispatchEvent(new window.Event("input", { bubbles: true })); });
    await act(async () => { button("Review and save").click(); });

    expect(host.textContent).not.toContain("Credentials require one-time approval");
  });

  it("locks cancellation while a reviewed save is in flight", async () => {
    let resolveSave: (value: unknown) => void = () => {};
    api.updateNamedPrivacyPolicy.mockReturnValue(new Promise((resolve) => { resolveSave = resolve; }));
    await act(async () => { render(h(PrivacyPolicyPane, { policyId: DEFAULT_ID }), host); });
    await settle();
    const editor = host.querySelector("textarea") as HTMLTextAreaElement;
    editor.value = "# Changed\n";
    await act(async () => { editor.dispatchEvent(new window.Event("input", { bubbles: true })); });
    await act(async () => { button("Review and save").click(); });
    await act(async () => { button("Save policy").click(); });

    expect(button("Cancel").disabled).toBe(true);
    expect(button("Saving…").disabled).toBe(true);
    const dialog = host.querySelector<HTMLElement>("[role='dialog']")!;
    await act(async () => { dialog.dispatchEvent(new window.Event("click", { bubbles: true })); });
    expect(host.querySelector("[role='dialog']")).not.toBeNull();
    const tab = new window.Event("keydown", { bubbles: true, cancelable: true });
    Object.defineProperty(tab, "key", { value: "Tab" });
    await act(async () => { window.dispatchEvent(tab); });
    expect(tab.defaultPrevented).toBe(true);
    await act(async () => {
      resolveSave({ ...current, policy: "# Changed\n", revision: "c".repeat(64), generation: 4 });
      await Promise.resolve();
    });
    expect(api.updateNamedPrivacyPolicy).toHaveBeenCalledWith(DEFAULT_ID, {
      policy: "# Changed\n",
      beforeVersion: current.generation,
    });
    expect(host.textContent).toContain("Privacy policy saved.");
  });

  it("rebases a save conflict onto the latest head without losing the draft", async () => {
    api.updateNamedPrivacyPolicy.mockRejectedValue({ status: 409 });
    api.getNamedPrivacyPolicy
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce({ ...current, policy: "# Concurrent\n", revision: "d".repeat(64), generation: 4 });
    await act(async () => { render(h(PrivacyPolicyPane, { policyId: DEFAULT_ID }), host); });
    await settle();
    const editor = host.querySelector("textarea") as HTMLTextAreaElement;
    editor.value = "# My draft\n";
    await act(async () => { editor.dispatchEvent(new window.Event("input", { bubbles: true })); });
    await act(async () => { button("Review and save").click(); });
    await act(async () => { button("Save policy").click(); });
    await settle();

    expect((host.querySelector("textarea") as HTMLTextAreaElement).value).toBe("# My draft\n");
    expect(host.textContent).toContain("changed elsewhere");
  });

  it("warns when a persisted draft was based on an older revision", async () => {
    sessionStorage.setItem(
      `omnesis:privacy-policy-draft:${DEFAULT_ID}`,
      serializePolicyDraft("# Older draft\n", { ...current, revision: "0".repeat(64) }),
    );
    await act(async () => { render(h(PrivacyPolicyPane, { policyId: DEFAULT_ID }), host); });
    await settle();

    expect(host.textContent).toContain("based on an older policy");
    expect((host.querySelector("textarea") as HTMLTextAreaElement).value).toBe("# Older draft\n");
  });

  it("preserves a dirty draft when a restore conflicts", async () => {
    api.getNamedPrivacyPolicy
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce({ ...current, policy: "# Concurrent\n", revision: "e".repeat(64), generation: 4 });
    api.getNamedPrivacyPolicyHistory.mockResolvedValue({
      versions: [{ generation: 2, action: "edit", createdAt: 2 }],
      pageInfo: { hasMore: false },
    });
    api.getNamedPrivacyPolicyVersion.mockResolvedValue({
      version: { generation: 2, action: "edit", createdAt: 2, policy: "# Earlier\n" },
    });
    api.restoreNamedPrivacyPolicy.mockRejectedValue({ status: 409 });
    await act(async () => { render(h(PrivacyPolicyPane, { policyId: DEFAULT_ID }), host); });
    await settle();
    const editor = host.querySelector("textarea") as HTMLTextAreaElement;
    editor.value = "# My draft\n";
    await act(async () => { editor.dispatchEvent(new window.Event("input", { bubbles: true })); });
    await act(async () => { viewButton().click(); });
    await settle();
    await act(async () => { button("Restore as new version").click(); });
    await act(async () => { button("Restore as new version").click(); });
    await settle();

    expect((host.querySelector("textarea") as HTMLTextAreaElement).value).toBe("# My draft\n");
    expect(host.textContent).toContain("changed before it could be restored");
  });

  it("edits the family the URL names and saves through the family-scoped endpoint", async () => {
    const work = {
      ...current,
      policy: "# Work safe\n",
      familyId: "00000000-0000-4000-8000-000000000002",
      familyName: "Work safe",
      familyVersion: 2,
    };
    api.listPrivacyPolicies.mockResolvedValue({
      policyFamilies: [
        { id: "00000000-0000-4000-8000-000000000001", name: "Default policy" },
        { id: work.familyId, name: "Work safe" },
      ],
    });
    api.getNamedPrivacyPolicy.mockResolvedValue({ family: { current: work } });
    api.getNamedPrivacyPolicyHistory.mockResolvedValue({
      versions: [],
      pageInfo: { hasMore: false },
    });
    api.updateNamedPrivacyPolicy.mockResolvedValue({ family: { current: { ...work, policy: "# Changed\n", revision: "f".repeat(64) } } });
    api.getAccessOverview.mockResolvedValue({
      principals: [{
        id: "principal-1",
        name: "Fictional research assistant",
        revokedAt: null,
        grants: [{
          id: "grant-1",
          name: "Research answers",
          revokedAt: null,
          expiresAt: null,
          rules: [{
            capability: "answer",
            sources: { mode: "all", sourceIds: [] },
            release: { mode: "reviewed", policyFamilyId: work.familyId },
          }],
        }],
      }],
    });

    await act(async () => { render(h(PrivacyPolicyPane, { policyId: work.familyId }), host); });
    await settle();
    expect(api.getNamedPrivacyPolicy).toHaveBeenCalledWith(work.familyId);
    expect((host.querySelector("textarea") as HTMLTextAreaElement).value).toBe("# Work safe\n");

    const editor = host.querySelector("textarea") as HTMLTextAreaElement;
    editor.value = "# Changed\n";
    await act(async () => { editor.dispatchEvent(new window.Event("input", { bubbles: true })); });
    await act(async () => { button("Review and save").click(); });
    await settle();
    const affected = host.querySelector(".privacy-policy-affected");
    expect(affected?.querySelectorAll("li")).toHaveLength(1);
    expect(affected?.textContent).toContain("Fictional research assistant");
    expect(affected?.textContent).toContain("Connection");
    expect(affected?.textContent).not.toContain("Research answers");
    await act(async () => { button("Save policy").click(); });
    await settle();
    expect(api.updateNamedPrivacyPolicy).toHaveBeenCalledWith(work.familyId, {
      policy: "# Changed\n",
      beforeVersion: work.familyVersion,
    });
  });

  it("forks a named family without rewriting its source history", async () => {
    const defaultSummary = {
      id: "00000000-0000-4000-8000-000000000001",
      name: "Default policy",
    };
    api.listPrivacyPolicies.mockResolvedValue({ policyFamilies: [defaultSummary] });
    api.getNamedPrivacyPolicy.mockResolvedValue({ ...current, familyId: defaultSummary.id });
    api.getNamedPrivacyPolicyHistory.mockResolvedValue({ versions: [], pageInfo: { hasMore: false } });
    api.forkPrivacyPolicy.mockResolvedValue({
      family: {
        id: "00000000-0000-4000-8000-000000000003",
        name: "Research safe",
        current: { ...current, familyId: "00000000-0000-4000-8000-000000000003", familyName: "Research safe" },
      },
    });
    await act(async () => {
      render(h(ForkPolicyButton, { policyId: defaultSummary.id, policyName: "Default policy" }), host);
    });
    await settle();
    await act(async () => { button("Fork policy").click(); });
    const dialog = host.querySelector("[role='dialog']")!;
    const name = dialog.querySelector("input") as HTMLInputElement;
    name.value = "Research safe";
    await act(async () => { name.dispatchEvent(new window.Event("input", { bubbles: true })); });
    const confirm = [...dialog.querySelectorAll("button")].find((item) => item.textContent === "Fork policy")!;
    await act(async () => { confirm.click(); });
    await settle();
    expect(api.forkPrivacyPolicy).toHaveBeenCalledWith(defaultSummary.id, { name: "Research safe" });
    // A fork is a family of its own, so the editor opens it rather than
    // leaving the origin on screen under a message about a policy not shown.
    expect(router.navigate).toHaveBeenCalledWith(
      "/portal/settings/policies/00000000-0000-4000-8000-000000000003",
    );
  });

  it("shows what went wrong, and no editor, for a policy the gateway does not know", async () => {
    api.getNamedPrivacyPolicy.mockRejectedValue({ status: 404, serverMessage: "Privacy policy family not found." });
    await act(async () => { render(h(PrivacyPolicyPane, { policyId: "gone" }), host); });
    await settle();

    expect(host.querySelector("[role='alert']")?.textContent).toContain("Failed to load policy");
    expect(host.querySelector("textarea")).toBeNull();
    expect(api.updateNamedPrivacyPolicy).not.toHaveBeenCalled();
  });

  it("restores a named version append-only through the family endpoint", async () => {
    const defaultId = "00000000-0000-4000-8000-000000000001";
    api.listPrivacyPolicies.mockResolvedValue({
      policyFamilies: [{ id: defaultId, name: "Default policy" }],
      defaultPolicyFamilyId: defaultId,
    });
    api.getNamedPrivacyPolicyHistory.mockResolvedValue({
      versions: [{ familyVersion: 2, action: "edit", createdAt: 2 }],
      pageInfo: { hasMore: false },
    });
    api.getNamedPrivacyPolicyVersion.mockResolvedValue({
      version: { familyVersion: 2, action: "edit", createdAt: 2, policy: "# Earlier\n" },
    });
    api.restoreNamedPrivacyPolicy.mockResolvedValue({
      ...current,
      familyId: defaultId,
      familyName: "Default policy",
      familyVersion: 4,
      policy: "# Earlier\n",
    });

    await act(async () => { render(h(PrivacyPolicyPane, { policyId: DEFAULT_ID }), host); });
    await settle();
    await act(async () => { viewButton().click(); });
    await settle();
    await act(async () => { button("Restore as new version").click(); });
    await act(async () => { button("Restore as new version").click(); });
    await settle();

    expect(api.restoreNamedPrivacyPolicy).toHaveBeenCalledWith(defaultId, 2, current.revision);
    expect(host.textContent).toContain("Version 2 restored as a new change");
  });
});

describe("affectedPolicyAccess", () => {
  it("attributes legacy reviewed access only to the configured default policy", () => {
    const defaultPolicyId = "00000000-0000-4000-8000-000000000001";
    const alternatePolicyId = "00000000-0000-4000-8000-000000000002";
    const overview = {
      defaultPolicyFamilyId: defaultPolicyId,
      principals: [{
        id: "principal-1",
        name: "Fictional assistant",
        revokedAt: null,
        grants: [{
          id: "grant-1",
          name: "Default reviewed access",
          revokedAt: null,
          expiresAt: null,
          capabilities: [{
            capability: "answer",
            sourceMode: "all",
            sourceIds: [],
            releaseMode: "reviewed",
            privacyPolicy: "default",
          }],
        }],
      }],
    };

    expect(affectedPolicyAccess(overview, alternatePolicyId)).toEqual({
      levels: [],
      connections: [],
      connectionCount: 0,
      deviceCount: 0,
    });
    expect(affectedPolicyAccess(overview, defaultPolicyId)).toEqual({
      levels: [],
      connections: [{ id: "principal-1", name: "Fictional assistant" }],
      connectionCount: 1,
      deviceCount: 0,
    });
  });

  it("names the access levels a policy reviews with the connections and devices using them", () => {
    const workPolicyId = "00000000-0000-4000-8000-000000000002";
    const reviewed = [{
      capability: "answer",
      sources: { mode: "all", sourceIds: [] },
      release: { mode: "reviewed", policyFamilyId: workPolicyId },
    }];
    const connection = (id: string, name: string, levelId: string, extra = {}) => ({
      id,
      name,
      revokedAt: null,
      grants: [{ id: `grant-${id}`, name: `${name} access`, levelId, revokedAt: null, expiresAt: null, rules: reviewed, credentials: [], ...extra }],
    });
    const overview = {
      defaultPolicyFamilyId: "00000000-0000-4000-8000-000000000001",
      levels: [
        { id: "level-empty", name: "Unused research", revision: 1, rules: reviewed, connectionCount: 0 },
        {
          id: "level-research",
          name: "Research",
          revision: 2,
          rules: reviewed,
          connectionCount: 2,
          devices: [{ id: "device-voice", name: "Studio voice" }],
        },
        { id: "level-notes", name: "Notes only", revision: 1, rules: [{ capability: "notes", sources: { mode: "all", sourceIds: [] } }], connectionCount: 1 },
      ],
      principals: [
        connection("principal-a", "Maya's laptop", "level-research"),
        connection("principal-b", "Studio desktop", "level-research"),
        connection("principal-c", "Expired helper", "level-research", { expiresAt: 5 }),
        connection("principal-d", "Journal", "level-notes"),
      ],
    };

    expect(affectedPolicyAccess(overview, workPolicyId, 10)).toEqual({
      levels: [
        { id: "level-research", name: "Research", connections: [
          { id: "principal-a", name: "Maya's laptop" },
          { id: "principal-b", name: "Studio desktop" },
        ], devices: [{ id: "device-voice", name: "Studio voice" }] },
        { id: "level-empty", name: "Unused research", connections: [], devices: [] },
      ],
      connections: [],
      connectionCount: 2,
      deviceCount: 1,
    });
  });
});

function storage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("PrivacyPolicyHistory", () => {
  let host: HTMLDivElement;
  let originalDocument: typeof globalThis.document | undefined;
  let originalWindow: typeof globalThis.window | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    originalDocument = globalThis.document;
    originalWindow = globalThis.window;
    const parsed = parseHTML("<html><body><div id='root'></div></body></html>");
    Object.assign(globalThis, { document: parsed.document, window: parsed.window });
    host = parsed.document.querySelector("#root") as unknown as HTMLDivElement;
  });

  afterEach(() => {
    act(() => render(null, host));
    if (originalDocument === undefined) delete (globalThis as { document?: unknown }).document;
    else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else globalThis.window = originalWindow;
  });

  it("tabulates the versions, newest first, and offers no restore of the one already loaded", async () => {
    api.getNamedPrivacyPolicyHistory.mockResolvedValue({
      versions: [
        { generation: 4, action: "restore", createdAt: 4, restoredFromVersion: 1 },
        { generation: 3, action: "edit", createdAt: 3 },
      ],
      pageInfo: { hasMore: false },
    });
    await act(async () => {
      render(h(PrivacyPolicyHistory, { familyId: DEFAULT_ID, currentGeneration: 4, refreshKey: 0, onRevert: vi.fn() }), host);
    });
    await settle();

    const rows = [...host.querySelectorAll(".privacy-history-table tbody tr")];
    expect(rows.map((row) => row.querySelectorAll("td")[0].textContent?.trim())).toEqual(["4", "3"]);
    // The current version is what the editor above already holds, so restoring
    // it would be a no-op dressed as a change.
    expect(rows[0].textContent).toContain("Current");
    expect(rows[0].querySelector("button")).toBeNull();
    // What a restore restored belongs to the row, not to a separate legend.
    expect(rows[0].textContent).toContain("Restored version 1");
    // Each earlier version's action names it, since the button carries no text.
    expect(rows[1].querySelector("button")?.getAttribute("aria-label")).toMatch(/^View version \d+$/);
    expect(rows[1].textContent).not.toContain("Current");
  });

  it("names its columns", async () => {
    api.getNamedPrivacyPolicyHistory.mockResolvedValue({
      versions: [{ generation: 3, action: "edit", createdAt: 3 }],
      pageInfo: { hasMore: false },
    });
    await act(async () => {
      render(h(PrivacyPolicyHistory, { familyId: DEFAULT_ID, currentGeneration: 3, refreshKey: 0, onRevert: vi.fn() }), host);
    });
    await settle();

    expect([...host.querySelectorAll(".privacy-history-table thead th")].map((cell) => cell.textContent?.trim()))
      .toEqual(["Version", "Change", "Saved", ""]);
  });

  it("says so rather than heading an empty table when no version can be read", async () => {
    api.getNamedPrivacyPolicyHistory.mockRejectedValue(new Error("history unavailable"));
    await act(async () => {
      render(h(PrivacyPolicyHistory, { familyId: DEFAULT_ID, currentGeneration: 3, refreshKey: 0, onRevert: vi.fn() }), host);
    });
    await settle();

    // Column headers over an empty body would assert a structure that was
    // never read.
    expect(host.querySelector(".privacy-history-table")).toBeNull();
    expect(host.querySelector(".privacy-empty")?.textContent).toMatch(/no versions could be read/i);
  });

  it("locks every restore while one version is being fetched", async () => {
    const pending = deferred<unknown>();
    api.getNamedPrivacyPolicyHistory.mockResolvedValue({
      versions: [
        { generation: 3, action: "edit", createdAt: 3 },
        { generation: 2, action: "edit", createdAt: 2 },
      ],
      pageInfo: { hasMore: false },
    });
    api.getNamedPrivacyPolicyVersion.mockReturnValue(pending.promise);
    await act(async () => {
      render(h(PrivacyPolicyHistory, { familyId: DEFAULT_ID, currentGeneration: 4, refreshKey: 0, onRevert: vi.fn() }), host);
    });
    await settle();

    const buttons = () => [...host.querySelectorAll<HTMLButtonElement>(".privacy-history-table button")];
    expect(buttons()).toHaveLength(2);
    await act(async () => { buttons()[0].click(); });

    // A second click while the first body is in flight would race two fetches,
    // and the loser's response would open the restore modal on the wrong
    // version — which the next click confirms as an append-only restore.
    for (const button of buttons()) {
      expect(button.disabled).toBe(true);
      expect(button.getAttribute("aria-busy")).toBe("true");
    }

    await act(async () => {
      pending.resolve({ version: { generation: 3, action: "edit", createdAt: 3, policy: "# Three\n" } });
      await Promise.resolve();
    });
    expect(api.getNamedPrivacyPolicyVersion).toHaveBeenCalledOnce();
  });

  it("ignores an older rejected history request after a refresh succeeds", async () => {
    const stale = deferred<unknown>();
    api.getNamedPrivacyPolicyHistory
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce({
        versions: [{ generation: 4, action: "edit", createdAt: 2 }],
        pageInfo: { hasMore: false },
      });
    await act(async () => {
      render(h(PrivacyPolicyHistory, { familyId: DEFAULT_ID, currentGeneration: 4, refreshKey: 0, onRevert: vi.fn() }), host);
    });
    await act(async () => {
      render(h(PrivacyPolicyHistory, { familyId: DEFAULT_ID, currentGeneration: 4, refreshKey: 1, onRevert: vi.fn() }), host);
      await Promise.resolve();
    });
    await act(async () => { stale.reject(new Error("stale failure")); await Promise.resolve(); });

    expect(host.textContent).toContain("Edited");
    expect(host.textContent).not.toContain("stale failure");
  });

  it("paginates history and forwards a selected version for append-only restore", async () => {
    const onRevert = vi.fn();
    api.getNamedPrivacyPolicyHistory
      .mockResolvedValueOnce({
        versions: [{ generation: 3, action: "edit", createdAt: 3 }],
        pageInfo: { hasMore: true, nextBeforeGeneration: 3 },
      })
      .mockResolvedValueOnce({
        versions: [{ generation: 2, action: "bootstrap", createdAt: 2 }],
        pageInfo: { hasMore: false },
      });
    api.getNamedPrivacyPolicyVersion.mockResolvedValue({
      version: { generation: 2, action: "bootstrap", createdAt: 2, policy: "# Earlier\n" },
    });
    await act(async () => {
      render(h(PrivacyPolicyHistory, { familyId: DEFAULT_ID, currentGeneration: 3, refreshKey: 0, onRevert }), host);
    });
    await settle();
    const loadMore = [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((candidate) => candidate.getAttribute("aria-label") === "Load older versions")!;
    await act(async () => { loadMore.click(); });
    await settle();
    expect(api.getNamedPrivacyPolicyHistory).toHaveBeenLastCalledWith(DEFAULT_ID, { limit: 25, beforeVersion: 3 });
    await act(async () => { viewButton().click(); });
    await settle();
    await act(async () => { button("Restore as new version").click(); });

    expect(onRevert).toHaveBeenCalledWith(expect.objectContaining({ generation: 2 }));
  });
});
