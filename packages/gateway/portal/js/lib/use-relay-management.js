// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { useEffect, useRef, useState } from "preact/hooks";
import { relayManagement, relayError, googleAuthorizationUrl } from "./cloud-relay-api.js";

/** One request at a time; a mutation invalidates any older status read. */
export function useRelayManagement() {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const active = useRef(null);
  const mounted = useRef(false);
  const run = async (operation = "", input = {}) => {
    if (!mounted.current) return;
    if (operation && active.current?.operation) return;
    if (!operation && active.current) return;
    active.current?.controller.abort();
    const controller = new AbortController();
    const attempt = { controller, operation };
    active.current = attempt;
    setBusy(operation || "refresh"); setError("");
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const result = await relayManagement(operation, input, controller.signal);
      if (controller.signal.aborted) throw new Error("Request expired");
      // Replacement and unmount both abort this request before clearing it.
      if (operation === "google/link") window.location.assign(googleAuthorizationUrl(result.authorizeUrl, status?.config?.relayUrl));
      else setStatus(result);
    } catch (error) {
      if (mounted.current && active.current === attempt) setError(relayError(error?.code) || "Couldn't load or update the relay. Check the connection and try again.");
    } finally {
      clearTimeout(timeout);
      if (mounted.current && active.current === attempt) { active.current = null; setBusy(""); }
    }
  };
  useEffect(() => {
    mounted.current = true;
    void run();
    const timer = setInterval(() => { if (document.visibilityState !== "hidden") void run(); }, 5000);
    return () => { mounted.current = false; clearInterval(timer); active.current?.controller.abort(); active.current = null; };
  }, []);
  return { status, error, busy, run };
}
