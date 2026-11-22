// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { useEffect, useRef, useState } from "preact/hooks";
import {
  relayManagement,
  relayError,
  googleAuthorizationUrl,
  accountAuthorizationUrl,
  gatewayVersion,
} from "./cloud-relay-api.js";

/** While a connect is under way the page follows it closely; otherwise a slow poll is enough. */
// An operation that may ask for the passkey first waits for the person, not only for the network.
const STEP_UP_OPERATIONS = new Set(["enrollment"]);
const IN_PROGRESS = ["waiting", "registering", "linking"];
export function relayPollInterval(status) {
  return IN_PROGRESS.includes(status?.connect?.state) ? 2000 : 5000;
}

const NO_ERROR = Object.freeze({ text: "", code: "", operation: false });

/**
 * One request at a time; a mutation invalidates any older status read.
 * `run` resolves to the operation's result, or undefined when it failed or was superseded.
 *
 * An invite the gateway refused stays said until the next operation or `clearError`: the page's
 * own status reads, every few seconds, never take it away. Any other failure is said only until a
 * status read succeeds. `errorCode` is the gateway's code for the error, when it gave one.
 */
export function useRelayManagement() {
  const [status, setStatus] = useState(null);
  // Only for the details a person copies when asking for help.
  const [version, setVersion] = useState("");
  const [error, setError] = useState(NO_ERROR);
  const [busy, setBusy] = useState("");
  const active = useRef(null);
  const mounted = useRef(false);
  const run = async (operation = "", input = {}, method = "POST", options) => {
    if (!mounted.current) return undefined;
    if (operation && active.current?.operation) return undefined;
    if (!operation && active.current) return undefined;
    active.current?.controller.abort();
    const controller = new AbortController();
    const attempt = { controller, operation };
    active.current = attempt;
    setBusy(operation || "refresh");
    setError((current) => (operation || !current.operation ? NO_ERROR : current));
    const timeout = setTimeout(
      () => controller.abort(),
      STEP_UP_OPERATIONS.has(operation) ? 130_000 : 10_000,
    );
    try {
      // The account page and Connectivity's account step show how to sign up; a plain status
      // read here asks for that too.
      const result = await relayManagement(
        operation,
        input,
        controller.signal,
        method,
        ...(options ? [options] : operation ? [] : [{ signup: true }]),
      );
      if (controller.signal.aborted) throw new Error("Request expired");
      // Replacement and unmount both abort this request before clearing it.
      if (operation === "google/link")
        window.location.assign(
          googleAuthorizationUrl(result.authorizeUrl, status?.config?.relayUrl),
        );
      else if (operation === "account/link")
        window.location.assign(
          accountAuthorizationUrl(result.authorizeUrl, status?.config?.relayUrl),
        );
      else setStatus(result);
      return result;
    } catch (error) {
      if (mounted.current && active.current === attempt)
        setError((current) =>
          // A status read that failed doesn't hide what the last operation was refused for.
          !operation && current.operation
            ? current
            : {
                text:
                  // A passkey step that couldn't go ahead says why in its own words.
                  (error?.stepUp === true && error.message) ||
                  relayError(error?.code) ||
                  "Couldn't load or update your Omnesis account settings. Check the connection and try again.",
                code: typeof error?.code === "string" ? error.code : "",
                // Only a refused invite stays: the person answers it by editing the invite.
                // Anything else is over once a status read succeeds.
                operation: Boolean(operation && /^invite-/.test(error?.code ?? "")),
              },
        );
      return undefined;
    } finally {
      clearTimeout(timeout);
      if (mounted.current && active.current === attempt) {
        active.current = null;
        setBusy("");
      }
    }
  };
  const interval = relayPollInterval(status);
  // While a connect is under way the person is often in another tab (the security check, the
  // sign-in), so the page keeps following it then even out of view.
  const following = IN_PROGRESS.includes(status?.connect?.state);
  useEffect(() => {
    mounted.current = true;
    void run();
    gatewayVersion().then((value) => mounted.current && setVersion(value));
    return () => {
      mounted.current = false;
      active.current?.controller.abort();
      active.current = null;
    };
  }, []);
  useEffect(() => {
    const timer = setInterval(() => {
      if (following || document.visibilityState !== "hidden") void run();
    }, interval);
    return () => clearInterval(timer);
  }, [interval, following]);
  const clearError = () => setError(NO_ERROR);
  return { status, error: error.text, errorCode: error.code, clearError, busy, run, version };
}

/** How long one account refresh may take, and the least time between two the page starts. */
const ACCOUNT_REFRESH_TIMEOUT_MS = 15_000;
const ACCOUNT_REFRESH_GAP_MS = 2_000;

/**
 * Asks the gateway to read the Omnesis account again when the page opens and whenever it comes
 * back into view (say, after adding a passkey on the account page in another tab), then calls
 * `onRefreshed` so the page reads the new status at once. The gateway throttles these reads and
 * they can't make anything trusted. A failure says nothing: the status read reports problems.
 */
export function useAccountRefresh(onRefreshed) {
  const latest = useRef(onRefreshed);
  latest.current = onRefreshed;
  useEffect(() => {
    let live = true,
      last = -Infinity,
      controller;
    const refresh = async () => {
      // Coming back to a tab fires both events; one refresh is enough.
      if (document.visibilityState === "hidden" || Date.now() - last < ACCOUNT_REFRESH_GAP_MS)
        return;
      last = Date.now();
      controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ACCOUNT_REFRESH_TIMEOUT_MS);
      try {
        await relayManagement("account/refresh", {}, controller.signal);
        if (live) latest.current?.();
      } catch {
        // The regular status read says what is wrong, if anything.
      } finally {
        clearTimeout(timer);
      }
    };
    const shown = () => {
      if (document.visibilityState !== "hidden") void refresh();
    };
    void refresh();
    document.addEventListener("visibilitychange", shown);
    window.addEventListener("focus", shown);
    return () => {
      live = false;
      controller?.abort();
      document.removeEventListener("visibilitychange", shown);
      window.removeEventListener("focus", shown);
    };
  }, []);
}
