// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.agent

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Bolt
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.omnesis.android.designsystem.theme.OmRadius
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.transport.dto.AgentToolResult

/**
 * Tool names whose successful call is an automation write worth a card.
 * `watch_create` / `watch_update` are what the agent calls today; the retired
 * `trigger_*` authoring names stay listed so transcripts recorded before
 * watches still render their cards when reopened.
 */
val AGENT_AUTOMATION_TOOLS = setOf("watch_create", "watch_update", "trigger_upsert", "trigger_toggle")

/**
 * Inline transcript card the agent surfaces whenever it successfully writes an
 * automation. Mirrors iOS `AgentWatchCard`:
 *
 *   - **Lightning glyph** (`bolt.fill`) in `accent` on the leading edge — the
 *     consistent "agent just performed an action" cue.
 *   - **Primary line**: verb + automation name. Verb derives from the result
 *     kind: created / updated for `trigger.upserted`, and enabled / disabled
 *     for a `trigger.toggled` result in an older transcript.
 *   - **Secondary line** (`triggerUpserted` only): the agent-supplied one-line
 *     summary explaining what the automation does.
 *   - **Pending stub**: while the tool block is open but the result hasn't landed,
 *     a muted "Setting up watch…" line so the user sees something is in flight.
 *   - **Error**: delegates to [AgentToolErrorCard].
 *
 * Read-only trigger tools (`triggers_list`, `trigger_get`, `trigger_firings`)
 * intentionally do NOT route here — they're background data fetches, not
 * user-visible actions.
 *
 * The card reports what the agent did and is not tappable: this app has no
 * watch surface to open, so a tap would have nowhere to land. The watch is
 * reachable from the portal and from the phone that has a Watches section.
 */
@Composable
fun AgentWatchCard(call: AgentToolCall) {
    when (val resolved = resolveWatch(call)) {
        is WatchResolved.Pending -> WatchPendingBody()

        is WatchResolved.Error ->
            AgentToolErrorCard(code = resolved.code, message = resolved.message)

        is WatchResolved.Action ->
            WatchActionBody(
                verb = resolved.verb,
                name = resolved.name,
                summary = resolved.summary,
            )
    }
}

/**
 * Pending stub — a neutral `border` left rail, muted bolt + "Setting up watch…".
 * No fill, no clip (transparent background bleeds the transcript through). Matches
 * iOS `pendingBody`.
 */
@Composable
private fun WatchPendingBody() {
    Row(
        Modifier.fillMaxWidth().height(IntrinsicSize.Min),
    ) {
        Box(Modifier.width(2.dp).fillMaxHeight().background(OmTheme.colors.border))
        Row(
            Modifier.padding(horizontal = 8.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Icon(
                Icons.Filled.Bolt,
                contentDescription = null,
                tint = OmTheme.colors.textMuted,
                modifier = Modifier.size(13.dp),
            )
            Text(
                "Setting up watch…",
                style = MaterialTheme.typography.bodySmall,
                color = OmTheme.colors.textMuted,
            )
        }
    }
}

/**
 * Action card — a solid `accent` 2-dp left rail, `accent @ 0.06` fill clipped to a
 * 6-dp rounded rect, bolt + verb (`textPrimary`) + name (`accent`, single line) and
 * an optional summary line (`textSecondary`, up to 2 lines). The whole card is
 * tappable. Matches iOS `actionBody`.
 */
@Composable
private fun WatchActionBody(
    verb: String,
    name: String,
    summary: String?,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .height(IntrinsicSize.Min)
            .clip(RoundedCornerShape(OmRadius.medium))
            .background(OmTheme.colors.accent.copy(alpha = 0.06f)),
    ) {
        Box(Modifier.width(2.dp).fillMaxHeight().background(OmTheme.colors.accent))
        Row(
            Modifier.padding(horizontal = 8.dp, vertical = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.Top,
        ) {
            Icon(
                Icons.Filled.Bolt,
                contentDescription = null,
                tint = OmTheme.colors.accent,
                modifier = Modifier.size(13.dp).padding(top = 2.dp),
            )
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(
                        verb,
                        style = MaterialTheme.typography.bodySmall,
                        fontWeight = FontWeight.Medium,
                        color = OmTheme.colors.textPrimary,
                    )
                    Text(
                        name,
                        style = MaterialTheme.typography.bodySmall,
                        fontWeight = FontWeight.Medium,
                        color = OmTheme.colors.accent,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                if (!summary.isNullOrEmpty()) {
                    Text(
                        summary,
                        style = MaterialTheme.typography.labelMedium,
                        color = OmTheme.colors.textSecondary,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
    }
}

/**
 * Compact, expandable error card. Same visual family as [AgentToolResultErrorView]
 * but tuned for the trigger surface: a fainter `danger @ 0.04` fill, the first line
 * rendered in `textSecondary` (not danger), and a `textMuted` chevron. Lifted into a
 * standalone composable so the trigger card can render tool errors with one look.
 * Mirrors iOS `AgentToolErrorCard`.
 */
@Composable
fun AgentToolErrorCard(code: String, message: String) {
    var expanded by remember { mutableStateOf(false) }
    val first = message.substringBefore('\n')
    val multi = message != first

    Row(
        Modifier
            .fillMaxWidth()
            .height(IntrinsicSize.Min)
            .clip(RoundedCornerShape(OmRadius.small))
            .background(OmTheme.colors.danger.copy(alpha = 0.04f)),
    ) {
        Box(Modifier.width(2.dp).fillMaxHeight().background(OmTheme.colors.danger.copy(alpha = 0.45f)))
        Column(
            Modifier
                .then(if (multi) Modifier.clickable { expanded = !expanded } else Modifier)
                .padding(horizontal = 8.dp, vertical = 4.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Text(
                    code,
                    style = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace),
                    fontWeight = FontWeight.SemiBold,
                    color = OmTheme.colors.danger,
                )
                Text(
                    first,
                    style = MaterialTheme.typography.labelMedium,
                    color = OmTheme.colors.textSecondary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                if (multi) {
                    Icon(
                        if (expanded) Icons.Filled.KeyboardArrowUp else Icons.Filled.KeyboardArrowDown,
                        contentDescription = null,
                        tint = OmTheme.colors.textMuted,
                        modifier = Modifier.size(13.dp),
                    )
                }
            }
            AnimatedVisibility(visible = expanded && multi) {
                Text(
                    message,
                    style = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace),
                    color = OmTheme.colors.textSecondary,
                )
            }
        }
    }
}

// MARK: - Result interpretation

private sealed interface WatchResolved {
    data object Pending : WatchResolved
    data class Error(val code: String, val message: String) : WatchResolved
    data class Action(
        val verb: String,
        val name: String,
        val summary: String?,
        val watchId: String,
    ) : WatchResolved
}

/**
 * Maps a watch tool call's result kind to the rendered verb + payload. A missing
 * result is "pending"; an error result delegates to the error card; the upserted
 * and toggled kinds map to action verbs. Any other kind that somehow reaches
 * here (routing is gated upstream) collapses to "pending" so nothing crashes if
 * the contract drifts. Mirrors iOS `AgentWatchCard.resolve()`.
 */
private fun resolveWatch(call: AgentToolCall): WatchResolved =
    when (val result = call.result) {
        null -> WatchResolved.Pending

        is AgentToolResult.ErrorResult ->
            WatchResolved.Error(code = result.code, message = result.message)

        is AgentToolResult.WatchUpserted ->
            WatchResolved.Action(
                verb = if (result.action == "created") "Created watch" else "Updated watch",
                name = result.name,
                summary = result.summary,
                watchId = result.watchId,
            )

        // Cards from conversations stored before the rename. Rendered rather
        // than dropped: they still describe something the user asked for, and
        // a stored transcript is still theirs.
        is AgentToolResult.TriggerUpserted ->
            WatchResolved.Action(
                verb = if (result.action == "created") "Created watch" else "Updated watch",
                name = result.name,
                summary = result.summary,
                watchId = result.triggerId,
            )

        is AgentToolResult.TriggerToggled ->
            WatchResolved.Action(
                verb = if (result.enabled) "Enabled watch" else "Disabled watch",
                name = result.name,
                summary = null,
                watchId = result.triggerId,
            )

        else -> WatchResolved.Pending
    }
