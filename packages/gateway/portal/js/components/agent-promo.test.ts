// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../lib/router.js", () => ({ navigate: vi.fn() }));
vi.mock("../api.js", () => ({ getAccessOverview: vi.fn() }));

// @ts-expect-error — portal is plain JS without sibling declarations.
import { navigate } from "../lib/router.js";
import {
  AGENT_CONNECT_PATH,
  AgentPromoCard,
  shouldShowAgentPromo,
  // @ts-expect-error — portal is plain JS without sibling declarations.
} from "./agent-promo.js";

const OAUTH = { resource: "https://gateway.example.org/mcp" };

describe("shouldShowAgentPromo", () => {
  test("shows only while the gateway can take a connection and none is live", () => {
    expect(shouldShowAgentPromo({ oauth: OAUTH, principals: [] })).toBe(true);
    expect(shouldShowAgentPromo({ oauth: OAUTH, principals: [{ revokedAt: 5 }] })).toBe(true);
    expect(shouldShowAgentPromo({ oauth: OAUTH, principals: [{ revokedAt: null }] })).toBe(false);
    expect(shouldShowAgentPromo({ principals: [] })).toBe(false);
    expect(shouldShowAgentPromo(null)).toBe(false);
  });
});

describe("AgentPromoCard", () => {
  let host: HTMLElement;
  let originalDocument: typeof globalThis.document | undefined;
  let originalWindow: typeof globalThis.window | undefined;

  beforeEach(() => {
    originalDocument = globalThis.document;
    originalWindow = globalThis.window;
    const parsed = parseHTML("<html><body><main id='root'></main></body></html>");
    Object.assign(globalThis, { document: parsed.document, window: parsed.window });
    host = parsed.document.querySelector("#root") as unknown as HTMLElement;
  });

  afterEach(() => {
    render(null, host);
    if (originalDocument === undefined) delete (globalThis as { document?: unknown }).document;
    else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else globalThis.window = originalWindow;
  });

  test("shows every connectable agent's mark and opens the Connect an agent dialog", async () => {
    await act(async () => {
      render(h(AgentPromoCard, {}), host);
    });
    const marks = host.querySelector(".agent-promo-marks")!;
    expect([...marks.querySelectorAll("img")].map((img) => img.getAttribute("src"))).toEqual([
      "/portal/img/agents/claude.svg",
      "/portal/img/agents/antigravity.svg",
      "/portal/img/agents/openclaw.svg",
      "/portal/img/agents/hermes.png",
    ]);
    expect(marks.querySelector(".provider-icon")?.getAttribute("style")).toContain("/model-logos/openai.svg");

    const connect = host.querySelector("a.agent-promo-connect") as HTMLAnchorElement;
    expect(connect.getAttribute("href")).toBe(AGENT_CONNECT_PATH);
    await act(async () => {
      connect.click();
    });
    expect(navigate).toHaveBeenCalledWith("/portal/settings/access/connect");
  });
});
