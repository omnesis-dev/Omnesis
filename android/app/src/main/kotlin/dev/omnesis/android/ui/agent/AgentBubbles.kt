// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.agent

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material.icons.outlined.Build
import androidx.compose.material.icons.outlined.CalendarMonth
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.Hub
import androidx.compose.material.icons.outlined.Loop
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.TableChart
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.TileMode
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withLink
import androidx.compose.ui.unit.dp
import dev.omnesis.android.designsystem.components.MarkdownText
import dev.omnesis.android.designsystem.components.OmFailureDetailLine
import dev.omnesis.android.designsystem.components.OmSpinner
import dev.omnesis.android.designsystem.theme.OmFonts
import dev.omnesis.android.designsystem.theme.OmRadius
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.sources.SourceCatalog
import dev.omnesis.android.transport.dto.AgentToolResult
import kotlinx.coroutines.delay
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject

/**
 * A user-input bubble: right-aligned with a 32-dp minimum leading gap, a soft
 * `accent @ 0.10` fill (NOT a solid-accent tailed bubble), `textPrimary` prose at 15 sp,
 * symmetric 12-dp corners, no border. URLs inside the text light up accent + underline.
 * Mirrors iOS `AgentTurnBubble.user`.
 */
@Composable
fun UserBubble(text: String) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
        Spacer(Modifier.widthIn(min = 32.dp))
        Box(
            Modifier
                .clip(RoundedCornerShape(12.dp))
                .background(OmTheme.colors.accent.copy(alpha = 0.10f))
                .padding(horizontal = 14.dp, vertical = 10.dp),
        ) {
            Text(
                text = userMessageWithLinks(text, OmTheme.colors.accent),
                color = OmTheme.colors.textPrimary,
                style = MaterialTheme.typography.bodyMedium,
            )
        }
    }
}

/**
 * Linkify a user message: bare `https://…` / `www.…` URLs become tinted, underlined,
 * tappable spans; the surrounding prose inherits the `Text`'s color. Mirrors iOS
 * `userMessageWithLinks` (which uses `NSDataDetector`).
 */
private val urlRegex = Regex("""(https?://[^\s]+|www\.[^\s]+)""")

@Composable
private fun userMessageWithLinks(text: String, accent: androidx.compose.ui.graphics.Color): AnnotatedString =
    buildAnnotatedString {
        var last = 0
        for (match in urlRegex.findAll(text)) {
            append(text.substring(last, match.range.first))
            val raw = match.value
            val href = if (raw.startsWith("www.")) "https://$raw" else raw
            withLink(LinkAnnotation.Url(href, TextLinkStyles(SpanStyle(color = accent, textDecoration = TextDecoration.Underline)))) {
                append(raw)
            }
            last = match.range.last + 1
        }
        if (last < text.length) append(text.substring(last))
    }

/**
 * An aggregated assistant turn. No bubble container — content sits directly on
 * `bgPrimary`, full text width, with 10-dp spacing between parts (matching iOS
 * `AgentTurnBubble.assistant`). Renders text (15 sp markdown), a collapsible thinking
 * disclosure, tool cards, and a per-turn error row. No citation-count footer chip — iOS
 * surfaces citations in the drawer + inline citing pill, not on the turn.
 */
@Composable
fun AssistantTurn(
    turn: AgentTurn.Assistant,
    catalog: SourceCatalog,
    onFlushEphemeral: (String) -> Unit,
    onOpenDocument: (String) -> Unit,
    /**
     * The conversation's single merged citation set (#748) — passed so a Deep Research
     * turn's verified-report artifact can render numbered inline citation markers off it
     * (no per-sub-agent attribution). Empty for an ordinary turn.
     */
    citations: List<AgentCitation> = emptyList(),
) {
    val pillRuns = remember(turn.parts) { computeCitationPillRuns(turn.parts) }
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        turn.parts.forEachIndexed { index, part ->
            when (part) {
                is AgentPart.Text ->
                    MarkdownText(
                        part.text,
                        style = MaterialTheme.typography.bodyMedium.copy(fontFamily = OmFonts.inter),
                        color = OmTheme.colors.textPrimary,
                    )

                // A thinking part is "live" only while it is the trailing part of
                // an in-flight turn (no stopReason yet). The moment anything
                // follows it — or the turn ends — it fades itself out.
                is AgentPart.Thinking ->
                    ThinkingBlock(
                        part.text,
                        active = turn.stopReason == null && index == turn.parts.lastIndex,
                    )

                is AgentPart.Tool ->
                    if (turn.stopReason == null || part.call.tool !in AgentReducer.EPHEMERAL_TOOLS) {
                        ToolCard(part.call, pillRuns[index], catalog, onFlushEphemeral, onOpenDocument)
                    }

                // A sub-agent (#748) the parent spawned via `spawn_subagent` — a
                // collapsible card whose expanded body recurses through the same
                // part renderers (registry-tinted), one level of recursion.
                //
                // The card is a LIVE in-flight marker. Once the parent turn ends
                // (`stopReason != null` — the SAME done-signal the thinking block
                // fades on), fold it away: the Deep Research report is now written
                // and its sources persist in the report artifact. On reload the card
                // is already absent (AgentTurnBuilder rebuilds only text/thinking/
                // tool_use, never subagent), so this only affects the live
                // just-finished turn.
                is AgentPart.Subagent ->
                    if (turn.stopReason == null) AgentSubAgentCard(part.card, catalog)

                // Forward-compat: a part kind the gateway introduced after this build
                // shipped. Production hides it entirely so an older client never shows
                // seams (iOS surfaces it only in demo builds).
                is AgentPart.Unknown -> Unit
            }
        }

        turn.failure?.let { failure -> AssistantErrorRow(failure) }
        turn.stopped?.let { stopped -> AssistantStoppedRow(stopped) }

        // The verified-report artifact (#748) hangs below the streamed report prose —
        // only when the reducer folded a summary event onto this turn. A turn without one
    }
}

/**
 * Coalescing context for one part slot. [lead] is true on the first pending-annotate
 * of a contiguous run; [count] is the number of pending annotates in that run. Mirrors
 * iOS `AgentCitationPillRun`.
 */
internal data class CitationPillRun(val lead: Boolean, val count: Int)

/**
 * Walk `parts[]` and return a map from part index → [CitationPillRun] for every
 * pending-annotate slot. A contiguous run of pending `annotate` tool parts collapses
 * into ONE pill rendered at the run's lead slot with `count == run length`; rendering
 * one pill per part would read as a stack of identical animations when the agent fires
 * off several annotates in a row. Mirrors iOS `computeCitationPillRuns`.
 */
private fun computeCitationPillRuns(parts: List<AgentPart>): Map<Int, CitationPillRun> {
    fun isPendingAnnotate(part: AgentPart): Boolean =
        part is AgentPart.Tool && part.call.tool == "annotate" && part.call.result == null

    val out = mutableMapOf<Int, CitationPillRun>()
    var i = 0
    while (i < parts.size) {
        if (!isPendingAnnotate(parts[i])) {
            i += 1
            continue
        }
        var j = i
        while (j < parts.size && isPendingAnnotate(parts[j])) j += 1
        val runLength = j - i
        out[i] = CitationPillRun(lead = true, count = runLength)
        for (k in (i + 1) until j) out[k] = CitationPillRun(lead = false, count = runLength)
        i = j
    }
    return out
}

/**
 * Inline "Citing N document(s)" pill rendered at the lead slot of a run of pending
 * `annotate` calls. While the model streams an annotate tool_use's verbatim-quote args
 * no text deltas arrive, so the transcript visibly pauses; a pulsing accent dot + muted
 * label makes that pause read as intentional ("agent is annotating its answer") rather
 * than a hang. The pill disappears the moment the run resolves. Mirrors iOS
 * `AgentCitingPill`.
 */
@Composable
private fun AgentCitingPill(count: Int) {
    val n = count.coerceAtLeast(1)
    val label = "Citing $n document${if (n == 1) "" else "s"}"
    // The infinite pulse keeps Compose non-idle, which hangs a Roborazzi/Preview capture —
    // freeze it to a static alpha when rendering in inspection mode.
    val dotAlpha = if (LocalInspectionMode.current) {
        1f
    } else {
        val transition = rememberInfiniteTransition(label = "citingPulse")
        transition.animateFloat(
            initialValue = 0.35f,
            targetValue = 1f,
            animationSpec = infiniteRepeatable(tween(700), RepeatMode.Reverse),
            label = "citingDotAlpha",
        ).value
    }
    Row(
        Modifier
            .clip(CircleShape)
            .background(OmTheme.colors.accent.copy(alpha = 0.07f))
            .padding(horizontal = 8.dp, vertical = 3.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        Box(
            Modifier
                .size(5.dp)
                .clip(CircleShape)
                .background(OmTheme.colors.accent.copy(alpha = dotAlpha)),
        )
        Text(
            label,
            style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.Normal),
            color = OmTheme.colors.textMuted,
        )
    }
}

/**
 * Per-turn assistant error — a triangle-alert + 12-sp danger text on a `danger @ 0.08` chip,
 * with the failure's code and any provider disposition on a quiet monospaced line beneath it.
 * The sentence is what happened; the second line is what to quote when reporting it.
 */
@Composable
private fun AssistantErrorRow(failure: AgentTurnFailure) {
    Column(
        Modifier
            .clip(RoundedCornerShape(OmRadius.medium))
            .background(OmTheme.colors.danger.copy(alpha = 0.08f))
            .padding(8.dp),
        verticalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Icon(Icons.Filled.Warning, contentDescription = null, tint = OmTheme.colors.danger, modifier = Modifier.size(13.dp))
            Text(failure.message, style = MaterialTheme.typography.labelMedium, color = OmTheme.colors.danger)
        }
        OmFailureDetailLine(failure.code, failure.providerDetail, Modifier.padding(start = 19.dp))
    }
}

/**
 * The note under a reply that was stopped, seen again on reopen. A stop is not an error:
 * no icon, no tinted chip — one quiet italic line, the register the portal uses for the
 * same note.
 */
@Composable
private fun AssistantStoppedRow(stopped: String) {
    Text(
        stopped,
        style = MaterialTheme.typography.labelMedium.copy(fontStyle = FontStyle.Italic),
        color = OmTheme.colors.textMuted,
    )
}

// The thinking indicator reuses the ephemeral cards' cadence (HoldMs / FadeMs
// in AgentToolSlots): once the agent moves on from reasoning, hold a beat (so a
// quick thought doesn't flash), then fade + shrink to nothing.
private const val ThinkingHoldMs = 450L
private const val ThinkingFadeMs = 300L

/**
 * Thinking indicator. Rendered for a `thinking` part only while it is the live
 * trailing part of an in-flight turn (`active`). The instant the agent appends
 * anything after it — another reasoning pass, a tool call, or the answer text —
 * or the turn ends, `active` flips false: the block holds a beat, fades + shrinks
 * away, and leaves nothing in the transcript.
 *
 * Two invariants fall out of this: never more than one on screen (each block is
 * already fading by the time the next reasoning pass begins, since consecutive
 * thinking deltas coalesce and any two thinking parts are separated by a
 * tool/text part), and resumed history shows none at all (AgentTurnBuilder drops
 * thinking parts on rebuild, and a part that mounts inactive never becomes
 * visible). Mirrors ThinkingBlock on the portal + AgentThinkingBlock on iOS.
 */
@Composable
private fun ThinkingBlock(text: String, active: Boolean) {
    var visible by remember { mutableStateOf(active) }
    var expanded by remember { mutableStateOf(false) }

    LaunchedEffect(active) {
        if (active) {
            visible = true
        } else if (visible) {
            // Was live, now superseded or the turn ended: hold a beat, then go.
            delay(ThinkingHoldMs)
            visible = false
        }
        // !active && !visible → never shown (resumed history); stay hidden.
    }

    AnimatedVisibility(
        visible = visible,
        enter = EnterTransition.None,
        exit = fadeOut(tween(ThinkingFadeMs.toInt())) + shrinkVertically(tween(ThinkingFadeMs.toInt())),
    ) {
        Column {
            Row(
                Modifier.clickable { expanded = !expanded },
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(5.dp),
            ) {
                Icon(
                    Icons.Filled.KeyboardArrowRight,
                    contentDescription = null,
                    tint = OmTheme.colors.textMuted,
                    modifier = Modifier.size(14.dp).rotate(if (expanded) 90f else 0f),
                )
                ThinkingShimmerLabel("Thinking")
                ThinkingDots()
            }
            AnimatedVisibility(visible = expanded) {
                Text(
                    text,
                    style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.Normal),
                    color = OmTheme.colors.textSecondary,
                    modifier = Modifier.padding(top = 4.dp, start = 2.dp),
                )
            }
        }
    }
}

/**
 * The thinking disclosure's three accent dots, travelling the shared wave at the
 * label's scale. Mirrors the portal `.agent-thinking-dots`.
 */
@Composable
private fun ThinkingDots() {
    AgentWaveDots(dotSize = 3.dp, spacing = 2.dp, contentDescription = "Thinking")
}

// The turn-level working indicator reveals its dots only after a short quiet
// window — above the streaming-token cadence (each token re-arms the timer, so
// they never flash mid-stream) but short enough that the brief gaps a real turn
// leaves clear it and read as "still working" rather than frozen.
private const val WorkingRevealMs = 350L

/**
 * The debounced visibility of the turn-level "working" dots — the transcript's answer to "is
 * anything still happening?" during the beats where no per-item card carries its own affordance:
 * a finished text block before the next tool call, `message.start` before the first delta, or a
 * batch tool (search_many / fetch_many) whose per-child cards never render (non-Codex backends
 * stream no child progress, so it shows NOTHING for the multi-second batch).
 *
 * Returns true only once [revision] — which bumps on every streamed token — has held steady for
 * [WorkingRevealMs] while [active], so the dots surface in a genuine gap but never flash
 * mid-stream. Split from [WorkingDots] and hoisted to the caller (which keeps it always composed,
 * so the debounce runs continuously) so the transcript adds the dots' LazyColumn item ONLY when
 * revealed — leaving no empty inter-item slot while hidden. Mirrors the iOS `AgentWorkingIndicator`.
 */
@Composable
internal fun rememberWorkingDotsRevealed(active: Boolean, revision: Int): Boolean {
    var revealed by remember { mutableStateOf(false) }
    LaunchedEffect(active, revision) {
        // A fresh token (revision change), a flip in eligibility, or first composition hides the
        // dots and re-arms the quiet timer; a real gap lets the delay run out and reveals them.
        revealed = false
        if (active) {
            delay(WorkingRevealMs)
            revealed = true
        }
    }
    return revealed
}

/**
 * The turn-level working indicator: the standalone twin of [ThinkingDots], a touch
 * larger since it stands on its own line rather than beside a label, travelling the
 * same shared wave.
 */
@Composable
internal fun WorkingDots(modifier: Modifier = Modifier) {
    AgentWaveDots(
        modifier = modifier.padding(vertical = 2.dp),
        dotSize = 5.dp,
        spacing = 4.dp,
        restAlpha = 0.3f,
    )
}

/**
 * "Thinking" with an accent highlight that sweeps across the glyphs while the
 * agent reasons — a moving linear-gradient brush with mirrored tiling so it
 * repeats seamlessly. Created only outside inspection mode (same Roborazzi
 * caveat as the dots); under inspection it freezes mid-word. Mirrors the
 * portal's `.agent-thinking-label` shimmer.
 */
@Composable
private fun ThinkingShimmerLabel(text: String) {
    val inspection = LocalInspectionMode.current
    val muted = OmTheme.colors.textMuted
    val accent = OmTheme.colors.accent
    val x: Float = if (inspection) {
        110f
    } else {
        val transition = rememberInfiniteTransition(label = "thinkingShimmer")
        transition.animateFloat(
            initialValue = 0f,
            targetValue = 220f,
            animationSpec = infiniteRepeatable(
                animation = tween(2100, easing = LinearEasing),
                repeatMode = RepeatMode.Restart,
            ),
            label = "thinkingShimmerX",
        ).value
    }
    val brush = Brush.linearGradient(
        colors = listOf(muted, accent, muted),
        start = Offset(x - 80f, 0f),
        end = Offset(x + 80f, 0f),
        tileMode = TileMode.Mirror,
    )
    Text(
        text,
        style = MaterialTheme.typography.labelMedium
            .copy(fontWeight = FontWeight.Medium)
            .merge(TextStyle(brush = brush)),
    )
}

/**
 * Routes one tool part to its renderer. Ephemeral tools (retrieval, memory, and
 * background actions) become rolling-slot glance cards that stream their content in and
 * then fade out, firing the [onFlushEphemeral] gate so parked turn-extending
 * events drain back in chronologically. Every ephemeral tool is routed here
 * regardless of result type (including `.error`/`.unknown`) so the card's
 * lifecycle always opens the causality gate. Read-only/silent tools render
 * nothing; everything else falls back to the bordered [AgentToolCallView]. Mirrors
 * the iOS `AgentPartView` `.tool` switch.
 */
@Composable
internal fun ToolCard(
    call: AgentToolCall,
    pillRun: CitationPillRun?,
    catalog: SourceCatalog,
    onFlushEphemeral: (String) -> Unit,
    @Suppress("UNUSED_PARAMETER") onOpenDocument: (String) -> Unit,
    // True when rendered AFTER-THE-FACT (a finished sub-agent card's expanded
    // transcript): freezes the ephemeral tool cards so they render statically —
    // no roll-in animation, no self-dismiss — instead of replaying every
    // animation at once on expand (#890).
    freeze: Boolean = false,
) {
    when {
        // A pending `annotate` at the lead slot of a contiguous run surfaces the inline
        // "Citing N document(s)" pill so the model's annotate-args pause reads as
        // intentional; non-lead and resolved annotates render nothing here.
        call.tool == "annotate" && call.result == null && pillRun?.lead == true ->
            AgentCitingPill(pillRun.count)

        // `annotate_many` is silent like `annotate` — its per-child citations arrive live via
        // agent.citation and persist in the drawer/Timeline. While the batch is pending, show ONE
        // pill sized to the batch (the model streams N verbatim-quote args with no text between);
        // once the batch result lands, nothing inline.
        call.tool == "annotate_many" && call.result == null ->
            AgentCitingPill(annotateManyCount(call))

        // Silent / panel-only tools: annotate / annotate_many feed the citations card, cite_record
        // (#757) feeds the citations drawer's Timeline (the directly-cited row never
        // surfaces as an inline card), plan feeds the pinned TODO panel, read-only
        // trigger fetches are background data. All bump the bubble's citation count
        // where applicable but render nothing in the transcript flow.
        call.tool == "annotate" ||
            call.tool == "annotate_many" ||
            call.tool == "cite_record" ||
            call.tool == "plan" ||
            call.tool == "join_subagents" ||
            call.tool == "triggers_list" ||
            call.tool == "trigger_get" ||
            call.tool == "trigger_firings" -> Unit

        // Automation writes surface a dedicated lightning card (created/updated/
        // pending/error), tappable through to the automation detail. The retired
        // `trigger_*` authoring names stay here so transcripts recorded before
        // watches still render their cards on reopen.
        call.tool in AGENT_AUTOMATION_TOOLS ->
            AgentWatchCard(call)

        call.tool in AgentReducer.EPHEMERAL_TOOLS -> when (call.tool) {
            "search_documents" -> AgentEphemeralSearchCard(call, catalog, onFlushEphemeral, freeze = freeze)
            "fetch_document" -> AgentEphemeralDocumentCard(call, catalog, onFlushEphemeral, freeze = freeze)
            "run_sql" -> AgentEphemeralSqlCard(call, catalog, onFlushEphemeral, freeze = freeze)
            "trace_connections" -> AgentEphemeralTrailCard(call, catalog, onFlushEphemeral, freeze = freeze)
            "lookup_people" -> AgentEphemeralPeopleCard(call, onFlushEphemeral, freeze = freeze)
            "lookup_document_by_url" -> AgentEphemeralUrlLookupCard(call, catalog, onFlushEphemeral, freeze = freeze)
            "search_loops" -> AgentEphemeralLoopsSearchCard(call, onFlushEphemeral, freeze = freeze)
            "fetch_loop" -> AgentEphemeralLoopCard(call, onFlushEphemeral, freeze = freeze)
            "temporal_query", "temporal_annotation_add", "temporal_annotation_update",
            "temporal_annotation_delete", "time_index_query", "time_index_add",
            "time_index_update", "time_index_delete" ->
                AgentEphemeralTemporalCard(call, onFlushEphemeral, freeze = freeze)
            // Batch retrieval: N live per-child cards, each reusing the singular card and animating
            // on its own lifecycle. A batch parent doesn't gate, so it takes no flush handler.
            "search_many", "fetch_many" -> AgentBatchEphemeralCards(call, catalog, freeze = freeze)
            else -> AgentEphemeralActionCard(
                call = call,
                label = prettyToolName(call.tool),
                glyph = toolIcon(call.tool),
                onFlushEphemeral = onFlushEphemeral,
                freeze = freeze,
            )
        }

        else -> AgentToolCallView(call)
    }
}

/**
 * Standard tool-call chrome for the non-ephemeral tools (today only future tools
 * surface a persistent piece of information the user might consult after the
 * answer arrives) — a 6-dp `bgTertiary @ 0.5` box with a 1-dp border, an accent
 * tool symbol + accent 12-sp semibold name + mono args + trailing duration. Error
 * results land here too so the failure detail stays readable. Mirrors iOS
 * `AgentToolCallView`.
 */
@Composable
private fun AgentToolCallView(call: AgentToolCall) {
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(OmRadius.medium))
            .background(OmTheme.colors.bgTertiary.copy(alpha = 0.5f))
            .border(1.dp, OmTheme.colors.border, RoundedCornerShape(OmRadius.medium))
            .padding(10.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Icon(toolIcon(call.tool), null, Modifier.size(13.dp), tint = OmTheme.colors.accent)
            Text(
                prettyToolName(call.tool),
                style = MaterialTheme.typography.labelMedium,
                fontWeight = FontWeight.SemiBold,
                color = OmTheme.colors.accent,
            )
            if (call.argsSummary.isNotBlank()) {
                Text(
                    call.argsSummary,
                    style = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace),
                    color = OmTheme.colors.textSecondary,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
            }
            Spacer(Modifier.weight(1f))
            call.durationMs?.let {
                Text("${it.toInt()}ms", style = MaterialTheme.typography.labelSmall, color = OmTheme.colors.textMuted)
            }
        }
        call.result?.let { AgentToolResultView(it) }
            ?: Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                OmSpinner(Modifier.size(14.dp), strokeWidth = 2.dp, color = OmTheme.colors.accent)
                Text(
                    if (call.argsKnown) "Running…" else "Building query…",
                    style = MaterialTheme.typography.labelMedium,
                    color = OmTheme.colors.textMuted,
                )
            }
    }
}

/**
 * The non-ephemeral result switchboard: `trace_connections` → an inline summary chip,
 * errors → the collapsible error notice, unknown kinds → a forward-compat notice.
 * Every other kind renders nothing here (they surface via ephemeral cards, the
 * trigger card, or the citations drawer). Mirrors iOS `AgentToolResultView`.
 */
@Composable
private fun AgentToolResultView(result: AgentToolResult) {
    when (result) {
        is AgentToolResult.EventTrailBuilt ->
            AgentEventTrailSummary(eventCount = result.events.size, truncated = result.truncated)

        is AgentToolResult.ErrorResult ->
            AgentToolResultErrorView(code = result.code, message = result.message)

        is AgentToolResult.Unknown ->
            AgentUnknownPartNotice(label = "tool result", kind = result.kind)

        else -> Unit
    }
}

/**
 * Child-annotation count of an `annotate_many` call — its args' `annotations.length` (present the
 * moment the tool_use resolves), falling back to the live child count, else 1 — used to size the
 * pending "Citing N document(s)" pill. Mirrors the portal's batch-sized pill count.
 */
private fun annotateManyCount(call: AgentToolCall): Int {
    val fromArgs = ((call.args as? JsonObject)?.get("annotations") as? JsonArray)?.size
    return fromArgs ?: call.children.size.takeIf { it > 0 } ?: 1
}

private fun prettyToolName(tool: String): String = when (tool) {
    "search_documents" -> "Search"
    "fetch_document" -> "Open document"
    "trace_connections" -> "Trace connections"
    "run_sql" -> "Run SQL"
    "search_loops" -> "Search loops"
    "fetch_loop" -> "Open loop"
    "list_loops" -> "List loops"
    "entity_context" -> "Gather context"
    "conversation_memory_evidence" -> "Prepare memory"
    "annotation_search" -> "Search memory"
    "annotate_durable" -> "Remember document"
    "annotation_revise" -> "Update document memory"
    "annotation_retract" -> "Forget document memory"
    "annotation_supersede" -> "Replace document memory"
    "annotate_person" -> "Remember person"
    "person_annotation_revise" -> "Update person memory"
    "person_annotation_retract" -> "Forget person memory"
    "person_annotation_supersede" -> "Replace person memory"
    "open_loop_search" -> "Search loops"
    "open_loop_fetch" -> "Open loop"
    "open_loop_create" -> "Create loop"
    "open_loop_update" -> "Update loop"
    "open_loop_delete" -> "Delete loop"
    "open_loop_ledger_append" -> "Note on loop"
    "brief_list" -> "List briefs"
    "brief_fetch" -> "Open brief"
    "brief_create" -> "Create brief"
    "brief_update" -> "Update brief"
    "brief_delete" -> "Withdraw brief"
    "notes_append" -> "Append notes"
    "notes_rewrite" -> "Rewrite notes"
    "schedule_agent_run" -> "Schedule follow-up"
    "temporal_query", "time_index_query" -> "Check dates"
    "temporal_annotation_add", "time_index_add" -> "Add date note"
    "temporal_annotation_update", "time_index_update" -> "Update date note"
    "temporal_annotation_delete", "time_index_delete" -> "Remove date note"
    else -> tool
}

private fun toolIcon(tool: String): ImageVector = when (tool) {
    "search_documents" -> Icons.Outlined.Search
    "fetch_document" -> Icons.Outlined.Description
    "trace_connections" -> Icons.Outlined.Hub
    "run_sql" -> Icons.Outlined.TableChart
    "search_loops", "fetch_loop", "list_loops",
    "open_loop_search", "open_loop_fetch", "open_loop_create", "open_loop_update",
    "open_loop_delete", "open_loop_ledger_append" -> Icons.Outlined.Loop
    "brief_list", "brief_fetch", "brief_create", "brief_update", "brief_delete",
    "notes_append", "notes_rewrite" -> Icons.Outlined.Description
    "schedule_agent_run" -> Icons.Outlined.CalendarMonth
    "entity_context" -> Icons.Outlined.Hub
    "conversation_memory_evidence", "annotation_search",
    "annotate_durable", "annotation_revise", "annotation_retract",
    "annotation_supersede", "annotate_person", "person_annotation_revise",
    "person_annotation_retract", "person_annotation_supersede" -> Icons.Outlined.Hub
    "temporal_query", "temporal_annotation_add", "temporal_annotation_update",
    "temporal_annotation_delete", "time_index_query", "time_index_add",
    "time_index_update", "time_index_delete" -> Icons.Outlined.CalendarMonth
    else -> Icons.Outlined.Build
}
