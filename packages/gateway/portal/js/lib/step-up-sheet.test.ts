// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { parseHTML } from "linkedom";
import { expect, test } from "vitest";
// @ts-expect-error — portal JavaScript has no sibling declarations.
import { confirmStepUp } from "./step-up-sheet.js";

const page = () => parseHTML("<html><body><main></main></body></html>").document;
const buttons = (doc: Document) =>
  [...doc.querySelectorAll(".relay-step-up-sheet button")] as HTMLButtonElement[];

test("the note says why the passkey prompt is coming, and Continue goes on to the browser's prompt", async () => {
  const doc = page();
  const answer = confirmStepUp({ doc });
  const sheet = doc.querySelector(".relay-step-up-sheet")!;
  expect(sheet.getAttribute("role")).toBe("dialog");
  expect(sheet.getAttribute("aria-modal")).toBe("true");
  expect(doc.getElementById(sheet.getAttribute("aria-labelledby")!)?.textContent).toBe(
    "Confirm it's you",
  );
  expect(doc.getElementById(sheet.getAttribute("aria-describedby")!)?.textContent).toBe(
    "You're connected from outside your home, so this needs your passkey.",
  );
  expect(buttons(doc).map((button) => button.textContent)).toEqual(["Cancel", "Continue"]);
  // A second request asked meanwhile shares the one note.
  expect(confirmStepUp({ doc })).toBe(answer);
  buttons(doc)[1]!.click();
  expect(await answer).toBe(true);
  expect(doc.querySelector(".relay-step-up-sheet")).toBeNull();
});

test("Cancel, Escape or an aborted request close it without going on", async () => {
  const doc = page();
  const cancelled = confirmStepUp({ doc });
  buttons(doc)[0]!.click();
  expect(await cancelled).toBe(false);
  const escaped = confirmStepUp({ doc });
  doc.dispatchEvent(Object.assign(new doc.defaultView!.Event("keydown"), { key: "Enter" }));
  expect(doc.querySelector(".relay-step-up-sheet")).not.toBeNull();
  doc.dispatchEvent(Object.assign(new doc.defaultView!.Event("keydown"), { key: "Escape" }));
  expect(await escaped).toBe(false);
  const controller = new AbortController();
  const aborted = confirmStepUp({ doc, signal: controller.signal });
  controller.abort();
  expect(await aborted).toBe(false);
  expect(doc.querySelector(".relay-step-up-sheet")).toBeNull();
  // Already aborted: nothing is shown.
  expect(await confirmStepUp({ doc, signal: controller.signal })).toBe(false);
  expect(doc.querySelector(".relay-step-up-sheet")).toBeNull();
});

test("with no page to show it on, the browser's prompt is the only explanation", async () => {
  expect(await confirmStepUp({ doc: undefined })).toBe(true);
  expect(await confirmStepUp({ doc: {} as Document })).toBe(true);
});
