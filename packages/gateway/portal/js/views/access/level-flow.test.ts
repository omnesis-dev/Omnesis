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
    (element) => element.querySelector("h4")?.textContent === "Answer privacy",
  )!;
  await act(async () => section.querySelector<HTMLButtonElement>("button")!.click());
  expect(host.textContent).toContain("How should answers be released?");
  const auto = [...host.querySelectorAll<HTMLInputElement>(".grant-builder-release input")][1]!;
  await change(auto);
  await click("Done");
  await click("Review changes");
  expect(host.querySelectorAll(".guided-review-decision")).toHaveLength(1);
  expect(host.querySelector(".guided-review-decision h4")?.textContent).toBe("Answer privacy");
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
