// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Keep each control with the final rendered word/link, without nesting interactive elements. */
export function bindClaimIndicatorTails(root) {
  const doc = root.ownerDocument;
  for (const button of root.querySelectorAll(".kn-claim-indicator")) {
    let previous = button.previousSibling;
    if (previous?.nodeType === 3) {
      const text = previous.textContent.replace(/[\s\u2060]+$/, "");
      previous.textContent = text;
      if (!text) { const empty = previous; previous = empty.previousSibling; empty.remove(); }
    }
    if (!previous) continue;
    // A nested claim ending at the same position already has a bound tail.
    let last = previous;
    while (last?.nodeType === 1 && !last.classList.contains("kn-claim-tail")) {
      last = last.lastChild;
      while (last?.nodeType === 3 && !last.textContent.trim()) last = last.previousSibling;
    }
    if (last?.nodeType === 1 && last.classList.contains("kn-claim-tail")) {
      last.append(button);
      continue;
    }
    const tail = doc.createElement("span");
    tail.className = "kn-claim-tail";
    if (previous.nodeType === 3) {
      const match = /\S+$/.exec(previous.textContent);
      if (!match) continue;
      const word = doc.createElement("span");
      word.textContent = match[0];
      previous.textContent = previous.textContent.slice(0, match.index);
      button.before(tail);
      tail.append(word, button);
    } else if (previous.nodeType === 1 && /^(A|EM|STRONG|DEL|CODE|SPAN)$/.test(previous.tagName)) {
      previous.before(tail);
      tail.append(previous, button);
    }
  }
}
