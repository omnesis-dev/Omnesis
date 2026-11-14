// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Produce an independent panel from a template checked out with native line endings. */
export function withoutPanelSection(html, section) {
  if (section !== "find" && section !== "notes") throw new Error("Unknown panel section");
  const block = new RegExp(
    `    <!-- ${section}:start -->[\\s\\S]*?    <!-- ${section}:end -->(?:\\r\\n|\\n|\\r|$)`,
  );
  if (!block.test(html)) throw new Error(`Missing ${section} section in panel template.`);
  return html.replace(block, "");
}
