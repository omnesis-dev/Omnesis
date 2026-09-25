// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.home

import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.tween
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import dev.omnesis.android.transport.dto.BriefsMenuEntry
import dev.omnesis.android.ui.agent.AgentScreen
import dev.omnesis.android.access.AccessAuthorizationPairingIdentity
import dev.omnesis.android.ui.access.AccessAuthorizationScreen
import dev.omnesis.android.ui.access.AccessPendingRequestBanner
import dev.omnesis.android.ui.briefs.BriefsScreen
import dev.omnesis.android.ui.common.GlobalHealthWarningBanner
import dev.omnesis.android.ui.common.NotificationSetupIssue
import dev.omnesis.android.ui.common.showsNotificationIssueGlobally
import dev.omnesis.android.ui.common.NotificationWarningDismissal
import dev.omnesis.android.ui.common.notificationSetupIssue
import dev.omnesis.android.designsystem.theme.OmSpacing
import dev.omnesis.android.ui.capture.CaptureScreen
import dev.omnesis.android.ui.capture.CaptureSurface
import dev.omnesis.android.ui.devannotate.DevAnnotationDialog
import dev.omnesis.android.ui.devannotate.ShakeToAnnotate
import dev.omnesis.android.ui.devannotate.devTargetForRoute
import dev.omnesis.android.ui.devices.DevicesScreen
import dev.omnesis.android.ui.document.DocumentDetailScreen
import dev.omnesis.android.ui.models.BackendDetailScreen
import dev.omnesis.android.ui.models.BackendsScreen
import dev.omnesis.android.ui.models.ModelsScreen
import dev.omnesis.android.ui.notes.PendingNotesSheet
import dev.omnesis.android.notes.PENDING_WARNING_AGE
import dev.omnesis.android.notes.pendingNoteNeedsAttention
import dev.omnesis.android.ui.people.MergeCandidatesScreen
import dev.omnesis.android.ui.people.MergeRulesScreen
import dev.omnesis.android.ui.people.PeopleScreen
import dev.omnesis.android.ui.people.PersonDetailScreen
import dev.omnesis.android.ui.privacy.DirectAuditDetailScreen
import dev.omnesis.android.ui.privacy.PrivacyApprovalScreen
import dev.omnesis.android.ui.privacy.PrivacyExchangeDetailScreen
import dev.omnesis.android.ui.privacy.PoliciesListScreen
import dev.omnesis.android.ui.privacy.PrivacyPolicyScreen
import dev.omnesis.android.ui.watches.WatchDetailScreen
import dev.omnesis.android.ui.watches.WatchesScreen
import dev.omnesis.android.ui.privacy.PrivacyScreen
import dev.omnesis.android.ui.privacy.PrivacySubscriptionApprovalScreen
import dev.omnesis.android.ui.search.SearchScreen
import dev.omnesis.android.ui.settings.SettingsScreen
import dev.omnesis.android.setup.flow.PhoneSetupEntry
import dev.omnesis.android.ui.phonesetup.PhoneSetupScreen
import dev.omnesis.android.ui.sources.SourceDetailScreen
import dev.omnesis.android.ui.sources.SourceRecentScreen
import dev.omnesis.android.ui.sources.SourcesScreen
import kotlinx.coroutines.delay
import java.time.Duration
import java.time.Instant

/**
 * Paired-state shell. A full-screen, scrim-less main menu drawer (the iOS
 * `MainMenuDrawer` port) slides in from the leading edge over the destination nav graph.
 * The agent is the start destination; the drawer's "New conversation" / conversation rows
 * drive the singleton AgentCoordinator and bring the agent surface forward.
 */
@Composable
fun HomeScaffold(
    vm: HomeViewModel = hiltViewModel(),
    nav: NavHostController = rememberNavController(),
) {
    val connection by vm.connection.collectAsStateWithLifecycle()
    val agentState by vm.agentState.collectAsStateWithLifecycle()
    val experimental by vm.experimentalEnabled.collectAsStateWithLifecycle()
    val briefsMenuEntry by vm.briefsMenuEntry.collectAsStateWithLifecycle()
    val briefsUnread by vm.briefsUnreadCount.collectAsStateWithLifecycle()
    val privacyPending by vm.privacyPendingCount.collectAsStateWithLifecycle()
    val pendingApprovalToPresent by vm.pendingApprovalToPresent.collectAsStateWithLifecycle()
    val captureRequest by vm.captureRequest.collectAsStateWithLifecycle()
    val searchRequest by vm.searchRequest.collectAsStateWithLifecycle()
    val privacyApprovalRequest by vm.privacyApprovalRequest.collectAsStateWithLifecycle()
    val accessAuthorizationRequest by vm.accessAuthorizationRequest.collectAsStateWithLifecycle()
    val agentConversationRequest by vm.agentConversationRequest.collectAsStateWithLifecycle()
    val watchFiringRequest by vm.watchFiringRequest.collectAsStateWithLifecycle()
    val sourcePermissionRequest by vm.sourcePermissionRequest.collectAsStateWithLifecycle()
    val remoteSourcePermissionRequest by vm.remoteSourcePermissionRequest.collectAsStateWithLifecycle()
    val pendingNotes by vm.pendingNotes.collectAsStateWithLifecycle()
    val permissionHealth by vm.permissionHealthState.collectAsStateWithLifecycle()
    val notificationHealth by vm.notificationHealth.collectAsStateWithLifecycle()
    val pushPlan by vm.pushPlan.collectAsStateWithLifecycle()
    val pushRegistrationFailed by vm.pushRegistrationFailed.collectAsStateWithLifecycle()
    val accessPending by vm.accessPending.collectAsStateWithLifecycle()
    val developerMode by vm.developerEnabled.collectAsStateWithLifecycle()
    // While phone setup presents (opened from Settings), every launch and offer below waits for it.
    val setupPresenting by vm.setupPresenting.collectAsStateWithLifecycle()
    val backStackEntry = nav.currentBackStackEntryAsState().value
    val currentRoute = backStackEntry?.destination?.route

    // Dismissible notification warning: one visible epoch per disabled spell.
    // Persisted so a relaunch does not resurface it; cleared when the app
    // observes healthy delivery again. Only the disabled-delivery issue is
    // dismissible — setup problems keep showing until fixed.
    val appContext = LocalContext.current
    var notificationWarningDismissed by remember {
        mutableStateOf(NotificationWarningDismissal.isDismissed(appContext))
    }
    LaunchedEffect(notificationHealth) {
        if (NotificationWarningDismissal.shouldResetDismissal(notificationHealth) &&
            notificationWarningDismissed
        ) {
            NotificationWarningDismissal.setDismissed(appContext, false)
            notificationWarningDismissed = false
        }
    }
    val notificationIssue = notificationSetupIssue(
        vm.pushConfigured,
        pushPlan,
        notificationHealth,
        pushRegistrationFailed,
    )
    val notificationNeedsAttention =
        showsNotificationIssueGlobally(notificationIssue, notificationWarningDismissed)
    val dismissNotificationWarning: (() -> Unit)? =
        if (notificationIssue == NotificationSetupIssue.PERMISSION && !notificationWarningDismissed) {
            {
                NotificationWarningDismissal.setDismissed(appContext, true)
                notificationWarningDismissed = true
            }
        } else {
            null
        }

    var drawerOpen by remember { mutableStateOf(false) }
    var pendingSheetOpen by remember { mutableStateOf(false) }
    var requestedModelPickerRole by rememberSaveable { mutableStateOf<String?>(null) }
    var focusedSourcePermissionId by rememberSaveable { mutableStateOf<String?>(null) }
    var focusedDeviceId by rememberSaveable { mutableStateOf<String?>(null) }
    var attentionNow by remember { mutableStateOf(Instant.now()) }
    // Shake-to-annotate (developer mode only): shaking the phone opens a
    // composer targeting whatever is on screen — the iOS gesture's Android
    // analogue.
    var devAnnotationOpen by rememberSaveable { mutableStateOf(false) }
    ShakeToAnnotate(enabled = developerMode) { devAnnotationOpen = true }
    if (devAnnotationOpen) {
        // Snapshot the target when the dialog opens (not on every
        // recomposition) so navigation underneath can't retarget the note —
        // and its label — while the operator types.
        val devTarget = remember {
            devTargetForRoute(
                route = currentRoute,
                documentId = backStackEntry?.arguments?.getString("id"),
                agentSessionId = agentState.sessionId,
            )
        }
        DevAnnotationDialog(
            target = devTarget,
            fileNote = { note -> vm.fileDevAnnotation(devTarget, note) },
            onClose = { devAnnotationOpen = false },
        )
    }

    fun openDrawer() {
        drawerOpen = true
        // Pull a fresh conversation list and unread count each time the menu is shown:
        // neither is pushed, so revealing the menu is the moment to ask.
        vm.refreshConversations()
        vm.refreshGatewayStatus()
        vm.refreshBriefsUnreadCount()
        vm.refreshPrivacyPending()
    }
    fun closeDrawer() {
        drawerOpen = false
    }

    fun navigateTo(route: String) {
        closeDrawer()
        if (currentRoute != route) {
            nav.navigate(route) {
                popUpTo(nav.graph.startDestinationId) { saveState = true }
                launchSingleTop = true
                restoreState = true
            }
        }
    }

    fun openSettingsChild(route: String) {
        closeDrawer()
        nav.navigateToSettingsChild(route)
    }

    fun bringAgentForward() {
        if (currentRoute != "agent") {
            nav.navigate("agent") {
                popUpTo(nav.graph.startDestinationId) { saveState = true }
                launchSingleTop = true
                restoreState = true
            }
        }
    }

    // Reachable from the "Open Settings" affordance on any full-screen gateway error.
    val openSettings: () -> Unit = {
        focusedSourcePermissionId = null
        focusedDeviceId = null
        nav.navigate("settings") { launchSingleTop = true }
    }

    // Reachable from the agent's first-run "no model assigned" state. Preserve Settings as
    // the Models screen's parent so both toolbar and system Back return to the expected place.
    val openModels: () -> Unit = {
        requestedModelPickerRole = null
        openSettingsChild(MODELS_ROUTE)
    }
    val configureBackgroundAgent: () -> Unit = {
        requestedModelPickerRole = "background-agent"
        openSettingsChild(MODELS_ROUTE)
    }
    val openPrivacyExchange: (String, String) -> Unit = { conversationId, taskId ->
        val route = privacyExchangeRoute(conversationId, taskId)
        if (!nav.popBackStack(route, inclusive = false)) nav.navigate(route)
    }
    // The policy an exchange was reviewed under opens on top of that exchange, so Back
    // returns to the exchange rather than to Settings.
    val openPolicy: (String, String?) -> Unit = { familyId, name ->
        nav.navigate(policyRoute(familyId, name)) { launchSingleTop = true }
    }

    fun openCapture(surface: String) {
        closeDrawer()
        nav.navigate("capture?surface=$surface") { launchSingleTop = true }
    }

    // Central app lifecycle policy. This lives above the nav graph rather than in AgentScreen:
    // foregrounding from Settings/Search still restores the exact recent agent surface, while a
    // missing, future, or hour-old snapshot starts a focused blank conversation. Explicit launch
    // intents are already represented by the buses below and always own navigation.
    val lifecycleOwner = LocalLifecycleOwner.current
    val latestHasExplicitLaunch by rememberUpdatedState(
        captureRequest != null || searchRequest != null || privacyApprovalRequest != null ||
            accessAuthorizationRequest != null ||
            agentConversationRequest != null || watchFiringRequest != null ||
            sourcePermissionRequest != null || remoteSourcePermissionRequest != null,
    )
    val latestAgentRouteActive by rememberUpdatedState(currentRoute == "agent")
    val latestRestoreForeground by rememberUpdatedState(
        newValue = {
            val destination = vm.foregroundDestination()
            when (destination) {
                is AppForegroundDestination.Conversation ->
                    vm.resumeConversation(destination.id)
                AppForegroundDestination.FreshConversation -> vm.newConversation()
                AppForegroundDestination.PreserveCurrent -> Unit
            }
            if (destination != AppForegroundDestination.PreserveCurrent) {
                bringAgentForward()
            }
        },
    )
    // Set when the app came to the foreground while phone setup presented; the restore runs once it closes.
    var foregroundRestoreDeferred by remember { mutableStateOf(false) }
    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_START -> {
                    // Becoming active reads the decision queue, so the menu badge is current
                    // however the app was opened. Unless the launch names its own destination
                    // it also offers the held answer: a decision nobody has made is the one
                    // thing worth interrupting for. The read is asynchronous, so the agent
                    // surface is still restored underneath and the approval, when there is
                    // one, is navigated to on top of it.
                    vm.onForegroundStarted(explicitLaunchPending = latestHasExplicitLaunch)
                    if (!latestHasExplicitLaunch) {
                        if (vm.setupPresenting.value) foregroundRestoreDeferred = true else latestRestoreForeground()
                    }
                    vm.onForeground()
                }
                Lifecycle.Event.ON_STOP -> vm.recordAppBackgrounded(latestAgentRouteActive)
                else -> Unit
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    LaunchedEffect(setupPresenting) {
        if (!vm.setupPresenting.value && foregroundRestoreDeferred) {
            foregroundRestoreDeferred = false
            if (!latestHasExplicitLaunch) latestRestoreForeground()
        }
    }

    // Each presenter below reads the gate's live value when it runs: a flow restored with the
    // activity takes the gate while composing, before the value collected above has caught up.

    // Tile / app-shortcut launches land in MainActivity as an intent and are
    // relayed here through the CaptureLaunchBus.
    LaunchedEffect(captureRequest, setupPresenting) {
        if (vm.setupPresenting.value) return@LaunchedEffect
        captureRequest?.let { request ->
            vm.recordExplicitLaunch()
            openCapture(request.surface)
            vm.consumeCaptureRequest()
        }
    }

    LaunchedEffect(searchRequest, setupPresenting) {
        if (searchRequest != null && !vm.setupPresenting.value) {
            vm.recordExplicitLaunch()
            closeDrawer()
            nav.navigate("search") { launchSingleTop = true }
        }
    }

    // A tapped privacy notification always lands on the decision it names. Not gated on
    // experimental mode: an Answer integration can require an operator decision in normal
    // operation, and a banner the user can tap must always land somewhere.
    LaunchedEffect(privacyApprovalRequest, setupPresenting) {
        val request = privacyApprovalRequest
        if (request != null && !vm.setupPresenting.value) {
            vm.recordExplicitLaunch()
            closeDrawer()
            nav.navigate("privacy/approvals/${Uri.encode(request.approvalId)}") {
                launchSingleTop = true
            }
            vm.consumePrivacyApprovalRequest()
        }
    }

    // The queue read on becoming active, once it has an answer. An explicit launch names its
    // own destination and wins — whether it is still on its bus or was handled earlier in
    // this foreground — so the offer is dropped rather than stacked on top of it.
    LaunchedEffect(pendingApprovalToPresent, setupPresenting) {
        if (vm.setupPresenting.value || pendingApprovalToPresent == null) return@LaunchedEffect
        val approvalId = vm.takePendingApprovalToPresent(
            explicitLaunchPending = latestHasExplicitLaunch,
        ) ?: return@LaunchedEffect
        closeDrawer()
        nav.navigate("privacy/approvals/${Uri.encode(approvalId)}") {
            launchSingleTop = true
        }
    }

    LaunchedEffect(accessAuthorizationRequest, setupPresenting) {
        if (vm.setupPresenting.value) return@LaunchedEffect
        accessAuthorizationRequest?.let { request ->
            vm.recordExplicitLaunch()
            if (!vm.accessAuthorizationRequestIsCurrent(request)) {
                vm.consumeAccessAuthorizationRequest()
                return@let
            }
            closeDrawer()
            nav.navigate(
                accessAuthorizationRoute(request.code, request.nonce, request.pairingIdentity),
            ) {
                launchSingleTop = true
            }
            vm.consumeAccessAuthorizationRequest()
        }
    }

    LaunchedEffect(sourcePermissionRequest, setupPresenting) {
        if (vm.setupPresenting.value) return@LaunchedEffect
        sourcePermissionRequest?.let { request ->
            vm.recordExplicitLaunch()
            focusedSourcePermissionId = request.sourceId
            focusedDeviceId = null
            nav.navigate(SETTINGS_ROUTE) { launchSingleTop = true }
            vm.consumeSourcePermissionRequest()
        }
    }

    LaunchedEffect(remoteSourcePermissionRequest, setupPresenting) {
        if (remoteSourcePermissionRequest != null && !vm.setupPresenting.value) vm.recordExplicitLaunch()
    }

    remoteSourcePermissionRequest?.takeUnless { setupPresenting }?.let { request ->
        val sourceName = request.sourceName ?: "Mobile source"
        val deviceName = request.deviceName ?: "Another paired device"
        AlertDialog(
            onDismissRequest = { vm.consumeRemoteSourcePermissionRequest() },
            title = { Text("$deviceName needs attention") },
            text = {
                Text(
                    "$sourceName needs permission attention on $deviceName. " +
                        "Open Omnesis on that device to review and restore access.",
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    focusedSourcePermissionId = null
                    focusedDeviceId = request.deviceId
                    vm.consumeRemoteSourcePermissionRequest()
                    openSettingsChild(DEVICES_ROUTE)
                }) { Text("View paired devices") }
            },
            dismissButton = {
                TextButton(onClick = vm::consumeRemoteSourcePermissionRequest) { Text("Done") }
            },
        )
    }

    // A tapped conversation notification opens that conversation. Not gated on
    // experimental mode: unread conversations are an ordinary surface, and a
    // banner the user can tap must always land somewhere.
    LaunchedEffect(agentConversationRequest, setupPresenting) {
        val request = agentConversationRequest
        if (request != null && !vm.setupPresenting.value) {
            vm.recordExplicitLaunch()
            closeDrawer()
            vm.resumeConversation(request.conversationId)
            bringAgentForward()
            vm.consumeAgentConversationRequest()
        }
    }

    LaunchedEffect(watchFiringRequest, setupPresenting) {
        val request = watchFiringRequest
        if (request != null && !vm.setupPresenting.value) {
            vm.recordExplicitLaunch()
            closeDrawer()
            nav.navigate(
                "watches/${Uri.encode(request.watchId)}?firingKey=${Uri.encode(request.firingKey)}",
            ) { launchSingleTop = true }
            vm.consumeWatchFiringRequest()
        }
    }

    BackHandler(enabled = drawerOpen) { closeDrawer() }

    // A fresh failed capture becomes noteworthy after five minutes even if the
    // drawer remains open and nothing else causes a recomposition.
    LaunchedEffect(drawerOpen, pendingNotes) {
        attentionNow = Instant.now()
        if (drawerOpen && pendingNotes.none { pendingNoteNeedsAttention(it, attentionNow) }) {
            val nextDeadline = pendingNotes.mapNotNull { note ->
                runCatching { Instant.parse(note.capturedAt).plus(PENDING_WARNING_AGE) }.getOrNull()
            }.minOrNull()
            if (nextDeadline != null) {
                val waitMillis = Duration.between(attentionNow, nextDeadline).toMillis().coerceAtLeast(0L)
                if (waitMillis > 0) delay(waitMillis)
                attentionNow = Instant.now()
            }
        }
    }

    LaunchedEffect(pendingNotes, pendingSheetOpen) {
        if (pendingSheetOpen && pendingNotes.isEmpty()) pendingSheetOpen = false
    }

    // The menu is the layer underneath; the app is what moves. The container owns the whole
    // choreography, including the drag — which is why no edge strip appears here: the reveal
    // starts from anywhere in the leading `MenuReveal.GESTURE_FRACTION` of the screen.
    MenuRevealContainer(
        isOpen = drawerOpen,
        onOpenChange = { open -> if (open) openDrawer() else closeDrawer() },
        menu = {
            MainMenuDrawer(
                currentRoute = currentRoute,
                conversations = agentState.conversations,
                conversationsLoading = agentState.conversationsLoading,
                conversationsPaging = agentState.conversationsPaging,
                conversationsError = agentState.conversationsError,
                conversationActionError = agentState.conversationActionError,
                onNewConversation = {
                    closeDrawer()
                    vm.newConversation()
                    bringAgentForward()
                },
                onNavigate = { navigateTo(it) },
                onTellBrain = { openCapture(CaptureSurface.APP) },
                queuedNotesNeedAttention = pendingNotes.any { pendingNoteNeedsAttention(it, attentionNow) },
                onQueuedNotesWarning = { pendingSheetOpen = true },
                onResumeConversation = { id ->
                    closeDrawer()
                    vm.resumeConversation(id)
                    bringAgentForward()
                },
                onDeleteConversation = { vm.deleteConversation(it) },
                onTogglePin = { id, pinned -> vm.togglePin(id, pinned) },
                onDismissConversationActionError = vm::ackConversationActionError,
                onOpenSettings = {
                    closeDrawer()
                    nav.navigate("settings") { launchSingleTop = true }
                },
                onRefreshConversations = { vm.refreshConversations() },
                onLoadMoreConversations = { vm.loadMoreConversations() },
                experimental = experimental,
                briefsMenuEntry = briefsMenuEntry,
                onConfigureBackgroundAgent = configureBackgroundAgent,
                briefsUnreadCount = briefsUnread,
                privacyPendingCount = privacyPending,
            )
        },
    ) {
      Box(Modifier.fillMaxSize()) {
        NavHost(navController = nav, startDestination = "agent") {
            composable("agent") {
                AgentScreen(
                    onOpenMenu = { openDrawer() },
                    onOpenDocument = { nav.navigate("document/${Uri.encode(it)}") },
                    onOpenWatch = { nav.navigate("watches/${Uri.encode(it)}") },
                    onOpenSettings = openSettings,
                    onOpenModels = openModels,
                )
            }
            composable("search") {
                SearchScreen(
                    connection = connection,
                    onOpenMenu = { openDrawer() },
                    onOpenDocument = { nav.navigate("document/${Uri.encode(it)}") },
                )
            }
            composable("sources") {
                SourcesScreen(
                    connection = connection,
                    onOpenMenu = { openDrawer() },
                    onOpenSource = { nav.navigate("source/${Uri.encode(it)}") },
                    onOpenSettings = openSettings,
                )
            }
            composable("people") {
                PeopleScreen(
                    onOpenMenu = { openDrawer() },
                    onOpenPerson = { id, name -> nav.navigate(personRoute(id, name)) },
                    onOpenMergeCandidates = { nav.navigate("people/merge-candidates") },
                    onOpenMergeRules = { nav.navigate("people/merge-rules") },
                    onOpenSettings = openSettings,
                )
            }
            composable("people/merge-candidates") {
                MergeCandidatesScreen(
                    onBack = { nav.popBackStack() },
                    onOpenSettings = openSettings,
                )
            }
            composable("people/merge-rules") {
                MergeRulesScreen(
                    onBack = { nav.popBackStack() },
                    onOpenSettings = openSettings,
                )
            }
            composable(DEVICES_ROUTE) {
                DevicesScreen(
                    focusedDeviceId = focusedDeviceId,
                    onBack = {
                        focusedDeviceId = null
                        nav.returnToSettings()
                    },
                    onOpenSettings = {
                        focusedDeviceId = null
                        nav.returnToSettings()
                    },
                )
            }
            composable(
                route = ACCESS_AUTHORIZATION_ROUTE_PATTERN,
                arguments = listOf(
                    navArgument("code") {
                        type = NavType.StringType
                        nullable = true
                        defaultValue = null
                    },
                    navArgument("request") {
                        type = NavType.StringType
                        nullable = true
                        defaultValue = null
                    },
                    navArgument("launch") {
                        type = NavType.LongType
                        defaultValue = 0L
                    },
                    navArgument("gateway") {
                        type = NavType.StringType
                        nullable = true
                        defaultValue = null
                    },
                    navArgument("device") {
                        type = NavType.StringType
                        nullable = true
                        defaultValue = null
                    },
                    navArgument("generation") {
                        type = NavType.StringType
                        nullable = true
                        defaultValue = null
                    },
                ),
            ) { entry ->
                val gatewayUrl = entry.arguments?.getString("gateway")
                AccessAuthorizationScreen(
                    onClose = { nav.popBackStack() },
                    initialCode = entry.arguments?.getString("code"),
                    initialRequestId = entry.arguments?.getString("request"),
                    launchNonce = entry.arguments?.getLong("launch") ?: 0L,
                    expectedPairing = gatewayUrl?.let {
                        AccessAuthorizationPairingIdentity(
                            gatewayUrl = it,
                            deviceId = entry.arguments?.getString("device"),
                            pairingGeneration = entry.arguments?.getString("generation"),
                        )
                    },
                )
            }
            composable(POLICIES_ROUTE) {
                PoliciesListScreen(
                    onBack = { nav.returnToSettings() },
                    onOpenPolicy = openPolicy,
                    onOpenSettings = { nav.returnToSettings() },
                )
            }
            composable(
                route = POLICY_ROUTE_PATTERN,
                arguments = listOf(
                    navArgument("familyId") { type = NavType.StringType },
                    navArgument("name") {
                        type = NavType.StringType
                        nullable = true
                        defaultValue = null
                    },
                ),
            ) {
                PrivacyPolicyScreen(
                    onBack = { nav.popBackStack() },
                    onOpenSettings = { nav.returnToSettings() },
                )
            }
            composable(MODELS_ROUTE) {
                ModelsScreen(
                    connection = connection,
                    initialPickerRole = requestedModelPickerRole,
                    onInitialPickerConsumed = { requestedModelPickerRole = null },
                    onBack = { nav.returnToSettings() },
                    onOpenSettings = { nav.returnToSettings() },
                    onOpenBackends = { nav.navigate("models/backends") },
                )
            }
            composable("briefs") {
                BriefsScreen(
                    onOpenMenu = { openDrawer() },
                    // A dictated question arrives as the thread's first message, so the
                    // user lands mid-answer rather than on an empty thread they must
                    // retype into.
                    onOpenConversation = { conversationId, autoSend ->
                        vm.resumeConversation(conversationId, autoSend)
                        bringAgentForward()
                    },
                    onOpenSettings = openSettings,
                    briefsMenuEntry = briefsMenuEntry,
                    onConfigureBackgroundAgent = configureBackgroundAgent,
                    onOpenDocument = { nav.navigate("document/${Uri.encode(it)}") },
                )
            }
            composable("watches") {
                WatchesScreen(
                    onOpenMenu = { openDrawer() },
                    onOpenWatch = { nav.navigate("watches/${Uri.encode(it)}") },
                    onOpenSettings = openSettings,
                )
            }
            composable(
                route = "watches/{watchId}?firingKey={firingKey}",
                arguments = listOf(
                    navArgument("watchId") { type = NavType.StringType },
                    navArgument("firingKey") {
                        type = NavType.StringType
                        nullable = true
                        defaultValue = null
                    },
                ),
            ) {
                WatchDetailScreen(
                    onBack = { nav.popBackStack() },
                    onOpenSettings = openSettings,
                )
            }
            composable("privacy") {
                PrivacyScreen(
                    onOpenMenu = { openDrawer() },
                    onOpenExchange = openPrivacyExchange,
                    onOpenSubscriptionApproval = {
                        nav.navigate("privacy/subscription-approvals/${Uri.encode(it)}")
                    },
                    onOpenDirectSession = { nav.navigate(directAuditSessionRoute(it)) },
                    onOpenSettings = openSettings,
                )
            }
            // One Direct transcript session, opened from the Audit screen's Direct tab.
            composable(
                route = "privacy/direct/sessions/{sessionId}",
                arguments = listOf(navArgument("sessionId") { type = NavType.StringType }),
            ) {
                DirectAuditDetailScreen(
                    onBack = { nav.popBackStack() },
                    onDeleted = {
                        returnToPrivacyAfterDeletion(
                            popToPrivacy = { nav.popBackStack("privacy", inclusive = false) },
                            navigateToTopLevelPrivacy = { navigateTo("privacy") },
                        )
                    },
                    onOpenSettings = openSettings,
                    onOpenDocument = { nav.navigate("document/${Uri.encode(it)}") },
                    onOpenPerson = { id, name ->
                        nav.navigate(personRoute(id, name))
                    },
                )
            }
            composable(
                route = "privacy/subscription-approvals/{subscriptionApprovalId}",
                arguments = listOf(
                    navArgument("subscriptionApprovalId") { type = NavType.StringType },
                ),
            ) {
                PrivacySubscriptionApprovalScreen(
                    onBack = { nav.popBackStack() },
                    onOpenSettings = openSettings,
                )
            }
            // The whole audit conversation, every exchange stacked.
            composable(
                route = "privacy/conversations/{conversationId}",
                arguments = listOf(navArgument("conversationId") { type = NavType.StringType }),
            ) {
                PrivacyExchangeDetailScreen(
                    onBack = { nav.popBackStack() },
                    onDeleted = {
                        returnToPrivacyAfterDeletion(
                            popToPrivacy = { nav.popBackStack("privacy", inclusive = false) },
                            navigateToTopLevelPrivacy = { navigateTo("privacy") },
                        )
                    },
                    onOpenPolicy = openPolicy,
                    onOpenSettings = openSettings,
                    onOpenDocument = { nav.navigate("document/${Uri.encode(it)}") },
                    onOpenPerson = { id, name ->
                        nav.navigate(personRoute(id, name))
                    },
                )
            }
            // One exchange, which is what a feed row opens.
            composable(
                route = "privacy/conversations/{conversationId}/exchanges/{taskId}",
                arguments = listOf(
                    navArgument("conversationId") { type = NavType.StringType },
                    navArgument("taskId") { type = NavType.StringType },
                ),
            ) {
                PrivacyExchangeDetailScreen(
                    onBack = { nav.popBackStack() },
                    onDeleted = {
                        returnToPrivacyAfterDeletion(
                            popToPrivacy = { nav.popBackStack("privacy", inclusive = false) },
                            navigateToTopLevelPrivacy = { navigateTo("privacy") },
                        )
                    },
                    onOpenConversation = { nav.navigate(privacyConversationRoute(it)) },
                    onOpenPolicy = openPolicy,
                    onOpenSettings = openSettings,
                    onOpenDocument = { nav.navigate("document/${Uri.encode(it)}") },
                    onOpenPerson = { id, name ->
                        nav.navigate(personRoute(id, name))
                    },
                )
            }
            composable(
                route = "privacy/approvals/{approvalId}",
                arguments = listOf(navArgument("approvalId") { type = NavType.StringType }),
            ) {
                PrivacyApprovalScreen(
                    onBack = { nav.popBackStack() },
                    onOpenExchange = { conversationId, taskId ->
                        nav.navigate(privacyExchangeRoute(conversationId, taskId))
                    },
                    onOpenPolicy = openPolicy,
                    onOpenSettings = openSettings,
                )
            }
            composable("models/backends") { backStackEntry ->
                // Share one BackendsViewModel between the list and the detail by
                // scoping it to the "models/backends" nav entry, so a verify
                // verdict issued on the detail survives navigating back and forth
                // (verify never mutates config — there's no reload, no staleness).
                val parentEntry = remember(backStackEntry) { nav.getBackStackEntry("models/backends") }
                BackendsScreen(
                    vm = hiltViewModel(parentEntry),
                    onBack = { nav.popBackStack() },
                    onOpenDetail = { nav.navigate("models/backends/${Uri.encode(it)}") },
                    onOpenSettings = { nav.returnToSettings() },
                )
            }
            composable(
                route = "models/backends/{key}",
                arguments = listOf(navArgument("key") { type = NavType.StringType }),
            ) { backStackEntry ->
                val key = backStackEntry.arguments?.getString("key").orEmpty()
                val parentEntry = remember(backStackEntry) { nav.getBackStackEntry("models/backends") }
                BackendDetailScreen(
                    backendKey = key,
                    vm = hiltViewModel(parentEntry),
                    onBack = { nav.popBackStack() },
                    onOpenSettings = { nav.returnToSettings() },
                )
            }
            composable(
                route = "person/{id}?name={name}",
                arguments = listOf(
                    navArgument("id") { type = NavType.StringType },
                    // Optional preset canonicalName so the header + title populate instantly
                    // during load (the iOS presetName). Absent when opened from a graph row.
                    navArgument("name") {
                        type = NavType.StringType
                        nullable = true
                        defaultValue = null
                    },
                ),
            ) {
                PersonDetailScreen(
                    onBack = { nav.popBackStack() },
                    onOpenDocument = { nav.navigate("document/${Uri.encode(it)}") },
                    onOpenPerson = { id, name -> nav.navigate(personRoute(id, name)) },
                    onOpenSettings = openSettings,
                )
            }
            composable(
                route = "source/{id}",
                arguments = listOf(navArgument("id") { type = NavType.StringType }),
            ) {
                SourceDetailScreen(
                    onBack = { nav.popBackStack() },
                    onOpenRecent = { nav.navigate("source/${Uri.encode(it)}/recent") },
                    onOpenSettings = openSettings,
                )
            }
            composable(
                route = "source/{id}/recent",
                arguments = listOf(navArgument("id") { type = NavType.StringType }),
            ) {
                SourceRecentScreen(
                    onBack = { nav.popBackStack() },
                    onOpenDocument = { nav.navigate("document/${Uri.encode(it)}") },
                    onOpenSettings = openSettings,
                )
            }
            composable(
                route = "document/{id}",
                arguments = listOf(navArgument("id") { type = NavType.StringType }),
            ) {
                DocumentDetailScreen(
                    onBack = { nav.popBackStack() },
                    onOpenDocument = { nav.navigate("document/${Uri.encode(it)}") },
                    onOpenPerson = { nav.navigate(personRoute(it)) },
                    onOpenSettings = openSettings,
                )
            }
            composable(
                route = "capture?surface={surface}",
                arguments = listOf(
                    navArgument("surface") {
                        type = NavType.StringType
                        defaultValue = CaptureSurface.APP
                    },
                ),
            ) {
                CaptureScreen(
                    onClose = { nav.popBackStack() },
                )
            }
            composable(route = PHONE_SETUP_ROUTE_PATTERN, arguments = phoneSetupArguments(PhoneSetupEntry.SETTINGS)) {
                PhoneSetupScreen(onClose = { nav.popBackStack() })
            }
            composable(SETTINGS_ROUTE) {
                SettingsScreen(
                    focusedSourceId = focusedSourcePermissionId,
                    onClose = {
                        focusedSourcePermissionId = null
                        nav.popBackStack()
                    },
                    // unpair()/repair() flip SessionManager to Unpaired; RootScreen then swaps
                    // the whole shell out for onboarding, so nothing extra is needed here.
                    onUnpaired = {},
                    onRepair = {},
                    onOpenModels = { openSettingsChild(MODELS_ROUTE) },
                    onOpenDevices = {
                        focusedSourcePermissionId = null
                        focusedDeviceId = null
                        openSettingsChild(DEVICES_ROUTE)
                    },
                    onOpenPolicies = { openSettingsChild(POLICIES_ROUTE) },
                    onOpenAccessAuthorization = {
                        openSettingsChild(ACCESS_AUTHORIZATION_ROUTE)
                    },
                    onOpenPhoneSetup = { nav.navigate(PHONE_SETUP_ROUTE) { launchSingleTop = true } },
                    onOpenPhoneSetupStep = { stepId -> nav.navigate(phoneSetupStepRoute(stepId)) { launchSingleTop = true } },
                )
            }
        }

        // The app-wide banners sit below each screen's app bar. The access banner names the
        // newest request waiting on the owner everywhere but inside the wizard that decides
        // it; the health warning stays bounded here because its detailed list is in Settings.
        if (currentRoute != PHONE_SETUP_ROUTE_PATTERN) Column(
            modifier = Modifier.align(Alignment.TopCenter).statusBarsPadding().padding(
                start = OmSpacing.md,
                top = 56.dp,
                end = OmSpacing.md,
            ),
            verticalArrangement = Arrangement.spacedBy(OmSpacing.sm),
        ) {
            val waitingOffer = accessPending.banner
            if (waitingOffer != null && currentRoute != ACCESS_AUTHORIZATION_ROUTE_PATTERN) {
                AccessPendingRequestBanner(
                    offer = waitingOffer,
                    onReview = {
                        closeDrawer()
                        nav.navigate(
                            accessAuthorizationRoute(
                                code = null,
                                nonce = System.nanoTime(),
                                pairing = vm.accessAuthorizationPairing(),
                                requestId = waitingOffer.newest.id,
                            ),
                        ) { launchSingleTop = true }
                    },
                    onDismiss = vm::dismissAccessPending,
                )
            }
            if (currentRoute != SETTINGS_ROUTE) {
                GlobalHealthWarningBanner(
                    notificationNeedsAttention = notificationNeedsAttention,
                    permissionIssueCount = permissionHealth.sumOf { it.actionable.size },
                    onOpenSettings = openSettings,
                    onDismissNotification = dismissNotificationWarning,
                )
            }
        }

        if (pendingSheetOpen && pendingNotes.isNotEmpty()) {
            PendingNotesSheet(
                notes = pendingNotes,
                now = attentionNow,
                onDismiss = { pendingSheetOpen = false },
                onRetry = vm::retryPendingNotes,
                onDiscard = vm::discardPendingNote,
            )
        }
      }
    }
}

internal fun directAuditSessionRoute(sessionId: String): String =
    "privacy/direct/sessions/${Uri.encode(sessionId)}"

internal fun privacyConversationRoute(conversationId: String): String =
    "privacy/conversations/${Uri.encode(conversationId)}"

internal fun privacyExchangeRoute(conversationId: String, taskId: String): String =
    "${privacyConversationRoute(conversationId)}/exchanges/${Uri.encode(taskId)}"

internal fun returnToPrivacyAfterDeletion(
    popToPrivacy: () -> Boolean,
    navigateToTopLevelPrivacy: () -> Unit,
) {
    if (!popToPrivacy()) navigateToTopLevelPrivacy()
}

/**
 * Build a `person/{id}` route, appending the optional `?name=` preset canonicalName so the
 * detail header + title can populate before the fetch resolves (the iOS presetName). Both
 * segments are URL-encoded so names containing `/`, `?`, `&`, or spaces round-trip cleanly.
 */
private fun personRoute(id: String, name: String? = null): String {
    val base = "person/${Uri.encode(id)}"
    return name?.takeIf { it.isNotBlank() }?.let { "$base?name=${Uri.encode(it)}" } ?: base
}
