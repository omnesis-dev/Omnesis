// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android.session

import android.util.Log
import dev.omnesis.android.BuildConfig
import dev.omnesis.android.distribution.DistributionSourceIntegration
import dev.omnesis.android.distribution.DistributionSourceSession
import dev.omnesis.android.feature.activitysegments.ActivitySegmentsIntegration
import dev.omnesis.android.feature.activitysegments.ActivitySegmentsSyncCoordinator
import dev.omnesis.android.feature.appusage.AppUsageIntegration
import dev.omnesis.android.feature.appusage.AppUsageSyncCoordinator
import dev.omnesis.android.feature.health.HealthIntegration
import dev.omnesis.android.feature.health.HealthSyncCoordinator
import dev.omnesis.android.feature.photos.PhotosIntegration
import dev.omnesis.android.feature.photos.PhotosSyncCoordinator
import dev.omnesis.android.notifications.FcmPushManager
import dev.omnesis.android.notifications.RelayEnroller
import dev.omnesis.android.notifications.drainClaimedNotifications
import dev.omnesis.android.pairing.Pairing
import dev.omnesis.android.pairing.PairingService
import dev.omnesis.android.pairing.PairingTlsMode
import dev.omnesis.android.setup.PhoneSetupStep
import dev.omnesis.android.setup.flow.PhoneSetupRecord
import dev.omnesis.android.setup.flow.pairingStartsClean
import dev.omnesis.android.sources.SourceCatalog
import dev.omnesis.android.transport.DeliveryReporter
import dev.omnesis.android.transport.DeviceCapabilities
import dev.omnesis.android.transport.GatewayException
import dev.omnesis.android.transport.HostedSourceOptIn
import dev.omnesis.android.transport.SessionScopeProvider
import dev.omnesis.android.transport.client.AdminClient
import dev.omnesis.android.transport.client.AgentClient
import dev.omnesis.android.transport.client.AgentEventSource
import dev.omnesis.android.transport.client.AnalyticsClient
import dev.omnesis.android.transport.client.BriefsClient
import dev.omnesis.android.transport.client.DocumentsClient
import dev.omnesis.android.transport.client.GatewayClient
import dev.omnesis.android.transport.client.NotesClient
import dev.omnesis.android.transport.client.NotificationsClient
import dev.omnesis.android.transport.client.SearchClient
import dev.omnesis.android.transport.client.WatchesClient
import dev.omnesis.android.transport.dto.BriefsMenuEntry
import dev.omnesis.android.transport.dto.ClaimedNotificationDelivery
import dev.omnesis.android.transport.dto.PushPlan
import dev.omnesis.android.transport.http.GatewayHttp
import dev.omnesis.android.transport.tls.PinnedOkHttp
import dev.omnesis.android.transport.ws.DeviceSocket
import dev.omnesis.android.ui.agent.AgentCoordinator
import javax.inject.Inject
import javax.inject.Provider
import javax.inject.Singleton
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Check the gateway plan even without an FCM token, then register only for the
 * pairing that requested it. The caller owns serialization.
 */
internal suspend fun <Session> retryPushRegistrationForSession(
    captured: Session,
    isCurrent: (Session) -> Boolean,
    ensureClaimCredential: suspend (Session) -> Unit,
    refreshPlan: suspend (Session) -> PushPlan?,
    registerCarrierToken: suspend (Session, PushPlan) -> Unit,
) {
    if (!isCurrent(captured)) return
    ensureClaimCredential(captured)
    if (!isCurrent(captured)) return
    val plan = refreshPlan(captured) ?: return
    if (isCurrent(captured)) registerCarrierToken(captured, plan)
}

internal fun relayConsentRequired(plan: PushPlan): Boolean =
    plan.transport == "unavailable" && plan.reasonCode == "relay-disabled"

internal fun shouldOfferRelayConsentWithoutToken(configured: Boolean, plan: PushPlan?): Boolean =
    configured && plan != null && relayConsentRequired(plan)

/**
 * Marks [prompt] as requesting while [grant] runs, then leaves the request in a
 * state its answers can act on: cleared by the grant, carrying an error when
 * the grant failed or did not finish, or — when the call is cancelled — back
 * as it was, unless something replaced it meanwhile.
 */
internal suspend fun requestRelayConsent(
    prompts: MutableStateFlow<SessionManager.RelayConsentPrompt?>,
    prompt: SessionManager.RelayConsentPrompt,
    isCurrent: () -> Boolean,
    grant: suspend () -> Unit,
) {
    val marked = prompt.copy(requesting = true, error = null)
    prompts.value = marked
    try {
        grant()
        if (isCurrent() && prompts.value?.requesting == true) {
            prompts.value = prompt.copy(
                requesting = false,
                error = "Relay approval was saved, but notification setup didn’t finish. Try again.",
            )
        }
    } catch (cancelled: CancellationException) {
        prompts.compareAndSet(marked, prompt.copy(requesting = false, error = null))
        throw cancelled
    } catch (_: Exception) {
        if (isCurrent()) {
            prompts.value = prompt.copy(
                requesting = false,
                error = "Couldn’t allow relay notifications. Check your connection and try again.",
            )
        }
    }
}

sealed interface PushPlanState {
    data object Checking : PushPlanState
    data class Ready(val plan: PushPlan) : PushPlanState
    data object Failed : PushPlanState
}

/** Keeps feature-status reads ordered so an older response cannot replace a newer one. */
internal class StatusProbeSerializer {
    private val mutex = Mutex()

    suspend fun <T> run(block: suspend () -> T): T = mutex.withLock { block() }
}

internal class RelayConsentDeferral {
    @Volatile
    private var dismissedIdentity: String? = null

    fun dismiss(identity: String) {
        dismissedIdentity = identity
    }

    fun shouldOffer(identity: String): Boolean = dismissedIdentity != identity

    fun beginForegroundVisit() {
        dismissedIdentity = null
    }

    fun clear() {
        dismissedIdentity = null
    }
}

/** Authorize first, then continue only while the pairing that displayed the disclosure is current. */
internal suspend fun <Session> grantRelayConsentForSession(
    captured: Session,
    isCurrent: (Session) -> Boolean,
    grant: suspend (Session) -> Unit,
    replanAndRegister: suspend (Session) -> Unit,
) {
    if (!isCurrent(captured)) return
    grant(captured)
    if (isCurrent(captured)) replanAndRegister(captured)
}

/** Keep the disclosure pending until relay enrollment has actually started. */
internal suspend fun <Session> beginRelayEnrollmentForSession(
    captured: Session,
    isCurrent: (Session) -> Boolean,
    begin: suspend () -> Unit,
    clearCurrentPrompt: () -> Unit,
    clearStalePending: () -> Unit,
) {
    if (!isCurrent(captured)) return
    begin()
    if (isCurrent(captured)) {
        clearCurrentPrompt()
    } else {
        clearStalePending()
    }
}

/**
 * The composition root (the iOS `AppStore` analogue). Holds the active pairing and,
 * on pair/unpair/url-change, rebuilds the pinned OkHttp client and every transport
 * client + the device socket so nothing keeps talking to a stale gateway. Feature
 * integrations plug in through generic seams only: the socket's command flow
 * in, its `sendEvent` out. Distribution-specific sources are supplied by the
 * selected product flavor, so restricted code is not linked into Play builds.
 */
@Singleton
class SessionManager @Inject constructor(
    private val pairingService: PairingService,
    private val deviceCapabilities: DeviceCapabilities,
    private val sourceCatalog: SourceCatalog,
    private val agentCoordinator: AgentCoordinator,
    private val healthIntegration: HealthIntegration,
    private val distributionSourceIntegration: DistributionSourceIntegration,
    private val appUsageIntegration: AppUsageIntegration,
    private val activitySegmentsIntegration: ActivitySegmentsIntegration,
    private val photosIntegration: PhotosIntegration,
    private val pushManager: FcmPushManager,
    private val relayEnroller: RelayEnroller,
    private val sourceRemovalReconciler: dev.omnesis.android.transport.SourceRemovalReconciler,
    private val hostedSourceOptIns: Set<@JvmSuppressWildcards HostedSourceOptIn>,
    private val phoneSetupRecord: PhoneSetupRecord,
    // A provider, because the steps that start first syncs ask this manager for the session scope.
    private val phoneSetupSteps: Provider<Set<@JvmSuppressWildcards PhoneSetupStep>>,
) : SessionScopeProvider, RelayConsentActions {
    sealed interface AppState {
        data object Unpaired : AppState
        data class Paired(val pairing: Pairing) : AppState
    }

    data class RelayConsentPrompt(
        val deviceId: String,
        val appId: String,
        val requesting: Boolean = false,
        val error: String? = null,
    )

    /** The set of clients bound to the current pairing. */
    class GatewaySession(
        val pairing: Pairing,
        val gateway: GatewayClient,
        val search: SearchClient,
        val admin: AdminClient,
        val agent: AgentClient,
        val notes: NotesClient,
        val watches: WatchesClient,
        val briefs: BriefsClient,
        val socket: DeviceSocket,
        val analytics: AnalyticsClient,
        val documents: DocumentsClient,
        val health: HealthSyncCoordinator,
        val distribution: DistributionSourceSession,
        val appUsage: AppUsageSyncCoordinator,
        val activitySegments: ActivitySegmentsSyncCoordinator,
        val photos: PhotosSyncCoordinator,
        initialNotifications: NotificationsClient?,
        private val agentEventSourceFactory: () -> AgentEventSource,
    ) {
        @Volatile var notifications: NotificationsClient? = initialNotifications
            internal set
        /**
         * Every device-hosted source, seen only as something that can say what
         * it has failed to deliver. The delivery-health surface folds this list
         * without knowing which sources are in it.
         */
        val deliveryReporters: List<DeliveryReporter> =
            listOf(health, appUsage, activitySegments, photos) + distribution.deliveryReporters

        /**
         * A fresh caller-wide agent stream for a bounded, non-visual consumer.
         * Each call owns an independent HTTP/SSE connection, cursor and
         * lifecycle; consuming it cannot steal events from, reconnect, or
         * otherwise mutate the visual [AgentCoordinator]'s stream.
         */
        fun newAgentEventSource(): AgentEventSource = agentEventSourceFactory()
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    /** Per-session work (command routing and initial source sync) — cancelled on rebuild. */
    @Volatile
    private var sessionJob: Job? = null

    /** The current session's child scope, made once per session and cancelled with it. */
    private var sessionScope: Pair<Job, CoroutineScope>? = null

    @Volatile
    private var sessionGeneration = 0L

    /** A scope for work that belongs to the current pairing, cancelled with it on unpair, re-pair or a URL change. */
    override fun current(): CoroutineScope? = synchronized(this) {
        val job = sessionJob?.takeIf { it.isActive } ?: return null
        sessionScope?.takeIf { it.first === job }?.second
            ?: CoroutineScope(Dispatchers.IO + SupervisorJob(job)).also { sessionScope = job to it }
    }

    override val generation: Long get() = sessionGeneration

    private val _state = MutableStateFlow<AppState>(AppState.Unpaired)
    val state: StateFlow<AppState> = _state.asStateFlow()

    /**
     * Whether the connected gateway runs in experimental mode
     * (`OMNESIS_EXPERIMENTAL=1` or synthetic mode), read from `GET /status`.
     * Gates discovery of the experimental nav entries.
     * Starts `false` and is reset to `false` on
     * every rebuild (unpair / re-pair / url-change), then set from the fetched
     * status, so an experimental feature never flashes in before the probe lands
     * and never leaks across a re-pair to a non-experimental gateway.
     */
    private val _experimentalEnabled = MutableStateFlow(false)
    val experimentalEnabled: StateFlow<Boolean> = _experimentalEnabled.asStateFlow()

    /**
     * Whether the connected gateway runs in developer mode (`OMNESIS_DEV_MODE=1`),
     * read from `GET /status`. Reveals the developer-annotation capture
     * affordance (shake-to-annotate). Starts `false` and is reset to `false` on
     * every rebuild (unpair / re-pair / url-change), then set from the fetched
     * status, so the affordance never flashes in before the probe lands and
     * never leaks across a re-pair to a non-developer gateway. Mirrors the iOS
     * `AppStore.developerEnabled`.
     */
    private val _developerEnabled = MutableStateFlow(false)
    val developerEnabled: StateFlow<Boolean> = _developerEnabled.asStateFlow()

    /**
     * What the menu should show for Briefs, from the same `/status` probe. Cleared on
     * every rebuild for the same reason as [experimentalEnabled]: a stale value from a
     * prior pairing must not surface the feature against a gateway that lacks it.
     */
    private val _briefsMenuEntry = MutableStateFlow(BriefsMenuEntry.HIDDEN)
    val briefsMenuEntry: StateFlow<BriefsMenuEntry> = _briefsMenuEntry.asStateFlow()
    private val _relayConsentPrompt = MutableStateFlow<RelayConsentPrompt?>(null)
    override val relayConsentPrompt: StateFlow<RelayConsentPrompt?> = _relayConsentPrompt.asStateFlow()
    private val _pushPlan = MutableStateFlow<PushPlanState>(PushPlanState.Checking)
    val pushPlan: StateFlow<PushPlanState> = _pushPlan.asStateFlow()
    private val _pushRegistrationFailed = MutableStateFlow(false)
    val pushRegistrationFailed: StateFlow<Boolean> = _pushRegistrationFailed.asStateFlow()
    private val relayConsentDeferral = RelayConsentDeferral()
    private val pushRegistrationMutex = Mutex()
    private val notificationDrainMutex = Mutex()
    private val revocationDrainMutex = Mutex()
    private val statusProbeSerializer = StatusProbeSerializer()

    @Volatile
    var session: GatewaySession? = null
        private set

    init {
        rebuild(atLaunch = true)
    }

    suspend fun pairFromQr(raw: String): Pairing = pairAndBuild { pairingService.pair(raw) }

    suspend fun pairManually(gatewayUrl: String, pairingCode: String, fingerprint: String?): Pairing =
        pairAndBuild { pairingService.pairManually(gatewayUrl, pairingCode, fingerprint) }

    /**
     * Records that a pairing is under way before its exchange persists
     * anything, so the session that follows — this one, or the next launch's
     * if the process dies in between — settles the phone's local state for it.
     */
    private suspend fun pairAndBuild(exchange: suspend () -> Pairing): Pairing {
        phoneSetupRecord.beginPairing()
        val pairing = try {
            exchange()
        } catch (error: Throwable) {
            if (pairingService.current() == null) phoneSetupRecord.clearPairingPending()
            throw error
        }
        rebuild()
        return pairing
    }

    fun updateGatewayUrl(url: String) {
        pairingService.updateGatewayURL(url)
        rebuild()
    }

    fun unpair() {
        pairingService.stageUnpair()
        // The session goes first, so nothing it started — a first sync phone setup launched — outlives the pairing.
        rebuild()
        resetPhoneSetupSteps()
        // A later pairing starts from every source's defaults and is offered phone setup again.
        hostedSourceOptIns.forEach { optIn -> runCatching { optIn.forget() } }
        phoneSetupRecord.clear()
        scope.launch { drainPendingDeviceRevocation() }
    }

    private suspend fun drainPendingDeviceRevocation() {
        revocationDrainMutex.withLock {
            while (true) {
                val pending = pairingService.pendingRevocation() ?: return@withLock
                val deviceId = pending.deviceId
                if (deviceId == null) {
                    pairingService.settlePendingRevocation(pending)
                    continue
                }
                val http = GatewayHttp(
                    PinnedOkHttp.build(pending.fingerprint),
                    pending.url,
                    pending.token,
                    pending.pairingGeneration,
                )
                try {
                    AdminClient(http).revokeDevice(deviceId)
                    pairingService.settlePendingRevocation(pending)
                } catch (_: GatewayException.Unauthorized) {
                    pairingService.settlePendingRevocation(pending)
                } catch (_: GatewayException.Forbidden) {
                    pairingService.settlePendingRevocation(pending)
                } catch (_: GatewayException.NotFound) {
                    pairingService.settlePendingRevocation(pending)
                } catch (error: GatewayException.ServerError) {
                    if (error.status == 409) {
                        pairingService.settlePendingRevocation(pending)
                    } else {
                        return@withLock
                    }
                } catch (_: Exception) {
                    return@withLock
                }
            }
        }
    }

    /**
     * Re-pair with the gateway: wipe the current token and rebuild back to [AppState.Unpaired]
     * so the onboarding / pairing surface comes forward and the user can scan a fresh code.
     * Indexed data on the gateway is untouched. Mirrors the iOS "Re-pair with gateway" action.
     */
    fun beginRepair() {
        // The pairing that follows is this phone's own again: it keeps what the user turned on.
        phoneSetupRecord.beginRepair()
        pairingService.unpair()
        rebuild()
        resetPhoneSetupSteps()
    }

    /**
     * Settles the phone's local source state for [pairing], after the previous
     * session was torn down and before the new one is built, in the same order
     * as unpairing. A new pairing to another device — a different gateway, or
     * an install whose state no pairing recorded — starts from every source's
     * defaults and is offered phone setup; a repair keeps its state whatever
     * device id it names. An install already paired before its state had an
     * owner keeps it.
     */
    private fun settleLocalState(pairing: Pairing, atLaunch: Boolean) {
        val record = phoneSetupRecord
        if (!record.pairingPending) {
            if (record.localStateDeviceId == null) record.claimLocalState(pairing.deviceId)
            return
        }
        if (pairingStartsClean(true, record.repairing, record.localStateDeviceId, pairing.deviceId)) {
            // At launch no step has run anything yet, and the steps are not built until this manager is.
            if (!atLaunch) resetPhoneSetupSteps()
            hostedSourceOptIns.forEach { optIn -> runCatching { optIn.forget() } }
            record.clear()
        }
        record.claimLocalState(pairing.deviceId)
        record.finishPairing()
    }

    /** No enable phone setup started, and nothing the user chose on its pages, outlives the pairing it was made for. */
    private fun resetPhoneSetupSteps() {
        phoneSetupSteps.get().forEach { step -> runCatching { step.reset() } }
    }

    fun requireSession(): GatewaySession =
        session ?: error("no active gateway session — app is unpaired")

    private fun rebuild(atLaunch: Boolean = false) {
        sourceRemovalReconciler.invalidateSession()
        sessionJob?.cancel()
        sessionJob = null
        sessionGeneration++
        session?.socket?.stop()
        session = null
        // Re-probe per rebuild; clear so a stale value from a prior pairing can't
        // surface an experimental feature against a non-experimental gateway.
        _experimentalEnabled.value = false
        _developerEnabled.value = false
        _briefsMenuEntry.value = BriefsMenuEntry.HIDDEN
        _relayConsentPrompt.value = null
        _pushPlan.value = PushPlanState.Checking
        _pushRegistrationFailed.value = false
        relayConsentDeferral.clear()
        val pairing = pairingService.current()
        if (pairing == null) {
            session = null
            relayEnroller.clearAll()
            sourceCatalog.clear()
            agentCoordinator.teardown()
            _state.value = AppState.Unpaired
            return
        }
        settleLocalState(pairing, atLaunch)
        val requirePin = pairing.tlsMode == PairingTlsMode.PINNED_LEAF
        val http = GatewayHttp(
            PinnedOkHttp.build(pairing.fingerprint, requirePin = requirePin),
            pairing.url,
            pairing.token,
            pairing.pairingGeneration,
        )
        val streaming = PinnedOkHttp.buildStreaming(pairing.fingerprint, requirePin = requirePin)
        val socket = DeviceSocket(
            client = streaming,
            gatewayUrl = pairing.url,
            token = pairing.token,
            scope = scope,
            capabilities = deviceCapabilities,
        )
        val agent = AgentClient(http)
        val admin = AdminClient(http)
        val analytics = AnalyticsClient(http)
        val documents = DocumentsClient(http)
        val health = healthIntegration.buildCoordinator(analytics, socket::sendEvent)
        val distribution = distributionSourceIntegration.buildSession(analytics, documents, socket::sendEvent)
        val appUsage = appUsageIntegration.buildCoordinator(analytics, documents, socket::sendEvent)
        val activitySegments = activitySegmentsIntegration.buildCoordinator(analytics, documents, socket::sendEvent)
        val photos = photosIntegration.buildCoordinator(analytics, documents, admin, socket::sendEvent, pairing.deviceId)
        // Answers a gateway "Sync now" from the dispatch itself, so a source
        // no feature takes on is refused rather than falsely acked. Wired
        // before `start()` — a command arriving on the first frame would
        // otherwise be refused for want of a dispatcher.
        socket.dispatchSync = { sourceId ->
            val payload = buildJsonObject { put("sourceId", sourceId) }
            listOf(
                { healthIntegration.handleCommand(health, "source.sync", payload, scope) },
                { distribution.handleCommand("source.sync", payload, scope) },
                { appUsageIntegration.handleCommand(appUsage, "source.sync", payload, scope) },
                { activitySegmentsIntegration.handleCommand(activitySegments, "source.sync", payload, scope) },
                { photosIntegration.handleCommand(photos, "source.sync", payload, scope) },
            ).any { it() }
        }
        socket.start()
        val built = GatewaySession(
            pairing = pairing,
            gateway = GatewayClient(http),
            search = SearchClient(http),
            admin = admin,
            agent = agent,
            notes = NotesClient(http),
            watches = WatchesClient(http),
            briefs = BriefsClient(http),
            socket = socket,
            analytics = analytics,
            documents = documents,
            health = health,
            distribution = distribution,
            appUsage = appUsage,
            activitySegments = activitySegments,
            photos = photos,
            initialNotifications = pairing.deviceId
                ?.let(pairingService::pushClaimCredential)
                ?.let { token ->
                    NotificationsClient(
                        GatewayHttp(
                            PinnedOkHttp.build(pairing.fingerprint, requirePin = requirePin),
                            pairing.url,
                            token,
                        ),
                    )
                },
            agentEventSourceFactory = {
                AgentEventSource(streaming, pairing.url, pairing.token)
            },
        )
        session = built
        // Everything the session starts is a child of its job, so a rebuild cancels the
        // launch reads still in flight along with the loops: none of them reaches the
        // gateway, or writes its reply into shared state, after the session ends.
        sessionJob = scope.launch {
            launch { sourceCatalog.load(built.admin) }
            // Probe the gateway's status so the drawer + composer can gate
            // experimental and developer surfaces. Best-effort: a failed/old-gateway
            // probe leaves them `false`, keeping those surfaces hidden. The
            // `session === built` guard drops a probe that resolves after a newer
            // rebuild replaced the session, so a slow status read can't light gated
            // surfaces against a gateway we have since re-paired away from.
            launch {
                probeStatus(built)
            }
            launch {
                pushRegistrationMutex.withLock {
                    retryPushRegistrationForSession(
                        captured = built,
                        isCurrent = { session === it },
                        ensureClaimCredential = ::ensurePushClaimCredential,
                        refreshPlan = ::refreshPushPlan,
                        registerCarrierToken = { current, plan -> registerFcmToken(current, plan = plan) },
                    )
                }
                drainPendingNotifications(maxItems = NOTIFICATION_DRAIN_LIMIT)
            }
            suspend fun reconcileRemovals() {
                try {
                    sourceRemovalReconciler.reconcile {
                        val removed = built.admin.sourcesToWithdraw(pairing.deviceId)
                        if (session === built) removed else emptyList()
                    }
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    Log.w("Omnesis:session", "Source removal refresh failed: ${e::class.simpleName}")
                }
            }
            launch {
                socket.state.collect { state ->
                    if (state is dev.omnesis.android.transport.ws.DeviceSocket.ConnectionState.Connected) reconcileRemovals()
                }
            }
            launch {
                socket.commands.collect { command ->
                    if (command.type == "source.removed") {
                        reconcileRemovals()
                    }
                }
            }
            launch {
                socket.events.collect { event ->
                    if (event.type == "source.removed") reconcileRemovals()
                    if (event.type == "push.available") {
                        drainPendingNotifications(maxItems = NOTIFICATION_DRAIN_LIMIT)
                    }
                }
            }
            healthIntegration.launchInitialSync(health, this)
            distribution.launchInitialSync(this)
            appUsageIntegration.launchInitialSync(appUsage, this)
            activitySegmentsIntegration.launchInitialSync(activitySegments, this)
            photosIntegration.launchInitialSync(photos, this)
        }
        agentCoordinator.rebuild(agent, built.newAgentEventSource())
        _state.value = AppState.Paired(pairing)
    }

    /** Best-effort registration for an FCM rotation callback. Never logs the token. */
    suspend fun registerCurrentFcmToken(token: String) {
        if (token.isBlank()) return
        val current = session ?: return
        pushRegistrationMutex.withLock {
            if (session === current) ensurePushClaimCredential(current)
            if (session === current) registerFcmToken(current, token)
        }
    }

    /** Start one foreground visit before its queued registration retry runs. */
    fun beginForegroundVisit() {
        relayConsentDeferral.beginForegroundVisit()
    }

    /** Retry the best-effort registration queued by the foreground owner. */
    suspend fun retryFcmRegistration() {
        drainPendingDeviceRevocation()
        val current = session ?: return
        pushRegistrationMutex.withLock {
            retryPushRegistrationForSession(
                captured = current,
                isCurrent = { session === it },
                ensureClaimCredential = ::ensurePushClaimCredential,
                refreshPlan = ::refreshPushPlan,
                registerCarrierToken = { captured, plan -> registerFcmToken(captured, plan = plan) },
            )
        }
        drainPendingNotifications(maxItems = NOTIFICATION_DRAIN_LIMIT)
    }

    override fun dismissRelayConsent() {
        val prompt = _relayConsentPrompt.value ?: return
        if (prompt.requesting) return
        relayConsentDeferral.dismiss(relayConsentIdentity(prompt.deviceId, prompt.appId))
        _relayConsentPrompt.value = null
    }

    /** Allows the relay in the manager's own scope, so leaving the screen that asked never cancels it half-way. */
    override fun allowRelayConsent() {
        scope.launch { grantRelayConsent() }
    }

    private suspend fun grantRelayConsent() {
        val current = session ?: return
        val prompt = _relayConsentPrompt.value ?: return
        val deviceId = current.pairing.deviceId ?: return
        if (prompt.deviceId != deviceId || prompt.appId != BuildConfig.APPLICATION_ID) return
        pushRegistrationMutex.withLock {
            if (session !== current || _relayConsentPrompt.value != prompt) return
            requestRelayConsent(_relayConsentPrompt, prompt, isCurrent = { session === current }) {
                grantRelayConsentForSession(
                    captured = current,
                    isCurrent = { session === it },
                    grant = { it.admin.grantRelayPushConsent(deviceId, prompt.appId) },
                    replanAndRegister = { registerFcmToken(it) },
                )
            }
        }
    }

    /** One serialized claim/render/confirm lane shared by FCM, WS, and foreground retry. */
    suspend fun drainPendingNotifications(
        maxItems: Int = NOTIFICATION_DRAIN_LIMIT,
        onClaimFailure: (Throwable) -> Unit = {},
        onClaimStarted: () -> Unit = {},
        onClaimCompleted: () -> Unit = {},
    ): Int =
        notificationDrainMutex.withLock {
            val current = session ?: return@withLock 0
            drainClaimedNotifications(
                session = current,
                maxItems = maxItems.coerceIn(0, NOTIFICATION_DRAIN_LIMIT),
                isCurrent = { session === it },
                claim = ::claimNotification,
                render = { captured, delivery ->
                    pushManager.showClaimedOutcome(delivery, captured.pairing.deviceId)
                },
                reportDisabled = ::reportNotificationHealth,
                onClaimFailure = onClaimFailure,
                onClaimStarted = onClaimStarted,
                onClaimCompleted = onClaimCompleted,
                confirm = ::confirmNotification,
            )
        }

    suspend fun reportNotificationHealth(captured: GatewaySession? = session) {
        if (!pushManager.configured) return
        val current = captured ?: return
        if (session !== current) return
        val deviceId = current.pairing.deviceId ?: return
        try {
            current.admin.reportPushHealth(deviceId, pushManager.deliveryHealth())
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            // Best-effort health reporting must not make foregrounding fail.
        }
    }

    /** Retry leased notifications after permission restoration even without a fresh carrier wake. */
    suspend fun drainNotifications() {
        drainPendingNotifications(maxItems = NOTIFICATION_DRAIN_LIMIT)
    }

    /** Claim with the narrow credential, rotating it once if the gateway revoked it. */
    suspend fun claimNotification(current: GatewaySession): ClaimedNotificationDelivery? {
        var notifications = current.notifications ?: return null
        try {
            return notifications.claim()
        } catch (_: GatewayException.Unauthorized) {
            pushRegistrationMutex.withLock {
                if (session !== current) return null
                if (current.notifications === notifications) {
                    current.notifications = null
                    pairingService.clearPushClaimCredential()
                    ensurePushClaimCredential(current)
                }
                notifications = current.notifications ?: return null
            }
            return notifications.claim()
        }
    }

    /** Confirm through the current narrow credential only. */
    suspend fun confirmNotification(current: GatewaySession, deliveryId: String) {
        if (session !== current) return
        current.notifications?.confirm(deliveryId)
    }

    /** Refresh feature-gate state after a settings mutation that can change readiness. */
    suspend fun refreshStatus() {
        session?.let { probeStatus(it) }
    }

    private suspend fun probeStatus(current: GatewaySession) {
        statusProbeSerializer.run probe@{
            if (session !== current) return@probe
            val status = runCatching { current.gateway.status() }.getOrElse { return@probe }
            if (session !== current) return@probe
            _experimentalEnabled.value = status.experimental
            _developerEnabled.value = status.developer
            _briefsMenuEntry.value = BriefsMenuEntry.from(status.briefs)
        }
    }

    private companion object {
        const val NOTIFICATION_DRAIN_LIMIT = 20
    }

    private suspend fun refreshPushPlan(current: GatewaySession): PushPlan? {
        val deviceId = current.pairing.deviceId ?: return null
        val result: Result<PushPlan> = try {
            Result.success(current.admin.pushPlan(deviceId, BuildConfig.APPLICATION_ID))
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Exception) {
            Result.failure(error)
        }
        if (session !== current) return null
        _pushPlan.value = result.fold({ PushPlanState.Ready(it) }, { PushPlanState.Failed })
        return result.getOrNull()
    }

    private suspend fun registerFcmToken(
        current: GatewaySession,
        suppliedToken: String? = null,
        plan: PushPlan? = null,
    ): Boolean {
        if (session !== current) return false
        val deviceId = current.pairing.deviceId ?: return false
        val token = suppliedToken ?: pushManager.currentRegistrationToken()
        if (token == null) {
            if (shouldOfferRelayConsentWithoutToken(pushManager.configured, plan) && session === current) {
                offerRelayConsent(deviceId)
            }
            if (session === current && pushManager.configured &&
                (plan?.transport == "direct-fcm" || plan?.transport == "relay")
            ) _pushRegistrationFailed.value = true
            return false
        }
        val projectId = BuildConfig.FIREBASE_PROJECT_ID.takeIf { it.isNotBlank() } ?: return false
        if (session !== current) return false
        val registered = runCatching {
            val selectedPlan = plan ?: refreshPushPlan(current) ?: return@runCatching false
            if (session !== current) return@runCatching false
            if (selectedPlan.transport == "relay") _pushRegistrationFailed.value = false
            relayEnroller.reconcilePlan(
                selectedRelayUrl = selectedPlan.relayUrl.takeIf { selectedPlan.transport == "relay" },
                registrationToken = token,
                appId = BuildConfig.APPLICATION_ID,
                deviceId = deviceId,
                gatewayUrl = current.pairing.url,
            )
            val consentIdentity = relayConsentIdentity(deviceId, BuildConfig.APPLICATION_ID)
            if (relayConsentRequired(selectedPlan)) {
                offerRelayConsent(deviceId)
                return@runCatching false
            }
            if (selectedPlan.transport != "relay") clearRelayConsentPrompt(consentIdentity)
            when (selectedPlan.transport) {
                "direct-fcm" -> {
                    current.admin.setDirectFcmPushRegistration(deviceId, token, projectId)
                    true
                }
                "relay" -> {
                    val relayUrl = selectedPlan.relayUrl?.takeIf { it.isNotBlank() }
                        ?: return@runCatching false
                    if (!relayEnroller.shouldRotate(
                            relayUrl,
                            token,
                            BuildConfig.APPLICATION_ID,
                            deviceId,
                            current.pairing.url,
                        )
                    ) {
                        clearRelayConsentPrompt(consentIdentity)
                        return@runCatching true
                    }
                    beginRelayEnrollmentForSession(
                        captured = current,
                        isCurrent = { session === it },
                        begin = {
                            relayEnroller.begin(
                                relayUrl = relayUrl,
                                registrationToken = token,
                                appId = BuildConfig.APPLICATION_ID,
                                deviceId = deviceId,
                                gatewayUrl = current.pairing.url,
                            )
                        },
                        clearCurrentPrompt = { clearRelayConsentPrompt(consentIdentity) },
                        // rebuild() may have cleared the old challenge while this
                        // request was in flight; do not restore stale pending state.
                        clearStalePending = relayEnroller::clearPending,
                    )
                    // The carrier accepted the challenge, but registration is
                    // not complete until its nonce is verified and stored.
                    false
                }
                "unavailable" -> false
                else -> false
            }
        }.getOrDefault(false)
        if (session === current && (plan ?: (_pushPlan.value as? PushPlanState.Ready)?.plan)?.transport == "direct-fcm") {
            _pushRegistrationFailed.value = !registered
        }
        return registered
    }

    private fun offerRelayConsent(deviceId: String) {
        val identity = relayConsentIdentity(deviceId, BuildConfig.APPLICATION_ID)
        if (!relayConsentDeferral.shouldOffer(identity)) return
        val existing = _relayConsentPrompt.value
        if (existing?.deviceId != deviceId || existing.appId != BuildConfig.APPLICATION_ID) {
            _relayConsentPrompt.value = RelayConsentPrompt(deviceId, BuildConfig.APPLICATION_ID)
        }
    }

    private fun clearRelayConsentPrompt(consentIdentity: String) {
        if (_relayConsentPrompt.value?.let { relayConsentIdentity(it.deviceId, it.appId) } == consentIdentity) {
            _relayConsentPrompt.value = null
        }
        relayConsentDeferral.clear()
    }

    private suspend fun ensurePushClaimCredential(current: GatewaySession) {
        if (current.notifications != null || session !== current) return
        val deviceId = current.pairing.deviceId ?: return
        val minted = runCatching {
            current.admin.createToken(
                deviceId = deviceId,
                scopes = listOf("push:claim"),
                name = "Android notifications",
            )
        }.getOrNull() ?: return
        if (minted.deviceId != deviceId || minted.scopes != listOf("push:claim") || minted.token.isBlank()) {
            runCatching { current.admin.revokeToken(minted.id) }
            return
        }
        if (session !== current) {
            // A re-pair raced the mint. Do not leave an unused narrow credential
            // behind on the old gateway.
            runCatching { current.admin.revokeToken(minted.id) }
            return
        }
        pairingService.setPushClaimCredential(deviceId, minted.token)
        current.notifications = NotificationsClient(
            GatewayHttp(
                PinnedOkHttp.build(
                    current.pairing.fingerprint,
                    requirePin = current.pairing.tlsMode == PairingTlsMode.PINNED_LEAF,
                ),
                current.pairing.url,
                minted.token,
            ),
        )
    }

    /** Finish a relay challenge only for the pairing that initiated it. */
    suspend fun completeRelayEnrollment(nonce: String) {
        val current = session ?: return
        val deviceId = current.pairing.deviceId ?: return
        pushRegistrationMutex.withLock {
            if (session !== current) return
            val token = pushManager.currentRegistrationToken() ?: return
            val projectId = BuildConfig.FIREBASE_PROJECT_ID.takeIf { it.isNotBlank() } ?: return
            val plan = runCatching {
                current.admin.pushPlan(deviceId, BuildConfig.APPLICATION_ID)
            }.getOrNull() ?: return
            if (session !== current) return
            val selectedRelayUrl = plan.relayUrl.takeIf { plan.transport == "relay" }
            relayEnroller.reconcilePlan(
                selectedRelayUrl = selectedRelayUrl,
                registrationToken = token,
                appId = BuildConfig.APPLICATION_ID,
                deviceId = deviceId,
                gatewayUrl = current.pairing.url,
            )
            when (plan.transport) {
                "direct-fcm" -> {
                    runCatching {
                        current.admin.setDirectFcmPushRegistration(deviceId, token, projectId)
                    }
                    return
                }
                "relay" -> if (selectedRelayUrl == null) return
                "unavailable" -> return
                else -> return
            }
            val verified = runCatching {
                relayEnroller.verify(nonce, deviceId, current.pairing.url)
            }.getOrNull() ?: return
            if (session !== current) return
            val stored = runCatching {
                current.admin.setRelayPushRegistration(
                    deviceId,
                    verified.relayUrl,
                    verified.credential,
                )
            }.isSuccess
            if (stored && session === current) {
                relayEnroller.markRegistered(
                    verified.relayUrl,
                    token,
                    BuildConfig.APPLICATION_ID,
                    deviceId,
                    current.pairing.url,
                )
            }
        }
    }

    private fun relayConsentIdentity(deviceId: String, appId: String): String =
        "$deviceId\u001f$appId"
}
