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
const IN_PROGRESS = ["waiting", "registering", "linking"];
export function relayPollInterval(status) {
  return IN_PROGRESS.includes(status?.connect?.state) ? 2000 : 5000;
}

/**
 * One request at a time; a mutation invalidates any older status read.
 * `run` resolves to the operation's result, or undefined when it failed or was superseded.
 */
export function useRelayManagement() {
  const [status, setStatus] = useState(null);
  // Only for the details a person copies when asking for help.
  const [version, setVersion] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const active = useRef(null);
  const mounted = useRef(false);
  const run = async (operation = "", input = {}, method = "POST") => {
    if (!mounted.current) return undefined;
    if (operation && active.current?.operation) return undefined;
    if (!operation && active.current) return undefined;
    active.current?.controller.abort();
    const controller = new AbortController();
    const attempt = { controller, operation };
    active.current = attempt;
    setBusy(operation || "refresh");
    setError("");
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const result = await relayManagement(operation, input, controller.signal, method);
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
        setError(
          relayError(error?.code) ||
            "Couldn't load or update your Omnesis account settings. Check the connection and try again.",
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
      if (document.visibilityState !== "hidden") void run();
    }, interval);
    return () => clearInterval(timer);
  }, [interval]);
  return { status, error, busy, run, version };
}
