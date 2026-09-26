// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Agent access as one grouped list: each access level as a card, with the
// connections that use it beneath its header.
//
// An access level holds permissions; a connection — one approved agent
// install — always uses exactly one level, so the list reads top-down the way
// the relationship does. A level's header says what its permissions allow
// (capabilities, source scope, Answer privacy) and how many connections share
// them; its menu edits, renames or deletes it. Each connection row
// under that header, says which app signed in and when it was last used; its
// menu renames it, moves it to another level, or removes it. Connection
// IDs, sign-in facts and permission terms are always visible.
//
// Every count here is of live connections — neither removed nor expired — the
// rule the gateway counts a level's connections by and refuses a deletion by.

import { html } from "htm/preact";
import { useRef, useState } from "preact/hooks";

import { CopyIconButton } from "../../components/copy-button.js";
import { CapabilityTriad } from "../../components/grant-builder.js";
import { RowActionMenu } from "../../components/row-action-menu.js";
import { timeAgo } from "../../lib/format.js";
import { KindIcon } from "../../lib/device-kind-icon.js";
import { navigate } from "../../lib/router.js";
import { LEVEL_NAME_TAKEN_MESSAGE, RenameField, levelNameTaken } from "./name-fields.js";
import {
  accessRules,
  connectionCountLabel,
  deviceCountLabel,
  levelDevices,
  effectiveAccessState,
  isLiveConnection,
  liveConnectionCount,
  overviewPolicies,
  timestamp,
} from "./shared.js";
import { AgentIcon, agentIconForApp } from "./agent-brand.js";
import { AccessTerms, AnswerPrivacy, reachSummary } from "./terms.js";

/** An integration on the Devices page, opened and scrolled to, drawn with its kind's icon. */
function DeviceLink({ device }) {
  const href = `/portal/settings/devices?device=${encodeURIComponent(device.id)}`;
  return html`<a
    class="access-device-link"
    href=${href}
    onClick=${(event) => { event.preventDefault(); navigate(href); }}
  ><${KindIcon} kind=${device.kind} size=${13} class="access-device-icon" />${device.name}</a>`;
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
 * How many live connections a level's header reports, nothing when it lists
 * none, and how many integrations use it when any do.
 */
function countText(count, listed, devices = 0) {
  const connections = listed === 0 ? "" : count > 0 ? connectionCountLabel(count) : "No active connections";
  return [connections, devices > 0 ? deviceCountLabel(devices) : ""].filter(Boolean).join(" · ");
}

/**
 * What a connection shows, in labelled fields: its ID to copy, when
 * its current sign-in was made and when it was last used. A connection
 * holding several sign-ins lists each of them as well.
 */
function ConnectionDetail({ entry, id }) {
  const signIns = newestFirst(entry.signIns);
  return html`<div class="access-connection-detail" id=${id}>
    <dl class="access-connection-facts">
      <div class="access-fact-id">
        <dt>Connection ID</dt>
        <dd>
          <code>${entry.id}</code>
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
    </dl>
    ${signIns.length > 1
      ? html`<ul class="access-sign-ins" aria-label=${`Sign-ins of ${entry.name}`}>
          ${signIns.map((credential) => html`<li key=${credential.id} class="access-sign-in">
            <span>${signInLabel(credential)}</span>
            <${StateTag} state=${effectiveAccessState({ ...credential, revokedAt: null })} />
          </li>`)}
        </ul>`
      : null}
  </div>`;
}

/**
 * One connection.
 *
 * Renaming happens in the row: the name becomes a field and, whichever way the
 * field closes, focus returns to the row's action menu so the keyboard is not
 * dropped on the page. Expired access is not moved back to life from here; it
 * can still be renamed and removed. The app and last use are labelled
 * beneath the connection name.
 */
function ConnectionRow({ entry, actions }) {
  const [renaming, setRenaming] = useState(false);
  const actionsRef = useRef(null);
  const closeRename = () => {
    setRenaming(false);
    actionsRef.current?.querySelector(".row-action-trigger")?.focus();
  };
  const detailId = `access-connection-detail-${entry.grant.id}`;
  const app = connectionApp(entry);
  const icon = agentIconForApp(app);
  const items = [
    { label: "Rename", onSelect: () => setRenaming(true) },
    ...(isLiveConnection(entry)
      ? [{ label: "Move to another access level…", onSelect: () => actions.onMove(entry) }]
      : []),
    { label: "Remove", onSelect: () => actions.onRemove(entry), danger: true },
  ];

  return html`<li class="access-connection-item">
    <div class=${`access-connection-row${entry.state === "active" ? "" : " is-inactive"}`}>
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
          ${app ? html`<span class="access-app-cell">${icon ? html`<span class="access-agent-logo" aria-hidden="true"><${AgentIcon} icon=${icon} size=${14} /></span>` : null}<span class="access-app-label">Signed in from ${app}</span></span><span aria-hidden="true"> · </span>` : null}
          <span class="access-used-cell">${entry.lastUsedAt ? `Last used ${timeAgo(entry.lastUsedAt)}` : "Never used"}</span>
        </div>
      </div>
      <div class="access-row-actions" ref=${actionsRef}>
        <${RowActionMenu} items=${items} label=${`Actions for ${entry.name}`} />
      </div>
    </div>
    <${ConnectionDetail} entry=${entry} id=${detailId} />
  </li>`;
}

function ConnectionList({ connections, label, actions }) {
  return html`<ul class="access-connection-list" aria-label=${label}>
    ${connections.map((entry) => html`<${ConnectionRow} key=${entry.grant.id} entry=${entry} actions=${actions} />`)}
  </ul>`;
}

/**
 * One level and the connections that use it.
 *
 * Deleting is offered only for a level no live connection uses: the gateway
 * refuses the rest, and the menu says what to do first instead of letting the
 * owner find out from a refusal. Expired connections are still listed under
 * the level, but they neither count nor keep it from being deleted. A new name
 * another listed level already has is refused in the field, before it is sent.
 */
function LevelGroup({ level, levels, connections, overview, levelActions, connectionActions }) {
  const [renaming, setRenaming] = useState(false);
  const rules = accessRules(level, overview);
  const reach = reachSummary(rules, overview);
  const titleId = `access-level-title-${level.id}`;
  const termsId = `access-level-terms-${level.id}`;
  const count = liveConnectionCount(level, connections);
  const devices = levelDevices(level);
  const inUse = count > 0 || devices.length > 0;
  const items = [
    { label: "Edit permissions", onSelect: () => levelActions.onEdit(level) },
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
        ${renaming
          ? html`<${RenameField}
              id=${level.id}
              name=${level.name}
              validate=${(name) => levelNameTaken(name, levels, level.id) ? LEVEL_NAME_TAKEN_MESSAGE : ""}
              onSave=${async (name) => {
                const saved = await levelActions.onRename(level, name);
                if (saved) setRenaming(false);
                return saved;
              }}
              onCancel=${() => setRenaming(false)}
            />`
          : null}
        <h3 id=${titleId} class=${`access-level-name${renaming ? " sr-only" : ""}`}>${level.name}</h3>
        <span class="access-count-cell">${countText(count, connections.length, devices.length)}</span>
      </div>
      <${CapabilityTriad} rules=${rules} />
      <span class="access-reach-cell"><span class="sr-only">Sources: </span>${reach ?? "—"}</span>
      <span class="access-head-divider" aria-hidden="true"></span>
      <span class=${`access-privacy-cell${rules.answer?.release.mode === "unreviewed" ? " access-unreviewed" : ""}`}>
        <span class="sr-only">Answer privacy: </span>${rules.answer
          ? html`<${AnswerPrivacy} rule=${rules.answer} policies=${overviewPolicies(overview)} />`
          : "—"}
      </span>
      <${RowActionMenu} items=${items} label=${`Actions for ${level.name}`} />
    </div>
    <div id=${termsId} class="access-level-terms"><${AccessTerms} rules=${rules} overview=${overview} /></div>
    <div class="access-level-body">
      ${connections.length > 0
        ? html`<${ConnectionList} connections=${connections} label=${`Connections using ${level.name}`} actions=${connectionActions} />`
        : devices.length === 0
          ? html`<p class="access-level-empty">No connections use this access level yet.</p>`
          : null}
      ${devices.length > 0
        ? html`<p class="access-level-devices">
            Answers for ${devices.map((device, index) => html`${index > 0 ? ", " : ""}<${DeviceLink} key=${device.id} device=${device} />`)}
          </p>`
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
              <span class="access-count-cell">${countText(others.filter(isLiveConnection).length, others.length)}</span>
            </div>
          </div>
          <div class="access-level-body">
            <${ConnectionList} connections=${others} label="Other connections" actions=${connectionActions} />
          </div>
        </section>`
      : null}
  </div>`;
}
