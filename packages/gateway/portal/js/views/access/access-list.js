// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Agent access as one grouped list: each access level as a card, with the
// connections and integrations that use it beneath its header.
//
// An access level holds permissions; a connection — one approved agent
// install — always uses exactly one level, so the list reads top-down the way
// the relationship does. A level's header names it; the permissions table below
// lists each capability, whether it is granted and the terms it runs under.
// Its Edit button opens the level editor; its menu renames or deletes it. Each
// connection row under it says which app signed in and when it was last used;
// its menu renames it, moves it to another level, or removes it. Connection
// IDs, sign-in facts and permission terms are always visible.
//
// Whether a level is in use counts live connections only — neither removed nor
// expired — the rule the gateway refuses a deletion by. A section heading
// counts the rows listed beneath it, expired ones included, so the number
// always matches what is shown.

import { html } from "htm/preact";
import { useEffect, useRef, useState } from "preact/hooks";

import { CopyIconButton } from "../../components/copy-button.js";
import { RowActionMenu } from "../../components/row-action-menu.js";
import { timeAgo } from "../../lib/format.js";
import { ExternalAgentGlyph } from "../audit/shared.js";
import { KindIcon } from "../../lib/device-kind-icon.js";
import { navigate } from "../../lib/router.js";
import { LEVEL_NAME_TAKEN_MESSAGE, RenameField, levelNameTaken } from "./name-fields.js";
import {
  accessRules,
  levelDevices,
  effectiveAccessState,
  isLiveConnection,
  liveConnectionCount,
  timestamp,
} from "./shared.js";
import { AgentIcon, agentIconForApp } from "./agent-brand.js";
import { AccessTerms } from "./terms.js";

/** An integration on the Devices page, opened and scrolled to, drawn with its kind's icon unless `icon` is false. */
export function DeviceLink({ device, icon = true }) {
  const href = `/portal/settings/devices?device=${encodeURIComponent(device.id)}`;
  return html`<a
    class="access-device-link"
    href=${href}
    onClick=${(event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button > 0) return;
      event.preventDefault(); navigate(href);
    }}
  >${icon ? html`<${KindIcon} kind=${device.kind} size=${13} class="access-device-icon" />` : null}${device.name}</a>`;
}

/** An MCP connection on the Access page, focused and scrolled to. */
export function ConnectionLink({ connection }) {
  const href = `/portal/settings/access?connection=${encodeURIComponent(connection.id)}`;
  return html`<a class="access-device-link" href=${href} onClick=${(event) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button > 0) return;
    event.preventDefault(); navigate(href);
  }}><${ExternalAgentGlyph} />${connection.name}</a>`;
}

export function levelEditorPath(levelId) {
  return `/portal/settings/access/levels/${encodeURIComponent(levelId)}`;
}

/**
 * The connections under each level, by level name, and the connections no
 * listed level accounts for — a gateway that predates access levels, or a
 * level the overview answered without — so no access is ever left off the page.
 */
export function levelGroups(entries, levels) {
  const known = new Set(levels.map((level) => level.id));
  return {
    groups: levels.map((level) => ({
      level,
      connections: entries.filter((entry) => entry.levelId === level.id),
    })),
    others: entries.filter((entry) => !entry.levelId || !known.has(entry.levelId)),
  };
}

function appName(credential) {
  return typeof credential.clientName === "string" && credential.clientName.trim()
    ? credential.clientName.trim()
    : null;
}

function newestFirst(credentials) {
  return [...credentials].sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0));
}

/**
 * The app a connection signed in with, as it names itself: the newest sign-in
 * that carries a name. Null when none does.
 */
export function connectionApp(entry) {
  return newestFirst(entry.signIns).map(appName).find(Boolean) ?? null;
}

const STATE_LABELS = { "signed-out": "Signed out" };

function StateTag({ state }) {
  if (state === "active") return null;
  return html`<span class=${`access-revoked${state === "pending" ? " access-state-pending" : ""}`}>${STATE_LABELS[state] ?? state}</span>`;
}

/**
 * One sign-in of a connection in words: the app that made it, as it names
 * itself, and the day it was made. The app's name travels with the sign-in, so
 * it stays true when the connection is renamed.
 */
export function signInLabel(credential) {
  const app = appName(credential);
  const day = credential.createdAt
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(credential.createdAt))
    : null;
  return [app ? `Signed in from ${app}` : "Signed in", day].filter(Boolean).join(" · ");
}

/**
 * A connection ID as the row shows it: a UUID by its first group, which is
 * enough to tell connections apart at a glance; any other ID in full. The copy
 * button and the tooltip always carry the whole ID.
 */
export function shortConnectionId(id) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(id) ? id.slice(0, 8) : id;
}

/**
 * What a connection shows, in labelled fields: its ID to copy, when its
 * current sign-in was made and when it was last used.
 */
function ConnectionFacts({ entry, signIns }) {
  return html`<dl class="access-connection-facts">
    <div class="access-fact-id">
      <dt>Connection ID</dt>
      <dd>
        <code title=${entry.id}>${shortConnectionId(entry.id)}</code>
        <${CopyIconButton} text=${entry.id} class="btn-icon access-copy" title="Copy connection ID" />
      </dd>
    </div>
    <div>
      <dt>Signed in</dt>
      <dd>${signIns.length > 0
        ? timestamp(signIns[0].createdAt)
        : html`<span class="access-muted">${entry.hadSignIn ? "No active sign-in" : "No sign-in yet"}</span>`}</dd>
    </div>
    <div><dt>Last used</dt><dd>${timestamp(entry.lastUsedAt)}</dd></div>
  </dl>`;
}

/** The app's logo when it is one Omnesis recognizes, otherwise a generic agent mark. */
function ConnectionLogo({ app }) {
  const icon = agentIconForApp(app);
  return html`<span class="access-connection-logo" aria-hidden="true">${icon
    ? html`<span class="access-agent-logo"><${AgentIcon} icon=${icon} size=${22} /></span>`
    : html`<${ExternalAgentGlyph} />`}</span>`;
}

/**
 * One connection, on one line: the app's logo, the connection's name with the
 * app it signed in from and when it was last used, then its facts and its
 * menu. A connection holding several sign-ins lists each of them beneath.
 *
 * Renaming happens in the row: the name becomes a field and, whichever way the
 * field closes, focus returns to the row's action menu so the keyboard is not
 * dropped on the page. Expired access is not moved back to life from here; it
 * can still be renamed and removed.
 */
function ConnectionRow({ entry, actions }) {
  const [renaming, setRenaming] = useState(false);
  const actionsRef = useRef(null);
  useEffect(() => {
    if (new URLSearchParams(window.location?.search ?? "").get("connection") !== entry.id) return;
    actionsRef.current?.closest(".access-connection-item")?.scrollIntoView?.({ block: "center" });
    actionsRef.current?.querySelector(".row-action-trigger")?.focus();
  }, [entry.id]);
  const closeRename = () => {
    setRenaming(false);
    actionsRef.current?.querySelector(".row-action-trigger")?.focus();
  };
  const app = connectionApp(entry);
  const signIns = newestFirst(entry.signIns);
  const items = [
    { label: "Rename", onSelect: () => setRenaming(true) },
    ...(isLiveConnection(entry)
      ? [{ label: "Move to another access level…", onSelect: () => actions.onMove(entry) }]
      : []),
    { label: "Remove", onSelect: () => actions.onRemove(entry), danger: true },
  ];

  return html`<li class="access-connection-item" id=${`access-connection-${entry.grant.id}`}>
    <div class=${`access-connection-row is-${entry.state}${entry.state === "active" ? "" : " is-inactive"}`}>
      <${ConnectionLogo} app=${app} />
      <div class="access-connection-heading">
        <div class="access-cell-lead">
          ${renaming
            ? html`<${RenameField}
                id=${entry.grant.id}
                name=${entry.name}
                onSave=${async (name) => {
                  const saved = await actions.onRename(entry, name);
                  if (saved) closeRename();
                  return saved;
                }}
                onCancel=${closeRename}
              />`
            : html`<span class="access-connection-label">${entry.name}</span>`}
          <${StateTag} state=${entry.state} />
        </div>
        <div class="access-connection-meta">
          <span class="access-status-dot" aria-hidden="true"></span>
          ${app ? html`<span class="access-app-cell">Signed in from ${app}</span><span aria-hidden="true"> · </span>` : null}
          <span class="access-used-cell">${entry.lastUsedAt ? `Last used ${timeAgo(entry.lastUsedAt)}` : "Never used"}</span>
        </div>
      </div>
      <${ConnectionFacts} entry=${entry} signIns=${signIns} />
      <div class="access-row-actions" ref=${actionsRef}>
        <${RowActionMenu} items=${items} label=${`Actions for ${entry.name}`} />
      </div>
    </div>
    ${signIns.length > 1
      ? html`<ul class="access-sign-ins" aria-label=${`Sign-ins of ${entry.name}`}>
          ${signIns.map((credential) => html`<li key=${credential.id} class="access-sign-in">
            <span>${signInLabel(credential)}</span>
            <${StateTag} state=${effectiveAccessState({ ...credential, revokedAt: null })} />
          </li>`)}
        </ul>`
      : null}
  </li>`;
}

function ConnectionList({ connections, label, actions }) {
  return html`<ul class="access-connection-list" aria-label=${label}>
    ${connections.map((entry) => html`<${ConnectionRow} key=${entry.grant.id} entry=${entry} actions=${actions} />`)}
  </ul>`;
}

/** A list under a level, headed by what it holds and how many. */
function LevelSection({ title, count, children }) {
  return html`<div class="access-level-section">
    <h4 class="access-level-subhead">${title} <span class="access-level-count">(${count})</span></h4>
    ${children}
  </div>`;
}

// Lucide "pencil" (https://lucide.dev, ISC-licensed).
function PencilGlyph() {
  return html`<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" /><path d="m15 5 4 4" /></svg>`;
}

/**
 * One level and who uses it: the connections signed in under it and the
 * integrations it answers for.
 *
 * Editing the level's permissions is its primary action, so it is a button;
 * renaming and deleting live in the menu beside it. Deleting is offered only
 * for a level nothing live uses: the gateway refuses the rest, and the menu
 * says what to do first instead of letting the owner find out from a refusal.
 * Expired connections are still listed under the level, but they neither count
 * nor keep it from being deleted. A new name another listed level already has
 * is refused in the field, before it is sent.
 */
function LevelGroup({ level, levels, connections, overview, levelActions, connectionActions }) {
  const [renaming, setRenaming] = useState(false);
  const actionsRef = useRef(null);
  const closeRename = () => {
    setRenaming(false);
    actionsRef.current?.querySelector(".row-action-trigger")?.focus();
  };
  const rules = accessRules(level, overview);
  const titleId = `access-level-title-${level.id}`;
  const count = liveConnectionCount(level, connections);
  const devices = levelDevices(level);
  const inUse = count > 0 || devices.length > 0;
  const items = [
    { label: "Rename", onSelect: () => setRenaming(true) },
    {
      label: "Delete",
      onSelect: () => levelActions.onDelete(level),
      danger: true,
      disabled: inUse,
      hint: !inUse
        ? undefined
        : devices.length === 0
          ? "Move or remove its connections first."
          : count === 0
            ? "Move its integrations to another access level first."
            : "Move its connections and integrations off it first.",
    },
  ];

  return html`<section class="access-level-group" aria-labelledby=${titleId}>
    <div class="access-level-head">
      <div class="access-level-title">
        <span class="access-level-kicker" aria-hidden="true">Access level</span>
        ${renaming
          ? html`<${RenameField}
              id=${level.id}
              name=${level.name}
              validate=${(name) => levelNameTaken(name, levels, level.id) ? LEVEL_NAME_TAKEN_MESSAGE : ""}
              onSave=${async (name) => {
                const saved = await levelActions.onRename(level, name);
                if (saved) closeRename();
                return saved;
              }}
              onCancel=${closeRename}
            />`
          : null}
        <h3 id=${titleId} class=${`access-level-name${renaming ? " sr-only" : ""}`}>${level.name}</h3>
      </div>
      <div class="access-level-actions" ref=${actionsRef}>
        <button
          type="button"
          class="btn-secondary access-level-edit"
          aria-label=${`Edit access level ${level.name}`}
          onClick=${() => levelActions.onEdit(level)}
        ><${PencilGlyph} />Edit access level</button>
        <${RowActionMenu} items=${items} label=${`Actions for ${level.name}`} />
      </div>
    </div>
    <div class="access-level-terms"><${AccessTerms} rules=${rules} overview=${overview} /></div>
    <div class="access-level-body">
      ${connections.length > 0
        ? html`<${LevelSection} title="Connected agents" count=${connections.length}>
            <${ConnectionList} connections=${connections} label=${`Connections using ${level.name}`} actions=${connectionActions} />
          </${LevelSection}>`
        : devices.length === 0
          ? html`<p class="access-level-empty">No connections use this access level yet.</p>`
          : null}
      ${devices.length > 0
        ? html`<${LevelSection} title="Used by integrations" count=${devices.length}>
            <ul class="access-level-devices" aria-label=${`Integrations using ${level.name}`}>
              ${devices.map((device) => html`<li key=${device.id} class="access-device-item">
                <span class="access-connection-logo" aria-hidden="true"><${KindIcon} kind=${device.kind} size=${18} class="access-device-icon" /></span>
                <span class="access-device-heading">
                  <${DeviceLink} device=${device} icon=${false} />
                  <span class="access-device-meta">Integration device</span>
                </span>
              </li>`)}
            </ul>
          </${LevelSection}>`
        : null}
    </div>
  </section>`;
}

/**
 * Whether the page has nothing to list, so the list shows its empty state and
 * that state's own Connect an agent button.
 */
export function accessListIsEmpty(entries, levels) {
  return entries.length === 0 && levels.length === 0;
}

/**
 * Every access level with its connections, by level name.
 *
 * `onConnect` opens the connect dialog from the empty state; it is null when
 * OAuth is not configured and there is nothing to connect to. The empty state
 * then says why it offers no control, rather than asking for an action the
 * page cannot carry out.
 *
 * `levelActions` carries `onEdit(level)`, `onRename(level, name)` and
 * `onDelete(level)`; `connectionActions` carries `onRename(entry, name)`,
 * `onMove(entry)` and `onRemove(entry)`. Both renames answer whether the name
 * was taken.
 */
export function AccessList({ entries, levels, overview, levelActions, connectionActions, onConnect = null }) {
  if (accessListIsEmpty(entries, levels)) {
    return html`
      <div class="access-empty">
        <strong>No agent has access yet</strong>
        <span>${onConnect
          ? "Connect an agent to authorize ChatGPT, Claude, Codex or another MCP client."
          : "Authorizing an MCP client runs over OAuth, which needs the Gateway public URL. Set it on the Config tab and this page will offer it."}</span>
        ${onConnect && html`<button type="button" class="btn-primary" onClick=${onConnect}>Connect an agent</button>`}
      </div>
    `;
  }
  const { groups, others } = levelGroups(entries, levels);
  return html`<div class="access-list">
    ${groups.map(({ level, connections }) => html`<${LevelGroup}
      key=${level.id}
      level=${level}
      levels=${levels}
      connections=${connections}
      overview=${overview}
      levelActions=${levelActions}
      connectionActions=${connectionActions}
    />`)}
    ${others.length > 0
      ? html`<section class="access-level-group" aria-labelledby="access-other-connections-title">
          <div class="access-level-head">
            <div class="access-level-title">
              <h3 id="access-other-connections-title" class="access-level-name">Other connections</h3>
            </div>
          </div>
          <div class="access-level-body">
            <${LevelSection} title="Connected agents" count=${others.length}>
              <${ConnectionList} connections=${others} label="Other connections" actions=${connectionActions} />
            </${LevelSection}>
          </div>
        </section>`
      : null}
  </div>`;
}
