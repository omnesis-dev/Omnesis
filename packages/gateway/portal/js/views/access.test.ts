// SPDX-License-Identifier: AGPL-3.0-or-later

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({
  completeAccessAuthorization: vi.fn(),
  createAccessLevel: vi.fn(),
  decideAccessAuthorization: vi.fn(),
  deleteAccessLevel: vi.fn(),
  getAccessAuthorization: vi.fn(),
  getAccessOverview: vi.fn(),
  lookupAccessAuthorization: vi.fn(),
  moveConnectionLevel: vi.fn(),
  pairDevice: vi.fn(),
  renameAccessPrincipal: vi.fn(),
  revokeAccess: vi.fn(),
  updateAccessLevel: vi.fn(),
}));
const router = vi.hoisted(() => ({ navigate: vi.fn(), replaceRoute: vi.fn() }));

const qr = vi.hoisted(() => ({ toCanvas: vi.fn().mockResolvedValue(undefined) }));

vi.mock("../api.js", () => api);
vi.mock("../lib/router.js", () => router);
vi.mock("qrcode", () => ({ default: qr }));

// @ts-expect-error — portal modules are plain JS without sibling declarations.
import * as accessModule from "./access.js";
// @ts-expect-error — portal modules are plain JS without sibling declarations.
import { errorMessage, expiresInLabel, timestamp } from "./access/shared.js";
// @ts-expect-error — portal modules are plain JS without sibling declarations.
import { timeAgo } from "../lib/format.js";

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

const {
  AccessView,
  authorizationEndpointLabel,
  authorizationErrorMessage,
  authorizationStatusNotice,
  buildAuthorizationSelection,
  effectiveAccessState,
  initialAuthorizationRules,
  reviewSourceScopes,
  sourceSummary,
} = accessModule;

const EMPTY_OVERVIEW = { principals: [], oauth: null };

describe("access authorization selections", () => {
  test("presents loopback callbacks without exposing ephemeral internal ports", () => {
    expect(authorizationEndpointLabel("http://127.0.0.1:48123/callback")).toBe(
      "Requesting device",
    );
    expect(authorizationEndpointLabel("https://client.example.org/oauth/callback")).toBe(
      "client.example.org",
    );
    expect(authorizationEndpointLabel("https://gateway.example.org/mcp", "This gateway")).toBe(
      "gateway.example.org",
    );
  });

  test("distinguishes completed authorization requests from expired ones", () => {
    expect(authorizationStatusNotice("code-issued")).toContain("completed");
    expect(authorizationStatusNotice("complete")).toContain("completed");
    expect(authorizationStatusNotice("expired")).toContain("expired");
    expect(authorizationStatusNotice("unknown")).toBe("This request is no longer waiting for a decision.");
  });

  test("words a refusal the gateway named as a machine token", () => {
    const refusal = (serverMessage: string, status = 409) =>
      Object.assign(new Error("refused"), { status, serverMessage });
    const fallback = "The MCP client could not finish connecting.";
    expect(authorizationErrorMessage(refusal("expired", 410), fallback))
      .toBe("This authorization request expired. Start the connection again.");
    expect(authorizationErrorMessage(refusal("client-completes"), fallback))
      .toBe("This client collects its own authorization code; there is nothing to finish from here.");
    expect(authorizationErrorMessage(refusal("oauth-not-configured", 503), fallback))
      .toBe("The MCP client could not finish connecting: OAuth needs the Gateway public URL. Set gateway.publicBaseUrl on the Config tab and try again.");
    expect(authorizationErrorMessage(refusal("not-found", 404), fallback))
      .toBe("This authorization request no longer exists.");
    expect(authorizationErrorMessage(refusal("already-decided"), fallback))
      .toBe("This authorization request was already completed.");
    // A 404 is the request being gone whether the gateway said so in a
    // token or in its own sentence.
    expect(authorizationErrorMessage(refusal("Authorization request not found.", 404), fallback))
      .toBe("This authorization request no longer exists.");
  });

  test("shows a token it cannot word as the caller's sentence, and a sentence as itself", () => {
    const fallback = "The authorization decision could not be saved.";
    const unknownToken = Object.assign(new Error("refused"), { status: 409, serverMessage: "rate-limited" });
    expect(authorizationErrorMessage(unknownToken, fallback)).toBe(fallback);
    expect(errorMessage(unknownToken, fallback)).toBe(fallback);
    const sentence = Object.assign(new Error("refused"), {
      status: 500,
      serverMessage: "The access store is read-only while a backup runs.",
    });
    expect(authorizationErrorMessage(sentence, fallback)).toBe(sentence.serverMessage);
    expect(errorMessage(sentence, fallback)).toBe(sentence.serverMessage);
    expect(errorMessage(new Error("offline"), fallback)).toBe(fallback);
    expect(errorMessage(undefined, fallback)).toBe(fallback);
  });

  test("derives active, expired, and revoked states at the exact expiry boundary", () => {
    expect(effectiveAccessState({ revokedAt: null, expiresAt: null }, 100)).toBe("active");
    expect(effectiveAccessState({ revokedAt: null, expiresAt: 101 }, 100)).toBe("active");
    expect(effectiveAccessState({ revokedAt: null, expiresAt: 100 }, 100)).toBe("expired");
    expect(effectiveAccessState({ revokedAt: 99, expiresAt: 200 }, 100)).toBe("revoked");
    expect(effectiveAccessState({ revokedAt: null, expiresAt: null, status: "pending" }, 100)).toBe(
      "pending",
    );
  });

  test("approves exactly what the owner chose: a new or existing level, or a replacement", () => {
    const policyFamilyId = "00000000-0000-4000-8000-000000000002";
    const rules = {
      direct: { capability: "direct", sources: { mode: "allowlist", sourceIds: ["github:work"] } },
      answer: {
        capability: "answer",
        sources: { mode: "denylist", sourceIds: ["mail:personal"] },
        release: { mode: "reviewed", policyFamilyId },
      },
    };
    const serialized = [
      { capability: "direct", sources: { mode: "allowlist", sourceIds: ["github:work"] } },
      {
        capability: "answer",
        sources: { mode: "denylist", sourceIds: ["mail:personal"] },
        release: { mode: "reviewed", policyFamilyId },
      },
    ];

    expect(buildAuthorizationSelection({
      kind: "new-level", name: "  Fictional coding agent ", levelName: " fictional research ", rules,
    })).toEqual({
      kind: "new-connection",
      name: "Fictional coding agent",
      level: { kind: "new", name: "fictional research", rules: serialized },
    });
    expect(buildAuthorizationSelection({
      kind: "existing-level", name: "Fictional coding agent",
      level: { id: "level-1", name: "fictional research", revision: 7 }, rules,
    })).toEqual({
      kind: "new-connection",
      name: "Fictional coding agent",
      level: { kind: "existing", levelId: "level-1", expectedLevelRevision: 7 },
    });
    expect(buildAuthorizationSelection({
      kind: "replace",
      connection: { id: "principal-1", name: "Fictional laptop", grant: { id: "grant-1", revision: 5 } },
      rules,
    })).toEqual({ kind: "replace-connection", connectionId: "principal-1", expectedGrantRevision: 5 });
  });

  test("starts from the access a recognised client already holds, else from Answer alone", () => {
    const policies = [{ id: "policy-work", name: "Work-safe", revision: "rev-1" }];
    const heldRules = [
      { capability: "direct", sources: { mode: "allowlist", sourceIds: ["github:work"] } },
      { capability: "notes", sources: { mode: "all", sourceIds: [] } },
    ];
    const match = {
      connectionId: "principal-1",
      connectionName: "Fictional integration",
      matchedBy: "client",
      levelId: "level-1",
      grant: { id: "grant-1", name: "Fictional integration access", revision: 2, rules: heldRules },
    };

    const held = initialAuthorizationRules({ requiresAnswer: false }, match, policies, "policy-work");
    expect(Object.keys(held).sort()).toEqual(["direct", "notes"]);
    expect(held.direct.sources).toEqual({ mode: "allowlist", sourceIds: ["github:work"] });

    // An integration that requires Answer gets it beside what the agent holds.
    const required = initialAuthorizationRules({ requiresAnswer: true }, match, policies, "policy-work");
    expect(Object.keys(required).sort()).toEqual(["answer", "direct", "notes"]);
    expect(required.answer.release).toEqual({ mode: "reviewed", policyFamilyId: "policy-work" });

    const fresh = initialAuthorizationRules({ requiresAnswer: false }, null, policies, "policy-work");
    expect(Object.keys(fresh)).toEqual(["answer"]);
    expect(fresh.answer.sources).toEqual({ mode: "allowlist", sourceIds: [] });
    expect(fresh.answer.release).toEqual({ mode: "reviewed", policyFamilyId: "policy-work" });
  });

  test("moves a held Answer off a policy the overview no longer lists", () => {
    const policies = [{ id: "policy-work", name: "Work-safe", revision: "rev-1" }];
    const match = {
      connectionId: "principal-1",
      connectionName: "Fictional integration",
      matchedBy: "client",
      levelId: "level-1",
      grant: {
        id: "grant-1",
        name: "Fictional integration access",
        revision: 2,
        rules: [
          {
            capability: "answer",
            sources: { mode: "all", sourceIds: [] },
            release: { mode: "reviewed", policyFamilyId: "policy-archived" },
          },
        ],
      },
    };

    const rules = initialAuthorizationRules({ requiresAnswer: false }, match, policies, "policy-work");
    expect(rules.answer.release).toEqual({ mode: "reviewed", policyFamilyId: "policy-work" });
    expect(rules.answer.sources).toEqual({ mode: "all", sourceIds: [] });

    // A policy the overview still lists, and an unreviewed release, are kept as held.
    const kept = { ...match, grant: { ...match.grant, rules: [
      { ...match.grant.rules[0], release: { mode: "reviewed", policyFamilyId: "policy-work" } },
    ] } };
    expect(initialAuthorizationRules({ requiresAnswer: false }, kept, policies, "policy-work").answer.release)
      .toEqual({ mode: "reviewed", policyFamilyId: "policy-work" });
    const unreviewed = { ...match, grant: { ...match.grant, rules: [
      { ...match.grant.rules[0], release: { mode: "unreviewed" } },
    ] } };
    expect(initialAuthorizationRules({ requiresAnswer: false }, unreviewed, policies, "policy-work").answer.release)
      .toEqual({ mode: "unreviewed" });
  });

  test("reviews one source boundary when Answer and Direct share it, and counts it over connected sources", () => {
    const sources = [
      { id: "calendar:work", name: "Work calendar" },
      { id: "github:work", name: "Work code" },
      { id: "mail:old", name: "Old mail", available: false },
    ];
    const shared = {
      answer: {
        capability: "answer",
        sources: { mode: "allowlist", sourceIds: ["github:work"] },
        release: { mode: "unreviewed" },
      },
      direct: { capability: "direct", sources: { mode: "allowlist", sourceIds: ["github:work"] } },
    };
    expect(reviewSourceScopes(shared).map((scope: { name: string }) => scope.name)).toEqual([
      "Answer and Direct",
    ]);
    const split = {
      ...shared,
      direct: { capability: "direct", sources: { mode: "denylist", sourceIds: ["calendar:work"] } },
    };
    expect(reviewSourceScopes(split).map((scope: { name: string }) => scope.name)).toEqual([
      "Answer",
      "Direct",
    ]);

    expect(sourceSummary(shared.answer, sources)).toBe("1 selected source");
    expect(sourceSummary(split.direct, sources)).toBe("All except 1 blocked");
    expect(sourceSummary({ capability: "direct", sources: { mode: "denylist", sourceIds: ["mail:old"] } }, sources))
      .toBe("All sources");
    expect(sourceSummary({ capability: "direct", sources: { mode: "all", sourceIds: [] } }, sources))
      .toBe("All sources");
  });
});

describe("pending authorization expiry", () => {
  const now = Date.parse("2026-09-06T10:00:00.000Z");

  test("counts whole minutes down, never up, while the request is lapsing", () => {
    expect(expiresInLabel(now + 9 * 60_000, now)).toBe("Expires in 9 minutes");
    expect(expiresInLabel(now + 90_000, now)).toBe("Expires in 1 minute");
    expect(expiresInLabel(now + 59_000, now)).toBe("Expires in under a minute");
  });

  test("says a lapsed request is gone rather than printing a negative remainder", () => {
    expect(expiresInLabel(now, now)).toBe("Expired");
    expect(expiresInLabel(now - 60_000, now)).toBe("Expired");
  });

  test("prints the moment itself once the remainder stops being the useful fact", () => {
    const label = expiresInLabel(now + 3 * 3_600_000, now);
    expect(label.startsWith("Expires ")).toBe(true);
    expect(label).not.toContain("minute");
  });

  test("distinguishes no expiry at all from an expiry that has passed", () => {
    expect(expiresInLabel(null, now)).toBe("No expiry");
    expect(expiresInLabel(0, now)).toBe("No expiry");
  });
});

describe("AccessView", () => {
  let host: HTMLElement;
  let originalDocument: typeof globalThis.document | undefined;
  let originalWindow: typeof globalThis.window | undefined;
  let restoreFocus: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    api.getAccessOverview.mockResolvedValue(EMPTY_OVERVIEW);
    api.getAccessAuthorization.mockResolvedValue({ request: null });
    originalDocument = globalThis.document;
    originalWindow = globalThis.window;
    const parsed = parseHTML("<html><body><main id='root'></main></body></html>");
    Object.assign(globalThis, { document: parsed.document, window: parsed.window });
    restoreFocus = trackFocus(parsed.window as unknown as Window, parsed.document as unknown as Document);
    host = parsed.document.querySelector("#root") as unknown as HTMLElement;
  });

  afterEach(() => {
    render(null, host);
    vi.useRealTimers();
    restoreFocus();
    if (originalDocument === undefined) delete (globalThis as { document?: unknown }).document;
    else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else globalThis.window = originalWindow;
  });

  async function mount(props: Record<string, unknown> = {}) {
    await act(async () => { render(h(AccessView, props), host); await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });
  }

  /** Tear the view down and mount it fresh, so its load effect runs again. */
  async function remount(props: Record<string, unknown> = {}) {
    await act(async () => { render(null, host); });
    await mount(props);
  }

  // The header's own action, by the name a reader sees; the empty state
  // carries a second button of the same name.
  /** The page's Connect an agent button: in the header, or in the empty state when nothing is listed. */
  function connectButton() {
    return [...host.querySelectorAll<HTMLButtonElement>(".access-actions button, .access-empty button")]
      .find((button) => button.textContent?.trim() === "Connect an agent");
  }
  function headerConnectButton() {
    return [...host.querySelectorAll<HTMLButtonElement>(".access-actions button")]
      .find((button) => button.textContent?.trim() === "Connect an agent");
  }

  const OAUTH = { resource: "https://gateway.example.org/mcp" };

  /** A request's lookup as the gateway serves it: the request and its connection proposal. */
  function lookup(request: { clientName: string }) {
    return {
      request,
      reconnect: null,
      connection: { defaultName: request.clientName, defaultLevelName: request.clientName, match: null, recommended: "new-level" },
    };
  }

  test("is one inventory with the connect action", async () => {
    await mount();

    expect(api.getAccessOverview).toHaveBeenCalledOnce();
    // One heading for the page; the connect dialog is not mounted until asked for.
    const headings = [...host.querySelectorAll("h2")];
    expect(headings).toHaveLength(1);
    expect(headings[0].textContent).toMatch(/access/i);
    expect(host.querySelector(".access-connect-dialog")).toBeNull();
    expect(host.querySelector("[role='dialog']")).toBeNull();
    const text = host.textContent.replace(/\s+/g, " ");
    expect(text).toMatch(/read the corpus/i);
    expect(host.querySelector(".access-empty")).not.toBeNull();
  });

  test("says why the oauth-null page offers no way to connect, and where to fix it", async () => {
    await mount();

    // The blocker is the page's answer to both missing actions, so it is
    // announced rather than left as decoration beside controls that are gone.
    const blocker = host.querySelector(".access-oauth-blocker")!;
    expect(blocker.getAttribute("role")).toBe("status");
    const link = blocker.querySelector("a") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/portal/settings/config");
    expect(link.textContent).toMatch(/config/i);
    await act(async () => {
      link.dispatchEvent(new window.Event("click", { bubbles: true, cancelable: true }));
    });
    expect(router.navigate).toHaveBeenCalledWith("/portal/settings/config");

    // The empty state offers no button, and says why rather than asking for
    // an action this page cannot carry out.
    const empty = host.querySelector(".access-empty")!;
    expect(empty.querySelector("button")).toBeNull();
    expect(empty.textContent).toMatch(/oauth/i);
    expect(empty.textContent).toMatch(/public url/i);
    expect(empty.textContent).not.toMatch(/^Connect an agent to authorize/);
  });

  test("keeps the connect dialog shut on a gateway without OAuth, however it was asked for", async () => {
    // The route asks for the dialog directly; step 1 has no address to show
    // and step 2 would take a code no gateway could have issued.
    await mount({ connectOpen: true });

    expect(host.querySelector(".access-connect-dialog")).toBeNull();
    expect(host.querySelector("[role='dialog']")).toBeNull();
    expect(host.querySelector(".access-code-input")).toBeNull();
    expect(host.querySelector(".access-oauth-blocker")).not.toBeNull();
  });

  test("never paints the dialog against an overview that has not answered", async () => {
    // `oauth` is null until the overview resolves, and the modal moves focus
    // once on the paint that opens it: opening before the answer would trap
    // the reader in a dialog describing a gateway nobody has asked yet.
    let resolveOverview!: (value: unknown) => void;
    api.getAccessOverview.mockReturnValue(new Promise((resolve) => { resolveOverview = resolve; }));

    await act(async () => { render(h(AccessView, { connectOpen: true }), host); });
    expect(host.querySelector("[role='dialog']")).toBeNull();

    await act(async () => {
      resolveOverview({ principals: [], oauth: OAUTH });
      await Promise.resolve();
    });
    await act(async () => { await Promise.resolve(); });
    expect(host.querySelector(".access-connect-dialog .access-mcp-resource code")?.textContent)
      .toBe(OAUTH.resource);
  });

  const reviewedAnswer = (policyFamilyId = "policy-a") => ({
    capability: "answer",
    sources: { mode: "all", sourceIds: [] },
    release: { mode: "reviewed", policyFamilyId },
  });
  const NOTES_RULE = { capability: "notes", sources: { mode: "all", sourceIds: [] } };

  function signIn(id: string, label: string, extra: Record<string, unknown> = {}) {
    return {
      id, label, kind: "oauth", status: "active", clientName: "Fictional desktop app",
      createdAt: 1_756_000_000_000, lastUsedAt: 1_757_000_000_000, revokedAt: null, expiresAt: null,
      ...extra,
    };
  }

  function connectionOf(
    id: string,
    name: string,
    levelId: string | null,
    rules: unknown[],
    credentials: unknown[],
    grant: Record<string, unknown> = {},
  ) {
    return {
      id, name, kind: "interactive", revokedAt: null,
      grants: [{
        id: `grant-${id}`, name: `${name} access`, levelId, revision: 3,
        revokedAt: null, expiresAt: null, rules, credentials, ...grant,
      }],
    };
  }

  // Two levels, listed by name: one nobody uses yet, and one two connections share.
  const levelOverview = {
    oauth: null,
    defaultPolicyFamilyId: "policy-a",
    policyFamilies: [
      { id: "policy-a", name: "Household", revision: "r1" },
      { id: "policy-b", name: "Work safe", revision: "r2" },
    ],
    levels: [
      { id: "level-research", name: "fictional research", revision: 4, rules: [reviewedAnswer()], connectionCount: 2, createdAt: 1, updatedAt: 1 },
      { id: "level-notes", name: "Fictional notes", revision: 1, rules: [NOTES_RULE], connectionCount: 0, createdAt: 1, updatedAt: 1 },
    ],
    principals: [
      connectionOf("principal-laptop", "Fictional laptop", "level-research", [reviewedAnswer()], [
        signIn("cred-laptop", "Fictional laptop"),
      ]),
      connectionOf("principal-desk", "Fictional desktop", "level-research", [reviewedAnswer()], [
        signIn("cred-desk", "Fictional desktop", { clientName: "Fictional coding agent", lastUsedAt: null }),
      ]),
    ],
  };

  test("puts Connect an agent in the header once anything is listed", async () => {
    api.getAccessOverview.mockResolvedValue({ ...levelOverview, oauth: OAUTH });
    await mount();
    expect(headerConnectButton()).toBeDefined();
    expect(host.querySelector(".access-empty")).toBeNull();
  });

  /** The same overview with the research level used by `names` alone, in that order. */
  function researchUsedBy(...names: string[]) {
    return {
      ...levelOverview,
      levels: levelOverview.levels.map((level) => level.id === "level-research" ? { ...level, connectionCount: names.length } : level),
      principals: levelOverview.principals.filter((principal) => names.includes(principal.name)),
    };
  }

  function levelGroup(name: string): Element {
    return [...host.querySelectorAll(".access-level-group")]
      .find((group) => group.querySelector(".access-level-name")?.textContent === name)!;
  }

  function connectionRow(name: string): Element {
    return [...host.querySelectorAll(".access-connection-row")]
      .find((row) => row.querySelector(".access-connection-label")?.textContent === name)!;
  }

  /**
   * Open a row's overflow menu, closing any other first, and return its items.
   * A menu already open stays open: pressing its trigger again would shut it.
   */
  async function openMenu(menuLabel: string): Promise<HTMLButtonElement[]> {
    const triggers = [...host.querySelectorAll<HTMLButtonElement>(".row-action-trigger")];
    for (const other of triggers) {
      if (other.getAttribute("aria-label") !== menuLabel && other.getAttribute("aria-expanded") === "true") {
        await act(async () => { other.click(); });
      }
    }
    const trigger = triggers.find((candidate) => candidate.getAttribute("aria-label") === menuLabel)!;
    if (trigger.getAttribute("aria-expanded") !== "true") await act(async () => { trigger.click(); });
    return [...trigger.closest(".row-action-menu")!.querySelectorAll<HTMLButtonElement>("[role='menuitem']")];
  }

  function itemLabel(item: Element): string {
    const hint = item.querySelector(".row-action-item-hint")?.textContent ?? "";
    return (item.textContent ?? "").replace(hint, "").trim();
  }

  /** The items a row's overflow menu offers, by label. */
  async function menuItems(menuLabel: string): Promise<string[]> {
    return (await openMenu(menuLabel)).map(itemLabel);
  }

  /** Open a row's overflow menu and click the item with this label. */
  async function chooseAction(menuLabel: string, label: string) {
    const item = (await openMenu(menuLabel)).find((candidate) => itemLabel(candidate) === label)!;
    await act(async () => { item.click(); });
  }

  function button(label: string): HTMLButtonElement {
    return [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((candidate) => candidate.textContent?.trim() === label)!;
  }

  async function check(input: HTMLInputElement, checked = true) {
    await act(async () => {
      input.checked = checked;
      input.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
  }

  async function typeInto(input: HTMLInputElement, value: string) {
    await act(async () => {
      input.value = value;
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
  }

  async function submitForm(form: Element) {
    await act(async () => {
      form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => { await Promise.resolve(); });
  }

  /** A radio or checkbox choice by the name it shows. */
  function choice(label: string): HTMLInputElement {
    const option = [...host.querySelectorAll(".access-choice-option")]
      .find((candidate) => candidate.querySelector("strong")?.firstChild?.textContent?.trim() === label)!;
    return option.querySelector("input") as HTMLInputElement;
  }

  function nameField(label: string): HTMLInputElement {
    const field = [...host.querySelectorAll(".access-name-field")]
      .find((candidate) => candidate.querySelector("label")?.textContent === label)!;
    return field?.querySelector("input") as HTMLInputElement;
  }

  /** An expanded connection's labelled fields, by label. */
  function detailFacts(panel: Element): Record<string, string | undefined> {
    return Object.fromEntries([...panel.querySelectorAll(".access-connection-facts > div")].map((fact) => [
      fact.querySelector("dt")?.textContent,
      fact.querySelector("dd")?.textContent?.trim(),
    ]));
  }

  const LEVEL_NAME_TAKEN = "An access level with that name already exists.";

  function confirmModal() {
    return host.querySelector(".confirm-modal");
  }

  async function confirmWith(label: string) {
    const confirm = [...host.querySelectorAll<HTMLButtonElement>(".confirm-modal button")]
      .find((candidate) => candidate.textContent?.trim() === label)!;
    await act(async () => {
      confirm.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => { await Promise.resolve(); });
  }

  test("lists each access level by name, then the connections that use it", async () => {
    api.getAccessOverview.mockResolvedValue(levelOverview);
    await mount();

    expect([...host.querySelectorAll(".access-level-group .access-level-name")].map((node) => node.textContent))
      .toEqual(["Fictional notes", "fictional research"]);

    // A level can exist with nobody on it, and says so rather than showing an empty table.
    const notes = levelGroup("Fictional notes");
    expect(notes.querySelector(".access-count-cell")?.textContent).toBe("");
    expect(notes.querySelector(".access-level-empty")?.textContent).toBe("No connections use this access level yet.");
    expect(notes.querySelector(".access-connection-row")).toBeNull();
    expect(notes.querySelector(".access-privacy-cell")?.textContent).toContain("—");

    // The level's header row carries what its permissions allow.
    const research = levelGroup("fictional research");
    expect(research.querySelector(".access-count-cell")?.textContent).toBe("2 connections");
    expect(research.querySelector(".access-privacy-cell")?.textContent).toContain("Household");
    // The policy it names is a link to that policy.
    const policyLink = research.querySelector(".access-privacy-cell a")!;
    expect(policyLink.textContent).toBe("Household");
    expect(policyLink.getAttribute("href")).toBe("/portal/settings/policies/policy-a");
    expect(research.querySelector(".access-level-head .access-badge-answer")?.getAttribute("class")).not.toContain("is-off");
    expect(research.querySelector(".access-level-head .access-badge-direct")?.getAttribute("class")).toContain("is-off");

    // Its connections follow it, inside the card: by name, the app that signed
    // in, and when it was last used — with no column headings repeated per level.
    expect(host.querySelector("table, thead, th")).toBeNull();
    const rows = [...research.querySelectorAll(".access-level-body .access-connection-row")];
    expect(rows.map((row) => row.querySelector(".access-connection-label")?.textContent))
      .toEqual(["Fictional desktop", "Fictional laptop"]);
    expect(rows.map((row) => row.querySelector(".access-app-cell")?.textContent))
      .toEqual(["Signed in from Fictional coding agent", "Signed in from Fictional desktop app"]);
    expect(rows.map((row) => row.querySelector(".access-used-cell")?.textContent))
      .toEqual(["Never used", `Last used ${timeAgo(1_757_000_000_000)}`]);

    expect(host.querySelector(".access-header p")?.textContent).toContain("2 active connections.");
    expect(host.textContent).not.toMatch(/\b(principal|grant|credential|profile)s?\b|own permissions/i);
  });

  test("says how many connected sources a level reaches, in sources", async () => {
    api.getAccessOverview.mockResolvedValue({
      ...levelOverview,
      sources: [{ id: "fictional-code:work", name: "code" }, { id: "fictional-mail:home", name: "mail" }],
      levels: [
        ...levelOverview.levels,
        {
          id: "level-narrow", name: "fictional narrow", revision: 1, connectionCount: 0, createdAt: 1, updatedAt: 1,
          rules: [{ ...reviewedAnswer(), sources: { mode: "allowlist", sourceIds: ["fictional-code:work"] } }],
        },
      ],
    });
    await mount();
    expect(levelGroup("fictional research").querySelector(".access-reach-cell")?.textContent).toBe("Sources: All sources");
    expect(levelGroup("fictional narrow").querySelector(".access-reach-cell")?.textContent).toBe("Sources: 1 of 2 sources");
  });

  test("lists a connection no listed level accounts for, so no access is left off the page", async () => {
    api.getAccessOverview.mockResolvedValue({
      ...levelOverview,
      principals: [
        ...levelOverview.principals,
        connectionOf("principal-old", "Fictional helper", null, [NOTES_RULE], [signIn("cred-old", "Fictional helper")]),
      ],
    });
    await mount();
    const others = levelGroup("Other connections");
    expect([...others.querySelectorAll(".access-connection-label")].map((node) => node.textContent))
      .toEqual(["Fictional helper"]);
    expect(await menuItems("Actions for Fictional helper")).toEqual(["Rename", "Move to another access level…", "Remove"]);
  });

  test("shows the empty state only when there is no level and no connection", async () => {
    api.getAccessOverview.mockResolvedValue({ ...levelOverview, principals: [], levels: [] });
    await mount();
    expect(host.querySelector(".access-list")).toBeNull();
    expect(host.textContent).toContain("No agent has access yet");

    api.getAccessOverview.mockResolvedValue({ ...levelOverview, principals: [] });
    await remount();
    expect(host.querySelector(".access-empty")).toBeNull();
    expect(host.querySelectorAll(".access-level-group")).toHaveLength(2);
  });

  test("something removed leaves no row behind, and expired access says so", async () => {
    api.getAccessOverview.mockResolvedValue({
      ...levelOverview,
      principals: [
        { ...levelOverview.principals[0], revokedAt: 5 },
        connectionOf("principal-desk", "Fictional desktop", "level-research", [reviewedAnswer()], [
          signIn("cred-desk", "Fictional desktop"),
        ], { expiresAt: 5 }),
      ],
    });
    await mount();
    expect(connectionRow("Fictional laptop")).toBeUndefined();
    const expired = connectionRow("Fictional desktop");
    expect(expired.querySelector(".access-revoked")?.textContent).toBe("expired");
    expect(expired.getAttribute("class")).toContain("is-inactive");
    // Expired access is not moved back to life; it can still be renamed and removed.
    expect(await menuItems("Actions for Fictional desktop")).toEqual(["Rename", "Remove"]);
  });

  test("says a connection whose sign-in has not finished is pending, and still offers every action", async () => {
    api.getAccessOverview.mockResolvedValue({
      ...levelOverview,
      principals: [connectionOf("principal-laptop", "Fictional laptop", "level-research", [reviewedAnswer()], [
        signIn("cred-laptop", "Fictional laptop", { status: "pending", lastUsedAt: null }),
      ])],
    });
    await mount();
    expect(connectionRow("Fictional laptop").querySelector(".access-state-pending")?.textContent).toBe("pending");
    expect(await menuItems("Actions for Fictional laptop")).toEqual(["Rename", "Move to another access level…", "Remove"]);
  });

  test("always shows connection facts without collapsible rows or nested panels", async () => {
    api.getAccessOverview.mockResolvedValue(levelOverview);
    await mount();
    const row = connectionRow("Fictional laptop");
    expect(host.querySelector(".access-expand")).toBeNull();
    expect(row.querySelector(".access-connection-heading .access-connection-meta")?.textContent?.trim())
      .toBe(`Signed in from Fictional desktop app · Last used ${timeAgo(1_757_000_000_000)}`);
    const panel = row.nextElementSibling!;
    expect(detailFacts(panel)).toEqual({
      "Connection ID": "principal-laptop",
      "Signed in": timestamp(1_756_000_000_000),
      "Last used": timestamp(1_757_000_000_000),
    });
    expect(panel.querySelector(".access-fact-id button")?.getAttribute("title")).toBe("Copy connection ID");
    expect(panel.querySelector(".access-sign-ins")).toBeNull();
    await act(async () => { row.querySelector(".access-app-cell")!.dispatchEvent(new window.Event("click", { bubbles: true })); });
    expect(row.nextElementSibling).toBe(panel);
    await chooseAction("Actions for Fictional laptop", "Rename");
    expect(row.nextElementSibling).toBe(panel);
    expect(row.querySelector("input")).not.toBeNull();
  });

  test("puts a recognized app logo beside its sign-in label, independently of renamed connections", async () => {
    api.getAccessOverview.mockResolvedValue({
      ...levelOverview,
      principals: [connectionOf("principal-logo", "Fictional reader", "level-research", [reviewedAnswer()], [
        signIn("cred-logo", "Fictional reader", { clientName: "ChatGPT" }),
      ])],
    });
    await mount();
    const app = connectionRow("Fictional reader").querySelector(".access-app-cell")!;
    expect(app.textContent).toBe("Signed in from ChatGPT");
    expect(app.querySelector(".access-agent-logo .provider-icon")?.getAttribute("style")).toContain("/model-logos/openai.svg");
    expect(app.querySelector(".access-agent-logo")?.getAttribute("aria-hidden")).toBe("true");
  });

  test("always shows the terms its permissions run under, linking the policy by name", async () => {
    api.getAccessOverview.mockResolvedValue({
      ...levelOverview,
      levels: [
        ...levelOverview.levels,
        {
          id: "level-raw", name: "Fictional raw reads", revision: 1, connectionCount: 0, createdAt: 1, updatedAt: 1,
          rules: [
            { capability: "direct", sources: { mode: "all", sourceIds: [] } },
            { capability: "answer", sources: { mode: "all", sourceIds: [] }, release: { mode: "unreviewed" } },
          ],
        },
        { id: "level-lost", name: "Fictional lost policy", revision: 1, connectionCount: 0, createdAt: 1, updatedAt: 1, rules: [reviewedAnswer("policy-gone")] },
      ],
    });
    await mount();

    const research = levelGroup("fictional research");
    const link = research.querySelector(".access-level-terms a") as HTMLAnchorElement;
    // A list of links reads out its names alone, so the word travels with it.
    expect(link.getAttribute("aria-label")).toBe("Policy: Household");
    expect(link.getAttribute("href")).toBe("/portal/settings/policies/policy-a");
    await act(async () => { link.dispatchEvent(new window.Event("click", { bubbles: true, cancelable: true })); });
    expect(router.navigate).toHaveBeenCalledWith("/portal/settings/policies/policy-a");

    // An unreviewed Answer is named in words, in the header as well as on its badge.
    const raw = levelGroup("Fictional raw reads");
    expect(raw.querySelector(".access-privacy-cell")?.textContent).toContain("No privacy review");
    expect(raw.querySelector(".access-privacy-cell a")).toBeNull();
    expect(raw.querySelector(".access-privacy-cell")?.getAttribute("class")).toContain("access-unreviewed");
    const answer = raw.querySelector(".access-level-head .access-badge-answer")!;
    expect(answer.getAttribute("class")).toContain("is-unreviewed");
    expect(answer.textContent).toContain("released without privacy review");
    expect(raw.querySelector(".access-level-terms")?.textContent).toContain("Raw access");
    expect(raw.querySelector(".access-level-terms a")).toBeNull();

    // A policy the overview no longer carries is not invented behind a link.
    const lost = levelGroup("Fictional lost policy");
    expect(lost.querySelector(".access-level-terms a")).toBeNull();
    expect(lost.querySelector(".access-level-terms")?.textContent).toContain("Policy unavailable");
  });

  test("edits a level's permissions from its menu, and creates one from the header", async () => {
    api.getAccessOverview.mockResolvedValue(levelOverview);
    await mount();
    expect((await menuItems("Actions for fictional research"))).toEqual(["Edit permissions", "Rename", "Delete"]);
    await chooseAction("Actions for fictional research", "Edit permissions");
    expect(router.navigate).toHaveBeenCalledWith("/portal/settings/access/levels/level-research");

    await act(async () => { button("New access level").click(); });
    expect(router.navigate).toHaveBeenCalledWith("/portal/settings/access/levels/new");
  });

  test("a level devices use names them, counts them, and keeps them from being deleted", async () => {
    const withDevices = {
      ...levelOverview,
      levels: levelOverview.levels.map((level) =>
        level.id === "level-research"
          ? { ...level, rules: [reviewedAnswer()], connectionCount: 0, devices: [{ id: "device-voice", name: "Studio voice", kind: "cli" }] }
          : level,
      ),
    };
    api.getAccessOverview.mockResolvedValue(withDevices);
    await mount();

    const research = levelGroup("fictional research");
    expect(research.querySelector(".access-count-cell")?.textContent).toContain("1 integration");
    const deviceLink = research.querySelector<HTMLAnchorElement>(".access-level-devices a")!;
    expect(deviceLink.textContent).toBe("Studio voice");
    expect(deviceLink.querySelector("svg.access-device-icon")).not.toBeNull();
    await act(async () => { deviceLink.click(); });
    expect(router.navigate).toHaveBeenCalledWith("/portal/settings/devices?device=device-voice");

    const inUse = (await openMenu("Actions for fictional research")).find((item) => itemLabel(item) === "Delete")!;
    expect(inUse.getAttribute("aria-disabled")).toBe("true");
    expect(inUse.querySelector(".row-action-item-hint")?.textContent).toBe(
      "Move its integrations to another access level first.",
    );
  });

  test("offers Delete only for a level nobody uses, and says what to do first otherwise", async () => {
    api.getAccessOverview.mockResolvedValue(levelOverview);
    await mount();

    const inUse = (await openMenu("Actions for fictional research")).find((item) => itemLabel(item) === "Delete")!;
    expect(inUse.getAttribute("aria-disabled")).toBe("true");
    expect(inUse.querySelector(".row-action-item-hint")?.textContent).toBe("Move or remove its connections first.");

    const unused = (await openMenu("Actions for Fictional notes")).find((item) => itemLabel(item) === "Delete")!;
    expect(unused.hasAttribute("disabled")).toBe(false);
    expect(unused.getAttribute("aria-disabled")).toBeNull();
    expect(unused.querySelector(".row-action-item-hint")).toBeNull();
    await act(async () => { unused.click(); });
    expect(host.querySelector(".confirm-modal-title")?.textContent).toBe("Delete “Fictional notes”?");

    api.deleteAccessLevel.mockResolvedValue({ removed: true });
    await confirmWith("Delete");
    expect(api.deleteAccessLevel).toHaveBeenCalledWith("level-notes");
    expect(api.deleteAccessLevel).toHaveBeenCalledTimes(1);
    expect(confirmModal()).toBeNull();
    expect(host.querySelector(".access-notice")?.textContent).toBe("Access level “Fictional notes” deleted.");
    expect(api.getAccessOverview).toHaveBeenCalledTimes(2);
  });

  test("removes a connection that shares its level without touching the level", async () => {
    api.getAccessOverview.mockResolvedValue(levelOverview);
    await mount();
    expect(await menuItems("Actions for Fictional laptop")).toEqual(["Rename", "Move to another access level…", "Remove"]);
    await chooseAction("Actions for Fictional laptop", "Remove");

    expect(host.querySelector(".confirm-modal-title")?.textContent).toBe("Remove “Fictional laptop”?");
    expect(host.querySelector(".confirm-modal-body")?.textContent).toContain("Its sign-in stops working immediately.");
    expect(host.querySelector(".confirm-modal input[type='checkbox']")).toBeNull();

    api.revokeAccess.mockResolvedValue({ revoked: true });
    await confirmWith("Remove");
    expect(api.revokeAccess).toHaveBeenCalledWith("principal", "principal-laptop");
    expect(api.revokeAccess).toHaveBeenCalledTimes(1);
    expect(api.deleteAccessLevel).not.toHaveBeenCalled();
    expect(host.querySelector(".access-notice")?.textContent).toBe("“Fictional laptop” removed.");
  });

  test("offers to delete the level with its last connection, checked, and honours unchecking it", async () => {
    api.getAccessOverview.mockResolvedValue(researchUsedBy("Fictional laptop"));
    await mount();
    await chooseAction("Actions for Fictional laptop", "Remove");
    const box = host.querySelector(".confirm-modal input[type='checkbox']") as HTMLInputElement;
    expect(box.hasAttribute("checked")).toBe(true);
    expect(box.closest("label")?.textContent?.trim()).toBe("Also delete the access level “fictional research”");

    api.revokeAccess.mockResolvedValue({ revoked: true });
    api.deleteAccessLevel.mockResolvedValue({ removed: true });
    await confirmWith("Remove");
    // The connection goes first; the level only once nothing uses it.
    expect(api.revokeAccess).toHaveBeenCalledWith("principal", "principal-laptop");
    expect(api.deleteAccessLevel).toHaveBeenCalledWith("level-research");
    expect(api.deleteAccessLevel).toHaveBeenCalledTimes(1);
    expect(api.revokeAccess.mock.invocationCallOrder[0]).toBeLessThan(api.deleteAccessLevel.mock.invocationCallOrder[0]);
    expect(host.querySelector(".access-notice")?.textContent)
      .toBe("“Fictional laptop” and its access level “fictional research” removed.");

    vi.clearAllMocks();
    api.getAccessOverview.mockResolvedValue(researchUsedBy("Fictional laptop"));
    await remount();
    await chooseAction("Actions for Fictional laptop", "Remove");
    await check(host.querySelector(".confirm-modal input[type='checkbox']") as HTMLInputElement, false);
    api.revokeAccess.mockResolvedValue({ revoked: true });
    await confirmWith("Remove");
    expect(api.revokeAccess).toHaveBeenCalledWith("principal", "principal-laptop");
    expect(api.deleteAccessLevel).not.toHaveBeenCalled();
  });

  test("does not offer to delete a level a device still uses", async () => {
    const used = researchUsedBy("Fictional laptop");
    api.getAccessOverview.mockResolvedValue({
      ...used,
      levels: used.levels.map((level) =>
        level.id === "level-research" ? { ...level, devices: [{ id: "device-voice", name: "Studio voice" }] } : level,
      ),
    });
    await mount();
    await chooseAction("Actions for Fictional laptop", "Remove");
    expect(host.querySelector(".confirm-modal input[type='checkbox']")).toBeNull();
  });

  test("keeps a level the gateway still finds in use, and says why", async () => {
    api.getAccessOverview.mockResolvedValue(researchUsedBy("Fictional laptop"));
    await mount();
    await chooseAction("Actions for Fictional laptop", "Remove");
    api.revokeAccess.mockResolvedValue({ revoked: true });
    api.deleteAccessLevel.mockRejectedValue(Object.assign(new Error("in use"), { status: 409, serverMessage: "level-in-use" }));
    await confirmWith("Remove");
    expect(host.querySelector(".access-notice")?.textContent).toBe("“Fictional laptop” removed.");
    expect(host.querySelector(".access-error")?.textContent)
      .toBe("The access level “fictional research” is still used by another connection or an integration, so it was kept.");
  });

  test("keeps an unavailable menu item reachable by keyboard, and choosing it does nothing", async () => {
    api.getAccessOverview.mockResolvedValue(levelOverview);
    await mount();
    const items = await openMenu("Actions for fictional research");
    const popover = host.querySelector(".row-action-popover")!;
    const press = async (key: string) => {
      await act(async () => {
        popover.dispatchEvent(Object.assign(new window.Event("keydown", { bubbles: true }), { key }));
      });
    };
    items[0].focus();
    await press("ArrowDown");
    await press("ArrowDown");
    expect(document.activeElement).toBe(items[2]);
    expect(itemLabel(items[2])).toBe("Delete");
    await press("ArrowDown");
    expect(document.activeElement).toBe(items[0]);
    await press("End");
    expect(document.activeElement).toBe(items[2]);

    await act(async () => { items[2].click(); });
    expect(confirmModal()).toBeNull();
    expect(host.querySelector(".row-action-popover")).not.toBeNull();
    expect(api.deleteAccessLevel).not.toHaveBeenCalled();
  });

  test("reads a connection whose every sign-in was revoked as signed out, not active", async () => {
    api.getAccessOverview.mockResolvedValue({
      ...levelOverview,
      principals: [
        connectionOf("principal-laptop", "Fictional laptop", "level-research", [reviewedAnswer()], [
          signIn("cred-laptop", "Fictional laptop", { revokedAt: 5 }),
        ]),
        connectionOf("principal-desk", "Fictional desktop", "level-research", [reviewedAnswer()], []),
        connectionOf("principal-tablet", "Fictional tablet", "level-notes", [NOTES_RULE], [
          signIn("cred-tablet", "Fictional tablet", { clientName: null }),
          signIn("cred-tablet-new", "Fictional tablet", { clientName: "fictional reader", createdAt: 1_756_500_000_000 }),
        ]),
      ],
    });
    await mount();

    const signedOut = connectionRow("Fictional laptop");
    expect(signedOut.querySelector(".access-revoked")?.textContent).toBe("Signed out");
    expect(signedOut.getAttribute("class")).toContain("is-inactive");
    // It is not active access, but it is still a live connection a new sign-in can take over.
    expect(host.querySelector(".access-header p")?.textContent).toContain("2 active connections.");
    expect(await menuItems("Actions for Fictional laptop")).toEqual(["Rename", "Move to another access level…", "Remove"]);
    expect(host.querySelector('[id="access-connection-detail-grant-principal-laptop"] .access-muted')?.textContent).toBe("No active sign-in");

    // Approved and never signed in is access granted, still waiting for its first sign-in.
    const never = connectionRow("Fictional desktop");
    expect(never.querySelector(".access-revoked")).toBeNull();
    expect(host.querySelector('[id="access-connection-detail-grant-principal-desk"] .access-muted')?.textContent).toBe("No sign-in yet");

    // Several sign-ins are listed, newest first, each saying where it signed in
    // from; one from an app that gave no name is still told apart by its day.
    const panel = host.querySelector('[id="access-connection-detail-grant-principal-tablet"]')!;
    const day = (at: number) => new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(at));
    expect([...panel.querySelectorAll(".access-sign-in")].map((item) => item.textContent?.trim()))
      .toEqual([`Signed in from fictional reader · ${day(1_756_500_000_000)}`, `Signed in · ${day(1_756_000_000_000)}`]);
    expect(detailFacts(panel)["Signed in"]).toBe(timestamp(1_756_500_000_000));
    expect(connectionRow("Fictional tablet").querySelector(".access-app-cell")?.textContent).toBe("Signed in from fictional reader");
  });

  test("counts only live connections: an expired one neither counts nor keeps its level from being deleted", async () => {
    api.getAccessOverview.mockResolvedValue({
      ...levelOverview,
      levels: [
        { ...levelOverview.levels[0], connectionCount: undefined },
        { ...levelOverview.levels[1], connectionCount: 0 },
      ],
      principals: [
        connectionOf("principal-laptop", "Fictional laptop", "level-research", [reviewedAnswer()], [signIn("cred-laptop", "Fictional laptop")]),
        connectionOf("principal-desk", "Fictional desktop", "level-research", [reviewedAnswer()], [signIn("cred-desk", "Fictional desktop")], { expiresAt: 5 }),
        connectionOf("principal-old", "Fictional helper", "level-notes", [NOTES_RULE], [signIn("cred-old", "Fictional helper")], { expiresAt: 5 }),
      ],
    });
    await mount();

    // Where the gateway sent no count, the page counts by its rule: listed is not counted.
    const research = levelGroup("fictional research");
    expect(research.querySelector(".access-count-cell")?.textContent).toBe("1 connection");
    expect(research.querySelectorAll(".access-connection-row")).toHaveLength(2);

    // A level only expired connections use has none active, and can be deleted.
    const notes = levelGroup("Fictional notes");
    expect(notes.querySelector(".access-count-cell")?.textContent).toBe("No active connections");
    expect(notes.querySelector(".access-level-empty")).toBeNull();
    const deletion = (await openMenu("Actions for Fictional notes")).find((item) => itemLabel(item) === "Delete")!;
    expect(deletion.getAttribute("aria-disabled")).toBeNull();
    expect(deletion.hasAttribute("disabled")).toBe(false);

    // Removing the level's last live connection offers the level with it, expired rows notwithstanding.
    await chooseAction("Actions for Fictional laptop", "Remove");
    expect(host.querySelector(".confirm-modal input[type='checkbox']")).not.toBeNull();

    // Removing the expired one leaves the live one on the level, so the level stays.
    await remount();
    await chooseAction("Actions for Fictional desktop", "Remove");
    expect(host.querySelector(".confirm-modal-title")?.textContent).toBe("Remove “Fictional desktop”?");
    expect(host.querySelector(".confirm-modal input[type='checkbox']")).toBeNull();
  });

  test("closes the confirmation when a removal fails, re-reads the list, and says why", async () => {
    api.getAccessOverview.mockResolvedValue(levelOverview);
    await mount();
    await chooseAction("Actions for Fictional laptop", "Remove");
    api.revokeAccess.mockResolvedValueOnce({ revoked: false });
    await confirmWith("Remove");
    expect(confirmModal()).toBeNull();
    expect(host.querySelector(".access-error")?.textContent).toBe("This connection was already removed.");
    expect(api.getAccessOverview).toHaveBeenCalledTimes(2);

    await chooseAction("Actions for Fictional laptop", "Remove");
    api.revokeAccess.mockRejectedValueOnce(new Error("offline"));
    await confirmWith("Remove");
    expect(confirmModal()).toBeNull();
    expect(host.querySelector(".access-error")?.textContent).toBe("The connection could not be removed.");
    expect(api.getAccessOverview).toHaveBeenCalledTimes(3);
    expect(api.deleteAccessLevel).not.toHaveBeenCalled();
  });

  test("says in one sentence that a connection went but its level could not be deleted", async () => {
    api.getAccessOverview.mockResolvedValue(researchUsedBy("Fictional laptop"));
    await mount();
    await chooseAction("Actions for Fictional laptop", "Remove");
    api.revokeAccess.mockResolvedValue({ revoked: true });
    api.deleteAccessLevel.mockRejectedValue(Object.assign(new Error("offline"), { status: 500 }));
    await confirmWith("Remove");
    expect(confirmModal()).toBeNull();
    expect(host.querySelector(".access-notice")).toBeNull();
    expect(host.querySelector(".access-error")?.textContent)
      .toBe("“Fictional laptop” removed. Its access level “fictional research” could not be deleted.");
  });

  describe("moving a connection to another access level", () => {
    async function openMove(name = "Fictional laptop") {
      api.getAccessOverview.mockResolvedValue(levelOverview);
      await mount();
      await chooseAction(`Actions for ${name}`, "Move to another access level…");
      return host.querySelector("[role='dialog'] .access-dialog-form")!;
    }

    test("offers the other levels and a new one, and says what an existing level brings", async () => {
      const form = await openMove();
      expect(host.querySelector(".modal-title")?.textContent).toBe("Move to another access level");
      expect(form.textContent).toContain("Connections that use the same access level share its permissions.");
      expect([...form.querySelectorAll(".access-choice-option strong")].map((node) => node.textContent))
        .toEqual(["Fictional notes", "New access level"]);
      const move = () => [...form.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent?.trim() === "Move")!;
      expect(move().disabled).toBe(true);

      await check(choice("Fictional notes"));
      expect(form.textContent).toContain("Fictional laptop will get the permissions of Fictional notes.");
      expect(move().disabled).toBe(false);

      api.moveConnectionLevel.mockResolvedValue({ grant: {}, level: {} });
      await submitForm(form);
      expect(api.moveConnectionLevel).toHaveBeenCalledWith("principal-laptop", { levelId: "level-notes", expectedLevelRevision: 1 }, 3);
      expect(api.moveConnectionLevel).toHaveBeenCalledTimes(1);
      expect(host.querySelector("[role='dialog']")).toBeNull();
      expect(host.querySelector(".access-notice")?.textContent).toBe("“Fictional laptop” now uses “Fictional notes”.");
    });

    test("counts the devices on a level it offers", async () => {
      api.getAccessOverview.mockResolvedValue({
        ...levelOverview,
        levels: levelOverview.levels.map((level) =>
          level.id === "level-notes" ? { ...level, devices: [{ id: "device-voice", name: "Studio voice" }] } : level,
        ),
      });
      await mount();
      await chooseAction("Actions for Fictional laptop", "Move to another access level…");
      const notes = choice("Fictional notes").closest("label")!;
      expect(notes.querySelector("small")?.textContent).toBe("No connections · 1 integration");
    });

    test("moves onto a new level named after the connection, and keeps the dialog on a refusal", async () => {
      const form = await openMove();
      await check(choice("New access level"));
      const name = nameField("Access level name");
      expect(name.value).toBe("Fictional laptop");
      expect(name.getAttribute("maxlength")).toBe("120");
      await typeInto(name, "");
      expect(form.querySelector(".access-field-error")?.textContent).toBe("Enter a name for this access level.");
      // The field sits inside the New access level card, and a name a level already has is refused there.
      expect(choice("New access level").closest(".access-choice-option")?.querySelector(".access-name-field.is-inline input")).toBe(name);
      await typeInto(name, "fictional NOTES");
      expect(form.querySelector(".access-field-error")?.textContent).toBe(LEVEL_NAME_TAKEN);
      expect([...form.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent?.trim() === "Move")?.disabled).toBe(true);
      await typeInto(name, " Fictional travel ");
      expect(form.querySelector(".access-field-error")).toBeNull();

      api.moveConnectionLevel.mockRejectedValueOnce(Object.assign(new Error("taken"), { status: 409, serverMessage: "level-name-taken" }));
      await submitForm(form);
      expect(api.moveConnectionLevel).toHaveBeenCalledWith("principal-laptop", { newLevel: { name: "Fictional travel" } }, 3);
      expect(host.querySelector("[role='dialog'] .access-error")?.textContent).toBe("An access level with that name already exists.");

      // Choices that moved meanwhile are re-read, and the dialog stays open on them.
      api.moveConnectionLevel.mockRejectedValueOnce(Object.assign(new Error("stale"), { status: 409, serverMessage: "stale-revision" }));
      await submitForm(host.querySelector("[role='dialog'] .access-dialog-form")!);
      expect(api.getAccessOverview).toHaveBeenCalledTimes(2);
      expect(host.querySelector("[role='dialog'] .access-error")?.textContent)
        .toBe("Access choices changed. Review the refreshed choices and try again.");
    });

    test("names a new level after the connection, skipping names live levels already have", async () => {
      api.getAccessOverview.mockResolvedValue({
        ...levelOverview,
        levels: [
          ...levelOverview.levels,
          { id: "level-taken", name: "fictional LAPTOP", revision: 1, rules: [NOTES_RULE], connectionCount: 0, createdAt: 1, updatedAt: 1 },
          { id: "level-taken-2", name: "Fictional laptop 2", revision: 1, rules: [NOTES_RULE], connectionCount: 0, createdAt: 1, updatedAt: 1 },
        ],
      });
      await mount();
      await chooseAction("Actions for Fictional laptop", "Move to another access level…");
      const form = host.querySelector("[role='dialog'] .access-dialog-form")!;
      expect(form.textContent).not.toContain("will keep its current permissions");
      await check(choice("New access level"));
      expect(nameField("Access level name").value).toBe("Fictional laptop 3");
      expect(form.textContent).toContain("“Fictional laptop” will keep its current permissions on the new access level.");
    });

    test("re-reads the choices when the chosen level is gone, and will not move onto it", async () => {
      const form = await openMove();
      await check(choice("Fictional notes"));
      api.getAccessOverview.mockResolvedValue({ ...levelOverview, levels: [levelOverview.levels[0]] });
      api.moveConnectionLevel.mockRejectedValueOnce(Object.assign(new Error("gone"), { status: 409, serverMessage: "inactive-grant" }));
      await submitForm(form);

      const dialog = host.querySelector("[role='dialog']")!;
      expect(api.getAccessOverview).toHaveBeenCalledTimes(2);
      expect(dialog.querySelector(".access-error")?.textContent).toBe("That access level no longer exists.");
      expect([...dialog.querySelectorAll(".access-choice-option strong")].map((node) => node.textContent))
        .toEqual(["New access level"]);
      expect(dialog.textContent).not.toContain("will get the permissions of");
      const move = [...dialog.querySelectorAll<HTMLButtonElement>("button")]
        .find((candidate) => candidate.textContent?.trim() === "Move")!;
      expect(move.disabled).toBe(true);
    });
  });

  describe("renaming a connection", () => {
    const NAME = "Fictional desktop";
    const NEW_NAME = "Fictional desktop (studio)";

    function field() {
      return host.querySelector(".access-connection-row .access-rename-input") as HTMLInputElement | null;
    }

    async function openRename() {
      api.getAccessOverview.mockResolvedValue(levelOverview);
      await mount();
      await chooseAction(`Actions for ${NAME}`, "Rename");
      return field()!;
    }

    /** Enter in the field is the form's own submission; the test sends what the browser would. */
    async function submit() {
      const form = host.querySelector(".access-rename") as HTMLFormElement;
      await act(async () => {
        form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
        await Promise.resolve();
      });
      await act(async () => { await Promise.resolve(); });
    }

    async function keydown(input: HTMLInputElement, key: string) {
      await act(async () => {
        // linkedom has no KeyboardEvent; a plain event carrying the key is
        // what the handler reads.
        const event = new window.Event("keydown", { bubbles: true, cancelable: true });
        Object.assign(event, { key });
        input.dispatchEvent(event);
      });
    }

    test("puts the name in a field, focused, and saves it to the gateway", async () => {
      const input = await openRename();
      expect(input.getAttribute("aria-label")).toBe(`New name for ${NAME}`);
      expect(input.value).toBe(NAME);
      expect(document.activeElement).toBe(input);

      api.renameAccessPrincipal.mockResolvedValue({ principal: { id: "principal-desk", name: NEW_NAME } });
      api.getAccessOverview.mockResolvedValue({
        ...levelOverview,
        principals: levelOverview.principals.map((principal) => principal.name === NAME ? { ...principal, name: NEW_NAME } : principal),
      });
      await typeInto(input, `  ${NEW_NAME} `);
      await submit();

      expect(api.renameAccessPrincipal).toHaveBeenCalledWith("principal-desk", NEW_NAME);
      expect(api.getAccessOverview).toHaveBeenCalledTimes(2);
      expect(field()).toBeNull();
      expect(connectionRow(NEW_NAME)).toBeDefined();
      expect(host.querySelector(".access-notice")?.textContent).toBe(`“${NAME}” is now “${NEW_NAME}”.`);
      // Focus goes back to the row rather than to the page.
      expect(document.activeElement).toBe(connectionRow(NEW_NAME).querySelector(".row-action-trigger"));
    });

    test("Escape and Cancel both put the name back untouched", async () => {
      let input = await openRename();
      await typeInto(input, "Half-typed");
      await keydown(input, "Escape");
      expect(field()).toBeNull();
      expect(document.activeElement).toBe(connectionRow(NAME).querySelector(".row-action-trigger"));

      await chooseAction(`Actions for ${NAME}`, "Rename");
      input = field()!;
      await typeInto(input, "Half-typed again");
      const cancel = [...host.querySelectorAll<HTMLButtonElement>(".access-rename button")]
        .find((candidate) => candidate.textContent?.trim() === "Cancel")!;
      await act(async () => { cancel.click(); });
      expect(field()).toBeNull();
      expect(api.renameAccessPrincipal).not.toHaveBeenCalled();
      expect(api.getAccessOverview).toHaveBeenCalledTimes(1);
    });

    test("refuses a blank name in place, and treats the same name as a cancel", async () => {
      const input = await openRename();
      await typeInto(input, "   ");
      await submit();
      expect(api.renameAccessPrincipal).not.toHaveBeenCalled();
      expect(input.getAttribute("aria-invalid")).toBe("true");
      const message = host.querySelector(".access-rename-message")!;
      expect(message.getAttribute("role")).toBe("alert");
      expect(message.textContent).toBe("Enter a name.");
      expect(input.getAttribute("aria-describedby")).toBe(message.getAttribute("id"));
      await typeInto(input, ` ${NAME} `);
      expect(host.querySelector(".access-rename-message")).toBeNull();
      await submit();
      expect(api.renameAccessPrincipal).not.toHaveBeenCalled();
      expect(field()).toBeNull();
    });

    test("shows the gateway's refusal on the page and keeps what was typed, and a gone connection leaves", async () => {
      const input = await openRename();
      api.renameAccessPrincipal.mockRejectedValue(Object.assign(new Error("refused"), { status: 409, serverMessage: "rate-limited" }));
      await typeInto(input, NEW_NAME);
      await submit();
      expect(host.querySelector(".access-error")?.textContent).toBe("The connection could not be renamed.");
      expect(field()?.value).toBe(NEW_NAME);

      api.renameAccessPrincipal.mockRejectedValue(Object.assign(new Error("refused"), { status: 404, serverMessage: "not-found" }));
      api.getAccessOverview.mockResolvedValue(researchUsedBy("Fictional laptop"));
      await submit();
      expect(host.querySelector(".access-error")?.textContent).toBe("This connection no longer exists.");
      expect(connectionRow(NAME)).toBeUndefined();
    });

    test("connection details stay visible while renaming", async () => {
      await openRename();
      // linkedom calls a listener with `this` set to the event's target, so a
      // click bubbling up from the input never reaches preact's handler on the
      // form intact; the form is clicked directly.
      const form = host.querySelector(".access-rename") as HTMLElement;
      await act(async () => {
        form.dispatchEvent(new window.Event("click", { bubbles: true, cancelable: true }));
      });
      expect(form.closest(".access-connection-row")?.nextElementSibling?.className).toBe("access-connection-detail");
    });
  });

  test("renames a level on the revision the list shows, and says when the name is taken", async () => {
    api.getAccessOverview.mockResolvedValue(levelOverview);
    await mount();
    await chooseAction("Actions for fictional research", "Rename");
    const input = levelGroup("fictional research").querySelector(".access-rename-input") as HTMLInputElement;
    expect(input.value).toBe("fictional research");

    // A name another level has is refused in the field, before anything is sent.
    await typeInto(input, " fictional NOTES ");
    await submitForm(host.querySelector(".access-level-head .access-rename")!);
    expect(api.updateAccessLevel).not.toHaveBeenCalled();
    expect(host.querySelector(".access-level-head .access-rename-message")?.textContent).toBe(LEVEL_NAME_TAKEN);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    await typeInto(input, "fictional notes archive");
    expect(host.querySelector(".access-level-head .access-rename-message")).toBeNull();

    // The gateway's refusal stays the backstop for a level named meanwhile.
    api.updateAccessLevel.mockRejectedValueOnce(Object.assign(new Error("taken"), { status: 409, serverMessage: "level-name-taken" }));
    await submitForm(host.querySelector(".access-level-head .access-rename")!);
    expect(api.updateAccessLevel).toHaveBeenCalledWith("level-research", { expectedRevision: 4, name: "fictional notes archive" });
    expect(host.querySelector(".access-error")?.textContent).toBe(LEVEL_NAME_TAKEN);
    expect(host.querySelector(".access-level-head .access-rename-input")).not.toBeNull();

    api.updateAccessLevel.mockResolvedValueOnce({ level: {} });
    await typeInto(host.querySelector(".access-level-head .access-rename-input") as HTMLInputElement, "Fictional archive");
    await submitForm(host.querySelector(".access-level-head .access-rename")!);
    expect(api.updateAccessLevel).toHaveBeenLastCalledWith("level-research", { expectedRevision: 4, name: "Fictional archive" });
    expect(host.querySelector(".access-notice")?.textContent).toBe("“fictional research” is now “Fictional archive”.");
  });

  test("lists the requests still waiting, each opening its own review", async () => {
    vi.useFakeTimers();
    const now = Date.now();
    api.getAccessOverview.mockResolvedValue({
      ...levelOverview,
      pendingRequests: [
        { id: "approval-new", clientName: "Fictional planner", userCode: "ABCD-EFGH", createdAt: now - 1_000, expiresAt: now + 5 * 60_000 },
        { id: "approval-old", clientName: "Fictional notebook", userCode: "IJKL-MNOP", createdAt: now - 2_000, expiresAt: now + 90_000 },
        // Lapsed since the overview answered: not waiting on anyone.
        { id: "approval-gone", clientName: "Fictional relic", userCode: "QRST-UVWX", createdAt: now - 9_000, expiresAt: now - 1 },
      ],
    });
    await mount();

    const strip = host.querySelector(".access-pending")!;
    expect(strip.querySelector("h3")?.textContent?.trim()).toBe("2 access requests waiting");
    const items = [...strip.querySelectorAll(".access-pending-item")];
    expect(items.map((item) => item.querySelector("strong")?.textContent))
      .toEqual(["Fictional planner", "Fictional notebook"]);
    expect(items[0].querySelector(".access-pending-expiry")?.textContent).toBe("Expires in 5 minutes");
    expect(items[1].querySelector(".access-pending-expiry")?.textContent).toBe("Expires in 1 minute");
    expect(strip.textContent).not.toContain("Fictional relic");
    // The strip comes before the inventory, and the code is not printed here:
    // the review page is where it is approved.
    expect(strip.textContent).not.toContain("ABCD-EFGH");
    expect(strip.compareDocumentPosition(host.querySelector(".access-list")!) & 4).toBeTruthy();

    const approve = items[1].querySelector<HTMLButtonElement>(".access-pending-review")!;
    // It opens the configuration, not an immediate approval, and says so.
    expect(approve.textContent?.trim()).toBe("Configure & Approve");
    await act(async () => { approve.click(); });
    expect(router.navigate).toHaveBeenCalledWith("/portal/settings/access/authorizations/approval-old");
  });

  test("shows no pending strip when the overview carries no requests, or none at all", async () => {
    api.getAccessOverview.mockResolvedValue(levelOverview);
    await mount();
    expect(host.querySelector(".access-pending")).toBeNull();

    api.getAccessOverview.mockResolvedValue({ ...levelOverview, pendingRequests: [] });
    await remount();
    expect(host.querySelector(".access-pending")).toBeNull();

    const now = Date.now();
    api.getAccessOverview.mockResolvedValue({
      ...levelOverview,
      pendingRequests: [{ id: "approval-gone", clientName: "Fictional relic", userCode: "QRST-UVWX", createdAt: now - 9_000, expiresAt: now - 1 }],
    });
    await remount();
    expect(host.querySelector(".access-pending")).toBeNull();
  });

  /** Let the interval fire and the overview it reads settle into the page. */
  async function tick(ms: number) {
    await act(async () => {
      vi.advanceTimersByTime(ms);
      for (let hop = 0; hop < 4; hop += 1) await Promise.resolve();
    });
  }

  test("follows the gateway while the inventory is open: a request that arrives shows up without a reload", async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const arrived = {
      id: "approval-arrived",
      clientName: "Fictional planner",
      userCode: "ABCD-EFGH",
      createdAt: now + 10_000,
      expiresAt: now + 5 * 60_000,
    };
    api.getAccessOverview
      .mockResolvedValueOnce(levelOverview)
      .mockResolvedValue({ ...levelOverview, pendingRequests: [arrived] });
    await mount();
    expect(host.querySelector(".access-pending")).toBeNull();
    expect(api.getAccessOverview).toHaveBeenCalledTimes(1);

    // Nothing is read ahead of the interval.
    await tick(29_999);
    expect(api.getAccessOverview).toHaveBeenCalledTimes(1);
    expect(host.querySelector(".access-pending")).toBeNull();

    await tick(1);
    expect(api.getAccessOverview).toHaveBeenCalledTimes(2);
    expect(host.querySelector(".access-pending h3")?.textContent?.trim()).toBe("1 access request waiting");
    expect(host.querySelector(".access-pending strong")?.textContent).toBe("Fictional planner");

    // A request decided elsewhere leaves the strip the same way.
    api.getAccessOverview.mockResolvedValue({ ...levelOverview, pendingRequests: [] });
    await tick(30_000);
    expect(api.getAccessOverview).toHaveBeenCalledTimes(3);
    expect(host.querySelector(".access-pending")).toBeNull();
  });

  test("does not follow the gateway from a detail page, whose review is built from what it loaded", async () => {
    vi.useFakeTimers();
    const request = {
      id: "request-still",
      approvalId: "approval-still",
      status: "pending",
      clientId: "client-still",
      clientName: "Fictional desktop agent",
      clientUri: null,
      redirectOrigin: "http://127.0.0.1:59927",
      resource: "https://gateway.example.org/mcp",
      expiresAt: Date.now() + 10 * 60_000,
      requiresAnswer: false,
    };
    api.getAccessOverview.mockResolvedValue(levelOverview);
    api.getAccessAuthorization.mockResolvedValue(lookup(request));
    await mount({ authorizationId: request.approvalId });
    expect(host.querySelector(".access-authorization-page")).not.toBeNull();
    expect(api.getAccessOverview).toHaveBeenCalledTimes(1);

    await tick(60_000);
    expect(api.getAccessOverview).toHaveBeenCalledTimes(1);
  });

  test("keeps the page as it was when a background read fails", async () => {
    vi.useFakeTimers();
    api.getAccessOverview.mockResolvedValueOnce({ ...levelOverview, oauth: OAUTH });
    await mount();
    await act(async () => { connectButton()!.click(); });
    expect(host.querySelector(".access-connect-dialog")).not.toBeNull();

    // The dialog the owner is typing into stays; no banner is raised.
    api.getAccessOverview.mockRejectedValueOnce(new Error("offline"));
    await tick(30_000);
    expect(api.getAccessOverview).toHaveBeenCalledTimes(2);
    expect(host.querySelector(".access-connect-dialog")).not.toBeNull();
    expect(host.querySelector(".access-error")).toBeNull();
    expect(host.querySelector(".access-list")).not.toBeNull();

    // The next read carries the page forward again.
    api.getAccessOverview.mockResolvedValue({ ...levelOverview, oauth: OAUTH, principals: [], levels: [] });
    await tick(30_000);
    expect(host.querySelector(".access-list")).toBeNull();
    expect(host.querySelector(".access-connect-dialog")).not.toBeNull();
  });

  test("counts a waiting request down and drops it when it lapses, without a reload", async () => {
    vi.useFakeTimers();
    const now = Date.now();
    api.getAccessOverview.mockResolvedValue({
      ...levelOverview,
      pendingRequests: [
        { id: "approval-lapsing", clientName: "Fictional notebook", userCode: "IJKL-MNOP", createdAt: now, expiresAt: now + 100_000 },
      ],
    });
    await mount();
    const expiry = () => host.querySelector(".access-pending-expiry")?.textContent;
    expect(expiry()).toBe("Expires in 1 minute");

    await tick(30_000);
    expect(expiry()).toBe("Expires in 1 minute");
    await tick(30_000);
    expect(expiry()).toBe("Expires in under a minute");
    // Lapsed between reads: the strip stops offering it before the gateway
    // has answered again.
    await tick(30_000);
    expect(expiry()).toBe("Expires in under a minute");
    await tick(30_000);
    expect(host.querySelector(".access-pending")).toBeNull();
  });

  test("says a request opened by id is gone when the gateway has no such request", async () => {
    // The gateway answers a 404 with its own sentence for an id it once
    // knew, and with a token for one that never parsed; the page says the
    // same thing for both.
    for (const serverMessage of ["Authorization request not found.", "not-found"]) {
      api.getAccessAuthorization.mockRejectedValue(
        Object.assign(new Error("missing"), { status: 404, serverMessage }),
      );
      await remount({ authorizationId: "approval-missing" });

      expect(host.querySelector(".access-error")?.textContent).toBe("This authorization request no longer exists.");
      expect(host.querySelector(".access-page-back")).not.toBeNull();
      expect(host.querySelector(".access-authorization-page")).toBeNull();
      expect(host.textContent).not.toContain("Deny request");
      expect(router.replaceRoute).not.toHaveBeenCalled();
    }
  });

  test("opens the connect dialog when routed to /connect and replaces the route on close", async () => {
    api.getAccessOverview.mockResolvedValue({ principals: [], oauth: OAUTH });
    await mount({ connectOpen: true });

    const dialog = host.querySelector(".access-connect-dialog");
    expect(dialog).not.toBeNull();
    expect(dialog?.querySelector(".access-mcp-resource code")?.textContent).toBe("https://gateway.example.org/mcp");
    const close = [...host.querySelectorAll("[role='dialog'] button")]
      .find((button) => button.textContent?.trim() === "Close") as HTMLButtonElement;
    await act(async () => { close.click(); });
    expect(router.replaceRoute).toHaveBeenCalledWith("/portal/settings/access");
  });

  test("shows one agent's setup at a time, chosen from a grid", async () => {
    api.getAccessOverview.mockResolvedValue({ principals: [], oauth: OAUTH });
    await mount({ connectOpen: true });

    const picker = host.querySelector(".access-connect-dialog .access-agent-setup")!;
    const cards = [...picker.querySelectorAll<HTMLButtonElement>("button[data-agent]")];
    expect(cards.map((card) => card.getAttribute("data-agent"))).toEqual([
      "claude-code",
      "codex",
      "chatgpt",
      "claude-apps",
      "antigravity",
      "openclaw",
      "hermes",
    ]);
    expect(cards.every((card) => card.getAttribute("aria-pressed") === "false")).toBe(true);
    expect(picker.querySelector(".access-agent-steps")).toBeNull();

    await act(async () => { cards[0]!.click(); });
    let steps = picker.querySelector(".access-agent-steps");
    expect(steps?.getAttribute("data-agent")).toBe("claude-code");
    expect(cards[0]!.getAttribute("aria-pressed")).toBe("true");
    expect(steps?.querySelector("[role='tab'][aria-selected='true']")?.textContent?.trim()).toBe(
      "Install the plugin (recommended)",
    );
    expect(steps?.querySelector(".access-mcp-resource code")?.textContent).toMatch(/^claude plugin marketplace add /u);
    expect(steps?.querySelector(".access-agent-headless")?.textContent).toMatch(/No browser on this machine\?/u);

    await act(async () => { cards[2]!.click(); });
    steps = picker.querySelector(".access-agent-steps");
    expect(steps?.getAttribute("data-agent")).toBe("chatgpt");
    expect(cards[0]!.getAttribute("aria-pressed")).toBe("false");
    expect(steps?.querySelector(".access-agent-command")).toBeNull();
    expect(steps?.textContent).toMatch(/address above/u);
    expect(steps?.querySelector("p a[href='https://developers.openai.com/api/docs/guides/developer-mode']")?.textContent)
      .toBe("developer mode");

    await act(async () => { cards[2]!.click(); });
    expect(picker.querySelector(".access-agent-steps")).toBeNull();
  });

  test("points a hosted app at the publishing docs, and warns about a private address", async () => {
    api.getAccessOverview.mockResolvedValue({
      principals: [],
      oauth: { resource: "https://192.168.1.20:7600/mcp" },
    });
    await mount({ connectOpen: true });
    const warned = [...host.querySelectorAll("button[data-agent]")]
      .filter((card) => card.querySelector(".access-agent-warning"))
      .map((card) => card.getAttribute("data-agent"));
    expect(warned).toEqual(["chatgpt", "claude-apps"]);
    expect(host.querySelector("button[data-agent='chatgpt'] .access-agent-warning")?.getAttribute("aria-label")).toBe(
      "Cannot reach this address",
    );

    const claudeApps = host.querySelector<HTMLButtonElement>("button[data-agent='claude-apps']")!;
    await act(async () => { claudeApps.click(); });
    // Instructions that cannot reach a private address are not offered at all.
    expect(host.querySelector(".access-agent-steps")?.textContent).not.toMatch(/Customize/u);
    expect(host.querySelector(".access-agent-public")?.textContent).toMatch(/This address is private/u);
    await act(async () => { claudeApps.click(); });

    const chatgpt = host.querySelector<HTMLButtonElement>("button[data-agent='chatgpt']")!;
    await act(async () => { chatgpt.click(); });

    const notice = host.querySelector(".access-agent-public")!;
    expect(notice.classList.contains("is-warning")).toBe(true);
    expect(notice.textContent).toMatch(/This address is private/u);
    expect(notice.textContent).toMatch(/Funnel or use a domain of your own/u);
    expect([...notice.querySelectorAll("a")].map((link) => link.getAttribute("href"))).toEqual([
      "https://omnesis.dev/docs/connect#tailscale-funnel",
      "https://omnesis.dev/docs/setup#public-domain",
    ]);
    expect(host.querySelector(".access-agent-docs a")?.getAttribute("href")).toBe(
      "https://omnesis.dev/docs/connect#chatgpt",
    );
  });

  test("warns ChatGPT off an address that is not on port 443", async () => {
    api.getAccessOverview.mockResolvedValue({
      principals: [],
      oauth: { resource: "https://gateway.example.org:10000/mcp" },
    });
    await mount({ connectOpen: true });
    const warned = [...host.querySelectorAll("button[data-agent]")]
      .filter((card) => card.querySelector(".access-agent-warning"))
      .map((card) => card.getAttribute("data-agent"));
    expect(warned).toEqual(["chatgpt"]);
    expect(host.querySelector("button[data-agent] .backend-opt-sub")).toBeNull();

    const chatgpt = host.querySelector<HTMLButtonElement>("button[data-agent='chatgpt']")!;
    await act(async () => { chatgpt.click(); });
    const notice = host.querySelector(".access-agent-public")!;
    expect(notice.classList.contains("is-warning")).toBe(true);
    expect(notice.textContent).toMatch(/This address uses port 10000\./u);
    expect(notice.textContent).toMatch(/only on the standard HTTPS port, 443/u);
    expect(host.querySelector(".access-agent-steps")?.textContent).not.toMatch(/developer mode/u);
  });

  test("mints an agent pairing code into the integration's commands", async () => {
    api.getAccessOverview.mockResolvedValue({
      principals: [],
      oauth: {
        resource: "https://gateway.example.org/mcp",
        resources: [
          { resource: "https://gateway.example.org/mcp", servedByGateway: false },
          { resource: "https://gateway.example.org:7600/mcp", servedByGateway: true },
        ],
        tlsFingerprintSha256: "ab".repeat(32),
      },
    });
    api.pairDevice.mockResolvedValue({ pairingCode: "K7Q2-M9XD", expiresAt: Date.now() + 600_000 });
    await mount({ connectOpen: true });
    const openclaw = host.querySelector<HTMLButtonElement>("button[data-agent='openclaw']")!;
    await act(async () => { openclaw.click(); });

    const command = () => host.querySelector(".access-agent-command code")?.textContent;
    const tabs = () => [...host.querySelectorAll<HTMLButtonElement>(".access-agent-tabs [role='tab']")];
    expect(tabs().map((tab) => tab.textContent?.trim())).toEqual(["Omnesis not installed", "Omnesis CLI installed"]);
    expect(host.querySelectorAll(".access-agent-command")).toHaveLength(1);
    expect(command()).toBe(
      `curl -fsSL https://omnesis.dev/install.sh | sh -s -- --openclaw --gateway-url https://gateway.example.org:7600 --trust-fingerprint sha256:${"ab".repeat(32)}`,
    );

    const create = [...host.querySelectorAll<HTMLButtonElement>(".access-agent-pair-action button")][0]!;
    await act(async () => { create.click(); });
    await act(async () => { await Promise.resolve(); });
    expect(api.pairDevice).toHaveBeenCalledWith({ kind: "agent" });
    expect(command()).toBe(
      `curl -fsSL https://omnesis.dev/install.sh | sh -s -- --openclaw --gateway-url https://gateway.example.org:7600 --code K7Q2-M9XD --trust-fingerprint sha256:${"ab".repeat(32)}`,
    );
    await act(async () => { tabs()[1]!.click(); });
    expect(tabs()[1]!.getAttribute("aria-selected")).toBe("true");
    expect(command()).toBe(
      `omnesis connect openclaw --gateway-url https://gateway.example.org:7600 --code K7Q2-M9XD --trust-fingerprint sha256:${"ab".repeat(32)}`,
    );

    const options = [...host.querySelectorAll("#access-agent-address option")].map((option) =>
      option.textContent?.replace(/\s+/gu, " ").trim(),
    );
    expect(options).toEqual([
      "https://gateway.example.org:7600 — direct to the gateway (recommended)",
      "https://gateway.example.org — public address through a proxy, for machines outside your network",
    ]);
    const address = host.querySelector<HTMLSelectElement>("#access-agent-address")!;
    // linkedom's <select>.value is read-only; select the option instead.
    await act(async () => {
      address.querySelectorAll("option")[1]!.setAttribute("selected", "");
      address.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
    expect(command()).toBe("omnesis connect openclaw --gateway-url https://gateway.example.org --code K7Q2-M9XD");
  });

  test("offers connecting an agent only when the Gateway has usable OAuth URLs", async () => {
    await mount();
    expect(connectButton()).toBeUndefined();

    api.getAccessOverview.mockResolvedValue({ principals: [], oauth: OAUTH });
    await act(async () => { render(null, host); });
    await mount();
    expect(host.textContent).not.toContain("OAuth is not available yet");
    expect(host.querySelector(".access-empty .btn-primary")?.textContent).toBe("Connect an agent");
    // The empty state carries the only Connect an agent button; the header does not repeat it.
    expect(headerConnectButton()).toBeUndefined();
    // The MCP resource lives in the dialog, not on the page.
    expect(host.querySelector(".access-mcp-resource")).toBeNull();
    const connect = connectButton()!;
    await act(async () => { connect.click(); });
    expect(host.querySelector(".access-connect-dialog .access-mcp-resource code")?.textContent).toBe(
      "https://gateway.example.org/mcp",
    );
    expect(host.querySelectorAll(".access-connect-step")).toHaveLength(2);
    expect(host.querySelectorAll(".access-connect-step h3")[1]?.textContent).toBe(
      "If the sign-in page shows a code, enter it here",
    );
    // Closing a dialog opened from the button leaves the route alone.
    const close = [...host.querySelectorAll("[role='dialog'] button")]
      .find((button) => button.textContent?.trim() === "Close") as HTMLButtonElement;
    await act(async () => { close.click(); });
    expect(host.querySelector(".access-connect-dialog")).toBeNull();
    expect(router.replaceRoute).not.toHaveBeenCalled();
  });

  describe("editing an access level", () => {
    function continueButton() {
      return [...host.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent === "Continue")!;
    }

    function capability(name: string): HTMLInputElement {
      return [...host.querySelectorAll<HTMLLabelElement>(".access-capability-preset")]
        .find((candidate) => candidate.querySelector("strong")?.textContent?.trim() === name)!
        .querySelector("input") as HTMLInputElement;
    }

    function saveButton() {
      return [...host.querySelectorAll<HTMLButtonElement>("button")]
        .find((candidate) => candidate.textContent?.startsWith("Save changes"))!;
    }

    test("changes every connection that uses the level, naming them before saving", async () => {
      api.getAccessOverview.mockResolvedValue(levelOverview);
      await mount({ levelId: "level-research" });
      expect(host.querySelector(".access-page-header h2")?.textContent).toBe("Edit fictional research");
      expect(document.activeElement).toBe(host.querySelector(".access-page-header h2"));

      await check(capability("Notes"));
      await act(async () => continueButton().click());
      await act(async () => continueButton().click());

      const impact = host.querySelector(".access-impact")!;
      expect(impact.querySelector("strong")?.textContent).toBe("2 connections affected");
      expect([...impact.querySelectorAll("li")].map((item) => item.textContent)).toEqual(["Fictional desktop", "Fictional laptop"]);
      expect(saveButton().textContent).toBe("Save changes for 2 connections");
      // The review names capabilities with the same pill the list uses.
      expect(host.querySelector(".grant-builder-summary .grant-review-row .access-badge-answer")).not.toBeNull();

      api.updateAccessLevel.mockResolvedValue({ level: {} });
      await act(async () => {
        saveButton().click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(api.updateAccessLevel).toHaveBeenCalledWith("level-research", {
        expectedRevision: 4,
        rules: [
          { capability: "answer", sources: { mode: "all", sourceIds: [] }, release: { mode: "reviewed", policyFamilyId: "policy-a" } },
          { capability: "notes", sources: { mode: "all", sourceIds: [] } },
        ],
      });
      expect(router.replaceRoute).toHaveBeenCalledWith("/portal/settings/access");
      await act(async () => { render(h(AccessView, {}), host); });
      expect(host.querySelector(".access-notice")?.textContent)
        .toBe("Access level updated. Its connections receive the new permissions when they refresh.");
    });

    test("saves plainly when one connection or none uses the level", async () => {
      api.getAccessOverview.mockResolvedValue(researchUsedBy("Fictional laptop"));
      await mount({ levelId: "level-research" });
      await act(async () => continueButton().click());
      await act(async () => continueButton().click());
      expect(host.querySelector(".access-impact strong")?.textContent).toBe("1 connection affected");
      expect(saveButton().textContent).toBe("Save changes");

      api.getAccessOverview.mockResolvedValue(levelOverview);
      await remount({ levelId: "level-notes" });
      await act(async () => continueButton().click());
      expect(host.querySelector(".access-impact strong")?.textContent).toBe("No connections use this access level yet");
      expect(host.querySelector(".access-impact li")).toBeNull();
      expect(saveButton().textContent).toBe("Save changes");
    });

    test("names the devices an edit reaches alongside the connections", async () => {
      api.getAccessOverview.mockResolvedValue({
        ...levelOverview,
        levels: levelOverview.levels.map((level) =>
          level.id === "level-research"
            ? { ...level, devices: [{ id: "device-voice", name: "Studio voice" }] }
            : level,
        ),
      });
      await mount({ levelId: "level-research" });
      await act(async () => continueButton().click());
      await act(async () => continueButton().click());
      const impact = host.querySelector(".access-impact")!;
      expect(impact.querySelector("strong")?.textContent).toBe("2 connections and 1 integration affected");
      expect([...impact.querySelectorAll("li")].map((item) => item.textContent)).toEqual([
        "Fictional desktop",
        "Fictional laptop",
        "Studio voice (integration)",
      ]);
      expect(impact.textContent).toContain("An integration's next question uses them.");
      expect(saveButton().textContent).toBe("Save changes for 2 connections and 1 integration");
    });

    test("says why a level devices use keeps its Answer", async () => {
      api.getAccessOverview.mockResolvedValue(levelOverview);
      await mount({ levelId: "level-research" });
      await act(async () => continueButton().click());
      await act(async () => continueButton().click());
      api.updateAccessLevel.mockRejectedValue(
        Object.assign(new Error("Conflict"), { status: 409, serverMessage: "level-in-use" }),
      );
      await act(async () => {
        saveButton().click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(host.textContent).toContain(
        "Integrations on this access level ask it for answers. Put them on another level before removing Answer.",
      );
    });

    test("will not continue past permissions with no capability selected", async () => {
      api.getAccessOverview.mockResolvedValue(levelOverview);
      await mount({ levelId: "level-notes" });
      expect(continueButton().disabled).toBe(false);
      await check(capability("Notes"), false);
      expect(continueButton().disabled).toBe(true);
      expect(host.textContent).toContain("Select at least one capability.");
    });

    test("reports a stale edit as unapplied and reloads the level's current permissions", async () => {
      api.getAccessOverview
        .mockResolvedValueOnce(levelOverview)
        .mockResolvedValue({
          ...levelOverview,
          levels: levelOverview.levels.map((level) => level.id === "level-research"
            ? { ...level, revision: 5, rules: [{ capability: "direct", sources: { mode: "all", sourceIds: [] } }] }
            : level),
        });
      api.updateAccessLevel.mockRejectedValue(Object.assign(new Error("stale"), { status: 409, serverMessage: "stale-revision" }));
      await mount({ levelId: "level-research" });
      await check(capability("Notes"));
      await act(async () => continueButton().click());
      await act(async () => continueButton().click());
      await act(async () => {
        saveButton().click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(api.updateAccessLevel).toHaveBeenCalledWith("level-research", expect.objectContaining({ expectedRevision: 4 }));
      expect(api.getAccessOverview.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(router.replaceRoute).toHaveBeenCalledWith("/portal/settings/access");
      await act(async () => { render(h(AccessView, {}), host); });
      expect(host.textContent).toContain("Your update was not applied");
      const head = levelGroup("fictional research").querySelector(".access-level-head")!;
      expect(head.querySelector(".access-badge-direct")?.getAttribute("class")).not.toContain("is-off");
      expect(head.querySelector(".access-badge-answer")?.getAttribute("class")).toContain("is-off");
    });

    test("says a level that is gone is no longer available", async () => {
      api.getAccessOverview.mockResolvedValue(levelOverview);
      await mount({ levelId: "level-gone" });
      expect(host.querySelector(".access-error")?.textContent).toBe("This access level is no longer available.");
    });

    test("says a level deleted while it was being edited is no longer available", async () => {
      api.getAccessOverview
        .mockResolvedValueOnce(levelOverview)
        .mockResolvedValue({ ...levelOverview, levels: [levelOverview.levels[1]] });
      api.updateAccessLevel.mockRejectedValue(Object.assign(new Error("gone"), { status: 404 }));
      await mount({ levelId: "level-research" });
      await act(async () => continueButton().click());
      await act(async () => continueButton().click());
      await act(async () => {
        saveButton().click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await act(async () => { await Promise.resolve(); });

      expect(api.getAccessOverview).toHaveBeenCalledTimes(2);
      expect(host.querySelector(".access-editor-page")).toBeNull();
      expect(host.querySelector(".access-error")?.textContent).toBe("This access level is no longer available.");
    });

    test("sends one save for a double click", async () => {
      api.getAccessOverview.mockResolvedValue(levelOverview);
      api.updateAccessLevel.mockReturnValue(new Promise(() => {}));
      await mount({ levelId: "level-research" });
      await act(async () => continueButton().click());
      await act(async () => continueButton().click());
      await act(async () => {
        saveButton().click();
        saveButton().click();
      });
      expect(api.updateAccessLevel).toHaveBeenCalledTimes(1);
    });
  });

  describe("creating an access level", () => {
    function continueButton() {
      return [...host.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent === "Continue")!;
    }

    function capability(name: string): HTMLInputElement {
      return [...host.querySelectorAll<HTMLLabelElement>(".access-capability-preset")]
        .find((candidate) => candidate.querySelector("strong")?.textContent?.trim() === name)!
        .querySelector("input") as HTMLInputElement;
    }

    test("asks for a name and permissions, then creates the level", async () => {
      api.getAccessOverview.mockResolvedValue(levelOverview);
      await mount({ newLevel: true });
      expect(host.querySelector(".access-page-header h2")?.textContent).toBe("New access level");
      const name = nameField("Access level name");
      // A fresh form does not open on a complaint.
      expect(host.querySelector(".access-level-name-form .access-field-error")).toBeNull();

      await check(capability("Answer"), false);
      await check(capability("Notes"));
      await act(async () => continueButton().click());
      const create = () => button("Create access level");
      expect(create().disabled).toBe(true);

      await typeInto(name, "Fictional");
      await typeInto(name, "");
      expect(host.querySelector(".access-level-name-form .access-field-error")?.textContent).toBe("Enter a name for this access level.");
      // A name a level already has is refused while it is typed.
      await typeInto(name, "FICTIONAL research ");
      expect(host.querySelector(".access-level-name-form .access-field-error")?.textContent).toBe(LEVEL_NAME_TAKEN);
      expect(create().disabled).toBe(true);
      await typeInto(name, " Fictional travel ");
      expect(create().disabled).toBe(false);

      api.createAccessLevel.mockRejectedValueOnce(Object.assign(new Error("taken"), { status: 409, serverMessage: "level-name-taken" }));
      await act(async () => {
        create().click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(api.createAccessLevel).toHaveBeenCalledWith({
        name: "Fictional travel",
        rules: [{ capability: "notes", sources: { mode: "all", sourceIds: [] } }],
      });
      expect(host.querySelector(".access-editor-page .access-error")?.textContent).toBe("An access level with that name already exists.");
      expect(router.replaceRoute).not.toHaveBeenCalled();

      api.createAccessLevel.mockResolvedValueOnce({ level: { id: "level-travel", name: "Fictional travel" } });
      await act(async () => {
        create().click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(router.replaceRoute).toHaveBeenCalledWith("/portal/settings/access");
      await act(async () => { render(h(AccessView, {}), host); });
      expect(host.querySelector(".access-notice")?.textContent).toBe("Access level “Fictional travel” created.");
    });

    test("names the level in its review, says so when the name is missing, and creates it once", async () => {
      api.getAccessOverview.mockResolvedValue(levelOverview);
      await mount({ newLevel: true });
      await check(capability("Answer"), false);
      await check(capability("Notes"));
      await act(async () => continueButton().click());

      const nameRow = () => [...host.querySelectorAll(".access-review-rows > div")]
        .find((row) => row.querySelector("dt")?.textContent === "Access level name")!;
      expect(nameRow().querySelector("dd")?.textContent).toBe("Enter a name for this access level.");
      // Leaving the first step is when the empty field starts saying so too.
      expect(host.querySelector(".access-level-name-form .access-field-error")?.textContent)
        .toBe("Enter a name for this access level.");
      await typeInto(nameField("Access level name"), " fictional travel ");
      expect(nameRow().querySelector("dd")?.textContent).toBe("fictional travel");

      api.createAccessLevel.mockReturnValue(new Promise(() => {}));
      await act(async () => {
        button("Create access level").click();
        button("Create access level").click();
      });
      expect(api.createAccessLevel).toHaveBeenCalledTimes(1);
    });
  });

  test("normalizes a short code and opens the matching request for review", async () => {
    const request = {
        id: "request-1",
        approvalId: "approval-1",
        status: "pending",
        clientId: "client-1",
        clientName: "example-agent",
        clientUri: "https://agent.example.com",
        redirectOrigin: "https://agent.example.com",
        expiresAt: Date.now() + 60_000,
        requiresAnswer: true,
      };
    api.lookupAccessAuthorization.mockResolvedValue({ request });
    api.getAccessAuthorization.mockResolvedValue(lookup(request));
    api.getAccessOverview.mockResolvedValue({ principals: [], oauth: OAUTH });
    await mount();
    await act(async () => { connectButton()!.click(); });

    const input = host.querySelector(".access-connect-dialog .access-code-input") as HTMLInputElement;
    await act(async () => {
      input.value = " abcd-efgh ";
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    const form = host.querySelector(".access-connect-dialog form") as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(api.lookupAccessAuthorization).toHaveBeenCalledWith("ABCD-EFGH");
    expect(router.navigate).toHaveBeenCalledWith(
      "/portal/settings/access/authorizations/approval-1",
    );
    await act(async () => {
      render(h(AccessView, { authorizationId: "approval-1" }), host);
      await Promise.resolve();
    });
    await act(async () => { await Promise.resolve(); });
    expect(host.textContent).toContain("example-agent");
    expect(host.querySelectorAll(".access-wizard-steps button")).toHaveLength(4);
    await act(async () => {
      [...host.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent === "Continue")!.click();
    });
    // This integration requires Answer, so it cannot be turned off: attempting
    // it leaves the profile intact and never reaches the empty-set refusal.
    const requiredAnswer = [...host.querySelectorAll<HTMLLabelElement>(".access-capability-preset")]
      .find((candidate) => candidate.querySelector("strong")?.textContent?.trim() === "Answer")!
      .querySelector("input") as HTMLInputElement;
    expect(requiredAnswer.getAttribute("aria-disabled")).toBe("true");
    await act(async () => {
      requiredAnswer.checked = false;
      requiredAnswer.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
    expect(host.textContent).not.toContain("Select at least one capability.");
    expect(host.textContent).toContain("Answer is required by this integration.");
    // Direct stays on offer beside a locked Answer.
    expect(
      [...host.querySelectorAll<HTMLLabelElement>(".access-capability-preset")].map(
        (label) => label.querySelector("strong")?.textContent,
      ),
    ).toEqual(["Answer", "Direct", "Notes"]);
    expect(host.textContent).not.toContain(request.clientId);
    expect(host.textContent).not.toContain(request.redirectOrigin);
    expect(host.querySelector(".access-request-facts")?.getAttribute("aria-label")).toBe(
      "Connection destinations",
    );
    // The destinations are metadata under the title, not a section of their
    // own, so they live inside the page header beside the client and expiry.
    expect(
      host.querySelector(".access-page-header .access-request-facts"),
    ).not.toBeNull();
    // "Choose access" already asks the question, so the picker's fieldset
    // label stays for assistive technology only.
    const legend = host.querySelector(".access-capability-presets legend")!;
    expect(legend.textContent).toBe("What should this connection be allowed to do?");
    expect(legend.getAttribute("class")).toBe("sr-only");

    expect(host.querySelector(".access-authorization-page")).not.toBeNull();
    expect(host.querySelector(".access-connect-dialog")).toBeNull();
    const back = host.querySelector(".access-page-back") as HTMLButtonElement;
    await act(async () => { back.click(); });
    expect(router.replaceRoute).toHaveBeenCalledWith("/portal/settings/access");
    expect(api.decideAccessAuthorization).not.toHaveBeenCalled();
  });

  test("returns an in-window OAuth approval to the connecting client", async () => {
    const request = {
      id: "request-oauth",
      approvalId: "approval-oauth",
      status: "pending",
      clientId: "client-oauth",
      clientName: "Fictional desktop agent",
      clientUri: "https://agent.example.com",
      redirectOrigin: "http://127.0.0.1:59927",
      expiresAt: Date.now() + 60_000,
      requiresAnswer: false,
    };
    const completeAuthorization = vi.fn();
    api.getAccessAuthorization.mockResolvedValue(lookup(request));
    api.decideAccessAuthorization.mockResolvedValue({ request: { ...request, status: "denied" } });

    await act(async () => {
      render(h(AccessView, {
        authorizationId: "approval-oauth",
        completeInPortal: true,
        completeAuthorization,
      }), host);
      await Promise.resolve();
    });
    await act(async () => { await Promise.resolve(); });
    const deny = host.querySelector<HTMLButtonElement>(".access-request-actions .danger")!;
    await act(async () => {
      deny.click();
      await Promise.resolve();
    });

    expect(api.decideAccessAuthorization).toHaveBeenCalledWith("approval-oauth", {
      decision: "deny",
    });
    expect(completeAuthorization).toHaveBeenCalledWith("approval-oauth");
    expect(router.replaceRoute).not.toHaveBeenCalled();
  });

  test("completes a browser authorization approved from another surface", async () => {
    const request = {
      id: "request-approved-elsewhere",
      approvalId: "approval-approved-elsewhere",
      status: "approved",
      clientId: "client-approved-elsewhere",
      clientName: "Fictional desktop agent",
      clientUri: null,
      redirectOrigin: "http://127.0.0.1:59927",
      resource: "https://gateway.example.org/mcp",
      expiresAt: Date.now() + 60_000,
      requiresAnswer: false,
    };
    // The browser leaves for the client's callback before this settles.
    const completeAuthorization = vi.fn().mockReturnValue(new Promise(() => {}));
    api.getAccessAuthorization.mockResolvedValue(lookup(request));

    await act(async () => {
      render(h(AccessView, {
        authorizationId: request.approvalId,
        completeInPortal: true,
        completeAuthorization,
      }), host);
      await Promise.resolve();
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    expect(completeAuthorization).toHaveBeenCalledWith(request.approvalId);
    expect(router.replaceRoute).not.toHaveBeenCalled();
    // Waiting on the redirect is not the request having gone missing.
    expect(host.querySelector(".access-error")).toBeNull();
    expect(host.querySelector(".access-detail-state [role='status']")?.textContent).toBe("Returning to the MCP client…");
  });

  test("reports a terminal connection as completed rather than expired", async () => {
    const request = {
      id: "request-complete",
      approvalId: "approval-complete",
      status: "complete",
      clientId: "client-complete",
      clientName: "Fictional desktop agent",
      clientUri: null,
      redirectOrigin: "http://127.0.0.1:59927",
      resource: "https://gateway.example.org/mcp",
      expiresAt: Date.now() - 60_000,
      requiresAnswer: false,
    };
    api.getAccessAuthorization.mockResolvedValue(lookup(request));

    await act(async () => {
      render(h(AccessView, { authorizationId: request.approvalId }), host);
      await Promise.resolve();
    });
    await act(async () => { await Promise.resolve(); });

    await act(async () => { render(h(AccessView, {}), host); });

    expect(host.textContent).toContain("This connection was already completed.");
    expect(host.textContent).not.toContain("This authorization request expired.");
    expect(router.replaceRoute).toHaveBeenCalledWith("/portal/settings/access");
  });

  test("does not advance past data selection with an empty source boundary", async () => {
    const request = {
      id: "request-empty-sources",
      approvalId: "approval-empty-sources",
      status: "pending",
      clientId: "client-empty-sources",
      clientName: "Fictional desktop agent",
      clientUri: "https://agent.example.com",
      redirectOrigin: "http://127.0.0.1:59927",
      expiresAt: Date.now() + 60_000,
      requiresAnswer: false,
    };
    api.getAccessOverview.mockResolvedValue({
      principals: [],
      policyFamilies: [{
        id: "00000000-0000-4000-8000-000000000002",
        name: "Example policy",
        revision: "policy-revision-1",
      }],
      defaultPolicyFamilyId: "00000000-0000-4000-8000-000000000002",
      sources: [{ id: "fictional-code:work", name: "Fictional code workspace" }],
      oauth: null,
    });
    api.getAccessAuthorization.mockResolvedValue(lookup(request));

    await act(async () => {
      render(h(AccessView, { authorizationId: request.approvalId }), host);
      await Promise.resolve();
    });
    await act(async () => { await Promise.resolve(); });
    const continueButton = () => [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Continue")!;
    await act(async () => continueButton().click());
    await act(async () => continueButton().click());
    const currentStep = host.querySelector(".access-wizard-steps [aria-current='step']");
    const stepHeading = host.querySelector(".access-wizard-copy h3");
    expect(currentStep?.textContent).toContain("Data & privacy");
    expect(stepHeading?.textContent).toBe("Choose data and privacy");
    expect((stepHeading as HTMLElement | null)?.tabIndex).toBe(-1);
    expect(continueButton().disabled).toBe(true);

    const source = host.querySelector<HTMLInputElement>("[aria-label='answer source selection'] input")!;
    await act(async () => {
      source.checked = true;
      source.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
    expect(continueButton().disabled).toBe(false);
  });

  describe("approving a connection onto an access level", () => {
    function pendingRequest(overrides: Record<string, unknown> = {}) {
      return {
        id: "request-levels",
        approvalId: "approval-levels",
        status: "pending",
        clientId: "client-levels",
        clientName: "Fictional desktop app",
        clientUri: "https://agent.example.org",
        redirectOrigin: "https://agent.example.org/callback",
        resource: "https://gateway.example.org/mcp",
        expiresAt: Date.now() + 60_000,
        requiresAnswer: false,
        ...overrides,
      };
    }

    const laptopGrant = levelOverview.principals[0].grants[0];

    function proposal(overrides: Record<string, unknown> = {}) {
      return {
        defaultName: "Fictional desktop app 2",
        defaultLevelName: "Fictional desktop app",
        match: null,
        recommended: "new-level",
        ...overrides,
      };
    }

    const laptopMatch = (overrides: Record<string, unknown> = {}) => ({
      connectionId: "principal-laptop",
      connectionName: "Fictional laptop",
      matchedBy: "client",
      levelId: "level-research",
      grant: laptopGrant,
      ...overrides,
    });

    async function openReview(connection: unknown, overview: unknown = levelOverview, request = pendingRequest()) {
      api.getAccessOverview.mockResolvedValue(overview);
      api.getAccessAuthorization.mockResolvedValue({ request, reconnect: null, connection });
      await remount({ authorizationId: request.approvalId });
      return request;
    }

    const chips = () => [...host.querySelectorAll(".access-wizard-steps button")]
      .map((chip) => chip.textContent?.replace(/^[\d✓]/u, ""));
    const currentStep = () => host.querySelector(".access-wizard-steps button[aria-current='step']")?.textContent?.replace(/^[\d✓]/u, "");
    const continueButton = () => [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((candidate) => candidate.textContent === "Continue")!;
    const allowButton = () => host.querySelector<HTMLButtonElement>(".access-request-actions .access-wizard-nav .btn-primary")!;
    const reviewRows = () => Object.fromEntries(
      [...host.querySelectorAll(".access-review-rows > div")].map((row) => [
        row.querySelector("dt")?.textContent,
        row.querySelector("dd")?.textContent,
      ]),
    );
    const checkedCapabilities = () => [...host.querySelectorAll<HTMLLabelElement>(".access-capability-preset")]
      .filter((label) => label.querySelector("input")?.hasAttribute("checked"))
      .map((label) => label.querySelector("strong")?.textContent);
    const levelOrder = () => [...host.querySelectorAll(".access-choice-option strong")]
      .map((node) => node.firstChild?.textContent?.trim());

    async function allow() {
      await act(async () => {
        allowButton().dispatchEvent(new window.Event("click", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await act(async () => { await Promise.resolve(); });
    }

    test("opens on a new access level named for the app, with permissions from the connection it found", async () => {
      const request = await openReview(proposal({
        recommended: "new-level",
        match: laptopMatch({
          grant: { ...laptopGrant, rules: [reviewedAnswer(), NOTES_RULE] },
        }),
      }));

      expect(chips()).toEqual(["Connection", "Permissions", "Data & privacy", "Review"]);
      expect(currentStep()).toBe("Connection");
      expect(host.querySelector(".access-wizard-copy h3")?.textContent).toBe("Name the connection");
      expect(host.querySelector(".access-wizard-copy p")?.textContent).toBe("Name this connection and choose the access level it uses.");
      expect(nameField("Connection name").value).toBe("Fictional desktop app 2");
      expect(host.querySelector(".access-choice-legend")?.textContent).toBe("Access level");
      expect(host.querySelector(".access-choice-helper")?.textContent).toBe("Connections that use the same access level share its permissions.");

      // The level the found connection uses is suggested and listed first, whatever was recommended.
      expect(levelOrder()).toEqual(["fictional research", "Fictional notes", "New access level"]);
      const suggested = choice("fictional research").closest(".access-choice-option")!;
      expect(suggested.querySelector(".access-suggested-tag")?.textContent).toBe("Suggested");
      expect(suggested.textContent).toContain("Fictional laptop uses this access level.");
      expect(suggested.textContent).toContain("2 connections");
      expect(choice("fictional research").hasAttribute("checked")).toBe(false);
      expect(choice("New access level").hasAttribute("checked")).toBe(true);
      expect(nameField("Access level name").value).toBe("Fictional desktop app");
      expect(host.textContent).toContain("Signing in again? Replace a connection");

      await act(async () => continueButton().click());
      expect(checkedCapabilities()).toEqual(["Answer", "Notes"]);
      await act(async () => continueButton().click());
      await act(async () => continueButton().click());
      expect(reviewRows()).toEqual({
        Connection: "Fictional desktop app 2",
        "Access level": "Fictional desktop app (new)",
        Permissions: expect.any(String),
        "Answer sources": "All sources",
        "Answer privacy": "Household",
        Notes: "Save notes; the agent's name is recorded",
      });
      expect(host.querySelector(".access-review-note")).toBeNull();
      expect(allowButton().textContent).toMatch(/^allow answer \+ notes$/i);

      api.decideAccessAuthorization.mockResolvedValue({ request: { ...request, status: "approved" } });
      await allow();
      expect(api.decideAccessAuthorization).toHaveBeenCalledWith(request.approvalId, {
        decision: "approve",
        selection: {
          kind: "new-connection",
          name: "Fictional desktop app 2",
          level: {
            kind: "new",
            name: "Fictional desktop app",
            rules: [
              { capability: "answer", sources: { mode: "all", sourceIds: [] }, release: { mode: "reviewed", policyFamilyId: "policy-a" } },
              { capability: "notes", sources: { mode: "all", sourceIds: [] } },
            ],
          },
        },
      });
    });

    test("requires both names, caps them at 120 characters, and cuts a longer prefill", async () => {
      await openReview(proposal({ defaultName: "x".repeat(130) }));
      const connectionName = nameField("Connection name");
      expect(connectionName.value).toHaveLength(120);
      expect(connectionName.getAttribute("maxlength")).toBe("120");
      expect(continueButton().disabled).toBe(false);

      await typeInto(connectionName, "   ");
      expect(host.querySelector(".access-connection-step .access-field-error")?.textContent).toBe("Enter a name for this connection.");
      expect(connectionName.getAttribute("aria-invalid")).toBe("true");
      expect(continueButton().disabled).toBe(true);
      await typeInto(connectionName, "Fictional desktop app");
      expect(continueButton().disabled).toBe(false);

      const levelName = nameField("Access level name");
      expect(levelName.getAttribute("maxlength")).toBe("120");
      await typeInto(levelName, "");
      expect(host.querySelector(".access-connection-step .access-field-error")?.textContent).toBe("Enter a name for this access level.");
      expect(continueButton().disabled).toBe(true);
    });

    test("joins an existing level straight to review, saying who else uses it", async () => {
      const request = await openReview(proposal({ recommended: "existing-level", match: laptopMatch() }));
      expect(choice("fictional research").hasAttribute("checked")).toBe(true);
      expect(nameField("Access level name")).toBeUndefined();
      expect(chips()).toEqual(["Connection", "Review"]);

      await act(async () => continueButton().click());
      expect(currentStep()).toBe("Review");
      const rows = reviewRows();
      expect(rows.Connection).toBe("Fictional desktop app 2");
      expect(rows["Access level"]).toBe("fictional research");
      expect(rows.Replaces).toBeUndefined();
      expect(rows["Answer privacy"]).toBe("Household");
      expect(host.querySelector(".access-review-note")?.textContent)
        .toBe("Also used by 2 other connections. Changing this access level later changes all of them.");

      api.decideAccessAuthorization.mockResolvedValue({ request: { ...request, status: "approved" } });
      await allow();
      expect(api.decideAccessAuthorization).toHaveBeenCalledWith(request.approvalId, {
        decision: "approve",
        selection: {
          kind: "new-connection",
          name: "Fictional desktop app 2",
          level: { kind: "existing", levelId: "level-research", expectedLevelRevision: 4 },
        },
      });

      // Choosing another level from the list works the same way; one other connection is singular.
      vi.clearAllMocks();
      await openReview(proposal(), {
        ...levelOverview,
        levels: levelOverview.levels.map((level) => level.id === "level-notes" ? { ...level, connectionCount: 1 } : level),
      });
      await check(choice("Fictional notes"));
      expect(chips()).toEqual(["Connection", "Review"]);
      await act(async () => continueButton().click());
      expect(host.querySelector(".access-review-note")?.textContent)
        .toBe("Also used by 1 other connection. Changing this access level later changes all of them.");
    });

    test("keeps an agent that needs Answer off a level without it", async () => {
      await openReview(
        proposal({ recommended: "existing-level", match: laptopMatch({ levelId: "level-notes" }) }),
        levelOverview,
        pendingRequest({ requiresAnswer: true }),
      );
      const notes = choice("Fictional notes");
      expect(notes.hasAttribute("disabled")).toBe(true);
      const option = notes.closest(".access-choice-option")!;
      expect(option.textContent).toContain("This agent needs Answer.");
      // Still suggested, never preselected.
      expect(option.querySelector(".access-suggested-tag")).not.toBeNull();
      expect(notes.hasAttribute("checked")).toBe(false);
      expect(choice("New access level").hasAttribute("checked")).toBe(true);
      expect(choice("fictional research").hasAttribute("disabled")).toBe(false);
    });

    test("replaces the connection an agent already has on this device", async () => {
      const request = await openReview(proposal({
        recommended: "replace",
        match: laptopMatch({ matchedBy: "device" }),
      }));

      // One heading and one explanation, then the choices.
      expect(host.querySelector(".access-wizard-copy h3")?.textContent).toBe("Replace a connection");
      expect([...host.querySelectorAll(".access-wizard-copy p")].map((node) => node.textContent))
        .toEqual(["The new sign-in takes over the chosen connection's name and access level. Its old sign-in stops working."]);
      expect(host.querySelector(".access-choice-legend")).toBeNull();
      expect(host.querySelector(".access-choice-helper")).toBeNull();
      expect(host.textContent).not.toContain("Choose the connection to replace");
      expect(nameField("Connection name")).toBeUndefined();
      // Most recently used first.
      expect(levelOrder()).toEqual(["Fictional laptop", "Fictional desktop"]);
      // The suggestion lives in the card of the connection it describes.
      const cardLines = (name: string) => [...choice(name).closest(".access-choice-option")!.querySelectorAll(".access-choice-text small")]
        .map((node) => node.textContent);
      const laptop = () => choice("Fictional laptop").closest(".access-choice-option")!;
      expect(laptop().querySelector(".access-suggested-tag")?.textContent).toBe("Suggested");
      expect(cardLines("Fictional laptop"))
        .toEqual(["Uses fictional research", `Last used ${timeAgo(1_757_000_000_000)}`, "Already connected on this device."]);
      expect(cardLines("Fictional desktop")).toEqual(["Uses fictional research", "Never used"]);
      expect(host.querySelectorAll(".access-suggestion")).toHaveLength(1);
      expect(host.textContent).not.toContain("already connected as");
      expect(choice("Fictional laptop").hasAttribute("checked")).toBe(true);
      expect(chips()).toEqual(["Connection", "Review"]);

      // It describes that connection, whichever one is picked.
      await check(choice("Fictional desktop"));
      expect(laptop().querySelector(".access-suggestion")?.textContent).toBe("Already connected on this device.");
      await check(choice("Fictional laptop"));

      await act(async () => continueButton().click());
      const rows = reviewRows();
      expect(rows.Connection).toBe("Fictional laptop");
      expect(rows["Access level"]).toBe("fictional research");
      expect(rows.Replaces).toBe("The current sign-in of Fictional laptop");
      // The replaced connection is not another user of its own level.
      expect(host.querySelector(".access-review-note")?.textContent)
        .toBe("Also used by 1 other connection. Changing this access level later changes all of them.");

      api.decideAccessAuthorization.mockResolvedValue({ request: { ...request, status: "approved" } });
      await allow();
      expect(api.decideAccessAuthorization).toHaveBeenCalledWith(request.approvalId, {
        decision: "approve",
        selection: { kind: "replace-connection", connectionId: "principal-laptop", expectedGrantRevision: 3 },
      });
    });

    test("moves between a new connection and a replacement, and hides replacing when nothing is connected", async () => {
      await openReview(proposal({ recommended: "replace", match: laptopMatch({ matchedBy: "device" }) }));
      await act(async () => { button("Connect as a new connection instead").click(); });
      expect(nameField("Connection name").value).toBe("Fictional desktop app 2");
      // A replacement recommendation says nothing about which level to use.
      expect(choice("New access level").hasAttribute("checked")).toBe(true);
      expect(document.activeElement).toBe(nameField("Connection name"));
      await act(async () => { button("Signing in again? Replace a connection").click(); });
      expect(host.querySelector(".access-wizard-copy h3")?.textContent).toBe("Replace a connection");

      vi.clearAllMocks();
      await openReview(proposal(), { ...levelOverview, principals: [] });
      expect(host.textContent).not.toContain("Signing in again? Replace a connection");
    });

    test("opens on a new level with no note when the connection to replace is gone", async () => {
      await openReview(proposal({
        recommended: "replace",
        match: laptopMatch({ connectionId: "principal-gone", matchedBy: "device" }),
      }));
      expect(host.querySelector(".access-choice-legend")?.textContent).toBe("Access level");
      expect(choice("New access level").hasAttribute("checked")).toBe(true);
      expect(host.querySelector(".access-suggestion")).toBeNull();
      expect(host.textContent).not.toContain("already connected as");
    });

    test("refuses a level name another level has while it is typed, and stays on the Connection step when the gateway refuses one", async () => {
      await openReview(proposal({ recommended: "existing-level", match: laptopMatch() }));
      // The connection name's label sits beside its field.
      expect(nameField("Connection name").closest(".access-name-field")?.getAttribute("class")).toContain("is-inline");
      await check(choice("New access level"));
      // The new level's name sits inside its own card.
      const card = () => choice("New access level").closest(".access-choice-option")!;
      expect(card().querySelector(".access-name-field.is-inline input")).toBe(nameField("Access level name"));

      await typeInto(nameField("Access level name"), " FICTIONAL research ");
      expect(card().querySelector(".access-field-error")?.textContent).toBe(LEVEL_NAME_TAKEN);
      expect(nameField("Access level name").getAttribute("aria-invalid")).toBe("true");
      expect(continueButton().disabled).toBe(true);
      await typeInto(nameField("Access level name"), "fictional archive");
      expect(card().querySelector(".access-field-error")).toBeNull();
      expect(continueButton().disabled).toBe(false);

      // A level created elsewhere meanwhile is the gateway's to refuse.
      await act(async () => continueButton().click());
      await act(async () => continueButton().click());
      await act(async () => continueButton().click());
      api.decideAccessAuthorization.mockRejectedValue(Object.assign(new Error("taken"), { status: 409, serverMessage: "level-name-taken" }));
      await allow();

      expect(currentStep()).toBe("Connection");
      expect(host.querySelector(".access-authorization-page .access-error")?.textContent)
        .toBe("An access level with that name already exists.");
      expect(api.getAccessAuthorization).toHaveBeenCalledTimes(1);
      expect(nameField("Access level name").value).toBe("fictional archive");

      // Typing another name is the fix, so the refusal goes as soon as the owner does.
      await typeInto(nameField("Access level name"), "fictional archive 2");
      expect(host.querySelector(".access-authorization-page .access-error")).toBeNull();
    });

    test("reloads the request and returns to the Connection step when the choices moved", async () => {
      const request = pendingRequest();
      api.getAccessOverview.mockResolvedValue(levelOverview);
      api.getAccessAuthorization
        .mockResolvedValueOnce({ request, reconnect: null, connection: proposal({ recommended: "existing-level", match: laptopMatch() }) })
        .mockResolvedValue({ request, reconnect: null, connection: proposal({ defaultName: "Fictional desktop app 3" }) });
      api.decideAccessAuthorization.mockRejectedValue(Object.assign(new Error("stale"), { status: 409, serverMessage: "stale-revision" }));
      await mount({ authorizationId: request.approvalId });
      await act(async () => continueButton().click());
      await allow();

      expect(api.getAccessAuthorization).toHaveBeenCalledTimes(2);
      expect(currentStep()).toBe("Connection");
      expect(host.querySelector(".access-authorization-page .access-error")?.textContent)
        .toBe("Access choices changed. Review the refreshed request.");
      expect(nameField("Connection name").value).toBe("Fictional desktop app 3");
      expect(choice("New access level").hasAttribute("checked")).toBe(true);
      expect(router.replaceRoute).not.toHaveBeenCalled();
    });

    test("keeps the names the owner typed when the refreshed choice walks the same path, and resets permissions", async () => {
      const request = pendingRequest();
      api.getAccessOverview.mockResolvedValue(levelOverview);
      api.getAccessAuthorization
        .mockResolvedValueOnce({ request, reconnect: null, connection: proposal({ match: laptopMatch() }) })
        .mockResolvedValue({ request, reconnect: null, connection: proposal({ defaultName: "Fictional desktop app 3" }) });
      api.decideAccessAuthorization.mockRejectedValue(Object.assign(new Error("invalid"), { status: 409, serverMessage: "invalid-selection" }));
      await mount({ authorizationId: request.approvalId });
      await typeInto(nameField("Connection name"), "studio desktop");
      await typeInto(nameField("Access level name"), "studio reads");
      await act(async () => continueButton().click());
      expect(checkedCapabilities()).toEqual(["Answer"]);
      await check([...host.querySelectorAll<HTMLLabelElement>(".access-capability-preset")]
        .find((label) => label.querySelector("strong")?.textContent?.trim() === "Notes")!
        .querySelector("input") as HTMLInputElement);
      await act(async () => continueButton().click());
      await act(async () => continueButton().click());
      expect(reviewRows().Notes).toBe("Save notes; the agent's name is recorded");
      await allow();

      expect(api.getAccessAuthorization).toHaveBeenCalledTimes(2);
      expect(currentStep()).toBe("Connection");
      expect(host.querySelector(".access-authorization-page .access-error")?.textContent)
        .toBe("Access choices changed. Review the refreshed request.");
      expect(nameField("Connection name").value).toBe("studio desktop");
      expect(nameField("Access level name").value).toBe("studio reads");
      // Permissions start again from the refreshed proposal, which found no connection to copy.
      await act(async () => continueButton().click());
      expect(checkedCapabilities()).toEqual(["Answer"]);
    });

    test("says so and hands the controls back when the refreshed request cannot be read", async () => {
      const request = pendingRequest();
      api.getAccessOverview.mockResolvedValue(levelOverview);
      api.getAccessAuthorization
        .mockResolvedValueOnce({ request, reconnect: null, connection: proposal({ recommended: "existing-level", match: laptopMatch() }) })
        .mockRejectedValue(new Error("offline"));
      api.decideAccessAuthorization.mockRejectedValue(Object.assign(new Error("stale"), { status: 409, serverMessage: "stale-revision" }));
      await mount({ authorizationId: request.approvalId });
      await act(async () => continueButton().click());
      await allow();

      expect(host.querySelector(".access-authorization-page .access-error")?.textContent)
        .toBe("The authorization request could not be reloaded.");
      expect(allowButton().disabled).toBe(false);
      expect(button("Deny request").disabled).toBe(false);
      expect(router.replaceRoute).not.toHaveBeenCalled();
    });

    test("sends one decision for a double click", async () => {
      const request = await openReview(proposal({ recommended: "existing-level", match: laptopMatch() }));
      await act(async () => continueButton().click());
      api.decideAccessAuthorization.mockReturnValue(new Promise(() => {}));
      await act(async () => {
        allowButton().dispatchEvent(new window.Event("click", { bubbles: true }));
        allowButton().dispatchEvent(new window.Event("click", { bubbles: true }));
      });
      expect(api.decideAccessAuthorization).toHaveBeenCalledTimes(1);
      expect(api.decideAccessAuthorization).toHaveBeenCalledWith(request.approvalId, expect.objectContaining({ decision: "approve" }));
    });

    test("never shows an error between a successful approval and the list", async () => {
      const request = await openReview(proposal({ recommended: "existing-level", match: laptopMatch() }));
      await act(async () => continueButton().click());
      api.decideAccessAuthorization.mockResolvedValue({ request: { ...request, status: "approved" } });
      // The list's re-read is slow: the page must not fill the wait with an error.
      api.getAccessOverview.mockReturnValue(new Promise(() => {}));
      await allow();

      expect(router.replaceRoute).toHaveBeenCalledWith("/portal/settings/access");
      expect(router.replaceRoute.mock.invocationCallOrder[0]).toBeLessThan(api.getAccessOverview.mock.invocationCallOrder[1]);
      expect(host.querySelector(".access-error")).toBeNull();
      // The review stays, disabled, until the route moves on.
      expect(host.querySelector(".access-authorization-page")).not.toBeNull();
      expect(button("Deny request").disabled).toBe(true);

      await act(async () => { render(h(AccessView, {}), host); });
      expect(host.querySelector(".access-error")).toBeNull();
      expect(host.querySelector(".access-notice")?.textContent).toBe("Access approved. The MCP client can finish connecting.");
    });

    test("never shows an error while an in-window approval hands the request back to its client", async () => {
      const request = pendingRequest();
      api.getAccessOverview.mockResolvedValue(levelOverview);
      api.getAccessAuthorization.mockResolvedValue({
        request, reconnect: null, connection: proposal({ recommended: "existing-level", match: laptopMatch() }),
      });
      // The browser leaves for the client's callback before this settles.
      const completeAuthorization = vi.fn().mockReturnValue(new Promise(() => {}));
      await remount({ authorizationId: request.approvalId, completeInPortal: true, completeAuthorization });
      await act(async () => continueButton().click());
      api.decideAccessAuthorization.mockResolvedValue({ request: { ...request, status: "approved" } });
      await allow();

      expect(completeAuthorization).toHaveBeenCalledWith(request.approvalId);
      expect(host.querySelector(".access-error")).toBeNull();
      expect(host.querySelector(".access-detail-state [role='status']")?.textContent).toBe("Returning to the MCP client…");
      expect(router.replaceRoute).not.toHaveBeenCalled();
    });

    test("opens a replacement an agent needing Answer cannot use as a new connection on a new level", async () => {
      await openReview(
        proposal({ recommended: "replace", match: laptopMatch({ matchedBy: "device" }) }),
        {
          ...levelOverview,
          principals: [
            connectionOf("principal-laptop", "Fictional laptop", "level-notes", [NOTES_RULE], [signIn("cred-laptop", "Fictional laptop")]),
            levelOverview.principals[1],
          ],
        },
        pendingRequest({ requiresAnswer: true }),
      );
      expect(host.querySelector(".access-wizard-copy h3")?.textContent).toBe("Name the connection");
      expect(host.querySelector(".access-choice-legend")?.textContent).toBe("Access level");
      expect(choice("New access level").hasAttribute("checked")).toBe(true);
      expect(host.querySelector(".access-suggestion")).toBeNull();

      // Replacing it is still suggested, never preselected, the way a level is.
      await act(async () => { button("Signing in again? Replace a connection").click(); });
      expect(choice("Fictional laptop").hasAttribute("disabled")).toBe(true);
      expect(choice("Fictional laptop").hasAttribute("checked")).toBe(false);
      const laptop = choice("Fictional laptop").closest(".access-choice-option")!;
      expect(laptop.textContent).toContain("This agent needs Answer.");
      expect(laptop.querySelector(".access-suggested-tag")).not.toBeNull();
      expect(laptop.querySelector(".access-suggestion")?.textContent).toBe("Already connected on this device.");
    });

    test("says a lookup without a proposal cannot be reviewed, and offers no decision", async () => {
      api.getAccessOverview.mockResolvedValue(levelOverview);
      api.getAccessAuthorization.mockResolvedValue({ request: pendingRequest(), reconnect: null });
      await remount({ authorizationId: "approval-levels" });
      expect(host.querySelector(".access-error")?.textContent).toBe("This approval could not be loaded. Reload the page.");
      expect(host.querySelector(".access-authorization-page")).toBeNull();
      expect(button("Deny request")).toBeUndefined();
    });
  });

  test("leaves execution-bound OAuth completion to the connecting client", async () => {
    const request = {
      id: "request-execution",
      approvalId: "approval-execution",
      status: "pending",
      clientId: "client-execution",
      clientName: "Fictional agent integration",
      clientUri: "https://agent.example.com",
      redirectOrigin: "http://127.0.0.1:59927",
      expiresAt: Date.now() + 60_000,
      requiresAnswer: true,
    };
    const completeAuthorization = vi.fn();
    api.getAccessAuthorization.mockResolvedValue(lookup(request));
    api.decideAccessAuthorization.mockResolvedValue({ request: { ...request, status: "denied" } });

    await act(async () => {
      render(h(AccessView, {
        authorizationId: request.approvalId,
        completeInPortal: true,
        completeAuthorization,
      }), host);
      await Promise.resolve();
    });
    await act(async () => { await Promise.resolve(); });
    const deny = host.querySelector<HTMLButtonElement>(".access-request-actions .danger")!;
    await act(async () => {
      deny.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(completeAuthorization).not.toHaveBeenCalled();
    expect(router.replaceRoute).toHaveBeenCalledWith("/portal/settings/access");
  });

  test("leaves code-entered OAuth completion to the original authorization page", async () => {
    const request = {
      id: "request-code",
      approvalId: "approval-code",
      status: "pending",
      clientId: "client-code",
      clientName: "Fictional desktop agent",
      clientUri: "https://agent.example.com",
      redirectOrigin: "http://127.0.0.1:59927",
      expiresAt: Date.now() + 60_000,
      requiresAnswer: false,
    };
    const completeAuthorization = vi.fn();
    api.getAccessAuthorization.mockResolvedValue(lookup(request));
    api.decideAccessAuthorization.mockResolvedValue({ request: { ...request, status: "denied" } });

    await act(async () => {
      render(h(AccessView, {
        authorizationId: request.approvalId,
        completeAuthorization,
      }), host);
      await Promise.resolve();
    });
    await act(async () => { await Promise.resolve(); });
    const deny = host.querySelector<HTMLButtonElement>(".access-request-actions .danger")!;
    await act(async () => {
      deny.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(completeAuthorization).not.toHaveBeenCalled();
    expect(router.replaceRoute).toHaveBeenCalledWith("/portal/settings/access");
  });

  test("never renders a prior authorization after the route changes", async () => {
    let resolveSecond!: (value: unknown) => void;
    const second = new Promise((resolve) => { resolveSecond = resolve; });
    const request = (approvalId: string, clientName: string) => ({
      id: `request-${approvalId}`,
      approvalId,
      status: "pending",
      clientId: `client-${approvalId}`,
      clientName,
      clientUri: "https://agent.example.com",
      redirectOrigin: "https://agent.example.com",
      expiresAt: Date.now() + 60_000,
      requiresAnswer: false,
    });
    api.getAccessAuthorization.mockImplementation((approvalId: string) =>
      approvalId === "approval-a"
        ? Promise.resolve(lookup(request("approval-a", "First agent")))
        : second,
    );

    await act(async () => {
      render(h(AccessView, { authorizationId: "approval-a" }), host);
      await Promise.resolve();
    });
    await act(async () => { await Promise.resolve(); });
    expect(host.textContent).toContain("First agent");

    await act(async () => {
      render(h(AccessView, { authorizationId: "approval-b" }), host);
    });
    expect(host.textContent).not.toContain("First agent");
    expect(host.textContent).not.toContain("Allow access");

    await act(async () => {
      resolveSecond(lookup(request("approval-b", "Second agent")));
      await Promise.resolve();
    });
    await act(async () => { await Promise.resolve(); });
    expect(host.textContent).toContain("Second agent");
    expect(host.textContent).not.toContain("First agent");
  });

  test("does not expose approval controls when the access overview fails", async () => {
    const request = {
      id: "request-overview-failure",
      approvalId: "approval-overview-failure",
      status: "pending",
      clientId: "client-overview-failure",
      clientName: "Fictional agent",
      clientUri: "https://agent.example.com",
      redirectOrigin: "https://agent.example.com",
      expiresAt: Date.now() + 60_000,
      requiresAnswer: false,
    };
    api.getAccessOverview.mockRejectedValue(new Error("offline"));
    api.getAccessAuthorization.mockResolvedValue(lookup(request));

    await act(async () => {
      render(h(AccessView, { authorizationId: request.approvalId }), host);
      await Promise.resolve();
    });
    await act(async () => { await Promise.resolve(); });

    expect(host.textContent).toContain("Agent access could not be loaded");
    expect(host.textContent).not.toContain("Allow access");
    expect(host.textContent).not.toContain("Deny");
  });

  test("closes a request that was already decided on another approval surface", async () => {
    const request = {
        id: "request-raced",
        approvalId: "approval-raced",
        status: "pending",
        clientId: "client-raced",
        clientName: "Fictional desktop agent",
        clientUri: "https://agent.example.com",
        redirectOrigin: "https://agent.example.com",
        expiresAt: Date.now() + 60_000,
        requiresAnswer: true,
      };
    api.getAccessAuthorization.mockResolvedValue(lookup(request));
    api.decideAccessAuthorization.mockRejectedValue(
      Object.assign(new Error("already decided"), {
        status: 409,
        serverMessage: "already-decided",
      }),
    );
    await act(async () => {
      render(h(AccessView, { authorizationId: "approval-raced" }), host);
      await Promise.resolve();
    });
    await act(async () => { await Promise.resolve(); });
    const deny = host.querySelector<HTMLButtonElement>(".access-request-actions .danger")!;
    await act(async () => {
      deny.dispatchEvent(new window.Event("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(router.replaceRoute).toHaveBeenCalledWith("/portal/settings/access");
    expect(api.getAccessOverview.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  test("hands the review to a phone on request, with the code the apps scan", async () => {
    const request = {
      id: "request-phone",
      approvalId: "approval-phone",
      status: "pending",
      clientId: "client-phone",
      clientName: "Fictional desktop agent",
      clientUri: "https://agent.example.com",
      redirectOrigin: "http://127.0.0.1:59927",
      resource: "https://gateway.example.org/mcp",
      userCode: "WXYZ-1234",
      expiresAt: Date.now() + 60_000,
      requiresAnswer: false,
    };
    api.getAccessAuthorization.mockResolvedValue(lookup(request));
    await act(async () => {
      render(h(AccessView, { authorizationId: request.approvalId }), host);
      await Promise.resolve();
    });
    await act(async () => { await Promise.resolve(); });

    // Shut by default: the code and the QR are not on the page until asked.
    const toggle = host.querySelector<HTMLButtonElement>(".access-phone-toggle")!;
    expect(toggle.textContent).toContain("Use your phone instead");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    // Shut, it names no panel: the id is not in the document until it opens.
    expect(toggle.getAttribute("aria-controls")).toBeNull();
    expect(host.querySelector(".access-phone-panel")).toBeNull();
    expect(host.textContent).not.toContain("WXYZ-1234");
    expect(qr.toCanvas).not.toHaveBeenCalled();

    await act(async () => { toggle.click(); });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const panel = host.querySelector(".access-phone-panel")!;
    expect(toggle.getAttribute("aria-controls")).toBe(panel.id);
    expect(panel.querySelector(".access-phone-code")?.textContent).toBe("WXYZ-1234");
    expect(panel.querySelector("canvas.access-phone-qr")).not.toBeNull();
    // The same payload the public consent page encodes.
    expect(qr.toCanvas).toHaveBeenCalledWith(
      expect.anything(),
      "omnesis://access-authorization?v=1&code=WXYZ-1234",
      expect.objectContaining({ width: 160 }),
    );
    // The review itself is untouched: the decision still runs on this page.
    expect(host.querySelector(".access-request-actions .danger")).not.toBeNull();

    await act(async () => { toggle.click(); });
    expect(host.querySelector(".access-phone-panel")).toBeNull();
  });

  test("offers no phone hand-off for a request that carries no code", async () => {
    const request = {
      id: "request-codeless",
      approvalId: "approval-codeless",
      status: "pending",
      clientId: "client-codeless",
      clientName: "Fictional desktop agent",
      clientUri: null,
      redirectOrigin: "http://127.0.0.1:59927",
      resource: "https://gateway.example.org/mcp",
      expiresAt: Date.now() + 60_000,
      requiresAnswer: false,
    };
    api.getAccessAuthorization.mockResolvedValue(lookup(request));
    await act(async () => {
      render(h(AccessView, { authorizationId: request.approvalId }), host);
      await Promise.resolve();
    });
    await act(async () => { await Promise.resolve(); });
    expect(host.querySelector(".access-phone-toggle")).toBeNull();
  });

  test("reads a client that finished first as done, not as a failure", async () => {
    // The client polls the same request and can collect its code before the
    // window that approved it asks to hand it over. The gateway then refuses
    // a second code as already decided; the window says the connection is
    // done rather than flashing an error and bouncing to the list.
    const request = {
      id: "request-raced-complete",
      approvalId: "approval-raced-complete",
      status: "pending",
      clientId: "client-raced-complete",
      clientName: "Fictional desktop agent",
      clientUri: null,
      redirectOrigin: "http://127.0.0.1:59927",
      resource: "https://gateway.example.org/mcp",
      expiresAt: Date.now() + 60_000,
      requiresAnswer: false,
    };
    api.getAccessAuthorization.mockResolvedValue(lookup(request));
    api.decideAccessAuthorization.mockResolvedValue({ request: { ...request, status: "denied" } });
    const completeAuthorization = vi.fn().mockRejectedValue(
      Object.assign(new Error("already decided"), { status: 409, serverMessage: "already-decided" }),
    );
    await act(async () => {
      render(h(AccessView, {
        authorizationId: request.approvalId,
        completeInPortal: true,
        completeAuthorization,
      }), host);
      await Promise.resolve();
    });
    await act(async () => { await Promise.resolve(); });
    const deny = host.querySelector<HTMLButtonElement>(".access-request-actions .danger")!;
    await act(async () => {
      deny.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(completeAuthorization).toHaveBeenCalledWith(request.approvalId);
    expect(host.querySelector(".access-error")).toBeNull();
    expect(host.querySelector(".access-notice")?.textContent)
      .toBe("The client has already finished connecting. You can close this window.");
    // Nothing else to show in a window opened for this one request.
    expect(host.querySelector(".access-list")).toBeNull();
    expect(host.querySelector(".access-header")).toBeNull();
    expect(router.replaceRoute).not.toHaveBeenCalled();
  });

  test("reads a decided request the client already collected as done on arrival", async () => {
    // The consent redirect lands on a request approved from a phone, whose
    // client collected its code in the meantime.
    const request = {
      id: "request-collected",
      approvalId: "approval-collected",
      status: "approved",
      clientId: "client-collected",
      clientName: "Fictional desktop agent",
      clientUri: null,
      redirectOrigin: "http://127.0.0.1:59927",
      resource: "https://gateway.example.org/mcp",
      expiresAt: Date.now() + 60_000,
      requiresAnswer: false,
    };
    api.getAccessAuthorization.mockResolvedValue(lookup(request));
    const completeAuthorization = vi.fn().mockRejectedValue(
      Object.assign(new Error("already decided"), { status: 409, serverMessage: "already-decided" }),
    );
    await act(async () => {
      render(h(AccessView, {
        authorizationId: request.approvalId,
        completeInPortal: true,
        completeAuthorization,
      }), host);
      await Promise.resolve();
    });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    expect(host.querySelector(".access-error")).toBeNull();
    expect(host.querySelector(".access-notice")?.textContent).toContain("already finished connecting");
    expect(router.replaceRoute).not.toHaveBeenCalled();
  });

  test("still reports a completion the gateway refused for any other reason", async () => {
    const request = {
      id: "request-refused",
      approvalId: "approval-refused",
      status: "pending",
      clientId: "client-refused",
      clientName: "Fictional desktop agent",
      clientUri: null,
      redirectOrigin: "http://127.0.0.1:59927",
      resource: "https://gateway.example.org/mcp",
      expiresAt: Date.now() + 60_000,
      requiresAnswer: false,
    };
    api.getAccessAuthorization.mockResolvedValue(lookup(request));
    api.decideAccessAuthorization.mockResolvedValue({ request: { ...request, status: "approved" } });
    const completeAuthorization = vi.fn().mockRejectedValue(
      Object.assign(new Error("oauth"), { status: 503, serverMessage: "oauth-not-configured" }),
    );
    await act(async () => {
      render(h(AccessView, {
        authorizationId: request.approvalId,
        completeInPortal: true,
        completeAuthorization,
      }), host);
      await Promise.resolve();
    });
    await act(async () => { await Promise.resolve(); });
    const button = (label: RegExp) =>
      [...host.querySelectorAll("button")].find((candidate) => label.test(candidate.textContent ?? ""))!;
    await act(async () => button(/^continue$/i).click());
    await act(async () => button(/^continue$/i).click());
    await act(async () => button(/^continue$/i).click());
    await act(async () => {
      button(/^allow answer$/i).click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // The gateway's token is worded for the owner, and names the fix.
    expect(host.querySelector(".access-error")?.textContent).toBe(
      "The MCP client could not finish connecting: OAuth needs the Gateway public URL. Set gateway.publicBaseUrl on the Config tab and try again.",
    );
    expect(router.replaceRoute).toHaveBeenCalledWith("/portal/settings/access");
  });

  test("a notes-only level goes from Permissions straight to Review", async () => {
    const policyFamilyId = "00000000-0000-4000-8000-000000000002";
    api.getAccessOverview.mockResolvedValue({
      principals: [],
      policyFamilies: [{ id: policyFamilyId, name: "Fictional work-safe policy", revision: "policy-revision-1" }],
      defaultPolicyFamilyId: policyFamilyId,
      sources: [{ id: "fictional-code:work", name: "Fictional code workspace" }],
      oauth: null,
    });
    const request = {
      id: "request-notes",
      approvalId: "approval-notes",
      status: "pending",
      clientId: "client-notes",
      clientName: "Fictional journal",
      clientUri: "https://journal.example.com",
      redirectOrigin: "https://journal.example.com",
      expiresAt: Date.now() + 60_000,
      requiresAnswer: false,
    };
    api.getAccessAuthorization.mockResolvedValue(lookup(request));
    await mount({ authorizationId: request.approvalId });
    const chips = () => [...host.querySelectorAll(".access-wizard-steps button")]
      .map((chip) => chip.textContent?.replace(/^[\d✓]/u, ""));
    const preset = (name: string) => [...host.querySelectorAll<HTMLLabelElement>(".access-capability-preset")]
      .find((label) => label.querySelector("strong")?.textContent?.trim() === name)!
      .querySelector("input") as HTMLInputElement;
    const toggle = async (name: string, checked: boolean) => {
      await act(async () => {
        preset(name).checked = checked;
        preset(name).dispatchEvent(new window.Event("change", { bubbles: true }));
      });
    };
    const continueButton = () => [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Continue")!;
    expect(chips()).toEqual(["Connection", "Permissions", "Data & privacy", "Review"]);
    await act(async () => continueButton().click());

    // Notes alone reads no sources and releases no answers, so the middle
    // step has nothing to ask and leaves the path.
    await toggle("Answer", false);
    await toggle("Notes", true);
    expect(chips()).toEqual(["Connection", "Permissions", "Review"]);
    await act(async () => continueButton().click());
    expect(host.querySelector(".access-wizard-steps button[aria-current='step']")?.textContent).toMatch(/Review$/u);
    expect(chips()).toEqual(["Connection", "Permissions", "Review"]);
    expect(host.querySelector(".access-request-actions .access-wizard-nav .btn-primary")?.textContent)
      .toMatch(/^allow notes$/i);

    // Back returns to Permissions, not to the skipped step.
    const backButton = [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Back")!;
    await act(async () => backButton.click());
    expect(host.querySelector(".access-wizard-steps button[aria-current='step']")?.textContent).toMatch(/Permissions$/u);

    // Adding a reading capability brings the step back.
    await toggle("Direct", true);
    expect(chips()).toEqual(["Connection", "Permissions", "Data & privacy", "Review"]);
  });

  test("does not spring the connect dialog back over the decision the code led to", async () => {
    const request = {
      id: "request-reopen",
      approvalId: "approval-reopen",
      status: "pending",
      clientId: "client-reopen",
      clientName: "Fictional desktop agent",
      clientUri: "https://agent.example.com",
      redirectOrigin: "https://agent.example.com",
      expiresAt: Date.now() + 60_000,
      requiresAnswer: true,
    };
    api.getAccessOverview.mockResolvedValue({ principals: [], oauth: OAUTH });
    api.lookupAccessAuthorization.mockResolvedValue({ request });
    await mount();
    await act(async () => { connectButton()!.click(); });
    const input = host.querySelector(".access-code-input") as HTMLInputElement;
    await act(async () => {
      input.value = "ABCD-EFGH";
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    await act(async () => {
      (host.querySelector(".access-connect-dialog form") as HTMLFormElement)
        .dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(router.navigate).toHaveBeenCalledWith(
      "/portal/settings/access/authorizations/approval-reopen",
    );

    // The review returns to this page to show its result. This view is one
    // instance for the tab, so a dialog left open would reopen over that
    // notice and take the focus with it.
    await act(async () => { render(h(AccessView, {}), host); await Promise.resolve(); });
    expect(host.querySelector(".access-connect-dialog")).toBeNull();
    expect(host.querySelector("[role='dialog']")).toBeNull();
  });

  test("keeps a code the gateway will not open inside the dialog, and clears it on close", async () => {
    api.getAccessOverview.mockResolvedValue({ principals: [], oauth: OAUTH });
    api.lookupAccessAuthorization.mockResolvedValue({
      request: {
        id: "request-settled",
        approvalId: "approval-settled",
        status: "complete",
        clientId: "client-settled",
        clientName: "Fictional desktop agent",
        clientUri: "https://agent.example.com",
        redirectOrigin: "https://agent.example.com",
        expiresAt: Date.now() + 60_000,
        requiresAnswer: false,
      },
    });
    await mount();
    await act(async () => { connectButton()!.click(); });
    const input = host.querySelector(".access-code-input") as HTMLInputElement;
    const submit = () => act(async () => {
      (host.querySelector(".access-connect-dialog form") as HTMLFormElement)
        .dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    await act(async () => {
      input.value = "ABCD-EFGH";
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    await submit();

    expect(router.navigate).not.toHaveBeenCalled();
    expect(host.querySelector(".access-connect-dialog")).not.toBeNull();
    expect(host.querySelector(".access-connect-dialog [role='alert']")?.textContent)
      .toMatch(/already completed/i);

    // A code the gateway does not hold is worded for this form, which is the
    // only page that has one.
    api.lookupAccessAuthorization.mockRejectedValue(Object.assign(new Error("missing"), { status: 404 }));
    await submit();
    expect(host.querySelector(".access-connect-dialog [role='alert']")?.textContent)
      .toMatch(/no pending authorization matches that code/i);

    // Reopening starts clean: a rejected code left in the field would submit
    // again on the next Enter.
    const close = [...host.querySelectorAll<HTMLButtonElement>("[role='dialog'] button")]
      .find((button) => button.textContent?.trim() === "Close")!;
    await act(async () => { close.click(); });
    await act(async () => { connectButton()!.click(); });
    expect((host.querySelector(".access-code-input") as HTMLInputElement).value).toBe("");
    expect(host.querySelector(".access-connect-dialog [role='alert']")).toBeNull();
    const review = [...host.querySelectorAll<HTMLButtonElement>(".access-connect-dialog button")]
      .find((button) => button.textContent?.trim() === "Review request")!;
    expect(review.disabled).toBe(true);
  });

  test("returns focus to the inventory heading when a detail page closes", async () => {
    const request = {
      id: "request-focus",
      approvalId: "approval-focus",
      status: "pending",
      clientId: "client-focus",
      clientName: "Fictional desktop agent",
      clientUri: "https://agent.example.com",
      redirectOrigin: "https://agent.example.com",
      expiresAt: Date.now() + 60_000,
      requiresAnswer: true,
    };
    api.getAccessAuthorization.mockResolvedValue(lookup(request));
    await act(async () => {
      render(h(AccessView, { authorizationId: request.approvalId }), host);
      await Promise.resolve();
    });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { render(h(AccessView, {}), host); await Promise.resolve(); });

    expect(document.activeElement).toBe(host.querySelector(".access-header h2"));
  });
});
