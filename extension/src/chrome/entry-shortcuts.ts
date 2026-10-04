// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Tooltips reflect Chrome's configured commands, including user-customized shortcuts. */
export function initEntryShortcuts(
  document: Document,
  commands: { getAll(): Promise<Array<{ name?: string; shortcut?: string }>> },
): void {
  void commands
    .getAll()
    .then((configured) => {
      for (const [id, name, label] of [
        ["tell-omnesis", "tell-omnesis", "Tell Omnesis"],
        ["find-omnesis", "find-omnesis", "Find in Omnesis"],
      ] as const) {
        const button = document.getElementById(id);
        if (!button) continue;
        const shortcut = configured.find((command) => command.name === name)?.shortcut;
        button.title = shortcut
          ? `${label} · ${shortcut}`
          : `${label} · Assign a shortcut in chrome://extensions/shortcuts`;
      }
    })
    .catch(() => undefined);
}
