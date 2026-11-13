// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

package dev.omnesis.android

import android.content.Intent
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.graphics.toArgb
import androidx.core.view.WindowCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.lifecycleScope
import dagger.hilt.android.AndroidEntryPoint
import dev.omnesis.android.access.accessAuthorizationIdentity
import dev.omnesis.android.access.routeAccessAuthorizationDeepLink
import dev.omnesis.android.designsystem.theme.OmTheme
import dev.omnesis.android.designsystem.theme.OmnesisTheme
import dev.omnesis.android.notes.NotesRepository
import dev.omnesis.android.notifications.NotificationLaunchBus
import dev.omnesis.android.session.SessionManager
import dev.omnesis.android.transport.SourceMembership
import dev.omnesis.android.ui.capture.CaptureLaunchBus
import dev.omnesis.android.ui.capture.CaptureSurface
import dev.omnesis.android.ui.root.RootScreen
import dev.omnesis.android.ui.search.SearchLaunchBus
import dev.omnesis.android.ui.settings.AppearanceMode
import dev.omnesis.android.ui.settings.AppearanceStore
import dev.omnesis.android.ui.tasks.TaskFocusBus
import dev.omnesis.android.widgets.TaskWidgetDeepLink
import dev.omnesis.android.widgets.TaskWidgetUpdates
import kotlinx.coroutines.launch
import javax.inject.Inject

@AndroidEntryPoint
class MainActivity : ComponentActivity() {

    @Inject
    lateinit var sessionManager: SessionManager

    @Inject
    lateinit var appearance: AppearanceStore

    @Inject
    lateinit var captureLaunchBus: CaptureLaunchBus

    @Inject
    lateinit var notesRepository: NotesRepository

    @Inject
    lateinit var sourceMembership: SourceMembership

    @Inject
    lateinit var notificationLaunchBus: NotificationLaunchBus

    @Inject
    lateinit var searchLaunchBus: SearchLaunchBus

    @Inject
    lateinit var taskFocusBus: TaskFocusBus

    /** Which launch intents were already acted on; kept across recreations. */
    private lateinit var launches: OneShotLaunches

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        launches = OneShotLaunches(savedInstanceState)
        handleLaunch(
            intent,
            if (savedInstanceState == null) LaunchDelivery.CREATED else LaunchDelivery.RECREATED,
        )
        // Draw edge-to-edge so the themed app background paints behind the status + navigation
        // bars (the bars themselves are coloured + their icons toned from the active theme below).
        enableEdgeToEdge()
        if (BuildConfig.DEBUG) maybeSeedPairing(intent)
        setContent {
            val mode by appearance.mode.collectAsStateWithLifecycle()
            val dark = when (mode) {
                AppearanceMode.LIGHT -> false
                AppearanceMode.DARK -> true
                AppearanceMode.SYSTEM -> isSystemInDarkTheme()
            }
            OmnesisTheme(darkTheme = dark) {
                // System-bar appearance follows the in-app theme (not just the OS one): a
                // transparent status bar so the app background shows through and matches it, a
                // nav bar tinted to the app background at slight translucency (whitish in light,
                // black in dark) that content scrolls gently under, and bar icons toned for
                // legibility against each.
                val navBarColor = OmTheme.colors.bgPrimary.copy(alpha = 0.85f).toArgb()
                LaunchedEffect(dark, navBarColor) {
                    val controller = WindowCompat.getInsetsController(window, window.decorView)
                    controller.isAppearanceLightStatusBars = !dark
                    controller.isAppearanceLightNavigationBars = !dark
                    window.statusBarColor = Color.TRANSPARENT
                    window.navigationBarColor = navBarColor
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                        window.isNavigationBarContrastEnforced = false
                    }
                }
                RootScreen()
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        // singleTask: a tile, shortcut, widget or notification launch while the task exists
        // lands here.
        setIntent(intent)
        handleLaunch(intent, LaunchDelivery.NEW_INTENT)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        launches.save(outState)
    }

    override fun onStart() {
        super.onStart()
        // Push any offline-queued quick-capture notes on every app start /
        // return to foreground. No-op while unpaired or with an empty queue.
        lifecycleScope.launch { runCatching { notesRepository.drain() } }
        // Registration is best-effort during pairing; retry on every foreground
        // so a transient gateway or FCM failure does not permanently disable push.
        sessionManager.beginForegroundVisit()
        TaskWidgetUpdates.refresh(applicationContext)
        lifecycleScope.launch { sessionManager.retryFcmRegistration() }
        // Feature gates the operator may have changed from another device while this
        // app was in the background, gateway dictation among them.
        lifecycleScope.launch { sessionManager.refreshStatus() }
        // A source the user turned off while the gateway was unreachable is
        // still listed there as hosted by this phone until the detach lands.
        sourceMembership.retryPending()
    }

    /**
     * Route [launchIntent] to the screen it asks for, when it is a request to act on (see
     * [OneShotLaunches]). A request acted on is then taken off the activity, so nothing
     * that reads the activity's intent later finds it again.
     */
    private fun handleLaunch(launchIntent: Intent?, delivery: LaunchDelivery) {
        if (launchIntent == null) return
        val handled = when (launchIntent.action) {
            ACTION_VOICE_INPUT, ACTION_TELL_BRAIN -> handleCapture(launchIntent, delivery)
            ACTION_PRIVACY_APPROVAL -> handlePrivacyApproval(launchIntent, delivery)
            ACTION_ACCESS_AUTHORIZATION -> handleAccessAuthorization(launchIntent, delivery)
            ACTION_AGENT_CONVERSATION -> handleAgentConversation(launchIntent, delivery)
            ACTION_WATCH_FIRING -> handleWatchFiring(launchIntent, delivery)
            ACTION_SOURCE_PERMISSION -> handleSourcePermission(launchIntent, delivery)
            ACTION_REMOTE_SOURCE_PERMISSION -> handleRemoteSourcePermission(launchIntent, delivery)
            ACTION_DEVICES -> handleDevices(launchIntent, delivery)
            ACTION_SEARCH -> handleSearch(launchIntent, delivery)
            Intent.ACTION_VIEW ->
                handleTaskWidgetDeepLink(launchIntent, delivery) || handleAccessAuthorizationDeepLink(launchIntent)
            else -> false
        }
        if (handled) setIntent(consumedLaunchIntent(launchIntent))
    }

    /**
     * The Omnesis tile and the voice shortcut launch [ACTION_VOICE_INPUT]; the Tell shortcut
     * launches [ACTION_TELL_BRAIN]. The surface slug rides through the [CaptureLaunchBus]
     * into the nav graph, which opens the capture screen, and with it the microphone.
     *
     * The tile stamps each tap with the time it was made ([EXTRA_LAUNCH_STAMP]), so a tap
     * is also refused once it is older than [CAPTURE_LAUNCH_FRESHNESS_MS]: the microphone
     * never opens for a tap made long ago, however the intent comes back. A static
     * shortcut cannot carry a stamp.
     */
    private fun handleCapture(launchIntent: Intent, delivery: LaunchDelivery): Boolean {
        val stamp = launchIntent.getLongExtra(EXTRA_LAUNCH_STAMP, 0L)
        if (stamp != 0L && SystemClock.elapsedRealtime() - stamp !in 0..CAPTURE_LAUNCH_FRESHNESS_MS) return false
        if (!launches.accept(KIND_CAPTURE, launchIntent, stamp, delivery)) return false
        val surface = if (launchIntent.action == ACTION_VOICE_INPUT) {
            launchIntent.getStringExtra(EXTRA_SURFACE)?.takeIf { it == CaptureSurface.TILE }
                ?: CaptureSurface.VOICE_SHORTCUT
        } else {
            launchIntent.getStringExtra(EXTRA_SURFACE) ?: CaptureSurface.APP
        }
        captureLaunchBus.post(surface)
        return true
    }

    private fun handleTaskWidgetDeepLink(launchIntent: Intent, delivery: LaunchDelivery): Boolean {
        val link = TaskWidgetDeepLink.parse(launchIntent.dataString) ?: return false
        if (!launches.accept(KIND_TASK_WIDGET, launchIntent, stamp = 0L, delivery)) return false
        taskFocusBus.postLaunch(link)
        return true
    }

    private fun handleSearch(launchIntent: Intent, delivery: LaunchDelivery): Boolean {
        if (!launches.accept(KIND_SEARCH, launchIntent, stamp = 0L, delivery)) return false
        searchLaunchBus.post(launchIntent.getStringExtra(EXTRA_SEARCH_QUERY))
        return true
    }

    private fun handlePrivacyApproval(launchIntent: Intent, delivery: LaunchDelivery): Boolean {
        val approvalId = launchIntent.getStringExtra(EXTRA_APPROVAL_ID)?.takeIf { it.isNotBlank() } ?: return false
        val stamp = launchIntent.getLongExtra(EXTRA_APPROVAL_LAUNCH_STAMP, 0L)
        if (!launches.accept(KIND_PRIVACY_APPROVAL, launchIntent, stamp, delivery)) return false
        notificationLaunchBus.postPrivacyApproval(approvalId)
        return true
    }

    private fun handleAccessAuthorization(launchIntent: Intent, delivery: LaunchDelivery): Boolean {
        val stamp = launchIntent.getLongExtra(EXTRA_ACCESS_AUTHORIZATION_LAUNCH_STAMP, 0L)
        if (!launches.accept(KIND_ACCESS_AUTHORIZATION, launchIntent, stamp, delivery)) return false
        notificationLaunchBus.postAccessAuthorization()
        return true
    }

    /**
     * The code-only handoff from the OAuth consent page. A canonical link is consumed even
     * on an unpaired phone, so a recreation cannot route that code after a later pairing.
     */
    private fun handleAccessAuthorizationDeepLink(launchIntent: Intent): Boolean {
        val pairingIdentity = (sessionManager.state.value as? SessionManager.AppState.Paired)
            ?.pairing
            ?.accessAuthorizationIdentity()
        return routeAccessAuthorizationDeepLink(
            launchIntent,
            freshDelivery = true,
            pairingIdentity = pairingIdentity,
            onLaunch = notificationLaunchBus::postAccessAuthorization,
        )
    }

    private fun handleAgentConversation(launchIntent: Intent, delivery: LaunchDelivery): Boolean {
        val conversationId =
            launchIntent.getStringExtra(EXTRA_CONVERSATION_ID)?.takeIf { it.isNotBlank() } ?: return false
        val stamp = launchIntent.getLongExtra(EXTRA_CONVERSATION_LAUNCH_STAMP, 0L)
        if (!launches.accept(KIND_AGENT_CONVERSATION, launchIntent, stamp, delivery)) return false
        notificationLaunchBus.postAgentConversation(conversationId)
        return true
    }

    private fun handleWatchFiring(launchIntent: Intent, delivery: LaunchDelivery): Boolean {
        val watchId = launchIntent.getStringExtra(EXTRA_WATCH_ID)?.takeIf { it.isNotBlank() } ?: return false
        val firingKey = launchIntent.getStringExtra(EXTRA_WATCH_FIRING_KEY)?.takeIf { it.isNotBlank() } ?: return false
        val stamp = launchIntent.getLongExtra(EXTRA_WATCH_LAUNCH_STAMP, 0L)
        if (!launches.accept(KIND_WATCH_FIRING, launchIntent, stamp, delivery)) return false
        notificationLaunchBus.postWatchFiring(watchId, firingKey)
        return true
    }

    private fun handleSourcePermission(launchIntent: Intent, delivery: LaunchDelivery): Boolean {
        val sourceId = launchIntent.getStringExtra(EXTRA_SOURCE_ID)?.takeIf { it.isNotBlank() } ?: return false
        val stamp = launchIntent.getLongExtra(EXTRA_SOURCE_PERMISSION_LAUNCH_STAMP, 0L)
        if (!launches.accept(KIND_SOURCE_PERMISSION, launchIntent, stamp, delivery)) return false
        notificationLaunchBus.postSourcePermission(sourceId)
        return true
    }

    private fun handleRemoteSourcePermission(launchIntent: Intent, delivery: LaunchDelivery): Boolean {
        val sourceId = launchIntent.getStringExtra(EXTRA_SOURCE_ID)?.takeIf { it.isNotBlank() } ?: return false
        val deviceId = launchIntent.getStringExtra(EXTRA_AFFECTED_DEVICE_ID)?.takeIf { it.isNotBlank() } ?: return false
        val sourceName = launchIntent.getStringExtra(EXTRA_SOURCE_NAME)?.takeIf { it.isNotBlank() }
        val deviceName = launchIntent.getStringExtra(EXTRA_AFFECTED_DEVICE_NAME)?.takeIf { it.isNotBlank() }
        val stamp = launchIntent.getLongExtra(EXTRA_REMOTE_SOURCE_PERMISSION_LAUNCH_STAMP, 0L)
        if (!launches.accept(KIND_REMOTE_SOURCE_PERMISSION, launchIntent, stamp, delivery)) return false
        notificationLaunchBus.postRemoteSourcePermission(sourceId, deviceId, sourceName, deviceName)
        return true
    }

    /**
     * A device-joined or pairing-request notification opens Devices. It exists only in a
     * cloud-relay build; without the flag the action is not handled at all, as on a build
     * without the feature.
     */
    private fun handleDevices(launchIntent: Intent, delivery: LaunchDelivery): Boolean {
        if (!BuildConfig.CLOUD_RELAY_ENABLED) return false
        val stamp = launchIntent.getLongExtra(EXTRA_DEVICES_LAUNCH_STAMP, 0L)
        if (!launches.accept(KIND_DEVICES, launchIntent, stamp, delivery)) return false
        if (launchIntent.getBooleanExtra(EXTRA_DEVICES_PAIRING_REQUESTS, false)) {
            notificationLaunchBus.postPairingRequests()
        } else {
            notificationLaunchBus.postDevices(launchIntent.getStringExtra(EXTRA_DEVICES_DEVICE_ID))
        }
        return true
    }

    /**
     * Debug-only: pair non-interactively from `am start` extras so the paired flow
     * can be exercised on an emulator or in CI without driving the pairing UI. It
     * runs the REAL [SessionManager.pairManually] exchange against the gateway.
     *
     *   adb shell am start -n dev.omnesis.android/.MainActivity \
     *     --es seed_url https://10.0.2.2:17700 --es seed_code <CODE> \
     *     --es seed_fingerprint <SHA256_HEX>
     */
    private fun maybeSeedPairing(launchIntent: Intent?) {
        val url = launchIntent?.getStringExtra("seed_url") ?: return
        val code = launchIntent.getStringExtra("seed_code") ?: return
        val fingerprint = launchIntent.getStringExtra("seed_fingerprint")
        lifecycleScope.launch {
            runCatching { sessionManager.pairManually(url, code, fingerprint) }
        }
    }

    companion object {
        const val ACTION_SEARCH = "dev.omnesis.android.action.SEARCH"
        const val EXTRA_SEARCH_QUERY = "query"
        /** Intent action the quick-capture entry points (QS tile, app shortcut) launch with. */
        const val ACTION_VOICE_INPUT = "dev.omnesis.android.action.VOICE_INPUT"
        const val ACTION_TELL_BRAIN = "dev.omnesis.android.action.TELL_BRAIN"

        /** String extra naming the capture surface slug ("android-tile", "android-shortcut"). */
        const val EXTRA_SURFACE = "surface"

        /** Long extra: the `elapsedRealtime()` of the tile tap that made the intent. */
        const val EXTRA_LAUNCH_STAMP = "launch_stamp"

        const val ACTION_AGENT_CONVERSATION = "dev.omnesis.android.action.AGENT_CONVERSATION"
        const val EXTRA_CONVERSATION_ID = "agent_conversation_id"
        const val EXTRA_CONVERSATION_LAUNCH_STAMP = "agent_conversation_launch_stamp"
        const val ACTION_PRIVACY_APPROVAL = "dev.omnesis.android.action.PRIVACY_APPROVAL"
        const val EXTRA_APPROVAL_ID = "privacy_approval_id"
        const val EXTRA_APPROVAL_LAUNCH_STAMP = "privacy_approval_launch_stamp"
        const val ACTION_ACCESS_AUTHORIZATION = "dev.omnesis.android.action.ACCESS_AUTHORIZATION"
        const val EXTRA_ACCESS_AUTHORIZATION_LAUNCH_STAMP = "access_authorization_launch_stamp"
        const val ACTION_WATCH_FIRING = "dev.omnesis.android.action.WATCH_FIRING"
        const val EXTRA_WATCH_ID = "watch_id"
        const val EXTRA_WATCH_FIRING_KEY = "watch_firing_key"
        const val EXTRA_WATCH_LAUNCH_STAMP = "watch_launch_stamp"
        const val ACTION_SOURCE_PERMISSION = "dev.omnesis.android.action.SOURCE_PERMISSION"
        const val EXTRA_SOURCE_ID = "source_permission_source_id"
        const val EXTRA_SOURCE_PERMISSION_LAUNCH_STAMP = "source_permission_launch_stamp"
        const val ACTION_REMOTE_SOURCE_PERMISSION = "dev.omnesis.android.action.REMOTE_SOURCE_PERMISSION"
        const val EXTRA_AFFECTED_DEVICE_ID = "remote_source_permission_device_id"
        const val EXTRA_SOURCE_NAME = "remote_source_permission_source_name"
        const val EXTRA_AFFECTED_DEVICE_NAME = "remote_source_permission_device_name"
        const val EXTRA_REMOTE_SOURCE_PERMISSION_LAUNCH_STAMP = "remote_source_permission_launch_stamp"
        const val ACTION_DEVICES = "dev.omnesis.android.action.DEVICES"
        const val EXTRA_DEVICES_DEVICE_ID = "devices_device_id"
        const val EXTRA_DEVICES_PAIRING_REQUESTS = "devices_pairing_requests"
        const val EXTRA_DEVICES_LAUNCH_STAMP = "devices_launch_stamp"

        /** How long after a tile tap the capture screen may still open for it. */
        const val CAPTURE_LAUNCH_FRESHNESS_MS = 30_000L

        private const val KIND_CAPTURE = "capture"
        private const val KIND_TASK_WIDGET = "task_widget"
        private const val KIND_SEARCH = "search"
        private const val KIND_PRIVACY_APPROVAL = "privacy_approval"
        private const val KIND_ACCESS_AUTHORIZATION = "access_authorization"
        private const val KIND_AGENT_CONVERSATION = "agent_conversation"
        private const val KIND_WATCH_FIRING = "watch_firing"
        private const val KIND_SOURCE_PERMISSION = "source_permission"
        private const val KIND_REMOTE_SOURCE_PERMISSION = "remote_source_permission"
        private const val KIND_DEVICES = "devices"

        /** [intent] with the request it carried removed: no action, no link, no extras. */
        internal fun consumedLaunchIntent(intent: Intent): Intent = Intent(intent).apply {
            action = null
            data = null
            replaceExtras(null as Bundle?)
        }
    }
}
