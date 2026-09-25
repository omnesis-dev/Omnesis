// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Gateway-first fleet update controller for the passive release notice.
 *
 * The gateway owns target selection and durable operation state. This
 * component only reviews its opaque plan, starts that exact plan, and keeps
 * polling through the expected gateway restart. Ordinary per-device updates
 * remain on the Devices page and do not pass through this controller.
 */

import { html } from "htm/preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { getHostFleetUpdate, startHostFleetUpdate } from "../api.js";
import { useVisiblePoll } from "../lib/use-visible-poll.js";
import { ConfirmModal } from "./confirm-modal.js";
import { Modal } from "./modal.js";

const OPERATION_POLL_MS = 2_000;
const DEVICE_POLL_WINDOW_MS = 15 * 60_000;
const SUCCESS_VISIBLE_MS = 30_000;
const ACTIVE_STATES = new Set(["queued", "running"]);
const ACTIVE_DEVICE_STATES = new Set(["pending", "dispatched", "installed"]);

function operationActive(operation) {
  return operation != null && ACTIVE_STATES.has(operation.state);
}

export function deviceUpdatesActive(plan, operation) {
  const completedAt = Date.parse(operation?.completedAt ?? "");
  return (
    operation?.state === "succeeded" &&
    Number.isFinite(completedAt) &&
    Date.now() < completedAt + DEVICE_POLL_WINDOW_MS &&
    Array.isArray(plan?.devices) &&
    plan.devices.some(
      (device) =>
        device?.desiredVersion === plan.targetVersion &&
        ACTIVE_DEVICE_STATES.has(device?.updateState),
    )
  );
}

function deviceName(device) {
  return typeof device?.name === "string" && device.name.trim()
    ? device.name
    : "Unnamed device";
}

function devicePlanLine(device, targetVersion) {
  const disposition = device?.disposition;
  if (disposition?.kind === "update") {
    return `${deviceName(device)}: ${device.version ?? "unknown"} → ${targetVersion}${
      device.online === false ? " (offline — sent on reconnect)" : ""
    }`;
  }
  if (disposition?.kind === "current") {
    return `${deviceName(device)}: already at ${targetVersion}`;
  }
  if (disposition?.kind === "refused") {
    return `${deviceName(device)}: not commanded — ${disposition.reason ?? "update it on its own host"}`;
  }
  return `${deviceName(device)}: ${device.updateDetail ?? device.detail ?? "status unavailable"}`;
}

function deviceProgressLine(device, targetVersion) {
  if (device?.desiredVersion == null && device?.disposition?.kind === "current") {
    return devicePlanLine(device, targetVersion);
  }
  const detail = device?.updateDetail ?? device?.detail;
  switch (device?.updateState) {
    case "pending":
      return `${deviceName(device)}: queued${device.online === false ? " until it reconnects" : ""}${
        detail ? ` — ${detail}` : ""
      }`;
    case "dispatched":
      return `${deviceName(device)}: update running${detail ? ` — ${detail}` : ""}`;
    case "installed":
      return `${deviceName(device)}: installed ${targetVersion}, waiting for its new connection${
        detail ? ` — ${detail}` : ""
      }`;
    case "failed":
      return `${deviceName(device)}: failed${detail ? ` — ${detail}` : ""}`;
    case "restart-pending":
      return `${deviceName(device)}: manual restart required${detail ? ` — ${detail}` : ""}`;
    case "unsupported":
      return `${deviceName(device)}: not commanded${detail ? ` — ${detail}` : ""}`;
    default:
      return devicePlanLine(device, targetVersion);
  }
}

function operationLabel(state) {
  switch (state) {
    case "queued":
      return "Update queued";
    case "running":
      return "Updating fleet";
    case "succeeded":
      return "Fleet update complete";
    case "failed":
      return "Fleet update failed";
    default:
      return "Fleet update";
  }
}

function compactOperationDetail(detail) {
  if (typeof detail !== "string") return null;
  const compact = detail.replace(/\s+/g, " ").trim();
  if (!compact) return null;
  return compact.length <= 140 ? compact : `${compact.slice(0, 137)}…`;
}

function DevicePlan({ plan, progress = false }) {
  const devices = Array.isArray(plan?.devices) ? plan.devices : [];
  if (devices.length === 0) {
    return html`<p class="fleet-host-update-empty">No paired device needs a command.</p>`;
  }
  return html`
    <ul class="fleet-host-update-devices">
      ${devices.map(
        (device, index) => html`
          <li key=${device.id ?? index} class=${device.disposition?.kind === "refused" ? "refused" : ""}>
            ${progress
              ? deviceProgressLine(device, plan.targetVersion)
              : devicePlanLine(device, plan.targetVersion)}
          </li>
        `,
      )}
    </ul>
  `;
}

function OperationReport({ operation, plan }) {
  if (!operation?.detail && !operation?.output && !plan) return null;
  return html`
    <div class="fleet-host-update-report">
      ${operation.detail
        ? html`<p class="fleet-host-update-report-detail">${operation.detail}</p>`
        : null}
      ${operation.output ? html`<pre>${operation.output}</pre>` : null}
      ${plan ? html`<${DevicePlan} plan=${plan} progress=${true} />` : null}
    </div>
  `;
}

/**
 * Always mounted by the application shell: an operation can remain relevant
 * after the release check stops advertising its now-installed target.
 */
export function FleetHostUpdate({ releaseUpdate }) {
  const [plan, setPlan] = useState(null);
  const [operation, setOperation] = useState(null);
  const [checking, setChecking] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [starting, setStarting] = useState(false);
  const [detailsOperationId, setDetailsOperationId] = useState(null);
  const [error, setError] = useState(null);
  const [disconnected, setDisconnected] = useState(false);
  const [, setVisibilityClock] = useState(0);
  const requestGeneration = useRef(0);

  const hostOperationActive = operationActive(operation);
  const pendingDeviceUpdates = deviceUpdatesActive(plan, operation);

  async function refresh({ surfaceError = false } = {}) {
    const generation = ++requestGeneration.current;
    try {
      const response = await getHostFleetUpdate();
      if (generation !== requestGeneration.current) return null;
      setPlan(response?.plan ?? null);
      setOperation(response?.operation ?? null);
      setDisconnected(false);
      if (surfaceError) setError(null);
      return response;
    } catch (caught) {
      if (generation !== requestGeneration.current) return null;
      if (operationActive(operation)) {
        // A restart is part of the operation. Keep the last durable snapshot
        // on screen and let the next poll reconnect rather than treating the
        // expected outage as a failed operation or an expired session.
        setDisconnected(true);
      } else if (surfaceError) {
        setError(caught?.serverMessage ?? caught?.message ?? "Update planning is unavailable.");
      }
      return null;
    } finally {
      if (generation === requestGeneration.current) setChecking(false);
    }
  }

  useEffect(() => {
    void refresh();
    return () => {
      requestGeneration.current += 1;
    };
  }, [releaseUpdate?.currentVersion, releaseUpdate?.latestVersion]);

  useVisiblePoll(() => void refresh(), OPERATION_POLL_MS, {
    // The independent host runner finishes once it has dispatched the fleet.
    // Device acknowledgements and reconnects can arrive afterwards, so keep
    // refreshing for a bounded window after host completion. Offline devices
    // remain durably queued and must not make an open portal poll forever.
    enabled: hostOperationActive || pendingDeviceUpdates,
  });

  useEffect(() => {
    if (operation?.state !== "succeeded") return undefined;
    const completedAt = Date.parse(operation.completedAt ?? "");
    if (!Number.isFinite(completedAt)) return undefined;
    const remaining = completedAt + SUCCESS_VISIBLE_MS - Date.now();
    if (remaining <= 0) return undefined;
    const timer = window.setTimeout(() => setVisibilityClock((value) => value + 1), remaining);
    return () => window.clearTimeout(timer);
  }, [operation?.id, operation?.state, operation?.completedAt]);

  async function reviewPlan() {
    setChecking(true);
    setError(null);
    const response = await refresh({ surfaceError: true });
    if (response?.plan?.supported) setConfirming(true);
  }

  async function start() {
    if (!plan?.id || starting) return;
    setStarting(true);
    setError(null);
    // The gateway can stop after accepting the operation but before this
    // response reaches the browser. Treat a network loss from this point as
    // the expected outage and keep polling the durable record; a structured
    // HTTP refusal still clears the optimistic row and is shown normally.
    const awaitingStart = {
      id: "awaiting-start-response",
      targetVersion: plan.targetVersion,
      state: "queued",
      detail: "Confirming the gateway host updater started.",
    };
    setOperation(awaitingStart);
    setDisconnected(true);
    try {
      const response = await startHostFleetUpdate(plan.id);
      setOperation(response?.operation ?? awaitingStart);
      setConfirming(false);
      setDisconnected(false);
    } catch (caught) {
      if (typeof caught?.status === "number") {
        setOperation(null);
        setDisconnected(false);
        setError(caught?.serverMessage ?? caught?.message ?? "The fleet update could not start.");
      } else {
        setDisconnected(true);
      }
      setConfirming(false);
    } finally {
      setStarting(false);
    }
  }

  const completedAt = Date.parse(operation?.completedAt ?? "");
  const completedSuccessExpired =
    operation?.state === "succeeded" &&
    (!Number.isFinite(completedAt) || Date.now() >= completedAt + SUCCESS_VISIBLE_MS);
  const detailsOpen = operation != null && detailsOperationId === operation.id;
  const visible = operation != null ? detailsOpen || !completedSuccessExpired : releaseUpdate != null;
  if (!visible) return null;

  const supported = plan?.supported === true;
  const unsupported = plan?.supported === false;
  const active = operationActive(operation);
  const targetVersion = operation?.targetVersion ?? plan?.targetVersion ?? releaseUpdate?.latestVersion;
  const operationDetail = compactOperationDetail(operation?.detail);

  return html`
    <div class=${`sidebar-release fleet-host-update ${operation ? `state-${operation.state}` : ""}`} role="status">
      ${operation
        ? html`
            <strong>${operationLabel(operation.state)}</strong>
            <span>Target ${targetVersion}</span>
            ${(disconnected || operation.id === "awaiting-start-response") && active
              ? html`<span class="fleet-host-update-reconnect">Gateway is restarting. Reconnecting…</span>`
              : null}
            ${operationDetail ? html`<span>${operationDetail}</span>` : null}
            ${operation.detail || operation.output || plan
              ? html`<button
                  class="btn-link fleet-host-update-details-button"
                  onClick=${() => setDetailsOperationId(operation.id)}
                >View details</button>`
              : null}
            ${operation.state === "failed"
              ? supported
                ? html`
                  <button
                    class="btn-tiny fleet-host-update-button"
                    disabled=${checking}
                    onClick=${reviewPlan}
                  >${checking ? "Checking…" : "Retry update"}</button>
                  ${error ? html`<span class="fleet-host-update-error">${error}</span>` : null}
                `
                : plan?.unsupportedReason
                  ? html`<span>${plan.unsupportedReason}</span>`
                  : null
              : null}
          `
        : html`
            <span>Omnesis <strong>${releaseUpdate.latestVersion}</strong> is available.</span>
            ${unsupported
              ? html`
                  <button class="btn-tiny" disabled>Update fleet</button>
                  <span>${plan.unsupportedReason ?? "This gateway cannot start its own update."}</span>
                  <code>omnesis update --fleet</code>
                `
              : html`
                  <button
                    class="btn-tiny fleet-host-update-button"
                    disabled=${checking || active}
                    onClick=${reviewPlan}
                  >${checking ? "Checking…" : "Update fleet"}</button>
                  ${error
                    ? html`<span class="fleet-host-update-error">${error}</span>
                        <code>omnesis update --fleet</code>`
                    : null}
                  ${!supported && !checking && !error
                    ? html`<code>omnesis update --fleet</code>`
                    : null}
                `}
          `}
    </div>

    <${Modal}
      open=${detailsOpen}
      onClose=${() => setDetailsOperationId(null)}
      title="Fleet update details"
      subtitle=${`${operationLabel(operation?.state)} · Target ${targetVersion}`}
      size="lg"
    >
      <${OperationReport} operation=${operation} plan=${plan} />
    </${Modal}>

    <${ConfirmModal}
      open=${confirming}
      title="Update the Omnesis fleet?"
      confirmLabel=${starting ? "Starting…" : "Update fleet"}
      confirmDisabled=${starting}
      cancelDisabled=${starting}
      onCancel=${() => setConfirming(false)}
      onConfirm=${start}
      body=${plan
        ? html`
            <p><strong>${plan.currentVersion === plan.targetVersion
              ? `Gateway already at ${plan.targetVersion}; retry remaining devices`
              : `Gateway: ${plan.currentVersion} → ${plan.targetVersion}`}</strong></p>
            <p>Then update all commandable devices to ${plan.targetVersion}</p>
            <${DevicePlan} plan=${plan} />
            <p>The portal will reconnect after the gateway restarts. Progress remains visible while the update runs.</p>
          `
        : null}
    />
  `;
}

export { devicePlanLine, operationActive };
