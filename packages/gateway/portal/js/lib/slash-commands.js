// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Slash-command registry for the agent composer.
 *
 * A composer affordance: typing `/` at the very start of an empty composer
 * opens a typeahead menu of slash commands. Selecting one "arms" it as a
 * per-message pill above the textarea — it governs the NEXT send only and
 * clears afterward (per-message; the following message is an ordinary turn
 * unless the user re-arms it).
 *
 * This is built as a GENERAL, extensible registry deliberately seeded with a
 * single entry ("Deep research") so more slash commands can be added later
 * without touching the composer wiring: add a descriptor to SLASH_COMMANDS
 * and it shows up in the menu and arms a pill the same way.
 *
 * A command descriptor is a plain object:
 *   {
 *     id:        stable identifier (also the menu key).
 *     label:     pill + menu display label.
 *     hint:      one-line menu description.
 *     trigger:   the typed token that selects it (without the leading `/`).
 *     send:      the partial message-send options this command contributes
 *                (merged into the POST body), e.g. { deepResearch: true }.
 *     icon:      a lucide-style glyph name rendered by the composer.
 *   }
 *
 * The module is pure (no DOM, no Preact) so it unit-tests cleanly, mirroring
 * the rest of the portal's testable-logic-in-lib idiom.
 */

/**
 * The registry. Seeded with exactly one command today; append to extend.
 * @type {ReadonlyArray<{ id: string, label: string, hint: string, trigger: string, send: Record<string, unknown>, icon: string }>}
 */
export const SLASH_COMMANDS = Object.freeze([
  Object.freeze({
    id: "deep-research",
    label: "Deep Research (beta)",
    hint: "Plan, fan out across your corpus, verify, and synthesize a cited report.",
    trigger: "deep-research",
    send: Object.freeze({ deepResearch: true }),
    icon: "telescope",
    experimental: false,
  }),
]);

/**
 * Look up a command descriptor by id. Returns `null` for an unknown id so
 * callers degrade gracefully rather than throwing.
 * @param {string} id
 */
export function getSlashCommand(id) {
  if (!id) return null;
  return SLASH_COMMANDS.find((c) => c.id === id) ?? null;
}

/**
 * Decide whether the composer's current text is a slash-menu query, and if so
 * which commands match.
 *
 * The menu is an at-start affordance: it opens only when the text begins with
 * `/` and contains no whitespace yet (a lone `/` or a `/partial` token). Once
 * the user types a space — i.e. starts composing a real prompt — the menu
 * closes even if the prompt happens to begin with a slash word.
 *
 * Matching is a case-insensitive substring over each command's trigger AND
 * label, so `/deep`, `/research`, and `/Deep Research` all surface the one
 * seeded item. A bare `/` lists everything.
 *
 * Experimental commands (those with `experimental: true`) are only offered
 * when `opts.experimental` is set — the gateway's experimental mode. Off by
 * default, so an experimental command never surfaces unless explicitly
 * enabled.
 *
 * @param {string} text the raw composer value.
 * @param {{ experimental?: boolean }} [opts]
 * @returns {{ open: boolean, query: string, matches: typeof SLASH_COMMANDS }}
 */
export function matchSlashCommands(text, opts = {}) {
  const closed = { open: false, query: "", matches: [] };
  if (typeof text !== "string") return closed;
  if (!text.startsWith("/")) return closed;
  const rest = text.slice(1);
  // Any whitespace means the user has moved past the command token into a
  // real prompt — stop offering the menu.
  if (/\s/.test(rest)) return closed;
  const query = rest.toLowerCase();
  const experimental = opts.experimental === true;
  const matches = SLASH_COMMANDS.filter((c) => {
    if (c.experimental && !experimental) return false;
    if (query.length === 0) return true;
    return (
      c.trigger.toLowerCase().includes(query) ||
      c.label.toLowerCase().replace(/\s+/g, "").includes(query.replace(/\s+/g, ""))
    );
  });
  return { open: true, query, matches };
}

/**
 * Build the per-message send options for an armed command (or no command).
 * Pure: given the armed command id, returns the options object the composer
 * hands to `onSubmit` and the client folds into the POST body. With no armed
 * command this is an empty object — the default send is an ordinary turn.
 *
 * @param {string | null} armedId
 * @returns {Record<string, unknown>}
 */
export function sendOptionsForArmed(armedId) {
  const cmd = getSlashCommand(armedId);
  if (!cmd) return {};
  return { ...cmd.send };
}
