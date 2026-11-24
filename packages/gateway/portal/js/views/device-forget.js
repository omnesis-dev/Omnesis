// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { html } from "htm/preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { getDeviceForgetImpact, forgetDevice } from "../api.js";
import { ConfirmModal } from "../components/confirm-modal.js";
import { sourceLabel } from "../lib/format.js";
import { errorMessage } from "./access/shared.js";

/** One device's current source impact is reviewed before its identity is forgotten. */
export function DeviceForgetDialog({ device, onClose, onForgotten }) {
  const [impact, setImpact] = useState(null);
  const [data, setData] = useState("keep");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState(null);
  const [pending, setPending] = useState(false);
  const [revision, setRevision] = useState(0);
  const submitting = useRef(false);

  useEffect(() => {
    let active = true;
    setImpact(null);
    setData("keep");
    setConfirmDelete(false);
    getDeviceForgetImpact(device.id).then(
      (result) => { if (active) setImpact(result); },
      (err) => { if (active) setError(errorMessage(err, "The device's sources could not be checked.")); },
    );
    return () => { active = false; };
  }, [device.id, revision]);

  const sources = impact?.sources ?? [];
  const deleting = sources.length > 0 && data === "delete";
  async function confirm() {
    if (submitting.current) return;
    if (!impact) {
      setError(null);
      setRevision((value) => value + 1);
      return;
    }
    if (deleting && !confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    submitting.current = true;
    setPending(true);
    setError(null);
    try {
      await forgetDevice(device.id, { data, impactFingerprint: impact.fingerprint });
      await onForgotten();
    } catch (err) {
      const changed = err?.code === "DEVICE_FORGET_IMPACT_CHANGED" || err?.code === "DEVICE_STILL_HOSTS_SOURCES";
      setError(changed ? "This device’s sources changed. Review them again before forgetting it." : errorMessage(err, "The device could not be forgotten."));
      if (err?.code === "DEVICE_FORGET_IMPACT_CHANGED" || err?.code === "DEVICE_STILL_HOSTS_SOURCES") {
        setRevision((value) => value + 1);
      }
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }

  return html`<${ConfirmModal}
    open=${true}
    title=${confirmDelete ? `Delete data from "${device.name}"?` : `Forget device "${device.name}"?`}
    body=${html`
      <p>This device will lose access permanently. Its pairing and sync warnings will stop.</p>
      ${!impact && !error && html`<p>Checking this device's sources…</p>`}
      ${impact && sources.length === 0 && html`<p>This device hosts no sources.</p>`}
      ${sources.length > 0 && html`
        <p>${sources.length} source${sources.length === 1 ? "" : "s"} affected:</p>
        <ul class="device-forget-sources">
          ${sources.map((source) => html`<li key=${source.id}>${sourceLabel(source.id)}
            ${source.deleteScope === "none" && html`<span class="text-muted"> — shared or previously kept history stays</span>`}
          </li>`)}
        </ul>
        ${confirmDelete ? html`
          <p>Data held only by this device will be permanently deleted from Omnesis. Other devices' data, shared data still in use and history kept from earlier forgotten devices will stay. This cannot be undone.</p>
        ` : html`
          <fieldset class="device-forget-options" disabled=${pending}>
            <legend>What should happen to its data?</legend>
            <label><input type="radio" name="forget-device-data" value="keep" checked=${data === "keep"} onChange=${() => setData("keep")} /> Keep historical data</label>
            <p>Keep its indexed history searchable, without expecting this device to sync again.</p>
            <label><input type="radio" name="forget-device-data" value="delete" checked=${data === "delete"} onChange=${() => setData("delete")} /> Remove this device's data</label>
            <p>Delete data held only by this device. You will confirm this separately.</p>
          </fieldset>
        `}
      `}
      ${error && html`<div class="devices-banner error" role="alert">${error}</div>`}
    `}
    confirmLabel=${pending ? "Working…" : !impact ? "Retry" : confirmDelete ? "Forget and delete data" : deleting ? "Continue" : "Forget device"}
    confirmDisabled=${pending || (!impact && !error)}
    cancelDisabled=${pending}
    destructive=${confirmDelete}
    onCancel=${() => { if (!submitting.current) onClose(); }}
    onConfirm=${confirm}
  />`;
}
