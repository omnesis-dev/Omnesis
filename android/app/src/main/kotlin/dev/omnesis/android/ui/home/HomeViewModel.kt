// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.ui.home

import android.content.Context
import android.content.Intent
import android.provider.Settings
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import dev.omnesis.android.AppVersionInfo
import dev.omnesis.android.notes.NotesRepository
import dev.omnesis.android.access.AccessAuthorizationPairingIdentity
import dev.omnesis.android.access.AccessPendingRequests
import dev.omnesis.android.access.AccessPendingRequestsState
import dev.omnesis.android.access.accessAuthorizationIdentity
import dev.omnesis.android.access.accessAuthorizationPairingMatches
import dev.omnesis.android.notes.PendingNote
import dev.omnesis.android.session.SessionManager
import dev.omnesis.android.transport.dto.BriefsMenuEntry
import dev.omnesis.android.notifications.FcmPushManager
import dev.omnesis.android.notifications.NotificationLaunchBus
import dev.omnesis.android.transport.ws.DeviceSocket.ConnectionState
import dev.omnesis.android.transport.PermissionHealthCoordinator
import dev.omnesis.android.transport.PermissionHealthEntry
import dev.omnesis.android.sources.SourceCatalog
import dev.omnesis.android.setup.flow.PhoneSetupGate
import dev.omnesis.android.ui.agent.AgentCoordinator
import dev.omnesis.android.ui.capture.CaptureLaunchBus
import dev.omnesis.android.ui.devannotate.DevAnnotationTarget
import dev.omnesis.android.ui.privacy.PrivacyResolutionBus
import dev.omnesis.android.ui.privacy.PrivacySubscriptionResolutionBus
import dev.omnesis.android.ui.search.SearchLaunchBus
import dev.omnesis.android.transport.client.PRIVACY_APPROVALS_PAGE_MAX
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * Drives the app shell. Re-exposes the device connection state plus the singleton
 * [AgentCoordinator]'s surface so the main menu drawer can render the inline list of
 * recent conversations and start/resume/delete them. Since [AgentCoordinator] is a
 * `@Singleton`, this is the SAME instance the agent screen observes — the drawer list
 * and the agent transcript stay in sync.
 */
@HiltViewModel
class HomeViewModel @Inject constructor(
    private val session: SessionManager,
    private val coordinator: AgentCoordinator,
    private val captureLaunchBus: CaptureLaunchBus,
    private val searchLaunchBus: SearchLaunchBus,
    private val notificationLaunchBus: NotificationLaunchBus,
    private val pushManager: FcmPushManager,
    private val notesRepository: NotesRepository,
    private val foregroundStore: AppForegroundStore,
    private val permissionHealth: PermissionHealthCoordinator,
    private val sourceCatalog: SourceCatalog,
    private val accessPendingRequests: AccessPendingRequests,
    phoneSetupGate: PhoneSetupGate,
    privacyResolutionBus: PrivacyResolutionBus,
    privacySubscriptionResolutionBus: PrivacySubscriptionResolutionBus,
) : ViewModel() {

    private var backgroundedFreshInThisProcess = false

    private val current = session.requireSession()

    val connection: StateFlow<ConnectionState> = current.socket.state

    val agentState: StateFlow<AgentCoordinator.UiState> = coordinator.state

    /**
     * Whether the gateway runs in experimental mode — gates the Triggers nav
     * entry (hidden unless on, tagged "Experimental" when on) in the drawer.
     */
    val experimentalEnabled: StateFlow<Boolean> = session.experimentalEnabled

    /**
     * Whether the gateway runs in developer mode — reveals the
     * shake-to-annotate capture affordance. Mirrors the iOS
     * `AppStore.developerEnabled`.
     */
    val developerEnabled: StateFlow<Boolean> = session.developerEnabled

    /**
     * File one developer annotation against [target]. Attaches this build's
     * version/build alongside the note so an engineer triaging with
     * `omnesis dev-annotations` can tell which binary produced it.
     */
    suspend fun fileDevAnnotation(target: DevAnnotationTarget, note: String) {
        val versions = AppVersionInfo.current()
        current.search.createDevAnnotation(
            targetType = target.targetType,
            targetId = target.targetId,
            note = note,
            contextLabel = target.label,
            deepLink = target.deepLink,
            appVersion = versions.version,
            appBuild = versions.build,
        )
    }

    /** What the menu shows for Briefs, from the paired gateway's feature gate. */
    val briefsMenuEntry: StateFlow<BriefsMenuEntry> = session.briefsMenuEntry

    private val _briefsUnreadCount = MutableStateFlow(0)

    /**
     * Unread briefs awaiting attention, for the menu badge. Refreshed when the menu is
     * revealed — the same refresh-on-open cadence as the conversation list, since nothing
     * pushes this. Best-effort: a failure zeroes the badge rather than showing a stale
     * count or an error on a surface that is only a hint.
     */
    val briefsUnreadCount: StateFlow<Int> = _briefsUnreadCount.asStateFlow()

    fun refreshBriefsUnreadCount() {
        viewModelScope.launch {
            _briefsUnreadCount.value = runCatching {
                session.session?.briefs?.unreadCount() ?: 0
            }.getOrDefault(0)
        }
    }

    /** Refresh feature readiness so model changes made by any client reach the drawer. */
    fun refreshGatewayStatus() {
        viewModelScope.launch { session.refreshStatus() }
    }

    private val _privacyPendingCount = MutableStateFlow(0)

    /**
     * Decisions waiting on the operator, for the menu badge: held answers always, plus the
     * watch requests when the gateway offers them. Refreshed when the menu is revealed, on
     * becoming active and after any decision; best-effort, since the badge is a hint and a
     * failure must not surface as an error on a surface the operator did not ask for.
     */
    val privacyPendingCount: StateFlow<Int> = _privacyPendingCount.asStateFlow()

    private val _pendingApprovalToPresent = MutableStateFlow<String?>(null)

    /**
     * The held answer to open, once the queue has been read and something is waiting. Null
     * whenever there is nothing to present.
     */
    val pendingApprovalToPresent: StateFlow<String?> = _pendingApprovalToPresent.asStateFlow()

    private val pendingApprovalPresentation = PendingApprovalPresentation()
    private var privacyPendingGeneration = 0L

    /**
     * Becoming active. [explicitLaunchPending] is whether the launch that brought the app
     * forward already names its own destination; only when it does not is the oldest held
     * answer offered for presentation.
     */
    fun onForegroundStarted(explicitLaunchPending: Boolean) {
        pendingApprovalPresentation.beginForeground()
        refreshPrivacyPending(offerPendingApproval = !explicitLaunchPending)
        refreshAccessPending()
    }

    /**
     * The authorization requests waiting on the owner, for the banner at the top of the main
     * screen. Read on becoming active, and refreshed by every access-overview read the app
     * makes; a failed read shows nothing rather than a request that may be gone.
     */
    val accessPending: StateFlow<AccessPendingRequestsState> = accessPendingRequests.state

    private var accessPendingGeneration = 0L

    fun refreshAccessPending() {
        val generation = ++accessPendingGeneration
        viewModelScope.launch {
            val overview = session.session?.admin?.let { attempt { it.accessOverview() } }
            if (generation != accessPendingGeneration) return@launch
            accessPendingRequests.replace(overview?.pendingRequests.orEmpty())
        }
    }

    fun dismissAccessPending() = accessPendingRequests.dismiss()

    /** The pairing a banner tap opens the wizard for, so a re-pair in between is refused. */
    fun accessAuthorizationPairing(): AccessAuthorizationPairingIdentity? =
        session.session?.pairing?.accessAuthorizationIdentity()

    /** An explicit launch took the surface in this foreground episode. */
    fun recordExplicitLaunch() = pendingApprovalPresentation.recordExplicitLaunch()

    /**
     * Read the decision queues. [offerPendingApproval] additionally arms the oldest held
     * answer for presentation, which is what becoming active does and what revealing the menu
     * does not. A slower earlier read never overwrites a newer one.
     */
    fun refreshPrivacyPending(offerPendingApproval: Boolean = false) {
        val generation = ++privacyPendingGeneration
        viewModelScope.launch {
            val admin = session.session?.admin
            // Ask for one row: the page carries the exact total for the status with expired
            // rows excluded, so the count never depends on how much of the queue was fetched.
            val approvals = admin?.let { attempt { it.privacyApprovals(limit = 1) } }
            // Watch requests are resolved on an experimental surface, so they are counted
            // only where that surface is itself reachable.
            val watchRequests = if (experimentalEnabled.value) {
                admin?.let { attempt { it.privacySubscriptionApprovals(limit = 1) } }
            } else {
                null
            }
            val approvalId = if (
                offerPendingApproval && admin != null && approvals != null &&
                pendingApprovalPresentation.canOffer
            ) {
                attempt {
                    oldestPendingApprovalId(approvals) { cursor ->
                        admin.privacyApprovals(limit = PRIVACY_APPROVALS_PAGE_MAX, cursor = cursor)
                    }
                }
            } else {
                null
            }
            if (generation != privacyPendingGeneration) return@launch
            _privacyPendingCount.value = privacyDecisionsWaiting(
                heldAnswers = approvals?.totalCount,
                watchRequests = watchRequests?.totalCount,
                experimental = experimentalEnabled.value,
            )
            if (approvalId != null) _pendingApprovalToPresent.value = approvalId
        }
    }

    /**
     * Settles the offered held answer: the id to open now, or null when an explicit launch
     * owns the surface or the session's presentation is already spent. A dropped offer keeps
     * that presentation for a later foreground.
     */
    fun takePendingApprovalToPresent(explicitLaunchPending: Boolean): String? {
        val approvalId = _pendingApprovalToPresent.value
        _pendingApprovalToPresent.value = null
        return approvalId?.takeIf { pendingApprovalPresentation.present(it, explicitLaunchPending) }
    }

    /** Pending "open the capture screen" launch from the QS tile / app shortcut, if any. */
    val captureRequest: StateFlow<CaptureLaunchBus.Request?> = captureLaunchBus.request

    /** Pending App Actions GET_THING request; SearchViewModel consumes the payload. */
    val searchRequest: StateFlow<SearchLaunchBus.Request?> = searchLaunchBus.request

    val privacyApprovalRequest: StateFlow<NotificationLaunchBus.PrivacyApproval?> =
        notificationLaunchBus.privacyApproval
    val accessAuthorizationRequest: StateFlow<NotificationLaunchBus.AccessAuthorization?> =
        notificationLaunchBus.accessAuthorization

    /** Pending "open this conversation" launch from a tapped notification, if any. */
    val agentConversationRequest: StateFlow<NotificationLaunchBus.AgentConversation?> =
        notificationLaunchBus.agentConversation
    val watchFiringRequest: StateFlow<NotificationLaunchBus.WatchFiring?> =
        notificationLaunchBus.watchFiring
    val sourcePermissionRequest: StateFlow<NotificationLaunchBus.SourcePermission?> = notificationLaunchBus.sourcePermission
    val remoteSourcePermissionRequest: StateFlow<NotificationLaunchBus.RemoteSourcePermission?> =
        notificationLaunchBus.remoteSourcePermission

    val pushConfigured: Boolean get() = pushManager.configured
    val pushPlan = session.pushPlan
    val pushRegistrationFailed = session.pushRegistrationFailed

    /**
     * Whether the phone setup flow is presenting. While it is, the shell holds
     * every launch and offer it would present on its own, and delivers them
     * once the flow closes.
     */
    val setupPresenting: StateFlow<Boolean> = phoneSetupGate.presenting

    /** Durable local captures that have not reached the gateway yet. */
    val pendingNotes: StateFlow<List<PendingNote>> = notesRepository.pending
    val permissionHealthState: StateFlow<List<PermissionHealthEntry>> = permissionHealth.state
    private val _notificationHealth = MutableStateFlow(pushManager.deliveryHealth())
    val notificationHealth: StateFlow<String> = _notificationHealth
    fun sourceLabel(sourceId: String): String = sourceCatalog.label(sourceId)

    init {
        // `drain()` intentionally no-ops while unpaired, so independently load
        // the disk snapshot to ensure an old queue is never invisible after a restart.
        viewModelScope.launch { notesRepository.refreshPending() }
        // A decision made anywhere in the app changes what the menu badge counts.
        viewModelScope.launch { privacyResolutionBus.resolved.collect { refreshPrivacyPending() } }
        viewModelScope.launch { privacySubscriptionResolutionBus.changed.collect { refreshPrivacyPending() } }
    }

    fun retryPendingNotes() {
        viewModelScope.launch { notesRepository.drain() }
    }

    fun discardPendingNote(id: Long) {
        viewModelScope.launch { notesRepository.deletePending(id) }
    }

    fun consumeCaptureRequest() = captureLaunchBus.consume()

    fun consumePrivacyApprovalRequest() = notificationLaunchBus.consumePrivacyApproval()
    fun consumeAccessAuthorizationRequest() = notificationLaunchBus.consumeAccessAuthorization()

    fun accessAuthorizationRequestIsCurrent(request: NotificationLaunchBus.AccessAuthorization): Boolean =
        accessAuthorizationPairingMatches(
            expected = request.pairingIdentity,
            current = session.session?.pairing?.accessAuthorizationIdentity(),
        )

    fun consumeAgentConversationRequest() = notificationLaunchBus.consumeAgentConversation()
    fun consumeWatchFiringRequest() = notificationLaunchBus.consumeWatchFiring()
    fun consumeSourcePermissionRequest() = notificationLaunchBus.consumeSourcePermission()
    fun consumeRemoteSourcePermissionRequest() = notificationLaunchBus.consumeRemoteSourcePermission()

    fun newConversation() = coordinator.newConversation()

    fun resumeConversation(id: String, autoSend: String? = null) =
        coordinator.resumeConversation(id, autoSend)

    fun deleteConversation(id: String) = coordinator.deleteConversation(id)

    fun togglePin(id: String, pinned: Boolean) = coordinator.togglePin(id, pinned)

    fun ackConversationActionError() = coordinator.ackConversationActionError()

    fun refreshConversations() = coordinator.refreshConversationsPublic()

    fun loadMoreConversations() = coordinator.loadMoreConversationsPublic()

    fun foregroundDestination(): AppForegroundDestination {
        val saved = foregroundStore.destination()
        val minted = if (backgroundedFreshInThisProcess && foregroundStore.hasRecentFreshSurface()) {
            coordinator.state.value.sessionId
        } else {
            null
        }
        backgroundedFreshInThisProcess = false
        return minted?.let(AppForegroundDestination::Conversation) ?: saved
    }

    fun recordAppBackgrounded(agentRouteActive: Boolean) {
        coordinator.appVisibilityChanged(false)
        val surface = if (!agentRouteActive) {
            AppForegroundSurface.OutsideAgent
        } else {
            coordinator.state.value.sessionId
                ?.let(AppForegroundSurface::Conversation)
                ?: AppForegroundSurface.FreshConversation
        }
        foregroundStore.save(surface)
        backgroundedFreshInThisProcess = surface == AppForegroundSurface.FreshConversation
    }

    fun onForeground() {
        coordinator.appVisibilityChanged(true)
        coordinator.onForeground()
        permissionHealth.refresh()
        _notificationHealth.value = pushManager.deliveryHealth()
        refreshGatewayStatus()
        viewModelScope.launch {
            session.reportNotificationHealth()
            session.drainNotifications()
        }
    }

    fun openNotificationSettings(context: Context) {
        context.startActivity(
            Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName),
        )
    }
}

/**
 * The decisions the menu badge counts: held answers always, and watch requests only where the
 * experimental surface that resolves them exists. A queue that could not be read counts as
 * none — the badge is a hint, and a failed read must not become a wrong number.
 */
internal fun privacyDecisionsWaiting(
    heldAnswers: Int?,
    watchRequests: Int?,
    experimental: Boolean,
): Int = (heldAnswers ?: 0) + if (experimental) watchRequests ?: 0 else 0

/** A best-effort read: a failure is "no answer", but cancellation is never swallowed. */
private suspend fun <T> attempt(block: suspend () -> T): T? = try {
    block()
} catch (cancelled: CancellationException) {
    throw cancelled
} catch (_: Throwable) {
    null
}
