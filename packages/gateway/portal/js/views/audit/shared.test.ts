// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { describe, expect, test } from "vitest";

// @ts-expect-error — portal modules are plain JS without sibling declarations.
import { AGENT_ICONS } from "../access/agent-brand.js";
// @ts-expect-error — portal modules are plain JS without sibling declarations.
import { CallerMark, externalAgentAppIcon } from "./shared.js";

function renderCaller(caller) {
  const { document } = parseHTML("<!DOCTYPE html><body></body>");
  const container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    render(h(CallerMark, { caller, size: 14 }), container);
  });
  return container.innerHTML;
}

describe("audit caller logos", () => {
  test.each([
    ["Muse", "muse"],
    ["ChatGPT", "chatgpt"],
    ["Claude Code", "claude-code"],
    ["Claude", "claude-apps"],
  ])("draws the %s logo from the app that signed in", (clientName, id) => {
    expect(externalAgentAppIcon({ externalAgent: { clientName } })).toBe(AGENT_ICONS[id]);
  });

  test("draws the Muse logo for a Direct session carrying the app name", () => {
    expect(externalAgentAppIcon({ clientName: "Muse" })).toBe(AGENT_ICONS.muse);
  });

  test.each([null, undefined, "", "Guv", "Fictional reader"])(
    "leaves unrecognized callers without a logo: %s",
    (clientName) => {
      expect(externalAgentAppIcon({ externalAgent: { clientName } })).toBeNull();
    },
  );

  test("renders the Muse mark beside a feed row caller", () => {
    const markup = renderCaller({ externalAgent: { clientName: "Muse" } });
    expect(markup).toContain("privacy-caller-logo");
    expect(markup).toContain("/model-logos/meta.svg");
  });

  test("renders the ChatGPT mark beside a feed row caller", () => {
    const markup = renderCaller({ externalAgent: { clientName: "ChatGPT" } });
    expect(markup).toContain("privacy-caller-logo");
    expect(markup).toContain("/model-logos/openai.svg");
  });

  test("renders the Claude mark beside a feed row caller", () => {
    const markup = renderCaller({ externalAgent: { clientName: "Claude" } });
    expect(markup).toContain("privacy-caller-logo");
    expect(markup).toContain("/portal/img/agents/claude.svg");
  });

  test("renders no logo for a caller with no recognized app", () => {
    const markup = renderCaller({ externalAgent: { clientName: "Guv" } });
    expect(markup).not.toContain("privacy-caller-logo");
  });
});
