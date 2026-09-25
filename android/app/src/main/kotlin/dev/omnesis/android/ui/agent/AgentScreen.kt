// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.agent

import android.os.Build
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.spring
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.imeNestedScroll
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.EditNote
import androidx.compose.material.icons.outlined.KeyboardArrowDown
import androidx.compose.material.icons.outlined.Menu
import androidx.compose.material.icons.outlined.MoreHoriz
import androidx.compose.material.icons.outlined.PushPin
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.LocalViewConfiguration
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.error
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.sources.SourceCatalog
import dev.omnesis.android.transport.dto.AgentDocRef
import dev.omnesis.android.transport.dto.AgentPlanItem
import dev.omnesis.android.transport.dto.AgentToolResult
import dev.omnesis.android.transport.dto.ConversationSummary
import dev.omnesis.android.ui.common.GatewayErrorView
import dev.omnesis.android.ui.common.LandingBackdrop
import dev.omnesis.android.ui.common.OmnesisMarkGlyph
import dev.omnesis.android.ui.common.LandingMarkBox
import dev.omnesis.android.ui.common.LANDING_MARK_CENTRE_Y
import dev.omnesis.android.ui.common.landingPalette
import dev.omnesis.android.ui.common.ListPagingFooter
import dev.omnesis.android.ui.common.rememberPrependPagingAnchor
import kotlinx.coroutines.launch

@Composable
fun AgentScreen(
    onOpenMenu: () -> Unit,
    onOpenDocument: (String) -> Unit,
    onOpenWatch: ((String) -> Unit)? = null,
    onOpenSettings: () -> Unit = {},
    onOpenModels: () -> Unit = {},
    vm: AgentViewModel = hiltViewModel(),
) {
    val state by vm.state.collectAsStateWithLifecycle()
    val experimental by vm.experimentalEnabled.collectAsStateWithLifecycle()
    // This composable is the only thing that knows a transcript is actually
    // rendered. Scoped to the session so switching conversations withdraws the
    // old claim before making the new one, and torn down when the user moves
    // to another surface — the coordinator's session id outlives both.
    val shownSessionId = state.sessionId
    if (shownSessionId != null) {
        DisposableEffect(shownSessionId) {
            vm.conversationSurfaceVisible(shownSessionId, true)
            onDispose { vm.conversationSurfaceVisible(shownSessionId, false) }
        }
    }
    AgentContent(
        state = state,
        catalog = vm.catalog,
        onOpenMenu = onOpenMenu,
        onSend = { text, command -> vm.send(text, command?.deepResearch ?: false) },
        onStop = vm::cancelTurn,
        onRetry = vm::retry,
        onNewConversation = vm::newConversation,
        onTogglePin = vm::togglePin,
        onDeleteConversation = vm::deleteConversation,
        onRetryLiveSession = vm::retryLiveSession,
        onAckSendRejected = vm::ackSendRejected,
        onDismissActionError = vm::ackLastTurnError,
        onDismissConversationActionError = vm::ackConversationActionError,
        onFlushEphemeral = vm::flushEphemeralTail,
        onOpenDocument = onOpenDocument,
        onOpenWatch = onOpenWatch,
        onOpenSettings = onOpenSettings,
        onOpenModels = onOpenModels,
        experimental = experimental,
        onLoadOlderMessages = vm::loadOlderMessages,
    )
}

@Composable
fun AgentContent(
    state: AgentCoordinator.UiState,
    catalog: SourceCatalog,
    onOpenMenu: () -> Unit,
    onSend: (String, SlashCommand?) -> Unit,
    onStop: () -> Unit,
    onRetry: () -> Unit,
    onNewConversation: () -> Unit,
    onFlushEphemeral: (String) -> Unit,
    onOpenDocument: (String) -> Unit,
    onOpenWatch: ((String) -> Unit)? = null,
    onOpenSettings: () -> Unit = {},
    onOpenModels: () -> Unit = {},
    onAckSendRejected: () -> Unit = {},
    onDismissActionError: () -> Unit = {},
    experimental: Boolean = false,
    onLoadOlderMessages: () -> Unit = {},
    onRetryLiveSession: () -> Unit = {},
    onTogglePin: (String, Boolean) -> Unit = { _, _ -> },
    onDeleteConversation: (String) -> Unit = {},
    onDismissConversationActionError: () -> Unit = {},
) {
    var showCitations by remember { mutableStateOf(false) }
    var conversationMenuOpen by remember(state.sessionId) {
        mutableStateOf(false)
    }
    var pendingDeleteId by remember(state.sessionId) { mutableStateOf<String?>(null) }
    val busy = state.chat.busy
    // Enabled as soon as a client exists — including the fresh/empty state (no session yet;
    // send() mints one lazily), so a new conversation and a cold start are typable immediately;
    // disabled only while a transcript loads or a fatal error owns the surface.
    val enabled = state.canCompose
    // The reference drawer surfaces only annotate-recorded citations — never the
    // merged Deep Research set (that lives in the report-artifact card) — so it stays
    // untouched during a Deep Research run, matching iOS + the portal.
    val drawerCitations = AgentReducer.drawerCitations(state.chat)
    val hasReferences = drawerCitations.isNotEmpty() ||
        state.chat.records.isNotEmpty()
    // Which branch of the `when` below owns the surface: the landing screen, or something
    // with content in it. Read by the top fade strip, which has nothing to dissolve on the
    // landing screen. Kept in step with that `when`.
    val showsLanding = !state.transcriptLoading &&
        state.fatalError == null &&
        state.chat.turns.isEmpty() &&
        state.terminalFailure == null

    // Top-level overlay container: the conversation shell sits below, the citations drawer
    // slides in over it from the right.
    Box(Modifier.fillMaxSize()) {
        // Full-bleed shell: the transcript fills edge-to-edge on bgPrimary; floating chrome
        // (top fade strip + glass circle buttons) layers over it. No Scaffold / TopAppBar.
        Box(
            Modifier
                .fillMaxSize()
                .background(OmTheme.colors.bgPrimary),
        ) {
            // The floating composer pill (+ pinned plan panel) is a bottom-aligned
            // overlay in this Box, not a Column sibling — so the edge-to-edge
            // transcript scrolls visibly through the area behind it (the trailing
            // content padding keeps the last message clear of the pill). Mirrors
            // the iOS floating-glass-composer layout.
            val composer: @Composable () -> Unit = {
                Column {
                    state.conversationActionError
                        ?.takeIf { state.conversationActionErrorSessionId == state.sessionId }
                        ?.let { error ->
                        AgentActionErrorBanner(
                            message = error,
                            onDismiss = onDismissConversationActionError,
                            modifier = Modifier.padding(
                                start = OmTheme.spacing.md,
                                end = OmTheme.spacing.md,
                                bottom = OmTheme.spacing.xs,
                            ),
                        )
                    }
                    state.chat.lastTurnError?.let { error ->
                        AgentActionErrorBanner(
                            message = error,
                            onDismiss = onDismissActionError,
                            modifier = Modifier.padding(
                                start = OmTheme.spacing.md,
                                end = OmTheme.spacing.md,
                                bottom = OmTheme.spacing.xs,
                            ),
                        )
                    }
                    if (state.terminalFailure != null) {
                        ContextWindowExceededCard(onNewConversation)
                    } else if (state.liveSessionMissingReason != null) {
                        // The transcript above came from storage because no session could be
                        // minted. Take the composer's place rather than greying it out: a
                        // disabled input invites tapping and says nothing about why it will
                        // not answer.
                        ReadOnlyConversationCard(state.liveSessionMissingReason, onRetryLiveSession)
                    } else {
                        AgentComposer(
                            busy = busy,
                            enabled = enabled,
                            onSend = onSend,
                            onStop = onStop,
                            experimental = experimental,
                            // A send the gateway never accepted (failed mint, local Stop, refused POST)
                            // hands its text back here so the composer restores it instead of dropping it.
                            pendingRestore = state.sendRejectedText,
                            onRestoreConsumed = onAckSendRejected,
                            requestFocus = state.sessionId == null,
                            composerGeneration = state.composerGeneration,
                        )
                    }
                }
            }

            val fatal = state.fatalError
            when {
                // A resumed conversation whose transcript is still loading: the surface already
                // switched to the target (id + title); show a skeleton until the messages land
                // rather than the previous conversation or a blank empty state.
                state.transcriptLoading -> Column(Modifier.fillMaxSize()) {
                    AgentTranscriptSkeleton(Modifier.weight(1f))
                    composer()
                }

                // The fatal-error placeholder pins the composer below it (a Column),
                // since there is no transcript to scroll behind it.
                fatal != null -> Column(Modifier.fillMaxSize()) {
                    GatewayErrorView(
                        context = "start the agent",
                        error = fatal,
                        onRetry = onRetry,
                        onOpenSettings = onOpenSettings,
                        modifier = Modifier.weight(1f),
                        onOpenModels = onOpenModels,
                    )
                    composer()
                }

                // The landing backdrop still owns the whole surface. Only the foreground
                // responds to the IME, keeping the mark and headline above the keyboard-raised
                // composer without interrupting the wash behind the translucent pill.
                //
                // A freshly opened anchored thread has no visible turns — the seeded prefix is
                // the whole transcript and is hidden — but it is not a blank chat: it must show
                // the card it is a reply to, so it takes the transcript branch instead.
                state.chat.turns.isEmpty() &&
                    state.terminalFailure == null &&
                    !hasContextCard(state.conversationOrigin) -> {
                    var landingComposerHeightPx by remember { mutableStateOf(0) }
                    val density = LocalDensity.current
                    val imeBottomPx = WindowInsets.ime.getBottom(density)
                    val composerHeightTarget = with(density) {
                        if (imeBottomPx > 0) {
                            (landingComposerHeightPx - imeBottomPx).coerceAtLeast(0).toDp()
                        } else {
                            0.dp
                        }
                    }
                    val composerHeight by animateDpAsState(
                        targetValue = composerHeightTarget,
                        animationSpec = if (composerHeightTarget > 0.dp) snap() else spring(),
                        label = "landingComposerClearance",
                    )
                    LandingBackdrop(Modifier.matchParentSize())
                    AgentEmptyState(
                        Modifier
                            .fillMaxSize()
                            .windowInsetsPadding(WindowInsets.ime)
                            .padding(bottom = composerHeight),
                    )
                    Column(
                        Modifier
                            .align(Alignment.BottomCenter)
                            .fillMaxWidth()
                            .onSizeChanged { landingComposerHeightPx = it.height },
                    ) {
                        composer()
                    }
                }

                else -> {
                    // Measure the floating bottom bar (live research workspace + plan +
                    // composer) so the transcript reserves exactly its height. When the
                    // workspace is live the bar is far taller than the composer alone, and
                    // a static clearance would bury the last messages behind it.
                    var barHeightPx by remember { mutableStateOf(0) }
                    val barInset = with(LocalDensity.current) { barHeightPx.toDp() }
                    Transcript(
                        state = state,
                        catalog = catalog,
                        onFlushEphemeral = onFlushEphemeral,
                        onOpenDocument = onOpenDocument,
                        onOpenWatch = onOpenWatch,
                        modifier = Modifier.fillMaxSize(),
                        bottomInset = (barInset + 16.dp).coerceAtLeast(72.dp),
                        onLoadOlderMessages = onLoadOlderMessages,
                    )
                    Column(
                        Modifier
                            .align(Alignment.BottomCenter)
                            .fillMaxWidth()
                            // Opaque so the transcript scrolls cleanly behind the bar
                            // instead of bleeding through it (the workspace's own faint
                            // tint sits on top of this).
                            .background(OmTheme.colors.bgPrimary)
                            .onSizeChanged { barHeightPx = it.height },
                    ) {
                        AgentPlanPanel(state.chat.planItems)
                        composer()
                    }
                }
            }

            // Top fade strip: a solid→transparent gradient so the transcript dissolves into the
            // status-bar zone instead of hard-cutting under a nav bar. Suppressed on the
            // landing screen — there is no transcript to dissolve, and left up it would slab
            // flat bgPrimary across the backdrop's gradient.
            if (!showsLanding) {
                Box(
                    Modifier
                        .fillMaxWidth()
                        .height(90.dp)
                        .align(Alignment.TopStart)
                        .background(
                            Brush.verticalGradient(
                                listOf(OmTheme.colors.bgPrimary, OmTheme.colors.bgPrimary.copy(alpha = 0f)),
                            ),
                        ),
                )
            }

            // Floating top buttons: leading menu (hamburger), trailing new-conversation
            // (pencil) and overflow (...) merged into one capsule — new conversation
            // leads, overflow trails, no divider. Each icon keeps an independent
            // 46-dp tap target. Over the fade strip.
            Row(
                Modifier
                    .fillMaxWidth()
                    .align(Alignment.TopStart)
                    .windowInsetsPadding(WindowInsets.statusBars)
                    .padding(start = OmTheme.spacing.sm, end = 10.dp, top = 2.dp, bottom = 2.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                GlassCircleButton(onClick = onOpenMenu, contentDescription = "Menu") {
                    Icon(Icons.Outlined.Menu, contentDescription = null, tint = OmTheme.colors.textPrimary, modifier = Modifier.size(20.dp))
                }
                Spacer(Modifier.weight(1f))
                val showOverflow = state.sessionId != null
                val showNewChat = !isBlankNewConversation(state)
                if (showOverflow || showNewChat) {
                    GlassCapsuleGroup {
                        // Nothing to offer on a conversation that is already blank and new.
                        if (showNewChat) {
                            CapsuleIconButton(onClick = onNewConversation, contentDescription = "New conversation") {
                                Icon(Icons.Outlined.EditNote, contentDescription = null, tint = OmTheme.colors.textPrimary, modifier = Modifier.size(22.dp))
                            }
                        }
                        state.sessionId?.let { conversationId ->
                            val pinned = state.conversations
                                .firstOrNull { it.sessionId == conversationId }
                                ?.pinned
                                ?: state.activeConversationPinned
                            ConversationActionsMenu(
                                expanded = conversationMenuOpen,
                                pinned = pinned,
                                enabled = conversationId !in state.conversationActionsInFlight,
                                onOpen = { conversationMenuOpen = true },
                                onDismiss = { conversationMenuOpen = false },
                                onTogglePin = {
                                    conversationMenuOpen = false
                                    onTogglePin(conversationId, !pinned)
                                },
                                onDelete = {
                                    conversationMenuOpen = false
                                    pendingDeleteId = conversationId
                                },
                            )
                        }
                    }
                }
            }
        }

        // Right-side reference drawer. Renders its own scrim + slide animation; mounts only
        // once there is something to reference (or while it's animating closed).
        if (hasReferences || showCitations) {
            CitationsDrawer(
                open = showCitations,
                citations = drawerCitations,
                catalog = catalog,
                onClose = { showCitations = false },
                onOpen = { showCitations = true },
                onOpenDocument = { showCitations = false; onOpenDocument(it) },
                records = state.chat.records,
            )
        }
    }

    pendingDeleteId?.let { conversationId ->
        AlertDialog(
            onDismissRequest = { pendingDeleteId = null },
            title = { Text("Delete this chat?") },
            text = { Text("This chat will be permanently deleted.") },
            confirmButton = {
                TextButton(
                    onClick = {
                        pendingDeleteId = null
                        onDeleteConversation(conversationId)
                    },
                ) {
                    Text("Delete", color = OmTheme.colors.danger)
                }
            },
            dismissButton = {
                TextButton(onClick = { pendingDeleteId = null }) {
                    Text("Cancel")
                }
            },
        )
    }
}

@Composable
private fun ConversationActionsMenu(
    expanded: Boolean,
    pinned: Boolean,
    enabled: Boolean,
    onOpen: () -> Unit,
    onDismiss: () -> Unit,
    onTogglePin: () -> Unit,
    onDelete: () -> Unit,
) {
    val colors = OmTheme.colors
    Box {
        CapsuleIconButton(
            onClick = onOpen,
            contentDescription = "Conversation options",
            enabled = enabled,
        ) {
            Icon(
                Icons.Outlined.MoreHoriz,
                contentDescription = null,
                tint = colors.textPrimary,
                modifier = Modifier.size(22.dp),
            )
        }
        DropdownMenu(expanded = expanded, onDismissRequest = onDismiss) {
            DropdownMenuItem(
                text = { Text(if (pinned) "Unpin this chat" else "Pin this chat") },
                leadingIcon = { Icon(Icons.Outlined.PushPin, contentDescription = null) },
                onClick = onTogglePin,
            )
            DropdownMenuItem(
                text = { Text("Delete this chat", color = colors.danger) },
                leadingIcon = {
                    Icon(Icons.Outlined.Delete, contentDescription = null, tint = colors.danger)
                },
                onClick = onDelete,
            )
        }
    }
}

/** Compact, dismissible feedback for a send/stop action that the gateway rejected. */
@Composable
internal fun AgentActionErrorBanner(
    message: String,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = OmTheme.colors
    Row(
        modifier = modifier
            .fillMaxWidth()
            .semantics {
                liveRegion = LiveRegionMode.Assertive
                error(message)
            }
            .clip(RoundedCornerShape(12.dp))
            .background(colors.danger.copy(alpha = 0.12f))
            .border(0.5.dp, colors.danger.copy(alpha = 0.45f), RoundedCornerShape(12.dp))
            .padding(start = 12.dp, top = 9.dp, end = 8.dp, bottom = 9.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = message,
            color = colors.danger,
            style = MaterialTheme.typography.bodySmall,
            modifier = Modifier.weight(1f),
        )
        IconButton(onClick = onDismiss, modifier = Modifier.size(40.dp)) {
            Icon(
                imageVector = Icons.Filled.Close,
                contentDescription = "Dismiss error",
                tint = colors.danger,
                modifier = Modifier.size(18.dp),
            )
        }
    }
}

@Composable
private fun ContextWindowExceededCard(onNewConversation: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 8.dp)
            .background(OmTheme.colors.bgSecondary, RoundedCornerShape(16.dp))
            .border(
                1.dp,
                OmTheme.colors.accent.copy(alpha = 0.32f),
                RoundedCornerShape(16.dp),
            )
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            text = "Context window reached",
            style = MaterialTheme.typography.titleSmall,
            color = OmTheme.colors.textPrimary,
        )
        Text(
            text = "This conversation no longer fits in the selected model's context window. " +
                "Start a new conversation to continue.",
            style = MaterialTheme.typography.bodySmall,
            color = OmTheme.colors.textSecondary,
        )
        Button(onClick = onNewConversation) {
            Text("New conversation")
        }
    }
}

/**
 * Takes the composer's place when a conversation was read from storage because no session could
 * be minted. The transcript above it is complete and scrollable — only continuing the thread is
 * withheld, which is what this says. Retry re-attempts the mint, so the composer returns as soon
 * as the model does, without the reader losing their place.
 *
 * Shaped like [ContextWindowExceededCard] on purpose: both are the same situation to a reader —
 * a conversation they can read but not continue — and they should not look like two different
 * kinds of problem.
 */
@Composable
private fun ReadOnlyConversationCard(reason: String, onRetry: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 8.dp)
            .background(OmTheme.colors.bgSecondary, RoundedCornerShape(16.dp))
            .border(
                1.dp,
                OmTheme.colors.warning.copy(alpha = 0.32f),
                RoundedCornerShape(16.dp),
            )
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            text = "Read-only",
            style = MaterialTheme.typography.titleSmall,
            color = OmTheme.colors.textPrimary,
        )
        Text(
            text = reason,
            style = MaterialTheme.typography.bodySmall,
            color = OmTheme.colors.textSecondary,
        )
        Button(onClick = onRetry) {
            Text("Retry")
        }
    }
}

/**
 * One shared translucent capsule behind the merged trailing chat actions — the
 * new-conversation button and the overflow menu stay two independent 46-dp tap
 * targets with their own actions. Same fill and rim as the round buttons, drawn
 * as a pill. A single visible action collapses it back toward a circle.
 */
@Composable
private fun GlassCapsuleGroup(
    content: @Composable () -> Unit,
) {
    Row(
        Modifier
            .clip(CircleShape)
            .background(landingPalette.composerFill)
            .border(0.6.dp, landingPalette.composerRim, CircleShape),
        verticalAlignment = Alignment.CenterVertically,
    ) { content() }
}

/** A bare 46-dp tap target for one half of the trailing capsule — the glass lives on the group. */
@Composable
private fun CapsuleIconButton(
    onClick: () -> Unit,
    contentDescription: String,
    enabled: Boolean = true,
    content: @Composable () -> Unit,
) {
    Box(
        Modifier
            .size(46.dp)
            .semantics { this.contentDescription = contentDescription }
            .clickable(
                enabled = enabled,
                interactionSource = remember { MutableInteractionSource() },
                indication = null,
                onClickLabel = contentDescription,
                onClick = onClick,
            ),
        contentAlignment = Alignment.Center,
    ) { content() }
}

/** A 40-dp translucent glass circle behind a tappable icon — the iOS `GlassCircleButton`. */
@Composable
private fun GlassCircleButton(
    onClick: () -> Unit,
    contentDescription: String,
    enabled: Boolean = true,
    content: @Composable () -> Unit,
) {
    Box(
        Modifier
            .size(46.dp)
            .clip(CircleShape)
            .background(landingPalette.composerFill)
            // The same fine blue-gray rim as the composer, so the round chrome and the
            // pill read as one family rather than two borrowed styles.
            .border(0.6.dp, landingPalette.composerRim, CircleShape)
            .semantics { this.contentDescription = contentDescription }
            .clickable(
                enabled = enabled,
                interactionSource = remember { MutableInteractionSource() },
                indication = null,
                onClickLabel = contentDescription,
                onClick = onClick,
            ),
        contentAlignment = Alignment.Center,
    ) { content() }
}

/**
 * A cheap content signature that changes on every streamed token or tool beat, so the working
 * indicator's reveal debounce re-arms during streaming and settles only in a genuine gap. Covers
 * turn/part counts plus the trailing part's growth (text length, tool children/result), which is
 * everything that mutates while a turn is in flight.
 */
private fun agentWorkingRevision(turns: List<AgentTurn>): Int {
    val assistant = turns.lastOrNull() as? AgentTurn.Assistant ?: return turns.size
    var h = turns.size * 31 + assistant.parts.size
    h = h * 31 + when (val tail = assistant.parts.lastOrNull()) {
        is AgentPart.Text -> tail.text.length
        is AgentPart.Thinking -> tail.text.length
        is AgentPart.Tool -> tail.call.children.size * 2 + if (tail.call.result != null) 1 else 0
        else -> 0
    }
    return h
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun Modifier.transcriptKeyboardDismissal(): Modifier {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) return imeNestedScroll()

    val keyboardController = LocalSoftwareKeyboardController.current
    val touchSlop = LocalViewConfiguration.current.touchSlop
    val imeVisible = WindowInsets.isImeVisible
    val connection = remember(keyboardController, touchSlop, imeVisible) {
        KeyboardDismissNestedScrollConnection(touchSlop) {
            if (imeVisible) keyboardController?.hide()
        }
    }
    return nestedScroll(connection)
}

@Composable
private fun Transcript(
    state: AgentCoordinator.UiState,
    catalog: SourceCatalog,
    onFlushEphemeral: (String) -> Unit,
    onOpenDocument: (String) -> Unit,
    onOpenWatch: ((String) -> Unit)?,
    modifier: Modifier = Modifier,
    bottomInset: Dp = 140.dp,
    onLoadOlderMessages: () -> Unit = {},
) {
    val turns = state.chat.turns
    // An anchored thread pins its origin card above the pagination sentinel, so the number of
    // rows ahead of the first turn is not fixed. Everything that indexes into the list — the
    // initial scroll position and the prepend anchor — counts from here.
    val originCard = state.conversationOrigin.takeIf { hasContextCard(it) }
    val leadingItemCount = if (originCard != null) 2 else 1
    // Start on the newest turn so a newly opened transcript does not mistake initial
    // composition for a user reaching the older-history boundary. An anchored thread nobody has
    // replied to yet has no turns at all, and its card is the whole screen — so that one starts
    // at the top rather than one row past it.
    val listState = rememberLazyListState(
        initialFirstVisibleItemIndex = if (turns.isEmpty()) 0 else turns.size + leadingItemCount - 1,
    )
    val scope = rememberCoroutineScope()
    val prependAnchor = rememberPrependPagingAnchor()
    // Frozen to "stuck" under a Preview/Roborazzi capture so the scroll-chevron's
    // AnimatedVisibility can't flip as layout settles (an in-flight enter/exit animation
    // never idles and hangs the native capture).
    val inInspection = LocalInspectionMode.current

    // Whether the transcript is "stuck to the bottom" — the user is reading the latest
    // content. Derived from the list state: we are stuck when the last item is within a
    // couple of slots of the viewport's last visible item. While stuck, new tokens scroll
    // the view down to follow; once the user scrolls up, following stops (and the chevron
    // appears). Mirrors the iOS BottomStickController.
    val stickToBottom by remember(inInspection) {
        derivedStateOf {
            if (inInspection) return@derivedStateOf true
            val info = listState.layoutInfo
            val total = info.totalItemsCount
            if (total == 0) return@derivedStateOf true
            val lastVisible = info.visibleItemsInfo.lastOrNull()?.index ?: 0
            lastVisible >= total - 2
        }
    }

    // Follow streaming content only while stuck. Re-keys on turn count and the trailing
    // assistant's part count so each streamed part nudges the view down.
    val lastAssistantParts = (turns.lastOrNull() as? AgentTurn.Assistant)?.parts?.size ?: 0
    LaunchedEffect(turns.size, lastAssistantParts) {
        if (stickToBottom && !inInspection) {
            listState.animateScrollToItem((listState.layoutInfo.totalItemsCount - 1).coerceAtLeast(0))
        }
    }

    LaunchedEffect(state.transcriptPrependVersion) {
        if (!inInspection) {
            prependAnchor.restore(
                completedVersion = state.transcriptPrependVersion,
                listState = listState,
                orderedKeys = turns.map { it.id },
                leadingItemCount = leadingItemCount,
            )
        }
    }

    // Turn-level "still working" dots: eligible when the turn is in flight with a static trailing
    // part (no per-item spinner/shimmer of its own). The revision changes on every streamed token,
    // so the reveal debounce re-arms mid-stream and settles only in a real gap — always composed
    // here (not gated) so the debounce runs continuously, and its `revealed` result gates the
    // LazyColumn item below. Mirrors the iOS AgentWorkingIndicator wiring.
    val workingActive = AgentReducer.workingIndicatorActive(state.chat)
    val workingRevision = agentWorkingRevision(turns)
    val workingRevealed = rememberWorkingDotsRevealed(active = workingActive, revision = workingRevision)

    Box(modifier.fillMaxSize()) {
        LazyColumn(
            state = listState,
            modifier = Modifier
                .fillMaxSize()
                .transcriptKeyboardDismissal(),
            contentPadding = PaddingValues(
                start = OmTheme.spacing.lg,
                end = OmTheme.spacing.lg,
                top = 108.dp,
                // Clearance so the last message scrolls fully above the floating
                // bottom bar (composer + plan + the live research workspace) instead of
                // resting behind it — measured by the caller so it grows with the bar.
                bottom = bottomInset,
            ),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            if (originCard != null) {
                item(key = "transcript-origin") {
                    ConversationOriginCard(originCard, onOpenWatch = onOpenWatch)
                }
            }
            item(key = "transcript-pagination") {
                if (!state.chat.busy) {
                    ListPagingFooter(
                        listState = listState,
                        boundaryKey = "transcript-pagination",
                        paging = state.transcriptPaging,
                        loadAction = "earlier messages",
                        onLoadMore = {
                            prependAnchor.capture(
                                currentVersion = state.transcriptPrependVersion,
                                listState = listState,
                                eligibleKeys = turns.mapTo(hashSetOf()) { it.id },
                            )
                            onLoadOlderMessages()
                        },
                    )
                }
            }
            items(turns, key = { it.id }) { turn ->
                when (turn) {
                    is AgentTurn.User -> UserBubble(turn.text)
                    is AgentTurn.Assistant -> AssistantTurn(turn, catalog, onFlushEphemeral, onOpenDocument, citations = state.chat.citations)
                }
            }
            // The item is added only once the dots have actually revealed (a genuine quiet gap),
            // so a hidden/debouncing indicator never leaves an empty inter-item slot.
            if (workingRevealed) {
                item(key = "working") { WorkingDots() }
            }
        }

        // Floating scroll-to-bottom chevron, centred above the composer. Shown only when
        // the user has scrolled away from the bottom; tapping it re-arms the stick flag
        // by jumping to the last item. Mirrors the iOS scrollToBottom chevron.
        AnimatedVisibility(
            visible = !stickToBottom,
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .padding(bottom = 96.dp),
            enter = fadeIn(),
            exit = fadeOut(),
        ) {
            GlassCircleButton(
                onClick = {
                    scope.launch {
                        listState.animateScrollToItem((listState.layoutInfo.totalItemsCount - 1).coerceAtLeast(0))
                    }
                },
                contentDescription = "Scroll to latest",
            ) {
                Icon(
                    Icons.Outlined.KeyboardArrowDown,
                    contentDescription = null,
                    tint = OmTheme.colors.textPrimary,
                    modifier = Modifier.size(22.dp),
                )
            }
        }
    }
}

/**
 * The landing screen: the Omnesis mark over a layered wash, a short headline, nothing else.
 *
 * The mark aims for [LANDING_MARK_CENTRE_Y], then the whole block shifts up and the mark scales
 * down only when the available height requires it. Measuring the headline first keeps both
 * elements inside the height left above the composer without a layout-mode discontinuity. The
 * caller owns the full-screen backdrop, so the wash remains continuous behind the composer.
 */
@Composable
private fun AgentEmptyState(modifier: Modifier = Modifier) {
    Layout(
        modifier = modifier,
        content = {
            OmnesisMarkGlyph(Modifier.testTag("agentLandingMark"))
            Text(
                "Ask Omnesis about your corpus",
                style = MaterialTheme.typography.titleLarge.copy(
                    fontSize = 21.sp,
                    fontWeight = FontWeight.SemiBold,
                ),
                color = OmTheme.colors.textPrimary,
                textAlign = TextAlign.Center,
                maxLines = 2,
            )
        },
    ) { measurables, constraints ->
        val horizontalInset = 28.dp.roundToPx() * 2
        val headline = measurables[1].measure(
            Constraints(
                maxWidth = (constraints.maxWidth - horizontalInset).coerceAtLeast(0),
                maxHeight = constraints.maxHeight,
            ),
        )
        val preferredGap = 22.dp.roundToPx()
        val gap = preferredGap.coerceAtMost(
            (constraints.maxHeight - headline.height).coerceAtLeast(0),
        )
        val mark = measurables[0].measure(
            Constraints(
                maxWidth = constraints.maxWidth,
                maxHeight = (constraints.maxHeight - headline.height - gap).coerceAtLeast(0),
            ),
        )
        val blockHeight = mark.height + gap + headline.height
        val desiredTop =
            (constraints.maxHeight * LANDING_MARK_CENTRE_Y - mark.height / 2f).toInt()
        val top = desiredTop.coerceIn(0, (constraints.maxHeight - blockHeight).coerceAtLeast(0))

        layout(constraints.maxWidth, constraints.maxHeight) {
            mark.placeRelative((constraints.maxWidth - mark.width) / 2, top)
            headline.placeRelative(
                (constraints.maxWidth - headline.width) / 2,
                top + mark.height + gap,
            )
        }
    }
}

// --- previews ---

private fun previewState(): AgentCoordinator.UiState {
    val ref = AgentDocRef(documentId = "d1", sourceId = "notes:local", title = "Q4 budget review")
    val turns = listOf(
        AgentTurn.User("u1", "What did we decide about the Q4 budget?"),
        AgentTurn.Assistant(
            id = "a1",
            parts = listOf(
                AgentPart.Thinking("Searching the corpus for budget notes…"),
                AgentPart.Tool(
                    AgentToolCall(
                        toolCallId = "t1", tool = "search_documents", argsSummary = "Q4 budget", argsKnown = true,
                        result = AgentToolResult.SearchResults(query = "Q4 budget", results = listOf(ref)),
                        tailDismissed = true,
                    ),
                ),
                AgentPart.Text("You agreed to hold spend flat and revisit headcount in **January**. The note is here:"),
                AgentPart.Tool(
                    AgentToolCall(
                        toolCallId = "t2", tool = "fetch_document", argsSummary = "d1", argsKnown = true,
                        result = AgentToolResult.DocumentResult(ref = ref),
                    ),
                ),
            ),
            citationCount = 1,
        ),
    )
    return AgentCoordinator.UiState(
        chat = AgentChatState(turns = turns, busy = false),
        sessionId = "s1",
        title = "Q4 budget review",
        model = "claude (haiku)",
        hasClient = true,
        conversations = listOf(
            ConversationSummary(sessionId = "s1", title = "Q4 budget review", messageCount = 4),
            ConversationSummary(sessionId = "s2", title = "Marathon training plan", messageCount = 8),
        ),
    )
}

@Preview(name = "Agent · transcript · dark")
@Composable
private fun AgentPreviewDark() {
    OmnesisTheme(darkTheme = true) {
        AgentContent(
            state = previewState().copy(
                chat = previewState().chat.copy(
                    busy = true,
                    planItems = listOf(
                        AgentPlanItem("p1", "Search budget notes", "done"),
                        AgentPlanItem("p2", "Summarise the decision", "in_progress"),
                        AgentPlanItem("p3", "Cite the source", "pending"),
                    ),
                ),
            ),
            catalog = SourceCatalog(),
            onOpenMenu = {}, onSend = { _, _ -> }, onStop = {}, onRetry = {}, onNewConversation = {},
            onFlushEphemeral = {}, onOpenDocument = {},
        )
    }
}

@Preview(name = "Agent · empty · dark")
@Composable
private fun AgentPreviewEmpty() {
    OmnesisTheme(darkTheme = true) {
        AgentContent(
            state = AgentCoordinator.UiState(sessionId = "s1", hasClient = true),
            catalog = SourceCatalog(),
            onOpenMenu = {}, onSend = { _, _ -> }, onStop = {}, onRetry = {}, onNewConversation = {},
            onFlushEphemeral = {}, onOpenDocument = {},
        )
    }
}

// Live thinking indicator: an in-flight turn whose trailing part is a thinking
// block. Renders the animated "Thinking" row (chevron + shimmer + dots).
private val previewThinkingLiveTurn = AgentTurn.Assistant(
    id = "a-think-live",
    parts = listOf(
        AgentPart.Thinking(
            "The user wants the Q4 audit vendor. Let me search the engagement letter, then cross-check the invoice dates before answering.",
        ),
    ),
    stopReason = null,
)

// Completed turn that reasoned first: the thinking block is no longer live, so
// only the answer remains.
private val previewThinkingDoneTurn = AgentTurn.Assistant(
    id = "a-think-done",
    parts = listOf(
        AgentPart.Thinking("Let me search the engagement letter first."),
        AgentPart.Text("The Q4 audit was handled by **Studio Northstar**."),
    ),
    stopReason = "end_turn",
)

@Composable
private fun ThinkingTurnPreview(turn: AgentTurn.Assistant, dark: Boolean) {
    OmnesisTheme(darkTheme = dark) {
        Box(Modifier.background(OmTheme.colors.bgPrimary).padding(16.dp)) {
            AssistantTurn(turn, catalog = SourceCatalog(), onFlushEphemeral = {}, onOpenDocument = {})
        }
    }
}

@Preview(name = "Agent · thinking live · dark")
@Composable
private fun AgentThinkingLivePreviewDark() {
    ThinkingTurnPreview(previewThinkingLiveTurn, dark = true)
}

@Preview(name = "Agent · thinking live · light")
@Composable
private fun AgentThinkingLivePreviewLight() {
    ThinkingTurnPreview(previewThinkingLiveTurn, dark = false)
}

@Preview(name = "Agent · thinking done · dark")
@Composable
private fun AgentThinkingDonePreviewDark() {
    ThinkingTurnPreview(previewThinkingDoneTurn, dark = true)
}

@Preview(name = "Agent · thinking done · light")
@Composable
private fun AgentThinkingDonePreviewLight() {
    ThinkingTurnPreview(previewThinkingDoneTurn, dark = false)
}
