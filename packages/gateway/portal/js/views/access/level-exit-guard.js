// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { ConfirmModal } from "../../components/confirm-modal.js";
import { setRouteLeaveGuard } from "../../lib/router.js";

export function useLevelExitGuard(dirty, busy, onClose, inFlight) {
  const active = useRef(dirty);
  const pending = useRef(busy);
  pending.current = busy;
  const blocked = () => pending.current || inFlight?.current === true;
  const cleared = useRef(false);
  const [confirm, setConfirm] = useState(false);
  active.current = dirty && !cleared.current;
  useEffect(() => {
    setRouteLeaveGuard(() =>
      blocked() ? false : active.current ? "Discard your unsaved access-level changes?" : null,
    );
    const warn = (event) => {
      if (active.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => {
      setRouteLeaveGuard(null);
      window.removeEventListener("beforeunload", warn);
    };
  }, []);
  const leave = () => {
    if (blocked() || cleared.current) return;
    cleared.current = true;
    active.current = false;
    setRouteLeaveGuard(null);
    onClose();
  };
  return {
    close: () => {
      if (blocked()) return;
      if (dirty) setConfirm(true);
      else leave();
    },
    saved: () => {
      cleared.current = true;
      active.current = false;
      setRouteLeaveGuard(null);
    },
    confirmation: html`<div class="guided-exit-confirmation">
      <${ConfirmModal}
        open=${confirm}
        title="Discard this draft?"
        body="Your saved access level will not change. Unsaved choices in this draft will be lost."
        confirmLabel="Discard draft"
        cancelLabel="Keep editing"
        confirmDisabled=${busy}
        cancelDisabled=${busy}
        onCancel=${() => setConfirm(false)}
        onConfirm=${leave}
      />
    </div>`,
  };
}
