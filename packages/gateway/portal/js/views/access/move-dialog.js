// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Moves a connection to another access level.
//
// Moving onto an existing level gives the connection that level's
// permissions, and the dialog says so before it happens; moving onto a new
// level creates one that copies the permissions the connection has now.

import { html } from "htm/preact";
import { useState } from "preact/hooks";

import { CapabilityTriad } from "../../components/grant-builder.js";
import { Modal } from "../../components/modal.js";
import { ACCESS_NAME_MAX, NewLevelChoice, levelNameTaken, validAccessName } from "./name-fields.js";
import { LEVEL_HELPER, accessRules, levelUsersLabel } from "./shared.js";

const NEW_LEVEL = "new";

/**
 * The first name a new level can take without colliding with a live one:
 * `base`, then `base 2`, `base 3`… compared without regard to case, the way the
 * gateway compares level names, and cut so the suffix fits the name limit.
 */
export function firstFreeLevelName(base, levels) {
  const taken = new Set(levels.map((level) => level.name.trim().toLowerCase()));
  const root = base.trim().slice(0, ACCESS_NAME_MAX);
  if (!taken.has(root.toLowerCase())) return root;
  for (let suffix = 2; ; suffix += 1) {
    const tail = ` ${suffix}`;
    const candidate = `${root.slice(0, ACCESS_NAME_MAX - tail.length)}${tail}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/**
 * `onSubmit(target)` performs the move with `{ levelId, expectedLevelRevision }`
 * — the revision of the level as the dialog showed it — or `{ newLevel: { name } }`; `error` is the refusal to show inside the dialog,
 * which stays open so the owner can choose again.
 */
export function MoveConnectionDialog({ entry, levels, overview, busy = false, error = "", onSubmit, onClose }) {
  const others = levels.filter((level) => level.id !== entry.levelId);
  const [selected, setSelected] = useState(others.length === 0 ? NEW_LEVEL : null);
  const [levelName, setLevelName] = useState(() => firstFreeLevelName(entry.name, levels));
  const chosen = others.find((level) => level.id === selected) ?? null;
  const ready = selected === NEW_LEVEL
    ? validAccessName(levelName) && !levelNameTaken(levelName, levels)
    : Boolean(chosen);
  const radioName = `access-move-${entry.grant.id}`;

  const submit = (event) => {
    event.preventDefault();
    if (!ready || busy) return;
    onSubmit(selected === NEW_LEVEL
      ? { newLevel: { name: levelName.trim() } }
      : { levelId: chosen.id, expectedLevelRevision: chosen.revision });
  };

  return html`<${Modal} open title="Move to another access level" subtitle=${entry.name} onClose=${busy ? () => {} : onClose}>
    <form class="access-dialog-form" onSubmit=${submit}>
      <p class="access-dialog-note">${LEVEL_HELPER}</p>
      <fieldset class="access-choice-list" disabled=${busy}>
        <legend class="sr-only">${`Access level for ${entry.name}`}</legend>
        ${others.map((level) => html`<label class="access-choice-option" key=${level.id}>
          <input type="radio" name=${radioName} checked=${selected === level.id} onChange=${() => setSelected(level.id)} />
          <span class="access-choice-text">
            <strong>${level.name}</strong>
            <small>${levelUsersLabel(level)}</small>
          </span>
          <${CapabilityTriad} rules=${accessRules(level, overview)} />
        </label>`)}
        <${NewLevelChoice}
          radioName=${radioName}
          checked=${selected === NEW_LEVEL}
          onSelect=${() => setSelected(NEW_LEVEL)}
          fieldId=${`access-move-level-name-${entry.grant.id}`}
          levelName=${levelName}
          onLevelName=${setLevelName}
          levels=${levels}
          disabled=${busy}
        />
      </fieldset>
      ${chosen
        ? html`<p class="access-dialog-note">${`${entry.name} will get the permissions of ${chosen.name}.`}</p>`
        : null}
      ${selected === NEW_LEVEL
        ? html`<p class="access-dialog-note">${`“${entry.name}” will keep its current permissions on the new access level.`}</p>`
        : null}
      ${error ? html`<p class="access-error" role="alert">${error}</p>` : null}
      <div class="access-dialog-actions">
        <button type="button" class="btn-secondary" disabled=${busy} onClick=${onClose}>Cancel</button>
        <button type="submit" class="btn-primary" disabled=${busy || !ready}>${busy ? "Moving…" : "Move"}</button>
      </div>
    </form>
  </${Modal}>`;
}
