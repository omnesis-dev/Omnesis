// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// The ways the Access pages take a name: in place of a name already on a row,
// as a labelled field in a form, and as the name of a new access level inside
// the choice that creates it. Connections and access levels share the
// gateway's limits, so they share these fields.

import { html } from "htm/preact";
import { useEffect, useRef, useState } from "preact/hooks";

// The longest name the gateway takes for a connection or an access level, so
// a field stops where a save would.
export const ACCESS_NAME_MAX = 120;

/** What every page says when a new level name is one a live level already has. */
export const LEVEL_NAME_TAKEN_MESSAGE = "An access level with that name already exists.";

/** Whether a typed name is one the gateway takes: something left once trimmed. */
export function validAccessName(value) {
  return value.trim().length > 0;
}

/**
 * Whether `name` is already taken by one of `levels`, compared trimmed and
 * without regard to case — the way the gateway compares live level names. A
 * level being renamed passes its own id as `exceptId`, since its current name
 * does not collide with itself.
 */
export function levelNameTaken(name, levels, exceptId = null) {
  const wanted = name.trim().toLowerCase();
  if (!wanted) return false;
  return levels.some((level) => level.id !== exceptId && level.name.trim().toLowerCase() === wanted);
}

/**
 * A labelled name field that says, in place, what is wrong with the name.
 *
 * `emptyMessage` is the sentence for an empty field; the field reports it the
 * moment the name is gone rather than waiting for a submit, because the button
 * it blocks is already disabled. A caller whose field starts empty passes no
 * message until the owner has typed, so a fresh form does not open on a
 * complaint. `conflictMessage` is the caller's sentence for a name that is
 * there but cannot be used, shown the same way.
 *
 * `inline` puts the label beside the field instead of above it; the stylesheet
 * stacks them again where the line is too narrow.
 */
export function NameField({
  id,
  label,
  value,
  onInput,
  emptyMessage = "",
  conflictMessage = "",
  disabled = false,
  inline = false,
}) {
  const message = validAccessName(value) ? conflictMessage : emptyMessage;
  const messageId = `${id}-message`;
  return html`<div class=${`access-name-field${inline ? " is-inline" : ""}`}>
    <label for=${id}>${label}</label>
    <input
      id=${id}
      type="text"
      maxlength=${ACCESS_NAME_MAX}
      value=${value}
      disabled=${disabled}
      aria-invalid=${message ? "true" : undefined}
      aria-describedby=${message ? messageId : undefined}
      onInput=${(event) => onInput(event.currentTarget.value)}
    />
    ${message ? html`<p id=${messageId} class="access-field-error" role="alert">${message}</p>` : null}
  </div>`;
}

/**
 * The "New access level" choice in a list of levels, with the new level's
 * name inside it once it is chosen.
 *
 * The radio's own label stops at the title, so the name field — which has a
 * label of its own — sits beside it in the card rather than inside it. A name
 * any of `levels` already has is refused in place.
 */
export function NewLevelChoice({
  radioName,
  checked,
  onSelect,
  fieldId,
  levelName,
  onLevelName,
  levels,
  disabled = false,
}) {
  return html`<div class="access-choice-option has-field">
    <label class="access-choice-main">
      <input type="radio" name=${radioName} checked=${checked} disabled=${disabled} onChange=${onSelect} />
      <span class="access-choice-text"><strong>New access level</strong></span>
    </label>
    ${checked
      ? html`<${NameField}
          id=${fieldId}
          label="Access level name"
          value=${levelName}
          onInput=${onLevelName}
          emptyMessage="Enter a name for this access level."
          conflictMessage=${levelNameTaken(levelName, levels) ? LEVEL_NAME_TAKEN_MESSAGE : ""}
          disabled=${disabled}
          inline
        />`
      : null}
  </div>`;
}

/**
 * A row's name as a field, in the place the name was.
 *
 * Enter saves and Escape cancels, and focus lands in the field as it opens
 * so the keyboard is already there. A blank name is refused here, without a
 * round trip, since the gateway would refuse it too, and so is any name
 * `validate(name)` answers with a sentence for; the name already held is a
 * cancel rather than a save. Any other refusal is the page's to show, and the
 * field stays open with what was typed so the owner can try again.
 * `onSave` answers whether the name was taken.
 */
export function RenameField({ id, name, onSave, onCancel, validate = () => "" }) {
  const [value, setValue] = useState(name);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const inputRef = useRef(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select?.();
  }, []);

  const submit = async (event) => {
    event.preventDefault();
    if (saving) return;
    const next = value.trim();
    if (next === name) {
      onCancel();
      return;
    }
    const refusal = next ? validate(next) : "Enter a name.";
    if (refusal) {
      setMessage(refusal);
      inputRef.current?.focus();
      return;
    }
    setSaving(true);
    const saved = await onSave(next);
    if (!saved) setSaving(false);
  };
  const messageId = `access-rename-message-${id}`;

  return html`<form
    class="access-rename"
    onSubmit=${submit}
    onClick=${(event) => event.stopPropagation()}
  >
    <input
      ref=${inputRef}
      type="text"
      class="access-rename-input"
      aria-label=${`New name for ${name}`}
      aria-invalid=${message ? "true" : undefined}
      aria-describedby=${message ? messageId : undefined}
      maxlength=${ACCESS_NAME_MAX}
      value=${value}
      disabled=${saving}
      onInput=${(event) => {
        setValue(event.currentTarget.value);
        if (message) setMessage("");
      }}
      onKeyDown=${(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        onCancel();
      }}
    />
    <button type="submit" class="btn-tiny" disabled=${saving}>${saving ? "Saving…" : "Save"}</button>
    <button type="button" class="btn-tiny" disabled=${saving} onClick=${onCancel}>Cancel</button>
    ${message ? html`<span id=${messageId} class="access-rename-message" role="alert">${message}</span>` : null}
  </form>`;
}
