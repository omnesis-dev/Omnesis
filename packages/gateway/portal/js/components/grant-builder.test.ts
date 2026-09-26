// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error — Portal modules are plain JavaScript.
import { GrantBuilder } from "./grant-builder.js";
// @ts-expect-error — Portal modules are plain JavaScript.
import { newGrantRule } from "./grant-builder-state.js";

function sourcesChoice(root: ParentNode, label: string): HTMLInputElement {
  const match = [...root.querySelectorAll<HTMLLabelElement>(".grant-builder-link-sources label")]
    .find((candidate) => candidate.querySelector("strong")?.textContent?.trim() === label);
  if (!match) throw new Error(`Missing linked-sources option: ${label}`);
  return match.querySelector("input")!;
}

function capabilityBox(root: ParentNode, label: string): HTMLInputElement {
  const match = [...root.querySelectorAll<HTMLLabelElement>(".access-capability-preset")].find(
    (candidate) => candidate.querySelector("strong")?.textContent?.trim() === label,
  );
  if (!match) throw new Error(`Missing capability checkbox: ${label}`);
  return match.querySelector("input")!;
}

describe("GrantBuilder", () => {
  let host: HTMLDivElement;
  let originalDocument: typeof globalThis.document | undefined;
  let originalWindow: typeof globalThis.window | undefined;

  beforeEach(() => {
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

  it("consents to Notes independently without exposing source selectors", async () => {
    const onChange = vi.fn();
    await act(async () => render(h(GrantBuilder, { value: { notes: newGrantRule("notes") }, onChange }), host));
    expect(host.querySelector(".grant-builder")?.getAttribute("data-valid")).toBe("true");
    expect(host.querySelector(".grant-builder-boundary")).toBeNull();
    expect(host.textContent).toContain("Does not grant access to read existing notes.");
    const notes = capabilityBox(host, "Notes");
    notes.checked = false;
    await act(async () => { notes.dispatchEvent(new window.Event("change", { bubbles: true })); });
    expect(onChange).toHaveBeenCalledWith({});
    const answer = capabilityBox(host, "Answer");
    answer.checked = true;
    await act(async () => { answer.dispatchEvent(new window.Event("change", { bubbles: true })); });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ notes: newGrantRule("notes"), answer: expect.any(Object) }));
  });

  it("restores a capability's own sources when it is switched off and back on", async () => {
    const onChange = vi.fn();
    const value = {
      answer: { ...newGrantRule("answer", "policy-1"), sources: { mode: "allowlist", sourceIds: ["mail:personal"] } },
      direct: { ...newGrantRule("direct"), sources: { mode: "allowlist", sourceIds: ["github:work"] } },
    };
    await act(async () => render(h(GrantBuilder, { value, onChange, policies: [{ id: "policy-1", name: "Work-safe" }] }), host));

    const answer = capabilityBox(host, "Answer");
    answer.checked = false;
    await act(async () => { answer.dispatchEvent(new window.Event("change", { bubbles: true })); });
    const without = onChange.mock.lastCall![0];
    expect(without.answer).toBeUndefined();

    await act(async () => render(h(GrantBuilder, { value: without, onChange, policies: [{ id: "policy-1", name: "Work-safe" }] }), host));
    const answerAgain = capabilityBox(host, "Answer");
    answerAgain.checked = true;
    await act(async () => { answerAgain.dispatchEvent(new window.Event("change", { bubbles: true })); });
    // Its own boundary comes back — not Direct's, which is what a fresh rule
    // would have inherited.
    expect(onChange.mock.lastCall![0].answer.sources).toEqual({ mode: "allowlist", sourceIds: ["mail:personal"] });
  });

  it("inherits the other capability's sources when one is added for the first time", async () => {
    const onChange = vi.fn();
    await act(async () => render(h(GrantBuilder, {
      value: { answer: { ...newGrantRule("answer", "policy-1"), sources: { mode: "allowlist", sourceIds: ["mail:personal"] } } },
      onChange,
      policies: [{ id: "policy-1", name: "Work-safe" }],
    }), host));
    const direct = capabilityBox(host, "Direct");
    direct.checked = true;
    await act(async () => { direct.dispatchEvent(new window.Event("change", { bubbles: true })); });
    expect(onChange.mock.lastCall![0].direct.sources).toEqual({ mode: "allowlist", sourceIds: ["mail:personal"] });
  });

  it("states the empty-set refusal once, not once per component", async () => {
    await act(async () => render(h(GrantBuilder, { value: {}, onChange: vi.fn() }), host));
    const alerts = [...host.querySelectorAll("[role='alert']")].filter((node) =>
      node.textContent?.includes("Select at least one capability."),
    );
    expect(alerts).toHaveLength(1);
  });

  it("offers the three capabilities independently and refuses an empty profile", async () => {
    const onChange = vi.fn();
    await act(async () => render(h(GrantBuilder, { value: { answer: newGrantRule("answer", "policy-1") }, onChange }), host));
    expect(
      [...host.querySelectorAll<HTMLLabelElement>(".access-capability-preset")].map(
        (label) => label.querySelector("strong")?.textContent,
      ),
    ).toEqual(["Answer", "Direct", "Notes"]);
    // Every control is a checkbox: the capabilities do not exclude one another.
    expect(host.querySelectorAll(".access-capability-presets input[type=radio]")).toHaveLength(0);
    expect(host.querySelectorAll(".access-capability-presets input[type=checkbox]")).toHaveLength(3);

    // Notes rides alongside Answer rather than replacing it.
    const notes = capabilityBox(host, "Notes");
    notes.checked = true;
    await act(async () => { notes.dispatchEvent(new window.Event("change", { bubbles: true })); });
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ answer: expect.any(Object), notes: expect.any(Object) }),
    );

    // Turning the last one off is refused in words, driven through the UI.
    const only = capabilityBox(host, "Answer");
    only.checked = false;
    await act(async () => { only.dispatchEvent(new window.Event("change", { bubbles: true })); });
    await act(async () => render(h(GrantBuilder, { value: onChange.mock.lastCall![0], onChange }), host));
    expect(host.textContent).toContain("Select at least one capability.");
    expect(host.querySelector(".grant-builder")?.getAttribute("data-valid")).toBe("false");
  });

  it("adds checked allowlist rows to the allowed source ids", async () => {
    const onChange = vi.fn();
    await act(async () => render(h(GrantBuilder, {
      value: { answer: newGrantRule("answer", "policy-1") },
      onChange,
      sources: [
        { id: "github:work", displayName: "GitHub — Work" },
        { id: "mail:personal", displayName: "Mail — Personal" },
      ],
      policies: [{ id: "policy-1", name: "Work-safe" }],
    }), host));

    expect(host.textContent).toContain("github:work");
    expect(host.textContent).toContain("0 of 2 connected sources");
    const source = host.querySelector<HTMLInputElement>("[aria-label='answer source selection'] input")!;
    expect(source.hasAttribute("checked")).toBe(false);
    source.checked = true;
    await act(async () => { source.dispatchEvent(new window.Event("change", { bubbles: true })); });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      answer: expect.objectContaining({
        sources: { mode: "allowlist", sourceIds: ["github:work"] },
      }),
    }));
  });

  it("keeps source checkboxes positive in denylist mode", async () => {
    const onChange = vi.fn();
    await act(async () => render(h(GrantBuilder, {
      value: {
        direct: {
          ...newGrantRule("direct"),
          sources: { mode: "denylist", sourceIds: [] },
        },
      },
      onChange,
      sources: [
        { id: "github:work", displayName: "GitHub — Work" },
        { id: "mail:personal", displayName: "Mail — Personal" },
      ],
      policies: [],
    }), host));

    const source = host.querySelector<HTMLInputElement>("[aria-label='direct source selection'] input")!;
    expect(source.hasAttribute("checked")).toBe(true);
    source.checked = false;
    await act(async () => { source.dispatchEvent(new window.Event("change", { bubbles: true })); });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      direct: expect.objectContaining({
        sources: { mode: "denylist", sourceIds: ["github:work"] },
      }),
    }));
  });

  it.each([
    ["allowlist", 0, "allowlist", ["github:work", "mail:personal"]],
    ["allowlist", 1, "allowlist", []],
    ["denylist", 0, "denylist", []],
    ["denylist", 1, "allowlist", []],
  ])("applies %s bulk selection action %s", async (mode, actionIndex, expectedMode, sourceIds) => {
    const onChange = vi.fn();
    await act(async () => render(h(GrantBuilder, {
      value: {
        direct: {
          ...newGrantRule("direct"),
          sources: {
            mode,
            sourceIds: actionIndex === 1 ? [] : ["github:work", "mail:personal"],
          },
        },
      },
      onChange,
      sources: [
        { id: "github:work", name: "GitHub — Work" },
        { id: "mail:personal", name: "Mail — Personal" },
      ],
      policies: [],
    }), host));

    const button = host.querySelectorAll<HTMLButtonElement>(".grant-builder-bulk button")[actionIndex]!;
    await act(async () => button.click());
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      direct: expect.objectContaining({ sources: { mode: expectedMode, sourceIds } }),
    }));
  });

  it("can block one source while every source is initially allowed", async () => {
    const onChange = vi.fn();
    await act(async () => render(h(GrantBuilder, {
      value: {
        direct: {
          ...newGrantRule("direct"),
          sources: { mode: "all", sourceIds: [] },
        },
      },
      onChange,
      sources: [{ id: "github:work", name: "GitHub — Work" }],
      policies: [],
    }), host));

    const source = host.querySelector<HTMLInputElement>("[aria-label='direct source selection'] input")!;
    source.checked = false;
    await act(async () => {
      source.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      direct: expect.objectContaining({ sources: { mode: "denylist", sourceIds: ["github:work"] } }),
    }));
  });

  it("copies Direct sources when Answer is added to a linked grant", async () => {
    const onChange = vi.fn();
    await act(async () => render(h(GrantBuilder, {
      value: {
        direct: {
          ...newGrantRule("direct"),
          sources: { mode: "allowlist", sourceIds: ["github:work"] },
        },
      },
      onChange,
      sources: [
        { id: "github:work", name: "GitHub — Work" },
        { id: "mail:personal", name: "Mail — Personal" },
      ],
      policies: [{ id: "policy-1", name: "Work-safe" }],
    }), host));

    const answer = capabilityBox(host, "Answer");
    answer.checked = true;
    await act(async () => {
      answer.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith({
      answer: expect.objectContaining({
        sources: { mode: "allowlist", sourceIds: ["github:work"] },
        release: { mode: "reviewed", policyFamilyId: "policy-1" },
      }),
      direct: expect.objectContaining({
        sources: { mode: "allowlist", sourceIds: ["github:work"] },
      }),
    });
  });

  it("offers one boundary or two as a plain choice, with the shared list on by default", async () => {
    await act(async () => render(h(GrantBuilder, {
      value: { answer: newGrantRule("answer", "policy-1"), direct: newGrantRule("direct") },
      onChange: vi.fn(),
      sources: [{ id: "github:work", name: "GitHub — Work" }],
      policies: [{ id: "policy-1", name: "Work-safe" }],
    }), host));

    // No disclosure hiding the choice, and no status line restating it.
    expect(host.querySelector(".grant-builder-link-sources details")).toBeNull();
    expect(host.textContent).not.toContain("Advanced source boundaries");
    // linkedom reflects a rendered `checked` as an attribute, not a property.
    expect(sourcesChoice(host, "Allow the same sources for Answer and Direct").hasAttribute("checked")).toBe(true);
    expect(sourcesChoice(host, "Allow different sources").hasAttribute("checked")).toBe(false);
    // One shared list while the boundaries are linked.
    expect(host.querySelectorAll(".grant-builder-boundary")).toHaveLength(1);
    expect(host.textContent).toContain("Sources available to Answer and Direct");
  });

  it("splits into a list per capability when different sources are chosen", async () => {
    await act(async () => render(h(GrantBuilder, {
      value: { answer: newGrantRule("answer", "policy-1"), direct: newGrantRule("direct") },
      onChange: vi.fn(),
      sources: [{ id: "github:work", name: "GitHub — Work" }],
      policies: [{ id: "policy-1", name: "Work-safe" }],
    }), host));

    const separate = sourcesChoice(host, "Allow different sources");
    separate.checked = true;
    await act(async () => { separate.dispatchEvent(new window.Event("change", { bubbles: true })); });

    expect(host.querySelectorAll(".grant-builder-boundary")).toHaveLength(2);
    expect(host.textContent).toContain("Answer sources");
    expect(host.textContent).toContain("Direct sources");
  });

  it("re-linking hands Direct the Answer boundary the shared list will show", async () => {
    const onChange = vi.fn();
    await act(async () => render(h(GrantBuilder, {
      value: {
        answer: {
          ...newGrantRule("answer", "policy-1"),
          sources: { mode: "allowlist", sourceIds: ["github:work"] },
        },
        direct: {
          ...newGrantRule("direct"),
          sources: { mode: "allowlist", sourceIds: ["mail:personal"] },
        },
      },
      onChange,
      sources: [
        { id: "github:work", name: "GitHub — Work" },
        { id: "mail:personal", name: "Mail — Personal" },
      ],
      policies: [{ id: "policy-1", name: "Work-safe" }],
    }), host));

    // Diverged boundaries start the pair unlinked; going back to one list must
    // not leave Direct on a boundary the shared list never shows.
    const shared = sourcesChoice(host, "Allow the same sources for Answer and Direct");
    shared.checked = true;
    await act(async () => { shared.dispatchEvent(new window.Event("change", { bubbles: true })); });

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      direct: expect.objectContaining({
        sources: { mode: "allowlist", sourceIds: ["github:work"] },
      }),
    }));
  });

  it("renders the source instance icon supplied by the access overview", async () => {
    const icon = "data:image/png;base64,AA==";
    await act(async () => render(h(GrantBuilder, {
      value: { direct: newGrantRule("direct") },
      onChange: vi.fn(),
      sources: [{ id: "fictional-source:work", name: "Fictional source", icon }],
      policies: [],
    }), host));

    expect(host.querySelector<HTMLImageElement>(".grant-builder-source-icon img")?.src).toBe(icon);
  });

  it("exposes invalid grant state as an alert", async () => {
    await act(async () => render(h(GrantBuilder, {
      value: {},
      onChange: vi.fn(),
      sources: [],
      policies: [],
    }), host));
    expect(host.querySelector("[role='alert']")).not.toBeNull();
  });

  it("takes unreviewed release as chosen, with no second acknowledgement to give", async () => {
    await act(async () => render(h(GrantBuilder, {
      value: {
        answer: {
          ...newGrantRule("answer", "policy-1"),
          sources: { mode: "allowlist", sourceIds: ["github:work"] },
          release: { mode: "unreviewed" },
        },
      },
      onChange: vi.fn(),
      sources: [{ id: "github:work", name: "GitHub — Work" }],
      policies: [{ id: "policy-1", name: "Work-safe" }],
    }), host));

    expect(host.querySelector(".grant-builder")?.getAttribute("data-valid")).toBe("true");
    expect(host.querySelector("[role='alert']")).toBeNull();
    expect(host.textContent).not.toContain("I understand that answers may contain private source data.");
    // The risk itself is still stated, on the choice that carries it.
    expect(host.textContent).toContain("High risk");
  });

  it("puts a boundary's refusal in the card that owns the list, naming its scope", async () => {
    const empty = { mode: "allowlist", sourceIds: [] };
    await act(async () => render(h(GrantBuilder, {
      value: {
        answer: { ...newGrantRule("answer", "policy-1"), sources: empty },
        direct: { ...newGrantRule("direct"), sources: empty },
      },
      onChange: vi.fn(),
      sources: [{ id: "github:work", name: "GitHub — Work" }],
      policies: [{ id: "policy-1", name: "Work-safe" }],
    }), host));

    const boundary = host.querySelector(".grant-builder-boundary")!;
    expect(boundary.querySelector(".grant-builder-boundary-error")?.textContent).toBe(
      "Select at least one source for Answer and Direct.",
    );
    // Said once, where the fix is — not again at the foot of the step.
    expect(host.querySelectorAll("[role='alert']")).toHaveLength(1);
  });

  it("offers every source in one click when a boundary reads nothing", async () => {
    const onChange = vi.fn();
    await act(async () => render(h(GrantBuilder, {
      value: { direct: { ...newGrantRule("direct"), sources: { mode: "denylist", sourceIds: ["github:work"] } } },
      onChange,
      sources: [{ id: "github:work", name: "GitHub — Work" }],
      policies: [],
    }), host));

    expect(host.querySelector(".grant-builder-boundary-error")?.textContent).toBe(
      "Direct would not be able to read any source.",
    );
    const allowEvery = host.querySelector<HTMLButtonElement>(".grant-builder-allow-every")!;
    expect(allowEvery.textContent).toBe("Allow every source, including new ones");
    await act(async () => { allowEvery.click(); });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      direct: expect.objectContaining({ sources: { mode: "all", sourceIds: [] } }),
    }));
  });

  it("keeps Direct's consequence inside its own card rather than as a second banner", async () => {
    await act(async () => render(h(GrantBuilder, {
      value: {
        direct: {
          ...newGrantRule("direct"),
          sources: { mode: "allowlist", sourceIds: ["github:work"] },
        },
      },
      onChange: vi.fn(),
      sources: [{ id: "github:work", name: "GitHub — Work" }],
      policies: [],
    }), host));

    const card = [...host.querySelectorAll(".access-capability-preset")].find(
      (candidate) => candidate.querySelector("strong")?.textContent?.trim() === "Direct",
    )!;
    expect(card.querySelector(".access-capability-warning")?.textContent).toBe(
      "Direct is not protected by a privacy policy.",
    );
    // Said once, by the card that offers the capability.
    expect(host.querySelectorAll(".access-capability-warning")).toHaveLength(1);
    expect(host.textContent).not.toContain("It may return raw content from every source allowed above.");
  });

  it("carries the policy the reviewed choice names on the choice's own row", async () => {
    await act(async () => render(h(GrantBuilder, {
      value: {
        answer: {
          ...newGrantRule("answer", "policy-1"),
          sources: { mode: "allowlist", sourceIds: ["github:work"] },
        },
      },
      onChange: vi.fn(),
      sources: [{ id: "github:work", name: "GitHub — Work" }],
      policies: [{ id: "policy-1", name: "Work-safe" }],
    }), host));

    const reviewed = host.querySelector(".grant-builder-release-reviewed")!;
    expect(reviewed.querySelector("strong")?.textContent).toBe("Review answers with a privacy policy");
    // The select is a sibling of the label, never inside it: nested, clicking
    // the dropdown would activate the label and flip the radio.
    const select = reviewed.querySelector("select")!;
    expect(select.getAttribute("aria-label")).toBe("Answer privacy policy");
    expect(select.closest("label")).toBeNull();
    expect(host.textContent).not.toContain("Recommended · a reviewer checks every answer before release.");
  });

  it("distinguishes unavailable retained source decisions from connected sources", async () => {
    await act(async () => render(h(GrantBuilder, {
      value: {
        direct: {
          ...newGrantRule("direct"),
          sources: { mode: "allowlist", sourceIds: ["github:removed"] },
        },
      },
      onChange: vi.fn(),
      sources: [
        { id: "github:work", name: "GitHub — Work", available: true },
        { id: "github:removed", name: "github:removed", available: false },
      ],
      policies: [],
    }), host));

    expect(host.textContent).toContain("Unavailable — decision retained");
    expect(host.textContent).toContain("0 of 1 connected source");
  });
});
