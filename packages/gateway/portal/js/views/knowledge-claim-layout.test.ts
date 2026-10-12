// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { parseHTML } from "linkedom";
import { expect, it } from "vitest";
// @ts-expect-error — portal modules are plain JavaScript.
import { bindClaimIndicatorTails } from "./knowledge-claim-layout.js";

it("binds the final word while preserving nested claim identities and sibling native controls", () => {
  const { document } = parseHTML('<main><span id="outer-span"><span id="inner-span">A long sentence ending here<button class="kn-claim-indicator" id="inner"></button></span><button class="kn-claim-indicator" id="outer"></button></span></main>');
  const root = document.querySelector("main")!;
  bindClaimIndicatorTails(root);
  expect(root.querySelectorAll(".kn-claim-tail")).toHaveLength(1);
  expect(root.querySelector(".kn-claim-tail")!.textContent).toBe("here");
  expect(root.querySelectorAll("#inner-span")).toHaveLength(1);
  expect(root.querySelectorAll("#outer-span")).toHaveLength(1);
  expect(root.querySelectorAll(".kn-claim-tail > button")).toHaveLength(2);
  expect(root.querySelector("button button")).toBeNull();
});

it("keeps final links separate from the indicator and retains their exact navigation", () => {
  const { document } = parseHTML('<main><p>Read <a href="https://example.org/guide">a detailed guide</a><button class="kn-claim-indicator"></button></p></main>');
  const root = document.querySelector("main")!;
  const link = root.querySelector("a");
  bindClaimIndicatorTails(root);
  expect(root.querySelector(".kn-claim-tail > a")).toBe(link);
  expect(link!.getAttribute("href")).toBe("https://example.org/guide");
  expect(root.querySelector("a button, button a")).toBeNull();
});
