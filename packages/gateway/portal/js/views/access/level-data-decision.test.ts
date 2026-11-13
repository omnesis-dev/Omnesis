// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
// @ts-expect-error — Portal modules are JavaScript.
import { LevelDataDecision } from "./level-data-decision.js";

const sources = ["north", "south", "east", "west", "upper", "lower"].map((name) => ({
  id: `fictional-${name.startsWith("u") || name.startsWith("l") ? "notes" : "mail"}:${name}@example.com`,
  displayName: name.startsWith("u") || name.startsWith("l") ? "Invented notes" : "Invented mail",
  available: true,
}));
let host: HTMLElement;
beforeEach(() => {
  const dom = parseHTML("<html><body><div id='root'></div></body></html>");
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.document);
  host = dom.document.querySelector("#root") as unknown as HTMLElement;
});
afterEach(() => {
  act(() => render(null, host));
  vi.unstubAllGlobals();
});

test("bulk selection reaches only the accounts the search shows and keeps a retained one", async () => {
  const retained = "fictional-mail:gone@example.com";
  const rule = {
    capability: "direct",
    sources: { mode: "allowlist", sourceIds: [retained, sources[4]!.id] },
  };
  const onChange = vi.fn();
  await act(async () =>
    render(
      h(LevelDataDecision, { capability: "direct", rule, sources, enabled: true, onChange }),
      host,
    ),
  );
  const search = host.querySelector<HTMLInputElement>(".guided-source-search input")!;
  await act(async () => {
    search.value = "invented mail";
    search.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  const button = (label: string) =>
    [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (element) => element.textContent?.trim() === label,
    )!;
  expect(host.querySelector(".guided-source-tools > span")?.textContent).toBe("2 of 7 allowed");
  await act(async () => button("Allow all").click());
  expect(onChange.mock.lastCall![0].sources).toEqual({
    mode: "allowlist",
    sourceIds: [retained, ...sources.slice(0, 5).map((item) => item.id)].sort(),
  });
  // Clearing the same search leaves the accounts it does not show as they were.
  await act(async () => button("Block all").click());
  expect(onChange.mock.lastCall![0].sources).toEqual(rule.sources);
});

test.each([false, null, undefined])(
  "closed filter editing (%s) keeps a filtered account selected and leaves the rest free to change",
  async (enabled) => {
    const scopes = { items: [{ kind: "conversation", noun: { one: "conversation", many: "conversations" } }] };
    const filtered = { ...sources[0]!, scopes };
    const whole = { ...sources[1]!, scopes };
    const policy = {
      sourceId: filtered.id,
      audience: { accessLevel: "saved-level", capability: "answer" },
      rules: [{ action: "share", match: [{ kind: "conversation", id: "invented-room" }] }],
      otherwise: "hide",
    };
    const rule = {
      capability: "answer",
      sources: { mode: "all", sourceIds: [] },
      release: { mode: "unreviewed" },
      filterRevision: 7,
      scopePolicies: [policy],
    };
    const onChange = vi.fn();
    const mount = (filterEditing: unknown) =>
      act(async () =>
        render(
          h(LevelDataDecision, {
            capability: "answer",
            rule,
            sources: [filtered, whole],
            enabled: filterEditing,
            onChange,
          }),
          host,
        ),
      );
    const rows = () => [...host.querySelectorAll<HTMLElement>(".guided-source-row")];
    const action = (row: HTMLElement) => row.querySelector("button")?.textContent?.trim();

    await mount(enabled);
    const boxes = rows().map((row) => row.querySelector<HTMLInputElement>("input[type=checkbox]")!);
    expect(boxes[0]!.hasAttribute("disabled")).toBe(true);
    expect(boxes[1]!.hasAttribute("disabled")).toBe(false);
    expect(rows()[0]!.textContent).toContain("Sources with saved filters must stay allowed");
    // The saved filter can be looked at; an unfiltered account offers nothing to open.
    expect(rows().map(action)).toEqual(["View", undefined]);

    await act(async () => {
      boxes[1]!.checked = false;
      boxes[1]!.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
    expect(onChange.mock.lastCall![0].sources).toEqual({ mode: "denylist", sourceIds: [whole.id] });
    expect(onChange.mock.lastCall![0].scopePolicies).toEqual([policy]);

    await mount(true);
    expect(rows().map(action)).toEqual(["Change", "Change"]);
    expect(
      rows()[0]!.querySelector<HTMLInputElement>("input[type=checkbox]")!.hasAttribute("disabled"),
    ).toBe(false);
  },
);
