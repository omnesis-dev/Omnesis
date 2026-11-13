// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
// @ts-expect-error — portal modules are plain JS without sibling declarations.
import { ResyncModal } from "./resync-modal.js";
import {
  RESYNC_WHOLE_SOURCE,
  resyncOptions,
  // @ts-expect-error — portal modules are plain JS without sibling declarations.
} from "../lib/resync-options.js";

let host: HTMLElement;
const onConfirm = vi.fn();
const onCancel = vi.fn();

const whole = { id: RESYNC_WHOLE_SOURCE, name: "Whole source", kind: null, hint: "every device" };
const laptop = { id: "dev-laptop", name: "Maya-Laptop", kind: "collector" };
const mini = { id: "dev-mini", name: "Studio-Mini", kind: "collector" };

beforeEach(() => {
  const parsed = parseHTML("<html><body><main></main></body></html>");
  vi.stubGlobal("document", parsed.document);
  vi.stubGlobal("window", parsed.window);
  host = document.querySelector("main")!;
  vi.clearAllMocks();
});
afterEach(() => {
  render(null, host);
  vi.unstubAllGlobals();
});

async function show(
  source: Record<string, unknown>,
  scopes: Array<typeof whole | typeof laptop> = [whole],
  brainNote = false,
) {
  await act(async () =>
    render(
      h(ResyncModal, {
        title: "Resync mail-synth",
        scopes,
        optionsFor: (scope: { id: string; name: string }) =>
          resyncOptions({
            source,
            label: "mail-synth",
            device: scope.id === RESYNC_WHOLE_SOURCE ? null : scope,
            brainNote,
          }),
        onConfirm,
        onCancel,
      }),
      host,
    ),
  );
}
const click = async (el: Element | null) => {
  expect(el).not.toBeNull();
  await act(async () => {
    el!.dispatchEvent(new window.Event("click"));
  });
};
const modeButton = (id: string) => host.querySelector(`.resync-mode[data-mode="${id}"]`);
const confirmButton = () => host.querySelector(".btn-primary") as HTMLButtonElement;
const exclusive = { multiDeviceMode: "exclusive", resyncModes: ["in-place", "from-scratch"] };

test("opens on in place: confirming without choosing deletes nothing", async () => {
  await show(exclusive);
  expect(modeButton("in-place")!.getAttribute("aria-checked")).toBe("true");
  expect(modeButton("from-scratch")!.getAttribute("aria-checked")).toBe("false");
  expect(confirmButton().textContent?.trim()).toBe("Resync");
  expect(confirmButton().className).not.toContain("danger");
  // One scope: nothing to pick, so no scope list is drawn.
  expect(host.querySelector(".member-picker-list")).toBeNull();
  expect(host.textContent).toContain("In place never deletes");
  expect(host.textContent).not.toContain("Brain");

  await click(confirmButton());
  expect(onConfirm).toHaveBeenCalledExactlyOnceWith({
    scopeId: RESYNC_WHOLE_SOURCE,
    mode: "in-place",
  });
});

test("choosing from scratch paints the confirmation red and says it deletes", async () => {
  await show(exclusive, [whole], true);
  await click(modeButton("from-scratch"));
  expect(modeButton("from-scratch")!.getAttribute("aria-checked")).toBe("true");
  expect(confirmButton().className).toContain("danger");
  expect(confirmButton().textContent?.trim()).toBe("Delete and resync");
  expect(host.querySelector(".resync-mode-note")?.textContent).toContain("the Brain built from mail-synth");

  await click(confirmButton());
  expect(onConfirm).toHaveBeenCalledExactlyOnceWith({
    scopeId: RESYNC_WHOLE_SOURCE,
    mode: "from-scratch",
  });
});

test("cancelling submits nothing", async () => {
  await show(exclusive);
  await click(host.querySelector(".btn-ghost"));
  expect(onCancel).toHaveBeenCalledOnce();
  expect(onConfirm).not.toHaveBeenCalled();
});

test("a replicated device offers no choice, and a from-scratch selection does not follow onto it", async () => {
  const replicated = { multiDeviceMode: "replicated", resyncModes: ["in-place", "from-scratch"] };
  await show(replicated, [whole, laptop, mini]);
  const scopes = [...host.querySelectorAll(".member-picker-item")];
  expect(scopes.map((s) => s.querySelector(".member-picker-item-name")?.textContent)).toEqual([
    "Whole source",
    "Maya-Laptop",
    "Studio-Mini",
  ]);
  expect(scopes[0]!.getAttribute("aria-checked")).toBe("true");

  await click(modeButton("from-scratch"));
  expect(confirmButton().className).toContain("danger");

  await click(scopes[2]!);
  expect(host.querySelector(".resync-mode-list")).toBeNull();
  expect(host.querySelector(".resync-single-mode")?.textContent).toContain(
    "Studio-Mini reads mail-synth again",
  );
  expect(confirmButton().className).not.toContain("danger");
  await click(confirmButton());
  expect(onConfirm).toHaveBeenCalledExactlyOnceWith({ scopeId: "dev-mini", mode: "in-place" });
});

test("a partitioned device keeps both modes", async () => {
  const partitioned = { multiDeviceMode: "partitioned", resyncModes: ["in-place", "from-scratch"] };
  await show(partitioned, [whole, laptop]);
  await click(host.querySelectorAll(".member-picker-item")[1]!);
  await click(modeButton("from-scratch"));
  expect(modeButton("from-scratch")!.textContent).toContain(
    "Deletes everything Maya-Laptop sent for mail-synth",
  );
  await click(confirmButton());
  expect(onConfirm).toHaveBeenCalledExactlyOnceWith({
    scopeId: "dev-laptop",
    mode: "from-scratch",
  });
});

test("a source that offers no mode cannot be confirmed", async () => {
  await show({ multiDeviceMode: "exclusive", resyncModes: [] });
  expect(confirmButton().disabled).toBe(true);
  await click(confirmButton());
  expect(onConfirm).not.toHaveBeenCalled();
});
