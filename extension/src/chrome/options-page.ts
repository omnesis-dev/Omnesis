// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./chrome-api.js";
import { normalizeCaptureDomain } from "@omnesis/provider-web/capture-policy";
import { GatewayUrlError } from "../push/index.js";
import { loadConfig, loadProfileLabel } from "./storage.js";
import {
  hasCapturePermission,
  needsCapturePermissionRepair,
  requestCapturePermission,
} from "./host-permission.js";
import { hasCaptureAccess } from "./content-registration.js";
import {
  commitBrowserPairing,
  grantCaptureAccess,
  loadInitialOptionsState,
  revokeUnpairedCaptureAccess,
  saveBrowserProfileLabel,
  unpairBrowser,
  withBestEffortRefresh,
} from "./options-actions.js";
import type { CapturePolicySnapshot, ExclusionAck, OptionsToSwMessage } from "./messages.js";

/**
 * Options / pairing page controller.
 *
 * Takes a gateway URL + pairing code (generated via `omnesis devices pair
 * --kind browser` or the portal admin), redeems the code against
 * `POST /devices/pair`, and stores the returned `write:web` token + gateway
 * URL in `chrome.storage.local`. Pairing codes are pasted into the form.
 *
 * IP literals are rejected before the network call (see `normalizeGatewayUrl`):
 * the gateway's certificate covers its trusted hostname, not a bare IP.
 *
 * The page and the `chrome` API are parameters of {@link initOptions} so the
 * controller runs against `options.html` parsed under Node as well as in the
 * real options tab.
 */

/** The slice of the `chrome.*` API the options page touches directly. */
export interface OptionsChrome {
  runtime: {
    sendMessage<T = unknown>(message: unknown): Promise<T>;
  };
}

/** Wire the options document and load both of its views. */
export function initOptions(document: Document, chrome: OptionsChrome): void {
  let pairingInFlight = false;

  const pairingActions = {
    requestPermission: requestCapturePermission,
    send: (message: OptionsToSwMessage) => chrome.runtime.sendMessage(message),
  };

  function $(id: string): HTMLElement {
    const el = document.getElementById(id);
    if (!el) throw new Error(`missing element #${id}`);
    return el;
  }

  function setStatus(message: string, kind: "ok" | "error" | "info"): void {
    const el = $("status");
    el.textContent = message;
    el.className = `status status-${kind}`;
  }

  /** A pairing change decides whether there are shared exclusions to show. */
  async function refreshPairedAndExclusions(): Promise<void> {
    await refreshPairedState();
    await refreshExclusions();
  }

  async function refreshPairedState(): Promise<void> {
    const [config, profileLabel] = await Promise.all([loadConfig(), loadProfileLabel()]);
    const pairedBlock = $("paired") as HTMLDivElement;
    const form = $("pair-form") as HTMLFormElement;
    const missingPermission = $("capture-permission-missing") as HTMLDivElement;
    const unpairedAccess = $("unpaired-capture-access") as HTMLDivElement;
    const profileInput = $("profile-label") as HTMLInputElement;
    const saveProfileLabel = $("save-profile-label") as HTMLButtonElement;
    const missingProfileLabel = $("profile-label-missing") as HTMLDivElement;
    if (profileLabel) profileInput.value = profileLabel;
    saveProfileLabel.hidden = !config;
    missingProfileLabel.hidden = !config || profileLabel !== null;
    if (config) {
      pairedBlock.style.display = "block";
      form.style.display = "none";
      $("paired-gateway").textContent = config.gatewayUrl;
      $("paired-scopes").textContent = config.scopes.join(", ");
      missingPermission.hidden = !needsCapturePermissionRepair(true, await hasCaptureAccess());
      unpairedAccess.hidden = true;
    } else {
      pairedBlock.style.display = "none";
      form.style.display = "block";
      missingPermission.hidden = true;
      unpairedAccess.hidden = !(await hasCapturePermission());
    }
  }

  async function onSubmit(event: Event): Promise<void> {
    event.preventDefault();
    if (pairingInFlight) return;
    pairingInFlight = true;
    const submit = $("pair-submit") as HTMLButtonElement;
    submit.disabled = true;
    const gatewayUrl = ($("gateway-url") as HTMLInputElement).value;
    const pairingCode = ($("pairing-code") as HTMLInputElement).value;
    const profileLabel = ($("profile-label") as HTMLInputElement).value;
    setStatus("Pairing…", "info");
    try {
      const warning = await withBestEffortRefresh(
        () => commitBrowserPairing(gatewayUrl, pairingCode, profileLabel, pairingActions),
        refreshPairedState,
      );
      setStatus(
        warning ? `${warning}. Grant HTTPS page access below.` : "Paired. You can close this page.",
        warning ? "error" : "ok",
      );
      // The service worker owns the toolbar badge and hasn't seen the new config
      // yet — ask it to re-probe with the new token and repaint the badge now, so
      // the "!" clears immediately instead of at the next capture. Best-effort: if
      // the SW is momentarily unavailable, the next drain/probe reconciles anyway.
      try {
        await pairingActions.send({ type: "check-now" });
      } catch {
        // SW not reachable this instant — the periodic drain will refresh it.
      }
    } catch (err) {
      // Keep the permission the user explicitly granted. It is inert without a
      // committed config, and another Options tab may be completing a valid pair.
      const detail = err instanceof Error ? err.message : String(err);
      const message =
        err instanceof GatewayUrlError || detail.startsWith("Pairing failed:")
          ? detail
          : `Pairing failed: ${detail}`;
      setStatus(message, "error");
      try {
        await refreshPairedState();
      } catch {
        // The pairing error remains primary; reopening Settings retries rendering.
      }
    } finally {
      pairingInFlight = false;
      submit.disabled = false;
    }
  }

  async function onSaveProfileLabel(): Promise<void> {
    try {
      await withBestEffortRefresh(
        () =>
          saveBrowserProfileLabel(($("profile-label") as HTMLInputElement).value, pairingActions),
        refreshPairedState,
      );
      setStatus("Chrome profile name saved.", "ok");
    } catch (error) {
      setStatus(
        `Could not save profile name: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    }
  }

  async function onUnpair(): Promise<void> {
    try {
      const permissionWarning = await withBestEffortRefresh(
        () => unpairBrowser(pairingActions),
        refreshPairedAndExclusions,
      );
      setStatus(
        permissionWarning
          ? `Unpaired, but Chrome could not remove page access: ${permissionWarning}. Remove it in the extension's site-access settings.`
          : "Unpaired. The extension will stop pushing until you pair again.",
        permissionWarning ? "error" : "info",
      );
    } catch (error) {
      setStatus(
        `Unpair failed: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    }
  }

  async function onRevokeCaptureAccess(): Promise<void> {
    try {
      const warning = await withBestEffortRefresh(
        () => revokeUnpairedCaptureAccess(pairingActions),
        refreshPairedState,
      );
      setStatus(
        warning
          ? `Chrome could not remove page access: ${warning}. Remove it in the extension's site-access settings.`
          : "HTTPS page access removed.",
        warning ? "error" : "info",
      );
    } catch (error) {
      setStatus(
        `Could not remove page access: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    }
  }

  async function onGrantCapturePermission(): Promise<void> {
    try {
      await withBestEffortRefresh(() => grantCaptureAccess(pairingActions), refreshPairedState);
      setStatus(
        "HTTPS page access granted. Reload any already-open page to start watching it.",
        "ok",
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setStatus(`Could not grant page access: ${detail}`, "error");
      return;
    }
  }

  /**
   * Render the shared exclusions with a remove button per entry. The list is the
   * gateway's, read through the worker's copy of the policy; an unpaired browser
   * has none to show.
   */
  async function refreshExclusions(): Promise<void> {
    const snapshot = (await chrome.runtime.sendMessage<CapturePolicySnapshot>({
      type: "read-policy",
    } satisfies OptionsToSwMessage)) ?? { policy: null, fetchedAt: null };
    const list = snapshot.policy?.excludedDomains ?? [];
    const ul = $("exclusions");
    ul.replaceChildren();
    const empty = $("exclusions-empty") as HTMLParagraphElement;
    const paired = (await loadConfig()) !== null;
    empty.textContent = !paired
      ? "Pair this browser to manage the exclusions shared by your paired browsers."
      : snapshot.policy === null
        ? "Capture settings have not been loaded from the gateway yet."
        : "No domains excluded yet.";
    empty.style.display = list.length ? "none" : "block";
    ($("exclusion-form") as HTMLFormElement).hidden = !paired;
    for (const domain of list) {
      const li = document.createElement("li");
      li.className = "exclusion-item";

      const name = document.createElement("span");
      name.textContent = domain; // textContent — never interpolate a stored value as markup
      li.appendChild(name);

      const remove = document.createElement("button");
      remove.className = "secondary chip";
      remove.type = "button";
      remove.textContent = "Remove";
      remove.addEventListener("click", () => {
        void (async () => {
          try {
            const result = await chrome.runtime.sendMessage<ExclusionAck>({
              type: "remove-excluded-domain",
              domain,
            } satisfies OptionsToSwMessage);
            if (!result?.ok) {
              setStatus(
                `Could not update exclusions: ${result?.reason ?? "worker unavailable"}`,
                "error",
              );
              return;
            }
            setStatus(`${domain} is no longer excluded in any paired browser.`, "info");
            await refreshExclusions();
          } catch (error) {
            setStatus(
              `Could not update exclusions: ${error instanceof Error ? error.message : String(error)}`,
              "error",
            );
          }
        })();
      });
      li.appendChild(remove);
      ul.appendChild(li);
    }
  }

  async function onAddExclusion(event: Event): Promise<void> {
    event.preventDefault();
    const input = $("exclusion-input") as HTMLInputElement;
    const purge = ($("exclusion-purge") as HTMLInputElement).checked;
    const domain = normalizeCaptureDomain(input.value);
    if (domain === "") {
      setStatus(`"${input.value}" isn't a valid domain.`, "error");
      return;
    }
    try {
      const result = await chrome.runtime.sendMessage<ExclusionAck>({
        type: "add-excluded-domain",
        input: input.value,
        purge,
      } satisfies OptionsToSwMessage);
      if (!result?.ok) {
        setStatus(
          `Could not update exclusions: ${result?.reason ?? "worker unavailable"}`,
          "error",
        );
        return;
      }
      input.value = "";
      setStatus(
        purge
          ? `${domain} is excluded in every paired browser; ${result.purged} captured page${result.purged === 1 ? "" : "s"} deleted.`
          : `${domain} is excluded in every paired browser.`,
        "ok",
      );
      await refreshExclusions();
    } catch (error) {
      setStatus(
        `Could not update exclusions: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    }
  }

  ($("pair-form") as HTMLFormElement).addEventListener("submit", (e) => void onSubmit(e));
  ($("unpair") as HTMLButtonElement).addEventListener("click", () => void onUnpair());
  ($("save-profile-label") as HTMLButtonElement).addEventListener(
    "click",
    () => void onSaveProfileLabel(),
  );
  ($("revoke-capture-access") as HTMLButtonElement).addEventListener(
    "click",
    () => void onRevokeCaptureAccess(),
  );
  ($("grant-capture-permission") as HTMLButtonElement).addEventListener(
    "click",
    () => void onGrantCapturePermission(),
  );
  ($("exclusion-form") as HTMLFormElement).addEventListener(
    "submit",
    (e) => void onAddExclusion(e),
  );
  void loadInitialOptionsState(refreshPairedState, refreshExclusions).then((error) => {
    if (error) {
      setStatus(
        `Could not load extension settings: ${error}. Reload the extension and this page, then try again.`,
        "error",
      );
    }
  });
}
