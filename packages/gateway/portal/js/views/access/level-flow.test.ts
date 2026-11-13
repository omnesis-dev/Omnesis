// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
const api = vi.hoisted(() => ({
  createAccessLevel: vi.fn(),
  updateAccessLevel: vi.fn(),
  getAccessOverview: vi.fn(),
  getSourceFilterOptions: vi.fn(),
  previewSourceFilter: vi.fn(),
}));
vi.mock("../../api.js", () => api);
// @ts-expect-error — Portal modules are JavaScript.
import { NewLevelPage, LevelEditorPage } from "./level-editor.js";
// @ts-expect-error — Portal modules are JavaScript.
import { newGrantRule } from "../../components/grant-builder-state.js";
const source = {
  id: "fictional:one",
  displayName: "Invented source",
  available: true,
  scopes: { items: [{ kind: "label", noun: { one: "label", many: "Labels" }, picker: "search" }] },
  scopeReadiness: [{ kind: "label", ready: true }],
};
const overview = {
  sources: [source],
  policyFamilies: [{ id: "invented-policy", name: "Invented policy", isDefault: true }],
  levels: [],
  sourceFilters: { enabled: true },
};
let host: HTMLElement;
beforeEach(() => {
  const dom = parseHTML("<html><body><div id='root'></div></body></html>");
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.document);
  // Browsers reject HTM's unsupported empty-element fragment spelling;
  // linkedom otherwise accepts it and conceals a production render crash.
  const createElementNS = dom.document.createElementNS.bind(dom.document);
  vi.spyOn(dom.document, "createElementNS").mockImplementation(
    (namespace, qualifiedName, options?: string | ElementCreationOptions) => {
      if (!qualifiedName) throw new Error("Invalid empty DOM element name");
      return createElementNS(namespace, qualifiedName, options);
    },
  );
  host = dom.document.querySelector("#root") as unknown as HTMLElement;
  for (const fn of Object.values(api)) fn.mockReset();
  api.createAccessLevel.mockResolvedValue({ level: { name: "Project assistant" } });
  api.updateAccessLevel.mockResolvedValue({});
  api.previewSourceFilter.mockImplementation(async (sourceId: string) => ({
    sourceId,
    items: [],
    readiness: source.scopeReadiness,
    visible: 4,
    hidden: 2,
    unknown: 0,
    samples: [],
  }));
});
afterEach(() => {
  act(() => render(null, host));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("the DOM guard rejects empty names and delegates valid namespaced elements", () => {
  expect(() => document.createElementNS("http://www.w3.org/2000/svg", "")).toThrow(
    "Invalid empty DOM element name",
  );
  const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  expect(circle.localName).toBe("circle");
  expect(circle.namespaceURI).toBe("http://www.w3.org/2000/svg");
});
const button = (label: string) => {
  const found = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (element) => element.textContent?.trim() === label,
  );
  if (!found) throw new Error(`Missing ${label}`);
  return found;
};
const click = async (label: string) => act(async () => button(label).click());
async function change(element: Element, value?: string) {
  const input = element as HTMLInputElement;
  await act(async () => {
    if (value !== undefined) input.value = value;
    else input.checked = !input.checked;
    input.dispatchEvent(
      new window.Event(value === undefined ? "change" : "input", { bubbles: true }),
    );
  });
}

test("create exposes one decision at a time, requests the name only at final review, and saves once", async () => {
  const onCreated = vi.fn(),
    onClose = vi.fn();
  await act(async () => render(h(NewLevelPage, { overview, onCreated, onClose }), host));
  expect(host.textContent).toContain("What should this connection be allowed to do?");
  expect(host.querySelector("input[id='access-new-level-name']")).toBeNull();
  expect(host.querySelector(".guided-source-list")).toBeNull();
  await click("Continue");
  expect(host.textContent).toContain("Which sources can Answer use?");
  expect(host.textContent).not.toContain("How should answers be released?");
  await change(host.querySelector(".guided-source-select input")!);
  await click("Continue");
  expect(host.textContent).toContain("What about new sources?");
  expect(host.querySelector(".guided-source-list")).toBeNull();
  await click("Continue");
  expect(host.textContent).toContain("How should answers be released?");
  await click("Continue");
  expect(host.textContent).toContain("Ready to create this access level?");
  await change(host.querySelector("#access-new-level-name")!, "Project assistant");
  await act(async () => {
    button("Create access level").click();
    button("Create access level").click();
  });
  expect(api.createAccessLevel).toHaveBeenCalledTimes(1);
  expect(api.createAccessLevel.mock.calls[0]![0]).toMatchObject({
    name: "Project assistant",
    rules: [
      {
        capability: "answer",
        sources: { mode: "allowlist", sourceIds: [source.id] },
        release: { mode: "reviewed", policyFamilyId: "invented-policy" },
      },
    ],
  });
  expect(onCreated).toHaveBeenCalledOnce();
  expect(onClose).toHaveBeenCalledOnce();
});
test("Back preserves a data draft and Cancel requires an explicit discard only after a change", async () => {
  const onClose = vi.fn();
  await act(async () => render(h(NewLevelPage, { overview, onCreated: vi.fn(), onClose }), host));
  await click("Continue");
  await change(host.querySelector(".guided-source-select input")!);
  await click("Continue");
  await click("Back");
  expect(
    host.querySelector<HTMLInputElement>(".guided-source-select input")!.hasAttribute("checked"),
  ).toBe(true);
  await click("Cancel");
  expect(host.textContent).toContain("Discard this draft?");
  expect(
    host.querySelector(".guided-exit-confirmation")?.closest(".access-editor-page"),
  ).toBeNull();
  await click("Keep editing");
  expect(onClose).not.toHaveBeenCalled();
  expect(
    host.querySelector<HTMLInputElement>(".guided-source-select input")!.hasAttribute("checked"),
  ).toBe(true);
  await click("Cancel");
  await click("Discard draft");
  expect(onClose).toHaveBeenCalledOnce();
  expect(api.createAccessLevel).not.toHaveBeenCalled();
});
test("cancelling an edited decision returns to the level's own page with the decision undone", async () => {
  const onClose = vi.fn();
  const level = {
    id: "invented-level",
    name: "Project assistant",
    revision: 3,
    rules: [
      {
        ...newGrantRule("answer", "invented-policy"),
        sources: { mode: "allowlist", sourceIds: [source.id] },
      },
    ],
  };
  await act(async () =>
    render(
      h(LevelEditorPage, {
        level,
        connections: [],
        overview,
        onSaved: vi.fn(),
        onConflict: vi.fn(),
        onGone: vi.fn(),
        onClose,
      }),
      host,
    ),
  );
  const back = () => host.querySelector<HTMLButtonElement>(".access-page-back")!;
  const open = async () => {
    const release = [...host.querySelectorAll<HTMLElement>(".guided-overview-decision")].find(
      (row) => row.querySelector("h4")?.textContent === "Answer release",
    )!;
    await act(async () => release.querySelector<HTMLButtonElement>("button")!.click());
  };
  expect(back().textContent?.trim()).toBe("← Back to access");
  await open();
  expect(back().textContent?.trim()).toBe("← Back to Project assistant");
  await change([...host.querySelectorAll<HTMLInputElement>(".grant-builder-release input")][1]!);
  await click("Cancel");
  expect(host.querySelector(".guided-edit-overview")).not.toBeNull();
  expect(button("Review changes").disabled).toBe(true);
  await open();
  await change([...host.querySelectorAll<HTMLInputElement>(".grant-builder-release input")][1]!);
  await act(async () => back().click());
  expect(host.querySelector(".guided-edit-overview")).not.toBeNull();
  expect(button("Review changes").disabled).toBe(true);
  expect(host.textContent).not.toContain("Discard");
  expect(onClose).not.toHaveBeenCalled();
  await click("Cancel");
  expect(onClose).toHaveBeenCalledOnce();
});
test("a targeted release edit shows only its before/after delta and preserves source filters and revisions", async () => {
  const filter = {
    sourceId: source.id,
    audience: { accessLevel: "invented-level", capability: "answer" },
    rules: [{ action: "share", match: [{ kind: "label", id: "invented-label" }] }],
    otherwise: "hide",
  };
  const answer = {
    ...newGrantRule("answer", "invented-policy"),
    sources: { mode: "allowlist", sourceIds: [source.id] },
    filterRevision: 7,
    scopePolicies: [filter],
  };
  const direct = {
    ...newGrantRule("direct"),
    sources: { ...answer.sources },
    filterRevision: 4,
    scopePolicies: [],
  };
  const level = {
    id: "invented-level",
    name: "Project assistant",
    revision: 9,
    rules: [answer, direct],
  };
  await act(async () =>
    render(
      h(LevelEditorPage, {
        level,
        connections: [],
        overview,
        onSaved: vi.fn(),
        onConflict: vi.fn(),
        onGone: vi.fn(),
        onClose: vi.fn(),
      }),
      host,
    ),
  );
  const section = [...host.querySelectorAll<HTMLElement>(".guided-overview-decision")].find(
    (element) => element.querySelector("h4")?.textContent === "Answer release",
  )!;
  await act(async () => section.querySelector<HTMLButtonElement>("button")!.click());
  expect(host.textContent).toContain("How should answers be released?");
  const auto = [...host.querySelectorAll<HTMLInputElement>(".grant-builder-release input")][1]!;
  await change(auto);
  await click("Done");
  await click("Review changes");
  expect(host.querySelectorAll(".guided-review-decision")).toHaveLength(1);
  expect(host.querySelector(".guided-review-decision h4")?.textContent).toBe("Answer release");
  expect(host.textContent).toContain("Before");
  expect(host.textContent).toContain("After");
  await click("Save changes");
  const body = api.updateAccessLevel.mock.calls[0]![1];
  expect(body.expectedRevision).toBe(9);
  expect(body.expectedFilterRevisions).toEqual({ answer: 7, direct: 4 });
  expect(
    body.rules.find((rule: { capability: string }) => rule.capability === "answer").scopePolicies,
  ).toEqual([filter]);
  expect(
    body.rules.find((rule: { capability: string }) => rule.capability === "direct").scopePolicies,
  ).toEqual([]);
});

test("a release edit on a level whose Direct is linked to Answer changes nothing else", async () => {
  const filter = (capability: string) => ({
    sourceId: source.id,
    audience: { accessLevel: "invented-level", capability },
    rules: [{ action: "hide", match: [{ kind: "label", id: "invented-label" }] }],
    otherwise: "share",
  });
  const sources = { mode: "allowlist", sourceIds: [source.id] };
  const level = {
    id: "invented-level",
    name: "Project assistant",
    revision: 9,
    rules: [
      { ...newGrantRule("answer", "invented-policy"), sources, filterRevision: 7, scopePolicies: [filter("answer")] },
      { ...newGrantRule("direct"), sources, filterRevision: 4, scopePolicies: [filter("direct")] },
    ],
  };
  await act(async () =>
    render(
      h(LevelEditorPage, {
        level,
        connections: [],
        overview,
        onSaved: vi.fn(),
        onConflict: vi.fn(),
        onGone: vi.fn(),
        onClose: vi.fn(),
      }),
      host,
    ),
  );
  const section = [...host.querySelectorAll<HTMLElement>(".guided-overview-decision")].find(
    (element) => element.querySelector("h4")?.textContent === "Answer release",
  )!;
  await act(async () => section.querySelector<HTMLButtonElement>("button")!.click());
  await change([...host.querySelectorAll<HTMLInputElement>(".grant-builder-release input")][1]!);
  await click("Done");
  await click("Review changes");
  expect([...host.querySelectorAll(".guided-review-decision h4")].map((item) => item.textContent)).toEqual([
    "Answer release",
  ]);
  await click("Save changes");
  const body = api.updateAccessLevel.mock.calls[0]![1];
  expect(body.expectedFilterRevisions).toEqual({ answer: 7, direct: 4 });
  expect(
    body.rules.find((rule: { capability: string }) => rule.capability === "direct").scopePolicies,
  ).toEqual([filter("direct")]);
});

async function createReview() {
  await act(async () =>
    render(h(NewLevelPage, { overview, onCreated: vi.fn(), onClose: vi.fn() }), host),
  );
  await click("Continue");
  await change(host.querySelector(".guided-source-select input")!);
  await click("Continue");
  await click("Continue");
  await click("Continue");
}
async function changeReview(title: string) {
  const section = [...host.querySelectorAll<HTMLElement>(".guided-review-decision")].find(
    (element) => element.querySelector("h4")?.textContent === title,
  )!;
  await act(async () => section.querySelector<HTMLButtonElement>("button")!.click());
}
test("correcting release or source data from create review returns immediately without replaying other decisions", async () => {
  await createReview();
  await changeReview("Answer release");
  await change([...host.querySelectorAll<HTMLInputElement>(".grant-builder-release input")][1]!);
  await click("Continue");
  expect(host.textContent).toContain("Ready to create this access level?");
  expect(host.querySelector(".compact-release-summary")?.textContent).toBe(
    "No privacy review",
  );
  await changeReview("Answer data");
  await click("Continue");
  expect(host.textContent).toContain("Ready to create this access level?");
  expect(host.querySelector(".compact-release-summary")?.textContent).toBe(
    "No privacy review",
  );
});
test("adding Direct from create review visits only newly required decisions and retains earlier answers", async () => {
  await createReview();
  await changeReview("Permissions");
  const direct = [...host.querySelectorAll<HTMLElement>(".access-capability-preset")].find((row) =>
    row.textContent?.includes("Direct"),
  )!;
  await change(direct.querySelector("input")!);
  await click("Continue");
  expect(host.textContent).toContain("Which sources can Direct read?");
  await click("Continue");
  expect(host.textContent).toContain("What about new sources?");
  await click("Continue");
  expect(host.textContent).toContain("Ready to create this access level?");
  expect(host.querySelector(".compact-release-summary")?.textContent).toBe(
    "Privacy reviewInvented policy",
  );
});
test("data change review pairs only the changed account and keeps unchanged count visible", async () => {
  const other = { ...source, id: "fictional:two" };
  const answer = {
    ...newGrantRule("answer", "invented-policy"),
    sources: { mode: "allowlist", sourceIds: [source.id, other.id] },
  };
  const level = { id: "invented-level", name: "Project assistant", revision: 1, rules: [answer] };
  await act(async () =>
    render(
      h(LevelEditorPage, {
        level,
        overview: { ...overview, sources: [source, other] },
        connections: [],
        onSaved: vi.fn(),
        onConflict: vi.fn(),
        onGone: vi.fn(),
        onClose: vi.fn(),
      }),
      host,
    ),
  );
  const section = [...host.querySelectorAll<HTMLElement>(".guided-overview-decision")].find(
    (row) => row.querySelector("h4")?.textContent === "Answer data",
  )!;
  await act(async () => section.querySelector<HTMLButtonElement>("button")!.click());
  await change(host.querySelector(".guided-source-select input")!);
  await click("Done");
  await click("Review changes");
  expect(host.querySelectorAll(".guided-account-delta")).toHaveLength(1);
  expect(host.querySelector(".guided-account-delta")?.textContent).toContain(
    "BeforeAll contentAfterNot shared",
  );
  expect(host.querySelector(".guided-unchanged-accounts")?.textContent).toContain(
    "1 account unchanged",
  );
});

test("a delayed creation freezes review navigation, the name and dismissal until the request settles", async () => {
  let reject!: (error: Error) => void;
  api.createAccessLevel.mockReturnValue(
    new Promise((_resolve, fail) => {
      reject = fail;
    }),
  );
  const onClose = vi.fn();
  await act(async () => render(h(NewLevelPage, { overview, onCreated: vi.fn(), onClose }), host));
  await click("Continue");
  await change(host.querySelector(".guided-source-select input")!);
  await click("Continue");
  await click("Continue");
  await click("Continue");
  await change(host.querySelector("#access-new-level-name")!, "Frozen draft");
  const changes = [...host.querySelectorAll<HTMLButtonElement>(".guided-review-decision button")];
  const back = button("Back"),
    cancel = button("Cancel"),
    name = host.querySelector<HTMLInputElement>("#access-new-level-name")!;
  await act(async () => {
    button("Create access level").click();
    changes[1]!.click();
    back.click();
    cancel.click();
    name.value = "Attempted later name";
    name.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  expect(host.textContent).toContain("Ready to create this access level?");
  expect(host.querySelector(".guided-source-list")).toBeNull();
  expect(onClose).not.toHaveBeenCalled();
  expect(host.querySelector(".confirm-modal-backdrop")).toBeNull();
  expect(changes.every((element) => element.disabled)).toBe(true);
  expect(back.disabled && cancel.disabled && name.disabled).toBe(true);
  expect(api.createAccessLevel).toHaveBeenCalledOnce();
  expect(api.createAccessLevel.mock.calls[0]![0].name).toBe("Frozen draft");
  await act(async () => reject(new Error("A deliberate fixture failure")));
  await click("Back");
  await click("Continue");
  expect(host.querySelector<HTMLInputElement>("#access-new-level-name")!.value).toBe(
    "Frozen draft",
  );
});
test("a delayed save keeps all review controls frozen and closes only the submitted draft", async () => {
  let resolve!: () => void;
  api.updateAccessLevel.mockReturnValue(
    new Promise<void>((done) => {
      resolve = done;
    }),
  );
  const onSaved = vi.fn(),
    onClose = vi.fn();
  const answer = {
    ...newGrantRule("answer", "invented-policy"),
    sources: { mode: "allowlist", sourceIds: [source.id] },
  };
  await act(async () =>
    render(
      h(LevelEditorPage, {
        level: { id: "invented-level", name: "Project assistant", revision: 4, rules: [answer] },
        connections: [],
        overview,
        onSaved,
        onClose,
        onConflict: vi.fn(),
        onGone: vi.fn(),
      }),
      host,
    ),
  );
  const release = [...host.querySelectorAll<HTMLElement>(".guided-overview-decision")].find(
    (row) => row.querySelector("h4")?.textContent === "Answer release",
  )!;
  await act(async () => release.querySelector<HTMLButtonElement>("button")!.click());
  await change([...host.querySelectorAll<HTMLInputElement>(".grant-builder-release input")][1]!);
  await click("Done");
  await click("Review changes");
  const changeButton = host.querySelector<HTMLButtonElement>(".guided-review-decision button")!,
    back = button("Back"),
    cancel = button("Cancel");
  await act(async () => {
    button("Save changes").click();
    changeButton.click();
    back.click();
    cancel.click();
  });
  expect(changeButton.disabled && back.disabled && cancel.disabled).toBe(true);
  expect(host.textContent).toContain("Review your changes");
  expect(host.querySelector(".grant-builder-release")).toBeNull();
  expect(onSaved).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
  expect(api.updateAccessLevel).toHaveBeenCalledOnce();
  await act(async () => resolve());
  expect(onSaved).toHaveBeenCalledOnce();
  expect(onClose).toHaveBeenCalledOnce();
});

test("linked Direct correction opens its reuse choice and saves independent refs without changing Answer", async () => {
  api.getSourceFilterOptions.mockResolvedValue({
    sourceId: source.id,
    readiness: source.scopeReadiness,
    items: [{ ref: { kind: "label", id: "direct-only" }, label: "Independent label", count: 1 }],
  });
  await act(async () =>
    render(h(NewLevelPage, { overview, onCreated: vi.fn(), onClose: vi.fn() }), host),
  );
  const direct = [...host.querySelectorAll<HTMLElement>(".access-capability-preset")].find(
    (row) => row.querySelector("strong")?.textContent === "Direct",
  )!;
  await change(direct.querySelector("input")!);
  await click("Continue");
  await change(host.querySelector(".guided-source-select input")!);
  await click("Continue");
  await click("Continue");
  await click("Continue");
  await click("Continue");
  await changeReview("Direct data");
  expect(host.textContent).toContain("Which sources can Direct read?");
  expect(host.textContent).not.toContain("What should this connection be allowed to do?");
  const separate = [...host.querySelectorAll<HTMLElement>(".guided-choice")].find((row) =>
    row.textContent?.includes("Choose different sources"),
  )!;
  await change(separate.querySelector("input")!);
  await click("Continue");
  expect(host.textContent).toContain("Which sources can Direct read?");
  await click("Change");
  const only = [...host.querySelectorAll<HTMLElement>(".source-filter-mode label")].find((row) =>
    row.textContent?.includes("Only matching content"),
  )!;
  await change(only.querySelector("input")!);
  await click("Continue");
  await change(host.querySelector(".source-filter-search input")!, "");
  await vi.waitFor(() => expect(host.querySelector(".source-filter-options input")).not.toBeNull());
  await change(host.querySelector(".source-filter-options input")!);
  await vi.waitFor(() => expect(button("Apply filter").disabled).toBe(false));
  await click("Apply filter");
  await click("Continue");
  expect(host.textContent).toContain("Ready to create this access level?");
  await change(host.querySelector("#access-new-level-name")!, "Independent draft");
  await click("Create access level");
  const rules = api.createAccessLevel.mock.calls[0]![0].rules;
  expect(
    rules.find((rule: { capability: string }) => rule.capability === "answer").scopePolicies ?? [],
  ).toEqual([]);
  expect(
    rules.find((rule: { capability: string }) => rule.capability === "direct").scopePolicies[0]
      .rules[0].match,
  ).toEqual([{ kind: "label", id: "direct-only" }]);
});

test("an unavailable unfiltered account remains visible in the overview, data decision and review", async () => {
  const missing = "fictional:missing@example.org";
  const answer = {
    ...newGrantRule("answer", "invented-policy"),
    sources: { mode: "allowlist", sourceIds: [missing] },
  };
  await act(async () =>
    render(
      h(LevelEditorPage, {
        level: { id: "invented-level", name: "Retained boundary", revision: 1, rules: [answer] },
        overview,
        connections: [],
        onSaved: vi.fn(),
        onConflict: vi.fn(),
        onGone: vi.fn(),
        onClose: vi.fn(),
      }),
      host,
    ),
  );
  expect(host.textContent).toContain("1 account selected");
  const sections = () => [...host.querySelectorAll<HTMLElement>(".guided-overview-decision")];
  const data = sections().find((row) => row.querySelector("h4")?.textContent === "Answer data")!;
  await act(async () => data.querySelector<HTMLButtonElement>("button")!.click());
  const retained = [...host.querySelectorAll<HTMLElement>(".guided-source-row")].find((row) =>
    row.textContent?.includes("missing@example.org"),
  )!;
  // Named for its source type, with its account line saying it is gone.
  expect(retained.querySelector(".compact-source-header strong")?.textContent).toBe("Fictional");
  expect(retained.querySelector(".compact-source-account")?.textContent).toBe(
    "missing@example.org · no longer connected",
  );
  expect(retained.textContent).toContain("All content");
  expect(retained.querySelector<HTMLInputElement>("input")!.hasAttribute("checked")).toBe(true);
  await click("Cancel");
  const permissions = sections().find(
    (row) => row.querySelector("h4")?.textContent === "Permissions",
  )!;
  await act(async () => permissions.querySelector<HTMLButtonElement>("button")!.click());
  const notes = [...host.querySelectorAll<HTMLElement>(".access-capability-preset")].find(
    (row) => row.querySelector("strong")?.textContent === "Notes",
  )!;
  await change(notes.querySelector("input")!);
  await click("Done");
  await click("Review changes");
  expect(host.querySelector(".guided-unchanged")?.textContent).toContain("missing@example.org");
  expect(host.querySelector(".guided-unchanged")?.textContent).toContain("All content");
  expect(button("Save changes").disabled).toBe(true);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    "would not be able to read any source",
  );
  await act(async () => button("Save changes").click());
  expect(api.updateAccessLevel).not.toHaveBeenCalled();
});

test("applying an unchanged filter on the first of two accounts keeps review disabled and wire order intact", async () => {
  const second = { ...source, id: "fictional:two", displayName: "Second invented source" };
  const policies = [source, second].map((item, index) => ({
    sourceId: item.id,
    audience: { accessLevel: "invented-level", capability: "answer" },
    rules: [{ action: "share", match: [{ kind: "label", id: `invented-label-${index}` }] }],
    otherwise: "hide",
  }));
  const answer = {
    ...newGrantRule("answer", "invented-policy"),
    sources: { mode: "allowlist", sourceIds: [source.id, second.id] },
    filterRevision: 7,
    scopePolicies: policies,
  };
  await act(async () =>
    render(
      h(LevelEditorPage, {
        level: { id: "invented-level", name: "Project assistant", revision: 2, rules: [answer] },
        overview: { ...overview, sources: [source, second] },
        connections: [],
        onSaved: vi.fn(),
        onClose: vi.fn(),
        onConflict: vi.fn(),
        onGone: vi.fn(),
      }),
      host,
    ),
  );
  const changeTopic = async (title: string) => {
    const row = [...host.querySelectorAll<HTMLElement>(".guided-overview-decision")].find(
      (item) => item.querySelector("h4")?.textContent === title,
    )!;
    await act(async () => row.querySelector<HTMLButtonElement>("button")!.click());
  };
  await changeTopic("Answer data");
  await act(async () =>
    host.querySelector<HTMLButtonElement>(".guided-source-row button")!.click(),
  );
  await click("Continue");
  await vi.waitFor(() => expect(button("Apply filter").disabled).toBe(false));
  await click("Apply filter");
  await click("Done");
  expect(button("Review changes").disabled).toBe(true);
  await changeTopic("Answer release");
  await change([...host.querySelectorAll<HTMLInputElement>(".grant-builder-release input")][1]!);
  await click("Done");
  await click("Review changes");
  await click("Save changes");
  expect(api.updateAccessLevel.mock.calls[0]![1].rules[0].scopePolicies).toEqual(policies);
});

test("toggling an account off and back on from all sources leaves no review or save action", async () => {
  const answer = {
    ...newGrantRule("answer", "invented-policy"),
    sources: { mode: "all", sourceIds: [] },
  };
  await act(async () =>
    render(
      h(LevelEditorPage, {
        level: { id: "invented-level", name: "All-source boundary", revision: 1, rules: [answer] },
        overview,
        connections: [],
        onSaved: vi.fn(),
        onClose: vi.fn(),
        onConflict: vi.fn(),
        onGone: vi.fn(),
      }),
      host,
    ),
  );
  const data = [...host.querySelectorAll<HTMLElement>(".guided-overview-decision")].find(
    (row) => row.querySelector("h4")?.textContent === "Answer data",
  )!;
  await act(async () => data.querySelector<HTMLButtonElement>("button")!.click());
  await change(host.querySelector(".guided-source-select input")!);
  await change(host.querySelector(".guided-source-select input")!);
  await click("Done");
  expect(button("Review changes").disabled).toBe(true);
  expect(api.updateAccessLevel).not.toHaveBeenCalled();
});

test("adding Answer beside an existing Direct boundary never rewrites Direct", async () => {
  const other = { ...source, id: "fictional:two", displayName: "Second invented source" };
  await act(async () =>
    render(
      h(NewLevelPage, {
        overview: { ...overview, sources: [source, other] },
        onCreated: vi.fn(),
        onClose: vi.fn(),
      }),
      host,
    ),
  );
  const preset = (name: string) =>
    [...host.querySelectorAll<HTMLElement>(".access-capability-preset")]
      .find((row) => row.querySelector("strong")?.textContent === name)!
      .querySelector("input")!;
  const setChecked = (input: HTMLInputElement, checked: boolean) =>
    act(async () => {
      input.checked = checked;
      input.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
  await setChecked(preset("Direct"), true);
  await setChecked(preset("Answer"), false);
  await click("Continue");
  expect(host.textContent).toContain("Which sources can Direct read?");
  await change(host.querySelector(".guided-source-select input")!);
  await click("Continue");
  await click("Continue");
  expect(host.textContent).toContain("Ready to create this access level?");
  await changeReview("Permissions");
  await setChecked(preset("Answer"), true);
  await click("Continue");
  expect(host.textContent).toContain("Which sources can Answer use?");
  // Answer's own selection must leave the Direct boundary chosen earlier alone.
  await change(host.querySelectorAll(".guided-source-select input")[1]!);
  for (let step = 0; step < 6 && !host.textContent?.includes("Ready to create"); step++)
    await click("Continue");
  await change(host.querySelector("#access-new-level-name")!, "Separate boundaries");
  await click("Create access level");
  const rules = api.createAccessLevel.mock.calls[0]![0].rules;
  const sourcesOf = (capability: string) =>
    rules.find((rule: { capability: string }) => rule.capability === capability).sources;
  expect(sourcesOf("answer")).toEqual({ mode: "allowlist", sourceIds: [other.id] });
  expect(sourcesOf("direct")).toEqual({ mode: "allowlist", sourceIds: [source.id] });
});

/** Renders the level page for a saved level over two invented accounts. */
async function editLevel(rules: unknown[]) {
  const other = { ...source, id: "fictional:two", displayName: "Second invented source" };
  const level = { id: "invented-level", name: "Project assistant", revision: 3, rules };
  await act(async () =>
    render(
      h(LevelEditorPage, {
        level,
        connections: [],
        overview: { ...overview, sources: [source, other], levels: [level] },
        onSaved: vi.fn(),
        onConflict: vi.fn(),
        onGone: vi.fn(),
        onClose: vi.fn(),
      }),
      host,
    ),
  );
  return other;
}
const overviewDecision = (title: string) =>
  [...host.querySelectorAll<HTMLElement>(".guided-overview-decision")].find(
    (element) => element.querySelector("h4")?.textContent === title,
  )!;
const openDecision = (title: string) =>
  act(async () => overviewDecision(title).querySelector<HTMLButtonElement>("button")!.click());
const sourceChecks = () => [...host.querySelectorAll<HTMLInputElement>(".guided-source-select input")];
const ticked = (input: HTMLInputElement) => input.checked === true || input.hasAttribute("checked");

test("choosing separate Direct data after a copy restores the boundary the copy replaced", async () => {
  const other = await editLevel([
    {
      ...newGrantRule("answer", "invented-policy"),
      sources: { mode: "allowlist", sourceIds: [source.id, "fictional:two"] },
    },
    { ...newGrantRule("direct"), sources: { mode: "allowlist", sourceIds: [source.id] } },
  ]);
  // The level page offers one way into Direct data.
  expect([...overviewDecision("Direct data").querySelectorAll("button")].map((item) => item.textContent?.trim())).toEqual(["Change"]);
  await openDecision("Direct data");
  // Direct's own list opens editable, with the one action that links it to Answer above it.
  expect(host.querySelector(".guided-direct-link p")).toBeNull();
  expect(sourceChecks().map((input) => input.disabled)).toEqual([false, false]);
  await click("Use same sources and filters as Answer mode");
  expect(host.querySelector(".guided-direct-link p")?.textContent).toBe(
    "Uses the same sources and filters as Answer mode.",
  );
  expect(sourceChecks().map((input) => [ticked(input), input.disabled])).toEqual([
    [true, true],
    [true, true],
  ]);
  await click("Done");
  expect(button("Review changes").disabled).toBe(false);
  // Change reopens Direct as it now stands: linked, with the way back out.
  await openDecision("Direct data");
  expect(host.querySelector(".guided-source-list.is-frozen")).not.toBeNull();
  await click("Choose different sources");
  expect(sourceChecks().map((input) => [ticked(input), input.disabled])).toEqual([
    [true, false],
    [false, false],
  ]);
  expect(other.id).toBe("fictional:two");
  await click("Done");
  expect(button("Review changes").disabled).toBe(true);
});

test("a saved Direct that mirrors Answer opens linked, follows Answer's edits and saves both", async () => {
  await editLevel([
    {
      ...newGrantRule("answer", "invented-policy"),
      sources: { mode: "allowlist", sourceIds: [source.id] },
    },
    { ...newGrantRule("direct"), sources: { mode: "allowlist", sourceIds: [source.id] } },
  ]);
  await openDecision("Direct data");
  expect(host.querySelector(".guided-direct-link p")?.textContent).toBe(
    "Uses the same sources and filters as Answer mode.",
  );
  // The frozen list shows each account's status but offers no checkbox or filter to change.
  expect(sourceChecks().every((input) => input.disabled)).toBe(true);
  expect(host.querySelector(".guided-source-boundary button")).toBeNull();
  expect([...host.querySelectorAll(".guided-readable-boundary")].map((item) => item.textContent)).toEqual([
    "All content",
    "Not shared",
  ]);
  await click("Cancel");
  // Answer's edit carries over to the Direct linked to it.
  await openDecision("Answer data");
  await change(sourceChecks()[1]!);
  await click("Done");
  expect(overviewDecision("Direct data").querySelector(".compact-topic-count")?.textContent).toBe(
    "Same sources and filters as Answer",
  );
  expect(overviewDecision("Answer data").querySelector(".compact-topic-count")?.textContent).toBe(
    "2 accounts selected · all content",
  );
  // New sources is one decision for both while they are linked.
  await openDecision("New sources");
  expect([...host.querySelectorAll(".guided-future-choices legend")].map((item) => item.textContent?.trim())).toEqual([
    "Answer and Direct",
  ]);
  await click("Cancel");
  await click("Review changes");
  await click("Save changes");
  const saved = api.updateAccessLevel.mock.calls[0]![1].rules;
  const sourcesOf = (capability: string) =>
    saved.find((rule: { capability: string }) => rule.capability === capability).sources;
  expect(sourcesOf("direct")).toEqual(sourcesOf("answer"));
  expect(sourcesOf("direct")).toEqual({ mode: "allowlist", sourceIds: [source.id, "fictional:two"].sort() });
});

test("Direct data without Answer is only the editable list", async () => {
  await editLevel([
    { ...newGrantRule("direct"), sources: { mode: "allowlist", sourceIds: [source.id] } },
  ]);
  await openDecision("Direct data");
  expect(host.querySelector(".guided-direct-link")).toBeNull();
  expect(sourceChecks().map((input) => input.disabled)).toEqual([false, false]);
});

const preset = (name: string) =>
  [...host.querySelectorAll<HTMLElement>(".access-capability-preset")]
    .find((row) => row.querySelector("strong")?.textContent === name)!
    .querySelector("input")!;

test("switching Answer on beside Direct's own accounts keeps them and leaves Direct unlinked", async () => {
  const other = await editLevel([
    { ...newGrantRule("direct"), sources: { mode: "allowlist", sourceIds: [source.id] } },
  ]);
  await openDecision("Permissions");
  await change(preset("Answer"));
  await click("Done");
  await openDecision("Answer data");
  await change(sourceChecks()[1]!);
  await click("Done");
  await openDecision("Direct data");
  // Direct opens on its own list, not on Answer's.
  expect(host.querySelector(".guided-source-list.is-frozen")).toBeNull();
  expect(button("Use same sources and filters as Answer mode")).toBeTruthy();
  expect(sourceChecks().map((input) => [ticked(input), input.disabled])).toEqual([
    [true, false],
    [false, false],
  ]);
  await click("Done");
  await click("Review changes");
  await click("Save changes");
  const saved = api.updateAccessLevel.mock.calls[0]![1].rules;
  const sourcesOf = (capability: string) =>
    saved.find((rule: { capability: string }) => rule.capability === capability).sources;
  expect(sourcesOf("direct")).toEqual({ mode: "allowlist", sourceIds: [source.id] });
  expect(sourcesOf("answer")).toEqual({ mode: "allowlist", sourceIds: [source.id, other.id].sort() });
});

test("switching Direct on while editing goes on to the Direct data screen", async () => {
  await editLevel([
    { ...newGrantRule("answer", "invented-policy"), sources: { mode: "allowlist", sourceIds: [source.id] } },
  ]);
  await openDecision("Permissions");
  await change(preset("Direct"));
  await click("Done");
  expect(host.querySelector(".guided-question h3")?.textContent).toBe("Which sources can Direct read?");
  await click("Done");
  expect(host.querySelector(".guided-edit-overview")).not.toBeNull();
  // A permissions change that does not add Direct returns to the overview.
  await openDecision("Permissions");
  await change(preset("Notes"));
  await click("Done");
  expect(host.querySelector(".guided-edit-overview")).not.toBeNull();
});

test("Direct switched on while editing starts linked to Answer, filters included", async () => {
  const label = { kind: "label", id: "invented-design-label" };
  const filter = {
    sourceId: source.id,
    audience: { accessLevel: "invented-level", capability: "answer" },
    rules: [{ action: "hide", match: [label] }],
    otherwise: "share",
  };
  await editLevel([
    {
      ...newGrantRule("answer", "invented-policy"),
      sources: { mode: "allowlist", sourceIds: [source.id, "fictional:two"] },
      filterRevision: 2,
      scopePolicies: [filter],
    },
  ]);
  await openDecision("Permissions");
  await change(preset("Direct"));
  await click("Done");
  // Direct never reads an account more widely than Answer does.
  expect(host.textContent).toContain("Uses the same sources and filters as Answer mode.");
  expect(host.querySelector(".guided-source-list.is-frozen")).not.toBeNull();
  await click("Done");
  await click("Review changes");
  await click("Save changes");
  const direct = api.updateAccessLevel.mock.calls[0]![1].rules.find(
    (rule: { capability: string }) => rule.capability === "direct",
  );
  expect(direct.sources).toEqual({ mode: "allowlist", sourceIds: [source.id, "fictional:two"] });
  expect(direct.scopePolicies).toEqual([
    { ...filter, audience: { accessLevel: "invented-level", capability: "direct" } },
  ]);
});
