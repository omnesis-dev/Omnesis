// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.agent

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.TravelExplore
import androidx.compose.ui.graphics.vector.ImageVector

/**
 * Slash-command registry for the agent composer — the Android analogue of the
 * portal's `slash-commands.js` and the iOS `SlashCommands.swift`.
 *
 * A composer affordance: typing `/` at the very start of an empty composer
 * opens a typeahead menu of slash commands. Selecting one "arms" it as a
 * per-message pill above the text field — it governs the NEXT send only and
 * clears afterward (per-message; the following message is an ordinary turn
 * unless the user re-arms it).
 *
 * This is a GENERAL, extensible registry deliberately seeded with a single
 * entry ("Deep research") so more slash commands can be added later without
 * touching the composer wiring: append a descriptor to [SlashCommand.all] and
 * it shows up in the menu and arms a pill the same way.
 *
 * The matching/decision logic ([matchSlashCommands]) is pure (no Compose, no
 * I/O) so it unit-tests cleanly — the interactive arm/clear behaviour, which
 * snapshots can't catch, is reasoned about against these functions.
 */
data class SlashCommand(
    /** Stable identifier (also the menu key). */
    val id: String,
    /** Pill + menu display label. */
    val label: String,
    /** One-line menu description. */
    val hint: String,
    /** The typed token that selects it (without the leading `/`). */
    val trigger: String,
    /** The glyph the composer renders for the menu row and the armed pill. */
    val icon: ImageVector,
    /**
     * Whether arming this command sends `deepResearch: true` in the POST body.
     * The registry stays generic — each command names the send options it
     * contributes — but the only send-option the gateway honours today is the
     * deep-research flag, so we model it explicitly as a typed Bool rather than
     * an open map the Kotlin type system can't validate at the boundary
     * (mirroring the iOS descriptor).
     */
    val deepResearch: Boolean,
    /**
     * Whether this command is experimental — only offered when the gateway
     * runs in experimental mode (`OMNESIS_EXPERIMENTAL=1` or synthetic mode).
     * [matchSlashCommands] filters it out otherwise. Defaults to `false` so a
     * non-experimental command such as Deep Research always surfaces.
     */
    val experimental: Boolean = false,
) {
    companion object {
        /**
         * The registry. Seeded with exactly one command today; append to extend.
         *
         * lucide `telescope` (the portal/iOS cross-client intent) is not in the
         * stock Material catalogue, so we use `TravelExplore` — the closest
         * "scan the horizon / explore broadly" glyph for the same intent the
         * portal's lucide `telescope` and the iOS `binoculars` convey.
         */
        val all: List<SlashCommand> = listOf(
            SlashCommand(
                id = "deep-research",
                label = "Deep Research (beta)",
                hint = "Plan, fan out across your corpus, verify, and synthesize a cited report.",
                trigger = "deep-research",
                icon = Icons.Outlined.TravelExplore,
                deepResearch = true,
            ),
        )

        /**
         * Look up a command by id. Returns `null` for an unknown id so callers
         * degrade gracefully rather than crashing.
         */
        fun byId(id: String?): SlashCommand? {
            if (id == null) return null
            return all.firstOrNull { it.id == id }
        }
    }
}

/** The outcome of inspecting the composer's current text for a slash query. */
data class SlashMenuState(
    val isOpen: Boolean,
    val query: String,
    val matches: List<SlashCommand>,
) {
    companion object {
        val Closed = SlashMenuState(isOpen = false, query = "", matches = emptyList())
    }
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
 * label (whitespace-insensitive), so `/deep`, `/research`, and `/Deep Research`
 * all surface the one seeded item. A bare `/` lists everything.
 *
 * Experimental commands (those with `experimental = true`) are only offered
 * when [experimental] is set — the gateway's experimental mode. Off by default,
 * so an experimental command never surfaces unless explicitly enabled.
 */
fun matchSlashCommands(text: String, experimental: Boolean = false): SlashMenuState {
    if (!text.startsWith("/")) return SlashMenuState.Closed
    val rest = text.drop(1)
    // Any whitespace means the user has moved past the command token into a
    // real prompt — stop offering the menu.
    if (rest.any { it.isWhitespace() }) return SlashMenuState.Closed
    val query = rest.lowercase()
    val normalizedQuery = query.replace(" ", "")
    val matches = SlashCommand.all.filter { cmd ->
        if (cmd.experimental && !experimental) return@filter false
        if (query.isEmpty()) return@filter true
        val label = cmd.label.lowercase().replace(" ", "")
        cmd.trigger.lowercase().contains(query) || label.contains(normalizedQuery)
    }
    return SlashMenuState(isOpen = true, query = query, matches = matches)
}
