// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { parseHTML } from "linkedom";
import { describe, expect, test, vi } from "vitest";

// @ts-expect-error — Portal modules are plain JavaScript without sibling declarations.
import * as oauthConsentController from "./oauth-consent-controller.js";

const {
  startConsentController,
  wireAuthorizationQr,
  wireUserCodeCopy,
} = oauthConsentController;

describe("OAuth consent controller", () => {
  test("polling redirects an approved request through the OAuth completion endpoint", async () => {
    const document = pollingDocument();
    const navigate = vi.fn();
    startConsentController({
      root: document,
      fetchImpl: vi.fn(async () => Response.json({ status: "approved" })),
      navigate,
      schedule: vi.fn(),
    });

    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith(
      "/oauth/authorize/complete?request=handle-1",
    ));
  });

  test("leaves execution-bound completion to the connecting client and shows the approved state", async () => {
    const document = pollingDocument(true);
    const navigate = vi.fn();
    const schedule = vi.fn();
    startConsentController({
      root: document,
      fetchImpl: vi.fn(async () => Response.json({ status: "approved" })),
      navigate,
      schedule,
    });

    await vi.waitFor(() => expect(
      document.querySelector("[data-authorization-state]")?.getAttribute("data-authorization-state"),
    ).toBe("approved"));
    expect(document.querySelector("[data-authorization-outcome]")?.textContent).toContain(
      "Fictional notebook client can finish connecting.",
    );
    expect(document.querySelector("[data-authorization-approval]")).toBeNull();
    expect(document.querySelector("[data-user-code]")).toBeNull();
    expect(document.querySelector("#status")?.textContent).toBe("");
    expect(navigate).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
  });

  test("a denied execution-bound request replaces the code with the denied state", async () => {
    const document = pollingDocument(true);
    startConsentController({
      root: document,
      fetchImpl: vi.fn(async () => Response.json({ status: "denied" })),
      navigate: vi.fn(),
      schedule: vi.fn(),
    });

    await vi.waitFor(() => expect(document.querySelector("[data-authorization-outcome]")?.textContent).toContain(
      "Nothing was shared.",
    ));
    expect(document.querySelector("[data-authorization-approval]")).toBeNull();
  });

  test("a completed request replaces the code with the done state", async () => {
    const document = pollingDocument();
    const navigate = vi.fn();
    startConsentController({
      root: document,
      fetchImpl: vi.fn(async () => Response.json({ status: "code-issued" })),
      navigate,
      schedule: vi.fn(),
    });

    await vi.waitFor(() => expect(document.querySelector("[data-authorization-outcome]")?.textContent).toContain(
      "You can close this page.",
    ));
    expect(document.querySelector("[data-authorization-approval]")).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
  });

  test("polling stops when the request expires", async () => {
    const document = pollingDocument();
    const schedule = vi.fn();
    startConsentController({
      root: document,
      fetchImpl: vi.fn(async () => Response.json({ status: "expired" })),
      navigate: vi.fn(),
      schedule,
    });

    await vi.waitFor(() => expect(document.querySelector("[data-authorization-outcome]")?.textContent).toContain(
      "expired",
    ));
    expect(document.querySelector("[data-authorization-approval]")).toBeNull();
    expect(schedule).not.toHaveBeenCalled();
  });

  test("a page rendered after the decision neither polls nor wires a code", () => {
    const document = parseHTML(`<!doctype html><html><body>
      <main id="oauth-consent-root" data-handle="handle-1" data-status="denied" data-client-name="Fictional notebook client" data-completes-in-client="false"><div data-authorization-outcome><div data-authorization-state="denied"></div></div><p id="status"></p></main>
    </body></html>`).document;
    const fetchImpl = vi.fn();
    startConsentController({ root: document, fetchImpl, navigate: vi.fn(), schedule: vi.fn() });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(document.querySelector("[data-authorization-state]")?.getAttribute("data-authorization-state")).toBe("denied");
  });

  test("transient polling failures are retried", async () => {
    const document = pollingDocument();
    const schedule = vi.fn();
    startConsentController({
      root: document,
      fetchImpl: vi.fn(async () => { throw new Error("offline"); }),
      navigate: vi.fn(),
      schedule,
    });

    await vi.waitFor(() => expect(schedule).toHaveBeenCalledOnce());
    expect(schedule.mock.calls[0]?.[1]).toBe(1_200);
  });

  test("copies the exact displayed authorization code and resets its visual state", async () => {
    const document = copyDocument();
    const writeText = vi.fn(async () => {});
    let reset!: () => void;
    expect(wireUserCodeCopy(document, {
      writeText,
      schedule: (callback: () => void) => { reset = callback; return 1; },
    })).toBe(true);

    const button = document.querySelector("[data-copy-user-code]") as HTMLButtonElement;
    button.click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("ABCD-EFGH"));
    expect(button.classList.contains("is-copied")).toBe(true);
    reset();
    expect(button.classList.contains("is-copied")).toBe(false);
  });

  test("reports clipboard rejection without showing a copied state", async () => {
    const document = copyDocument();
    const button = document.querySelector("[data-copy-user-code]") as HTMLButtonElement;
    wireUserCodeCopy(document, { writeText: vi.fn(async () => { throw new Error("denied"); }) });

    button.click();
    await vi.waitFor(() => expect(button.getAttribute("aria-label")).toBe("Copy failed"));
    expect(button.classList.contains("is-copied")).toBe(false);
  });

  test("renders a QR containing only the versioned mobile deep link and canonical user code", async () => {
    const document = qrDocument();
    const toCanvas = vi.fn(async () => {});

    expect(wireAuthorizationQr(document, { toCanvas })).toBe(true);

    const canvas = document.querySelector("[data-authorization-qr]");
    await vi.waitFor(() => expect(toCanvas).toHaveBeenCalledWith(
      canvas,
      "omnesis://access-authorization?v=1&code=ABCD-EFGH",
      expect.objectContaining({ width: 200, margin: 2, errorCorrectionLevel: "M" }),
    ));
  });

  test("keeps manual entry available when QR rendering fails", async () => {
    const document = qrDocument();
    const error = document.querySelector("[data-authorization-qr-error]") as HTMLElement;

    expect(wireAuthorizationQr(document, {
      toCanvas: vi.fn(async () => { throw new Error("canvas unavailable"); }),
    })).toBe(true);

    await vi.waitFor(() => expect(error.hidden).toBe(false));
    expect(document.querySelector("[data-user-code]")?.textContent).toBe("ABCD-EFGH");
    expect(document.querySelector("[data-copy-user-code]")).not.toBeNull();
  });

  test("does not attempt QR rendering without both a canvas and user code", () => {
    const document = parseHTML("<!doctype html><html><body></body></html>").document;
    expect(wireAuthorizationQr(document, { toCanvas: vi.fn() })).toBe(false);
  });
});

function copyDocument() {
  return parseHTML(`<!doctype html><html><body>
    <strong data-user-code>ABCD-EFGH</strong>
    <button type="button" data-copy-user-code aria-label="Copy authorization code"></button>
  </body></html>`).document;
}

function pollingDocument(completesInClient = false) {
  return parseHTML(`<!doctype html><html><body>
    <main id="oauth-consent-root" data-handle="handle-1" data-status="pending" data-client-name="Fictional notebook client" data-completes-in-client="${completesInClient}"><div data-authorization-outcome><div class="code" data-authorization-approval><strong data-user-code>ABCD-EFGH</strong></div></div><p id="status">Expires soon.</p></main>
  </body></html>`).document;
}

function qrDocument() {
  return parseHTML(`<!doctype html><html><body>
    <canvas data-authorization-qr></canvas>
    <span data-authorization-qr-error hidden>QR unavailable. Enter the code instead.</span>
    <strong data-user-code>ABCD-EFGH</strong>
    <button type="button" data-copy-user-code></button>
  </body></html>`).document;
}
