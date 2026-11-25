// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { useEffect, useRef, useState } from "preact/hooks";
import { getTailscale } from "./tailscale-api.js";
import { useVisiblePoll } from "./use-visible-poll.js";

/**
 * Whether something the owner is waiting for may change within seconds: the
 * helper starting, a sign-in link being opened, the trusted certificate being
 * fetched, or the public address opening.
 */
export function tailscaleTransitioning(state) {
  if (!state?.enabled || state.helper?.state === "unavailable") return false;
  if (state.helper?.state === "starting" || state.helper?.state === "restarting") return true;
  if (state.connection === "starting" || state.connection === "needs-sign-in") return true;
  if (state.connection !== "connected") return false;
  if (state.certificate?.reason === "pending") return true;
  const pub = state.public;
  return Boolean(pub?.wanted) && ["off", "starting", "needs-enable"].includes(pub.state);
}

/** While a transition is under way the page follows it closely; otherwise a slow poll is enough. */
export function tailscalePollInterval(state) {
  return tailscaleTransitioning(state) ? 2000 : 10_000;
}

const TIMEOUT_MS = 10_000;
/**
 * A change that may ask for the owner's passkey first (turning the device on,
 * signing it in) waits for the person, not only for the network. The other
 * changes the page makes never ask: see routes/tailscale.ts.
 */
const STEP_UP_OPERATIONS = new Set(["enable", "sign-in"]);
const STEP_UP_TIMEOUT_MS = 130_000;

function messageOf(error, timedOut) {
  if (timedOut) return "The gateway didn't answer in time. Check the connection and try again.";
  return error?.serverMessage || error?.message || "Something went wrong. Try again.";
}

/**
 * The Tailscale page's state and its one-at-a-time requests. A change waits
 * for no read but replaces any read in flight; a read never interrupts a
 * change. Polling pauses while the browser tab is hidden.
 *
 * `run(operation, call, { onError })` performs `call(signal)` as `operation`
 * and resolves to its result, or undefined when it failed or was superseded.
 * A result shaped like the page's state replaces it. `onError(error)` may
 * return true to say it showed the failure itself; otherwise the page shows
 * it with a "Try again" that repeats the same call.
 *
 * `adopt(state)` takes a state another route answered with (Connectivity's
 * answer for new devices); a read that started before it can no longer
 * replace it.
 */
export function useTailscaleAdmin() {
  const [state, setState] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState("");
  const active = useRef(null);
  const mounted = useRef(false);
  // Bumped by `adopt`: a read that started before then answers with what it replaced.
  const adopted = useRef(0);

  const run = async (operation, call, options = {}) => {
    if (!mounted.current) return undefined;
    if (operation && active.current?.operation) return undefined;
    if (!operation && active.current) return undefined;
    active.current?.controller.abort();
    const controller = new AbortController();
    const attempt = { controller, operation, timedOut: false, adopted: adopted.current };
    active.current = attempt;
    setBusy(operation || "refresh");
    if (operation) setError(null);
    const timeout = setTimeout(() => {
      attempt.timedOut = true;
      controller.abort();
    }, STEP_UP_OPERATIONS.has(operation) ? STEP_UP_TIMEOUT_MS : TIMEOUT_MS);
    try {
      const result = await call(controller.signal);
      if (controller.signal.aborted) throw new Error("aborted");
      if (!mounted.current || active.current !== attempt) return undefined;
      const current = operation || attempt.adopted === adopted.current;
      if (current && result && typeof result === "object" && "connection" in result) setState(result);
      // A read that succeeds clears an earlier failed read, never a failed change.
      if (!operation) setError((current) => (current && !current.operation ? null : current));
      return result;
    } catch (cause) {
      if (mounted.current && active.current === attempt) {
        const handled = !attempt.timedOut && options.onError?.(cause) === true;
        if (!handled)
          setError({
            operation,
            message: messageOf(cause, attempt.timedOut),
            retry: () => run(operation, call, options),
          });
      }
      return undefined;
    } finally {
      clearTimeout(timeout);
      if (mounted.current && active.current === attempt) {
        active.current = null;
        setBusy("");
      }
    }
  };

  const refresh = () => run("", getTailscale);
  const adopt = (next) => {
    if (!mounted.current) return;
    adopted.current += 1;
    setState(next);
  };

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
      active.current?.controller.abort();
      active.current = null;
    };
  }, []);
  useVisiblePoll(() => void refresh(), tailscalePollInterval(state));

  return { state, error, busy, run, refresh, adopt };
}
