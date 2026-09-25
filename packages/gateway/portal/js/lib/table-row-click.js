// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Anything inside a row that is already doing its own job when clicked.
 *
 * Matched with `matches()` rather than by tag name so roles and editable
 * regions are covered too: a shared helper is used by tables it was not
 * written against, and the cost of missing an entry here is hijacking
 * someone's click.
 */
const INTERACTIVE = [
  "button",
  "a",
  "input",
  "select",
  "textarea",
  "label",
  "summary",
  "[contenteditable]",
  '[role="menu"]',
  '[role="button"]',
  '[role="checkbox"]',
  '[role="switch"]',
  "[tabindex]",
].join(", ");

/**
 * Makes a table row activate from its own bare space.
 *
 * The handler goes on each `<td>` rather than on the `<tr>` so a row can leave
 * a cell out: the access table's actions column carries no handler, which is
 * what stops a click beside its menu button from toggling the row open.
 *
 * A click that started inside a control is left alone, and so is one whose
 * target is not inside the cell at all — a control that removes itself on
 * click leaves an ancestry that no longer reaches the cell, and guessing in
 * that case would activate the row on exactly the clicks it should ignore.
 * Modified clicks are left alone too, so the browser's own open-in-new-tab
 * and select gestures still belong to whatever the row contains.
 *
 * @param {() => void} activate what a click on the row's inert area does.
 * @returns {(event: Event) => void} a handler to spread onto every cell.
 */
export function rowActivateHandler(activate) {
  return (event) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    for (let node = event.target; node; node = node.parentElement) {
      if (node === event.currentTarget) {
        activate();
        return;
      }
      if (node.matches?.(INTERACTIVE)) return;
    }
  };
}
