// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error — Portal modules are plain JavaScript.
import { CapabilityPicker } from "./grant-builder.js";
// @ts-expect-error — Portal modules are plain JavaScript.
import { newGrantRule } from "./grant-builder-state.js";

function capabilityBox(root: ParentNode, label: string): HTMLInputElement {
  const match = [...root.querySelectorAll<HTMLLabelElement>(".access-capability-preset")].find(
    (candidate) => candidate.querySelector("strong")?.textContent?.trim() === label,
  );
  if (!match) throw new Error(`Missing capability checkbox: ${label}`);
  return match.querySelector("input")!;
}

describe("CapabilityPicker", () => {
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

  it("consents to Notes independently", async () => {
    const onChange = vi.fn();
    await act(async () => render(h(CapabilityPicker, { value: { notes: newGrantRule("notes") }, onChange }), host));
    expect(host.querySelector("[role='alert']")).toBeNull();
    expect(host.textContent).toContain("This does not grant access to read existing notes.");
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
    await act(async () => render(h(CapabilityPicker, { value, onChange, policies: [{ id: "policy-1", name: "Work-safe" }] }), host));

    const answer = capabilityBox(host, "Answer");
    answer.checked = false;
    await act(async () => { answer.dispatchEvent(new window.Event("change", { bubbles: true })); });
    const without = onChange.mock.lastCall![0];
    expect(without.answer).toBeUndefined();

    await act(async () => render(h(CapabilityPicker, { value: without, onChange, policies: [{ id: "policy-1", name: "Work-safe" }] }), host));
    const answerAgain = capabilityBox(host, "Answer");
    answerAgain.checked = true;
    await act(async () => { answerAgain.dispatchEvent(new window.Event("change", { bubbles: true })); });
    // Its own selection comes back — not Direct's, which is what a fresh rule
    // would have inherited.
    expect(onChange.mock.lastCall![0].answer.sources).toEqual({ mode: "allowlist", sourceIds: ["mail:personal"] });
  });

  it("inherits the other capability's sources when one is added for the first time", async () => {
    const onChange = vi.fn();
    await act(async () => render(h(CapabilityPicker, {
      value: { answer: { ...newGrantRule("answer", "policy-1"), sources: { mode: "allowlist", sourceIds: ["mail:personal"] } } },
      onChange,
      policies: [{ id: "policy-1", name: "Work-safe" }],
    }), host));
    const direct = capabilityBox(host, "Direct");
    direct.checked = true;
    await act(async () => { direct.dispatchEvent(new window.Event("change", { bubbles: true })); });
    expect(onChange.mock.lastCall![0].direct.sources).toEqual({ mode: "allowlist", sourceIds: ["mail:personal"] });
  });

  it("leaves the empty-set refusal to the page that asks the question", async () => {
    await act(async () => render(h(CapabilityPicker, { value: {}, onChange: vi.fn() }), host));
    expect(host.querySelectorAll("[role='alert']")).toHaveLength(0);
  });

  it("offers the three capabilities independently, down to none", async () => {
    const onChange = vi.fn();
    await act(async () => render(h(CapabilityPicker, { value: { answer: newGrantRule("answer", "policy-1") }, onChange }), host));
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

    // Turning the last one off empties the profile; the page refuses to leave it so.
    await act(async () => render(h(CapabilityPicker, { value: { answer: newGrantRule("answer", "policy-1") }, onChange }), host));
    const only = capabilityBox(host, "Answer");
    only.checked = false;
    await act(async () => { only.dispatchEvent(new window.Event("change", { bubbles: true })); });
    expect(onChange).toHaveBeenLastCalledWith({});
  });

  it("copies Direct sources when Answer is added beside it", async () => {
    const onChange = vi.fn();
    await act(async () => render(h(CapabilityPicker, {
      value: {
        direct: {
          ...newGrantRule("direct"),
          sources: { mode: "allowlist", sourceIds: ["github:work"] },
        },
      },
      onChange,
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

  it("keeps Direct's consequence inside its own card rather than as a second banner", async () => {
    await act(async () => render(h(CapabilityPicker, {
      value: {
        direct: {
          ...newGrantRule("direct"),
          sources: { mode: "allowlist", sourceIds: ["github:work"] },
        },
      },
      onChange: vi.fn(),
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
});
