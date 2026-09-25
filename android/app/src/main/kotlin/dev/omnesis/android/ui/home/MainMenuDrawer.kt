// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.home

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ChatBubbleOutline
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.GridView
import androidx.compose.material.icons.outlined.Inbox
import androidx.compose.material.icons.outlined.Mic
import androidx.compose.material.icons.outlined.People
import androidx.compose.material.icons.outlined.PushPin
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.Shield
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.omnesis.android.designsystem.components.OmSpinner
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.transport.dto.BriefsMenuEntry
import dev.omnesis.android.transport.dto.ConversationSummary
import dev.omnesis.android.ui.agent.AgentActionErrorBanner
import dev.omnesis.android.ui.common.CursorPagingState
import dev.omnesis.android.ui.common.ListPagingFooter
import dev.omnesis.android.ui.common.PullToRefresh

/**
 * The app's primary navigation menu — the layer that sits *under* the app and is
 * revealed when `MenuRevealContainer` slides the app aside. The Android port of the iOS
 * `MainMenuDrawer`.
 *
 * A single scroll context spans the wordmark, one continuous list of navigation
 * destinations, a "Conversations" header, and an inline list of recent agent sessions
 * driven by the singleton AgentCoordinator. There is no separate "Agent" nav item — the
 * agent IS the home surface, reached from the action bar or by tapping a conversation.
 *
 * A bar held across the foot carries the two actions that are never a destination: start
 * a conversation, and open Settings. They are deliberately not rows — everything in the
 * scrolling list answers "where do I want to be", these answer "do the thing" and "change
 * how the app behaves", and both have to stay reachable however far the history has been
 * scrolled. The list scrolls under the bar and rests clear of it.
 */
@Composable
fun MainMenuDrawer(
    currentRoute: String?,
    conversations: List<ConversationSummary>,
    conversationsLoading: Boolean,
    conversationsPaging: CursorPagingState = CursorPagingState(),
    conversationsError: String? = null,
    conversationActionError: String? = null,
    onNewConversation: () -> Unit,
    onNavigate: (String) -> Unit,
    onTellBrain: () -> Unit = {},
    queuedNotesNeedAttention: Boolean = false,
    onQueuedNotesWarning: () -> Unit = {},
    onResumeConversation: (String) -> Unit,
    onDeleteConversation: (String) -> Unit,
    onTogglePin: (String, Boolean) -> Unit = { _, _ -> },
    onDismissConversationActionError: () -> Unit = {},
    onOpenSettings: () -> Unit,
    onRefreshConversations: () -> Unit = {},
    onLoadMoreConversations: () -> Unit = {},
    experimental: Boolean = false,
    /** Whether Briefs is hidden, ready, or visible but waiting for its model. */
    briefsMenuEntry: BriefsMenuEntry = BriefsMenuEntry.HIDDEN,
    onConfigureBackgroundAgent: () -> Unit = {},
    briefsUnreadCount: Int = 0,
    /** Privacy decisions waiting on the operator: held answers plus any watch requests. */
    privacyPendingCount: Int = 0,
    modifier: Modifier = Modifier,
) {
    val colors = OmTheme.colors
    val listState = rememberLazyListState()
    // Measured, not a hand-kept constant: the bar's height moves with its padding and with
    // the user's font scale, and a stale number would strand the last conversation behind it.
    var actionBarHeightPx by remember { mutableIntStateOf(0) }
    val actionBarHeight = with(LocalDensity.current) { actionBarHeightPx.toDp() }
    Surface(color = colors.bgDrawer, modifier = modifier.fillMaxSize()) {
      Box(Modifier.fillMaxSize()) {
        // Pull-to-refresh the conversation list, mirroring the iOS `.refreshable`. The
        // indicator follows the coordinator's own in-flight flag, so it retires when the fetch
        // settles whether or not the list came back different.
        PullToRefresh(
            refreshing = conversationsLoading,
            onRefresh = onRefreshConversations,
            modifier = Modifier.windowInsetsPadding(WindowInsets.statusBars),
        ) {
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                state = listState,
                // The list scrolls *under* the bar but comes to rest clear of it.
                contentPadding = PaddingValues(bottom = actionBarHeight),
            ) {
            // --- header: the wordmark. Settings lives on the action bar at the foot. ---
            item {
                Row(
                    Modifier
                        .fillMaxWidth()
                        .padding(start = 12.dp, end = 12.dp, top = 8.dp, bottom = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        "Omnesis",
                        style = MaterialTheme.typography.titleLarge,
                        color = colors.textPrimary,
                    )
                    Spacer(Modifier.weight(1f))
                }
            }

            // --- menu rows ---
            // Every row here is a place to go, which is why starting a conversation is
            // not among them and lives on the action bar instead.
            item {
                MenuRow(
                    icon = Icons.Outlined.Search,
                    label = "Search",
                    active = currentRoute == "search",
                    onClick = { onNavigate("search") },
                )
            }

            // Omnesis Briefs — the proactive awareness feed. Experimental mode keeps the
            // stored feed available even while its producer is waiting for a model. In that
            // state the row still opens Briefs; only the separate warning opens the repair.
            if (briefsMenuEntry != BriefsMenuEntry.HIDDEN) {
                item {
                    MenuRow(
                        icon = Icons.Outlined.Inbox,
                        label = "Briefs",
                        active = currentRoute == "briefs",
                        onClick = { onNavigate("briefs") },
                        badge = briefsUnreadCount,
                        warning = if (briefsMenuEntry == BriefsMenuEntry.NEEDS_ATTENTION) {
                            MenuRowWarning(
                                "Configure the Background agent model",
                                onConfigureBackgroundAgent,
                            )
                        } else {
                            null
                        },
                    )
                }
            }
            item {
                MenuRow(
                    icon = Icons.Outlined.GridView,
                    label = "Sources",
                    active = currentRoute == "sources",
                    onClick = { onNavigate("sources") },
                )
            }
            item {
                MenuRow(
                    icon = Icons.Outlined.People,
                    label = "People",
                    active = currentRoute == "people",
                    onClick = { onNavigate("people") },
                )
            }
            item {
                MenuRow(
                    icon = Icons.Outlined.Mic,
                    label = "Tell Omnesis",
                    active = currentRoute?.startsWith("capture") == true,
                    onClick = onTellBrain,
                    warning = if (queuedNotesNeedAttention) {
                        MenuRowWarning("Show notes waiting to sync", onQueuedNotesWarning)
                    } else {
                        null
                    },
                )
            }

            // Watches is the runtime: what is being watched for, and what it has
            // said. Privacy is the record beside it: which integration asked, and
            // what it is allowed to be told. They are the same subject read from
            // two ends, so they remain adjacent.
            if (experimental) {
                item {
                    MenuRow(
                        icon = Icons.Outlined.Visibility,
                        label = "Watches",
                        active = currentRoute?.startsWith("watches") == true,
                        onClick = { onNavigate("watches") },
                    )
                }
            }
            // Privacy is a standard control surface, not an experimental one: an Answer
            // integration can require an operator decision in normal operation, and a
            // decision nobody can reach is a decision that never gets made.
            item {
                MenuRow(
                    icon = Icons.Outlined.Shield,
                    label = "Audit",
                    active = currentRoute?.startsWith("privacy") == true,
                    onClick = { onNavigate("privacy") },
                    badge = privacyPendingCount,
                    badgeDescription = if (privacyPendingCount == 1) {
                        "1 decision waiting for you"
                    } else {
                        "$privacyPendingCount decisions waiting for you"
                    },
                )
            }

            // --- conversations section header ---
            item { SectionHeader("Conversations") }

            conversationActionError?.let { message ->
                item("conversation-action-error") {
                    AgentActionErrorBanner(
                        message = message,
                        onDismiss = onDismissConversationActionError,
                        modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
                    )
                }
            }

            // --- conversations body ---
            when {
                conversations.isEmpty() && conversationsLoading -> item { ConvLoading() }
                conversations.isEmpty() && conversationsError != null -> item {
                    ConversationLoadError(
                        message = conversationsError,
                        onRetry = onRefreshConversations,
                    )
                }
                conversations.isEmpty() -> item { ConvEmptyState() }
                else -> items(conversations, key = { it.sessionId }) { c ->
                    ConversationDrawerRow(
                        title = c.title.ifBlank { "(untitled)" },
                        pinned = c.pinned,
                        unread = c.unread,
                        onClick = { onResumeConversation(c.sessionId) },
                        onDelete = { onDeleteConversation(c.sessionId) },
                        onTogglePin = { onTogglePin(c.sessionId, !c.pinned) },
                    )
                }
            }
            if (conversations.isNotEmpty() && conversationsError != null) {
                item("conversations-error") {
                    ConversationLoadError(
                        message = conversationsError,
                        onRetry = onRefreshConversations,
                    )
                }
            }
            item("conversations-paging") {
                ListPagingFooter(
                    listState = listState,
                    boundaryKey = "conversations-paging",
                    paging = conversationsPaging,
                    loadAction = "more conversations",
                    onLoadMore = onLoadMoreConversations,
                    modifier = Modifier.padding(horizontal = 12.dp),
                )
            }
            }
        }
        MenuActionBar(
            onNewConversation = onNewConversation,
            onOpenSettings = onOpenSettings,
            modifier = Modifier
                .align(Alignment.BottomStart)
                .onSizeChanged { actionBarHeightPx = it.height },
        )
      }
    }
}

/**
 * The two actions that are not destinations, held across the foot of the menu so neither
 * scrolls away. Settings is a quiet round target on the leading side; "Ask" is the app's
 * one primary action, carries the accent fill, and sits trailing — under the thumb, and on
 * the side the app itself is on.
 *
 * The list passes behind this bar, so the fade is what keeps the last row legible as it
 * goes under. It reaches above the bar's own box and past the navigation bar below.
 *
 * The ramp runs the full height of that box rather than finishing half way down it:
 * completing early leaves a flat slab from the buttons' waistline to the bottom of the
 * screen, and the eye reads that hard line as the edge of the menu. It also stops short of
 * opaque, so a row passing behind the very bottom is still faintly there instead of being
 * cut off mid-word.
 */
@Composable
private fun MenuActionBar(
    onNewConversation: () -> Unit,
    onOpenSettings: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = OmTheme.colors
    Box(
        modifier
            .fillMaxWidth()
            .background(
                Brush.verticalGradient(
                    0.00f to colors.bgDrawer.copy(alpha = 0f),
                    0.45f to colors.bgDrawer.copy(alpha = 0.55f),
                    1.00f to colors.bgDrawer.copy(alpha = 0.82f),
                ),
            ),
    ) {
        Row(
            Modifier
                .fillMaxWidth()
                .windowInsetsPadding(WindowInsets.navigationBars)
                .padding(start = OmSpacing.md, end = OmSpacing.md, top = OmSpacing.xl, bottom = OmSpacing.md),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                Modifier
                    .size(44.dp)
                    .clip(CircleShape)
                    .background(colors.bgSecondary)
                    .clickable(onClick = onOpenSettings)
                    .semantics { contentDescription = "Settings" },
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    Icons.Outlined.Settings,
                    contentDescription = null,
                    tint = colors.textPrimary,
                    modifier = Modifier.size(20.dp),
                )
            }
            Spacer(Modifier.weight(1f))
            Row(
                Modifier
                    .clip(CircleShape)
                    .background(colors.accent)
                    .clickable(onClick = onNewConversation)
                    .padding(horizontal = OmSpacing.lg, vertical = OmSpacing.md)
                    .semantics { contentDescription = "New conversation" },
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(OmSpacing.sm),
            ) {
                Icon(
                    Icons.Outlined.Edit,
                    contentDescription = null,
                    tint = Color.White,
                    modifier = Modifier.size(18.dp),
                )
                Text(
                    "Ask",
                    style = MaterialTheme.typography.labelLarge,
                    color = Color.White,
                )
            }
        }
    }
}

@Composable
private fun ConversationLoadError(
    message: String,
    onRetry: () -> Unit,
) {
    Column(
        Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            message,
            style = MaterialTheme.typography.bodySmall,
            color = OmTheme.colors.warning,
        )
        OutlinedButton(
            onClick = onRetry,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text("Retry loading conversations")
        }
    }
}

/**
 * A group label separating the navigation rows from conversations.
 */
@Composable
private fun SectionHeader(title: String) {
    val colors = OmTheme.colors
    Text(
        title.uppercase(),
        style = MaterialTheme.typography.labelSmall,
        color = colors.textMuted,
        letterSpacing = 0.8.sp,
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = 12.dp, end = 12.dp, top = 16.dp, bottom = 4.dp),
    )
}

/**
 * A row's attention marker: an amber triangle at the trailing edge. It is its own tap target,
 * separate from the row, because it leads somewhere the row does not — unsent notes open
 * delivery details while the row still starts a capture.
 *
 * Both fields are required. An unlabelled triangle is a visible warning no screen reader can
 * announce, and one without a destination is a control that does nothing.
 */
private data class MenuRowWarning(val description: String, val onClick: () -> Unit)

/**
 * A single navigation row. The active row paints a full-bleed accent@14% band (zero
 * radius, no inset) and turns its icon accent + label weight semibold — the iOS treatment.
 * The label colour stays `textPrimary` in both states; only the icon tint and weight change.
 *
 * [warning] is the drawer's single way to say "this destination needs attention" — an amber
 * triangle at the trailing edge, and never a sentence of diagnostics.
 */
@Composable
private fun MenuRow(
    icon: ImageVector,
    label: String,
    active: Boolean,
    onClick: () -> Unit,
    warning: MenuRowWarning? = null,
    /** Unread count, shown as a pill. In-app attention only — never an OS badge. */
    badge: Int = 0,
    /** What the pill's number counts, for a screen reader. */
    badgeDescription: String? = null,
) {
    val colors = OmTheme.colors
    Row(
        Modifier
            .fillMaxWidth()
            .background(if (active) colors.accent.copy(alpha = 0.14f) else Color.Transparent)
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Box(Modifier.width(22.dp), contentAlignment = Alignment.Center) {
            Icon(
                icon,
                contentDescription = null,
                tint = if (active) colors.accent else colors.textPrimary,
                modifier = Modifier.size(18.dp),
            )
        }
        Text(
            label,
            style = TextStyle(
                fontSize = 18.sp,
                fontWeight = if (active) FontWeight.SemiBold else FontWeight.Normal,
            ),
            color = colors.textPrimary,
        )
        if (badge > 0) {
            Spacer(Modifier.weight(1f))
            MenuBadge(count = badge, description = badgeDescription)
        }
        if (warning != null) {
            if (badge <= 0) Spacer(Modifier.weight(1f))
            IconButton(
                onClick = warning.onClick,
                modifier = Modifier.size(48.dp),
            ) {
                Icon(
                    Icons.Outlined.WarningAmber,
                    contentDescription = warning.description,
                    tint = colors.warning,
                    modifier = Modifier.size(20.dp),
                )
            }
        }
    }
}

/**
 * A single inline conversation row: single-line ellipsized title (preceded by a
 * pin glyph when pinned), tap to resume, long-press for a "Pin/Unpin" + "Delete"
 * context menu. Press feedback tints the row to `bgSecondary`, mirroring the iOS
 * `DrawerRowButtonStyle`.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ConversationDrawerRow(
    title: String,
    pinned: Boolean,
    unread: Boolean,
    onClick: () -> Unit,
    onDelete: () -> Unit,
    onTogglePin: () -> Unit,
) {
    val colors = OmTheme.colors
    var menuOpen by remember { mutableStateOf(false) }
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    Box {
        Row(
            Modifier
                .fillMaxWidth()
                .background(if (pressed) colors.bgSecondary else Color.Transparent)
                .combinedClickable(
                    interactionSource = interaction,
                    indication = null,
                    onClick = onClick,
                    onLongClick = { menuOpen = true },
                )
                .height(40.dp)
                .padding(horizontal = 12.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            // An indicator gutter, present on every row so the titles share one
            // left edge whether or not the row is unread.
            Box(Modifier.width(14.dp), contentAlignment = Alignment.CenterStart) {
                if (unread) {
                    Box(
                        Modifier
                            .size(6.dp)
                            .background(colors.accent, CircleShape)
                            .semantics { contentDescription = "Unread" },
                    )
                }
            }
            if (pinned) {
                Icon(
                    Icons.Outlined.PushPin,
                    contentDescription = null,
                    tint = colors.textMuted,
                    modifier = Modifier.size(14.dp),
                )
                Spacer(Modifier.width(6.dp))
            }
            Text(
                title,
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = if (unread) FontWeight.SemiBold else null,
                color = colors.textPrimary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
        }
        DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
            DropdownMenuItem(
                text = { Text(if (pinned) "Unpin" else "Pin") },
                leadingIcon = { Icon(Icons.Outlined.PushPin, contentDescription = null) },
                onClick = {
                    menuOpen = false
                    onTogglePin()
                },
            )
            DropdownMenuItem(
                text = { Text("Delete", color = colors.danger) },
                leadingIcon = { Icon(Icons.Outlined.Delete, contentDescription = null, tint = colors.danger) },
                onClick = {
                    menuOpen = false
                    onDelete()
                },
            )
        }
    }
}

@Composable
private fun ConvLoading() {
    Box(
        Modifier.fillMaxWidth().heightIn(min = 200.dp),
        contentAlignment = Alignment.Center,
    ) {
        OmSpinner(color = OmTheme.colors.accent)
    }
}

@Composable
private fun ConvEmptyState() {
    val colors = OmTheme.colors
    Column(
        Modifier.fillMaxWidth().heightIn(min = 200.dp).padding(top = 16.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Icon(
            Icons.Outlined.ChatBubbleOutline,
            contentDescription = null,
            tint = colors.textMuted,
            modifier = Modifier.size(40.dp),
        )
        Spacer(Modifier.height(12.dp))
        Text(
            "No prior conversations",
            style = TextStyle(fontSize = 14.sp),
            color = colors.textSecondary,
        )
        Spacer(Modifier.height(12.dp))
        Text(
            "Send a message in the Agent tab to start one.",
            style = TextStyle(fontSize = 12.sp),
            color = colors.textMuted,
            textAlign = TextAlign.Center,
        )
    }
}

/**
 * Small count pill for a menu row.
 *
 * A bare numeral beside a label reads as "Privacy, 3", so [description] says what the number
 * counts. It defaults to unread items, which is what most rows carry; a queue of decisions
 * passes its own phrasing.
 *
 * In-app only: this is opt-in attention on a surface the user already opened, never an OS
 * app-icon badge or a push. Caps at `99+` so a backlog never widens the row.
 */
@Composable
private fun MenuBadge(count: Int, description: String? = null) {
    val colors = OmTheme.colors
    Box(
        Modifier
            .clip(CircleShape)
            .background(colors.accent)
            .padding(horizontal = 7.dp, vertical = 2.dp)
            // The row is one merged node for a screen reader; the numeral inside is
            // replaced by the phrase, not read beside it.
            .clearAndSetSemantics { contentDescription = description ?: "$count unread" },
        contentAlignment = Alignment.Center,
    ) {
        Text(
            if (count > 99) "99+" else "$count",
            style = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.SemiBold),
            color = Color.White,
        )
    }
}
