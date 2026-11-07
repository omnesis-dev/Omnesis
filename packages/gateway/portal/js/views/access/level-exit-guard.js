// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { ConfirmModal } from "../../components/confirm-modal.js";
import { setRouteLeaveGuard } from "../../lib/router.js";

export function useLevelExitGuard(dirty, busy, onClose) {
  const active = useRef(dirty);
  const cleared = useRef(false);
  const [confirm, setConfirm] = useState(false);
  active.current = dirty && !cleared.current;
  useEffect(() => {
    setRouteLeaveGuard(() =>
      active.current ? "Discard your unsaved access-level changes?" : null,
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
    if (cleared.current) return;
    cleared.current = true;
    active.current = false;
    setRouteLeaveGuard(null);
    onClose();
  };
  return {
    close: () => {
      if (busy) return;
      if (dirty) setConfirm(true);
      else leave();
    },
    saved: () => {
      cleared.current = true;
      active.current = false;
      setRouteLeaveGuard(null);
    },
    confirmation: html`<${ConfirmModal}
      open=${confirm}
      title="Discard this draft?"
      body="Your saved access level will not change. Unsaved choices in this draft will be lost."
      confirmLabel="Discard draft"
      cancelLabel="Keep editing"
      onCancel=${() => setConfirm(false)}
      onConfirm=${leave}
    />`,
  };
}
