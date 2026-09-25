// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import QRCode from "qrcode";

import { authorizationQrPayload } from "./access-qr-payload.js";

export function wireAuthorizationQr(root, { toCanvas = QRCode.toCanvas } = {}) {
  const canvas = root.querySelector("[data-authorization-qr]");
  const error = root.querySelector("[data-authorization-qr-error]");
  const code = root.querySelector("[data-user-code]")?.textContent?.trim();
  if (!canvas || !code) return false;

  void Promise.resolve()
    .then(() => toCanvas(canvas, authorizationQrPayload(code), {
      width: 200,
      margin: 2,
      errorCorrectionLevel: "M",
      color: { dark: "#15233d", light: "#ffffff" },
    }))
    .catch(() => {
      if (error) error.hidden = false;
    });
  return true;
}

export function wireUserCodeCopy(root, { writeText, schedule = setTimeout } = {}) {
  const button = root.querySelector("[data-copy-user-code]");
  const code = root.querySelector("[data-user-code]")?.textContent?.trim();
  if (!button || !code) return false;
  const copy = writeText ?? ((text) => {
    const clipboard = globalThis.navigator?.clipboard;
    if (!clipboard?.writeText) return Promise.reject(new Error("Clipboard unavailable"));
    return clipboard.writeText(text);
  });
  button.addEventListener("click", async () => {
    try {
      await copy?.(code);
      button.classList.add("is-copied");
      button.setAttribute("aria-label", "Copied");
      schedule(() => {
        button.classList.remove("is-copied");
        button.setAttribute("aria-label", "Copy authorization code");
      }, 1_500);
    } catch {
      button.setAttribute("aria-label", "Copy failed");
    }
  });
  return true;
}

/**
 * The block that replaces the code and QR once the request has left
 * `pending`. Mirrors the server-rendered state block, so a reload and an
 * in-place update show the same outcome.
 */
function renderStateBlock(document, status, clientName) {
  const block = document.createElement("div");
  block.className = "state";
  block.dataset.authorizationState = status;
  block.setAttribute("role", "status");
  const title = document.createElement("strong");
  const detail = document.createElement("span");
  if (status === "approved") {
    title.textContent = "Approved";
    detail.textContent = `${clientName} can finish connecting.`;
  } else if (status === "denied") {
    title.textContent = "Denied";
    detail.textContent = "Nothing was shared.";
  } else if (status === "expired") {
    title.textContent = "Expired";
    detail.textContent = "This authorization request expired.";
  } else {
    title.textContent = "Done";
    detail.textContent = "You can close this page.";
  }
  block.append(title, detail);
  return block;
}

/** Wire the public short-code page while the canonical Portal page owns approval. */
export function startConsentController({
  root = document,
  fetchImpl = fetch,
  navigate = (url) => {
    location.href = url;
  },
  schedule = setTimeout,
  qrToCanvas = QRCode.toCanvas,
} = {}) {
  const shell = root.querySelector("#oauth-consent-root");
  if (!shell) return;
  // A page rendered after the decision carries no code to copy or scan, and
  // nothing left to poll for.
  if (shell.dataset.status && shell.dataset.status !== "pending") return;
  wireUserCodeCopy(root, { schedule });
  wireAuthorizationQr(root, { toCanvas: qrToCanvas });
  const { handle, clientName = "The client" } = shell.dataset;
  const completesInClient = shell.dataset.completesInClient === "true";
  const status = root.querySelector("#status");
  const outcome = root.querySelector("[data-authorization-outcome]");
  const completionUrl = `/oauth/authorize/complete?request=${encodeURIComponent(handle)}`;

  const settle = (state) => {
    if (outcome) outcome.replaceChildren(renderStateBlock(shell.ownerDocument, state, clientName));
    if (status) status.textContent = "";
  };

  const poll = async () => {
    try {
      const response = await fetchImpl(
        `/oauth/authorize/status?request=${encodeURIComponent(handle)}`,
        { cache: "no-store" },
      );
      const body = await response.json();
      if (body.status === "approved" || body.status === "denied") {
        // A client that completes its own request collects the code itself;
        // any other client receives it through this browser's redirect.
        if (completesInClient) {
          settle(body.status);
          return;
        }
        navigate(completionUrl);
        return;
      }
      if (body.status === "code-issued" || body.status === "complete") {
        settle(body.status);
        return;
      }
      if (body.status === "expired") {
        settle("expired");
        return;
      }
    } catch {
      // A transient polling failure is retried while the request is live.
    }
    schedule(poll, 1_200);
  };
  void poll();
}

if (typeof document !== "undefined") startConsentController();
