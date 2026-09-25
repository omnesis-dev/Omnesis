// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const union = vi.hoisted(() => ({ getSourceDescriptorsUnion: vi.fn() }));

vi.mock("../api.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getSourceDescriptorsUnion: union.getSourceDescriptorsUnion,
  listDevices: vi.fn().mockResolvedValue({ items: [] }),
}));

// @ts-expect-error — portal modules are intentionally plain JavaScript.
import { ReauthBanner } from "./reauth-banner.js";

const lapsed = [
  {
    id: "mail-synth:maya@example.com",
    type: "mail-synth",
    deviceId: "dev-laptop",
    deviceName: "Maya-Laptop",
    syncStatus: { state: "needs-auth", providerId: "synth:maya@example.com" },
  },
];

describe("ReauthBanner", () => {
  let host: HTMLDivElement;
  let originalDocument: typeof globalThis.document | undefined;
  let originalWindow: typeof globalThis.window | undefined;

  beforeEach(() => {
    originalDocument = globalThis.document;
    originalWindow = globalThis.window;
    vi.clearAllMocks();
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

  it("says so when the registry lands without the source's hosting collector", async () => {
    // The union registry answers 200 with whatever is online; a source whose
    // collector is asleep is simply absent from it, which must read as an
    // error, not as a fetch that never finishes.
    let land: (value: unknown) => void = () => {};
    union.getSourceDescriptorsUnion.mockReturnValue(new Promise((resolve) => { land = resolve; }));
    await act(async () => {
      render(h(ReauthBanner, { sources: lapsed, onReauthed: vi.fn() }), host);
    });
    const button = document.querySelector(".reauth-banner-btn");
    if (!button) throw new Error("Missing re-authenticate button");
    await act(async () => { button.dispatchEvent(new window.Event("click", { bubbles: true })); });
    expect(document.body.textContent).toContain("Loading…");

    await act(async () => { land({ items: [{ id: "notes-synth", name: "Notes" }] }); });
    expect(document.body.textContent).toContain("The collector hosting this source is offline");
    expect(document.body.textContent).not.toContain("Loading…");
  });
});
