// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

// DOMPurify needs a browser DOM; real sanitization is checked in browser validation.
vi.mock("dompurify", () => ({ default: { sanitize: (value: string) => value } }));
vi.mock("../api.js", () => ({
  getAdminConfig: vi.fn(async () => ({})),
  setProviderCredentials: vi.fn(),
}));
// @ts-expect-error — portal modules are plain JS.
import { CredentialsWizard } from "./credentials-wizard.js";

let host: HTMLElement;
const writeText = vi.fn(async (_text: string) => {});
beforeEach(() => {
  const parsed = parseHTML("<html><body><main></main></body></html>");
  vi.stubGlobal("document", parsed.document);
  vi.stubGlobal("window", parsed.window);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  host = document.querySelector("main")!;
  writeText.mockClear();
});
afterEach(() => {
  render(null, host);
  vi.unstubAllGlobals();
});

async function click(selector: string) {
  await act(async () => {
    // Linkedom replays the target handler at ancestors when clicks bubble.
    // Browser validation covers the modal's actual event propagation.
    host.querySelector<HTMLElement>(selector)!.dispatchEvent(new window.Event("click", { bubbles: false }));
  });
}

test("renders setup Markdown and copies every exact value across wizard steps", async () => {
  await act(async () => {
    render(h(CredentialsWizard, {
      entry: {
        fileKey: "example",
        providerName: "Example",
        spec: {
          fields: [],
          wizard: {
            intro: "Create an **application** named Omnesis at https://example.org/apps.",
            why: "Allow `read:documents` and use localhost for local sign-in.",
            estMinutes: 2,
            steps: [
              { title: "Redirect", body: "Under **OAuth**, enter `http://localhost:3002/oauth2callback`.\n\nSee https://example.org/help." },
              { title: "Scope", body: "Add `read:items` and `localhost`." },
            ],
          },
        },
      },
      onClose: vi.fn(),
    }), host);
  });
  expect(host.querySelector(".creds-wizard-intro strong")!.textContent).toBe("application");
  expect(host.querySelector(".creds-wizard-intro a")!.getAttribute("href")).toBe("https://example.org/apps");
  expect(host.querySelector(".creds-wizard-intro code")).toBeNull();
  expect(host.querySelectorAll(".creds-wizard-why code")).toHaveLength(1);
  await click(".creds-wizard-why .agent-value-copy-btn");
  expect(writeText).toHaveBeenLastCalledWith("read:documents");

  await click(".creds-wizard-btn-primary");
  expect(host.querySelector(".creds-wizard-step-body strong")!.textContent).toBe("OAuth");
  expect(host.querySelector(".creds-wizard-step-body a code")!.textContent).toBe("http://localhost:3002/oauth2callback");
  expect(host.querySelector(".creds-wizard-step-body a code")!.parentElement!.getAttribute("href")).toBe("http://localhost:3002/oauth2callback");
  expect(host.querySelector('a[href="https://example.org/help"]')).not.toBeNull();
  expect(host.querySelector("a .agent-value-copy-btn")).toBeNull();
  await click(".agent-value-copy-btn");
  expect(writeText).toHaveBeenLastCalledWith("http://localhost:3002/oauth2callback");

  await click(".creds-wizard-btn-primary");
  const buttons = host.querySelectorAll<HTMLButtonElement>(".agent-value-copy-btn");
  expect(buttons).toHaveLength(2);
  await act(async () => { buttons[0].dispatchEvent(new window.Event("click", { bubbles: false })); });
  expect(writeText).toHaveBeenLastCalledWith("read:items");
  await act(async () => { buttons[1].dispatchEvent(new window.Event("click", { bubbles: false })); });
  expect(writeText).toHaveBeenLastCalledWith("localhost");
});
