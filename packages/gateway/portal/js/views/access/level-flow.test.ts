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
  vi.unstubAllGlobals();
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
  expect(host.textContent).toContain("What may this connection do?");
  expect(host.querySelector("input[id='access-new-level-name']")).toBeNull();
  expect(host.querySelector(".guided-source-list")).toBeNull();
  await click("Continue");
  expect(host.textContent).toContain("Which data may Answer use?");
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
  expect(host.textContent).toContain("Answers are released without privacy review.");
  await changeReview("Answer data");
  await click("Continue");
  expect(host.textContent).toContain("Ready to create this access level?");
  expect(host.textContent).toContain("Answers are released without privacy review.");
});
test("adding Direct from create review visits only newly required decisions and retains earlier answers", async () => {
  await createReview();
  await changeReview("Permissions");
  const direct = [...host.querySelectorAll<HTMLElement>(".access-capability-preset")].find((row) =>
    row.textContent?.includes("Direct"),
  )!;
  await change(direct.querySelector("input")!);
  await click("Continue");
  expect(host.textContent).toContain("What may Direct read?");
  await click("Continue");
  expect(host.textContent).toContain("What about new sources?");
  await click("Continue");
  expect(host.textContent).toContain("Ready to create this access level?");
  expect(host.textContent).toContain("Answers are reviewed with Invented policy.");
});
test("data change review pairs the changed account and collapses unchanged accounts", async () => {
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
  expect(host.querySelector(".guided-unchanged-accounts summary")?.textContent).toContain(
    "1 unchanged account",
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
  expect(host.textContent).toContain("What may Direct read?");
  expect(host.textContent).not.toContain("What may this connection do?");
  const separate = [...host.querySelectorAll<HTMLElement>(".guided-choice")].find((row) =>
    row.textContent?.includes("data separately"),
  )!;
  await change(separate.querySelector("input")!);
  await click("Continue");
  expect(host.textContent).toContain("Which originals may Direct read?");
  await click("Change");
  const only = [...host.querySelectorAll<HTMLElement>(".guided-choice")].find((row) =>
    row.textContent?.includes("Only matching content"),
  )!;
  await change(only.querySelector("input")!);
  await click("Continue");
  await vi.waitFor(() => expect(host.querySelector(".source-filter-options input")).not.toBeNull());
  await change(host.querySelector(".source-filter-options input")!);
  await click("Review filter");
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
  expect(retained.textContent).toContain("Unavailable account");
  expect(retained.textContent).toContain("All content");
  expect(retained.querySelector<HTMLInputElement>("input")!.hasAttribute("checked")).toBe(true);
  await click("Back");
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
  await click("Review filter");
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
