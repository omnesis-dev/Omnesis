// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The settings step of the add-source flow, rendered.
 *
 * This form cannot be reached by the screenshot loop: it appears only after a
 * paired collector has advertised its descriptors, and the isolated gateway
 * that loop boots has no collector. Rendering it here is the substitute, and
 * the thing worth asserting is whose words the operator reads — the source's
 * own, not the form's guess about them.
 */

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";

import {
  ParamsForm,
  // @ts-expect-error — sibling .js modules, no .d.ts in the portal tree.
} from "./add-source.js";

const descriptor = (params: unknown[]) => ({
  description: "Notes from a folder you already keep",
  params,
});

async function renderForm(params: unknown[]) {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const parsed = parseHTML("<html><body><div id='host'></div></body></html>");
  Object.assign(globalThis, { document: parsed.document, window: parsed.window });
  const host = parsed.document.querySelector("#host") as unknown as HTMLElement;
  await act(async () => {
    render(
      h(ParamsForm, {
        descriptor: descriptor(params),
        params: {},
        errors: {},
        onChange: () => {},
        onBack: () => {},
        onContinue: () => {},
      }),
      host,
    );
  });
  const hints = [...host.querySelectorAll(".form-hint")].map((n) => n.textContent);
  const labels = [...host.querySelectorAll("label")].map((n) => n.textContent);
  render(null, host);
  globalThis.document = originalDocument;
  globalThis.window = originalWindow;
  return { hints, labels };
}

describe("the settings step", () => {
  it("shows the source's own explanation of a setting", async () => {
    const { hints } = await renderForm([
      {
        name: "sessionsPath",
        label: "Sessions directory",
        type: "path",
        help: "Leave blank to use the location this machine already uses.",
      },
    ]);
    expect(hints).toEqual(["Leave blank to use the location this machine already uses."]);
  });

  it("falls back to saying which shapes of path are accepted", async () => {
    // Not source-specific, and true of every path field: the form is the only
    // place an operator learns a home-relative path will work.
    const { hints } = await renderForm([{ name: "p", label: "Folder", type: "path" }]);
    expect(hints).toHaveLength(1);
    expect(hints[0]).toMatch(/~/);
  });

  it("leaves an ordinary field without a hint line", async () => {
    const { hints } = await renderForm([{ name: "q", label: "Label", type: "string" }]);
    expect(hints).toEqual([]);
  });

  it("marks a required field and leaves an optional one unmarked", async () => {
    const { labels } = await renderForm([
      { name: "a", label: "Vault path", type: "path", required: true },
      { name: "b", label: "Sessions directory", type: "path" },
    ]);
    expect(labels[0]).toContain("*");
    expect(labels[1]).not.toContain("*");
  });
});
