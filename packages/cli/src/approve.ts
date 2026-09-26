// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A prompt whose "no" is a legitimate answer: declining leaves the command's
 * work complete and it prints what the operator can do later. Without a
 * terminal there is nobody to ask, so it declines rather than blocking on a
 * prompt that could never be answered. `skip` is the command's `--yes`.
 */
export async function approveInteractive(message: string, skip: boolean): Promise<boolean> {
  if (skip) return true;
  if (!process.stdout.isTTY || !process.stdin.isTTY) return false;
  // Imported only once a question is really asked. Under `omnesis update` that
  // is after its own confirmation resolved this module, so the import is served
  // from the module cache rather than from a node_modules the update has since
  // rewritten.
  const prompts = await import("@clack/prompts");
  const confirmed = await prompts.confirm({ message, initialValue: true });
  return !prompts.isCancel(confirmed) && confirmed === true;
}
