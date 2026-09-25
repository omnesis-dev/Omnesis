// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// @ts-nocheck — exercises the plain-JS portal renderer from vitest.
import { h, render } from "preact";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProviderIcon } from "./provider-icon.js";

describe("gateway-served provider logos", () => {
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

  it("uses the gateway route for known and custom providers", () => {
    render(h(ProviderIcon, { providerId: "together", size: 22 }), host);
    expect(host.querySelector(".provider-icon")?.getAttribute("style")).toContain('/model-logos/together.svg');
    expect(host.querySelector(".provider-icon")?.getAttribute("aria-label")).toBe("Together AI");
    render(h(ProviderIcon, { providerId: "future/provider" }), host);
    expect(host.querySelector(".provider-icon")?.getAttribute("style")).toContain('/model-logos/future%2Fprovider.svg');
    render(h(ProviderIcon, { providerId: "future');url(https://example.com/a)" }), host);
    expect(host.querySelector(".provider-icon")?.getAttribute("style")).not.toContain("https://example.com");
  });

  it("avoids logo requests for pseudo-providers and shows the Ollama brand", () => {
    render(h(ProviderIcon, { providerId: "local" }), host);
    expect(host.querySelector(".provider-icon")).toBeNull();
    render(h(ProviderIcon, { providerId: "ollama" }), host);
    expect(host.querySelector(".provider-icon")?.getAttribute("style")).toContain("/model-logos/ollama.svg");
  });
});
