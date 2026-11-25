// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Settings view — everything that configures this gateway, on one page with
// tabs: the config file itself, Lab opt-ins, the standing instructions its agent runs under,
// the models that power its capabilities, the scheduled sweeps it makes over
// the corpus (experimental only), delegated agent access, the privacy policies
// that access is reviewed under, and the devices allowed to operate it.
//
// The tabs are lazy: opening Settings pulls in only the tab on screen, so the
// Models tab's model catalog and the Devices tab's QR/pairing machinery stay
// off the critical path until they're actually asked for.

import { html } from "htm/preact";
import { replaceRoute } from "../lib/router.js";
import { lazy } from "../lib/lazy.js";
import { WarningTriangle } from "../components/model-health.js";
import { AttentionIcon } from "../components/attention-icon.js";
import { settingsTabAttention } from "../lib/attention.js";
import { TabBar } from "../components/tab-bar.js";
import {
  settingsTabs,
  settingsTabAvailable,
  settingsTabParent,
  DEFAULT_SETTINGS_TAB,
  SETTINGS_TAB_KEYS,
  EXPERIMENTAL_SETTINGS_TABS,
} from "../lib/settings-tabs.js";

const LabView = lazy(() => import("./lab.js").then((m) => m.LabView));
const StorageView = lazy(() => import("./storage.js").then((m) => m.StorageView));
const ConfigView = lazy(() => import("./config.js").then((m) => m.ConfigView));
const OmnesisMdView = lazy(() => import("./omnesis-md.js").then((m) => m.OmnesisMdView));
const ModelsView = lazy(() => import("./models.js").then((m) => m.ModelsView));
const AccessView = lazy(() => import("./access.js").then((m) => m.AccessView));
const PoliciesView = lazy(() => import("./policies.js").then((m) => m.PoliciesView));
const DevicesView = lazy(() => import("./devices.js").then((m) => m.DevicesView));
const RelayView = lazy(() => import("./relay.js").then((m) => m.RelayView));
const TailscaleView = lazy(() => import("./tailscale.js").then((m) => m.TailscaleView));
const HostTailscaleView = lazy(() => import("./remote-access/own-pages.js").then((m) => m.HostTailscaleView));
const OwnAddressView = lazy(() => import("./remote-access/own-pages.js").then((m) => m.OwnAddressView));
const McpView = lazy(() => import("./remote-access/own-pages.js").then((m) => m.McpView));
const RemoteAccessView = lazy(() => import("./remote-access.js").then((m) => m.RemoteAccessView));
const SweepsView = lazy(() => import("./sweeps.js").then((m) => m.SweepsView));

const SUN_ICON = html`<svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="3.25"/><path d="M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3.05 3.05l1.05 1.05M11.9 11.9l1.05 1.05M3.05 12.95l1.05-1.05M11.9 4.1l1.05-1.05"/></svg>`;
const MOON_ICON = html`<svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 9.3A5.6 5.6 0 0 1 6.7 2.5 5.6 5.6 0 1 0 13.5 9.3z"/></svg>`;

export function SettingsView({
  tab,
  modelsSection,
  modelHealth,
  storagePressure,
  onStorageRefresh,
  onModelsRefresh,
  onLabChange,
  accessAuthorizationId,
  accessLevelId,
  accessNewLevel,
  accessConnect,
  pair,
  device,
  deviceAction,
  policyId,
  completeAccessInPortal,
  experimental = false,
  lab = { brain: experimental },
  labAvailable = false,
  tailscaleEmbed = false,
  // What waits for the owner's decision (`useAttention`), marked on the Devices and Access tabs.
  attention = null,
  theme = "dark",
  onThemeToggle,
  onLogout,
} = {}) {
  // The URL is the single source of truth for which tab is open — no mirrored
  // local state to drift out of sync — so a link into a specific tab (the
  // sidebar item, an agent error's "Configure the agent" link, a bookmark)
  // lands where it points.
  const requested = SETTINGS_TAB_KEYS.includes(tab) ? tab : DEFAULT_SETTINGS_TAB;
  // A link into a disabled feature lands on the default tab.
  const page =
    (!experimental && EXPERIMENTAL_SETTINGS_TABS.includes(requested)) || (requested === "sweeps" && !lab.brain) || (requested === "lab" && !labAvailable) || !settingsTabAvailable(requested, { tailscaleEmbed })
      ? DEFAULT_SETTINGS_TAB
      : requested;
  // A detail page (the Omnesis account, the Tailscale device) shows its parent tab as current.
  const parent = settingsTabParent(page);
  const activeTab = parent ?? page;

  // Mirror the chosen tab into the path so a refresh lands in the same place.
  // `replaceRoute` (replaceState + re-parse) keeps tab toggles out of the back
  // stack — matching the Debug page — while still re-deriving the route, so a
  // tab's URL-carried state resets to its defaults on a fresh visit.
  //
  // Re-selecting the tab already on screen is a no-op UNLESS that tab has a
  // page open below it, in which case clicking it walks back up to the tab's
  // own list rather than sitting inert. Four tabs open pages: Connectivity
  // labels its summary and the pages behind it (the Omnesis account and
  // relay, either Tailscale, the owner's own domain, the MCP server), Models both the capability grid and every capability's
  // detail, Policies both the list and one policy's editor, and Access both the
  // inventory and each of an access level's editor, a new level, an
  // authorization review, and the connect dialog.
  const switchTab = (next) => {
    const pageOpen = Boolean(
      parent
        || modelsSection
        || policyId
        || accessLevelId
        || accessNewLevel
        || accessAuthorizationId
        || accessConnect,
    );
    if (next === activeTab && !pageOpen) return;
    replaceRoute(`/portal/settings/${next}`);
  };

  return html`
    <div class="settings-view">
      <div class="settings-header">
        <div>
          <h1 class="settings-title">Settings</h1>
          <p class="settings-sub">
            Set up this gateway: its configuration file, the standing
            instructions its agent runs under, the models behind each
            capability, delegated agent access, the policies that review it, and
            the devices that operate it.
          </p>
        </div>
        <div class="settings-actions">
          <button
            type="button"
            class="btn-secondary settings-theme-btn"
            onClick=${onThemeToggle}
            title=${theme === "light" ? "Switch to dark mode" : "Switch to light mode"}
            aria-label=${theme === "light" ? "Switch to dark mode" : "Switch to light mode"}
          >
            ${theme === "light" ? MOON_ICON : SUN_ICON}
            <span>${theme === "light" ? "Dark mode" : "Light mode"}</span>
          </button>
          <button type="button" class="btn-secondary settings-logout-btn" onClick=${onLogout}>
            Logout
          </button>
        </div>
      </div>
      <${TabBar}
        style="margin-bottom:16px;"
        active=${activeTab}
        onSelect=${switchTab}
        tabs=${settingsTabs({ experimental, brain: lab.brain, labAvailable, tailscaleEmbed }).map((item) => {
          if (item.key === "models" && modelHealth?.warnings?.length) {
            return { ...item, label: html`${item.label} <${WarningTriangle} label="Models need attention" />` };
          }
          if (item.key === "storage" && storagePressure && storagePressure.state !== "normal") {
            return { ...item, label: html`${item.label} <${WarningTriangle} label="Storage needs attention" />` };
          }
          const waiting = settingsTabAttention(item.key, attention);
          return waiting ? { ...item, label: html`${item.label} <${AttentionIcon} label=${waiting} />` } : item;
        })}
      />
      ${activeTab === "lab" && html`<${LabView} onChange=${onLabChange} />`}
      ${activeTab === "config" && html`<${ConfigView} />`}
      ${activeTab === "storage" && html`<${StorageView} onChange=${onStorageRefresh} />`}
      ${activeTab === "omnesis-md" && html`<${OmnesisMdView} />`}
      ${activeTab === "models" && html`<${ModelsView} section=${modelsSection ?? null} onModelsRefresh=${onModelsRefresh} />`}
      ${parent && html`<button type="button" class="doc-back access-page-back remote-access-back" onClick=${() => switchTab(parent)}>← Connectivity</button>`}
      ${page === "account" && html`<${RelayView} part="account" />`}
      ${page === "relay" && html`<${RelayView} part="relay" />`}
      ${page === "host-tailscale" && html`<${HostTailscaleView} />`}
      ${page === "own-address" && html`<${OwnAddressView} />`}
      ${page === "mcp" && html`<${McpView} />`}
      ${page === "tailscale" && html`<${TailscaleView} />`}
      ${page === "connectivity" && html`<${RemoteAccessView} tailscaleEmbed=${tailscaleEmbed} />`}
      ${activeTab === "sweeps" && html`<${SweepsView} />`}
      ${activeTab === "access" && html`<${AccessView}
        authorizationId=${accessAuthorizationId ?? null}
        levelId=${accessLevelId ?? null}
        newLevel=${accessNewLevel ?? false}
        connectOpen=${accessConnect ?? false}
        completeInPortal=${completeAccessInPortal ?? false}
        tailscaleEmbed=${tailscaleEmbed}
      />`}
      ${activeTab === "policies" && html`<${PoliciesView} policyId=${policyId ?? null} />`}
      ${activeTab === "devices" && html`<${DevicesView} pairKindRequest=${pair ?? null} focusDeviceId=${device ?? null} deviceActionRequest=${deviceAction ?? null} tailscaleEmbed=${tailscaleEmbed} />`}
    </div>
  `;
}
